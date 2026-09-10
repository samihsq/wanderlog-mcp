import { describe, expect, it } from "vitest";
import {
  composeDelta,
  deltaToPlainText,
  markdownToDelta,
  noteTextToDelta,
  replaceDeltaOps,
} from "../../src/ot/rich-text.ts";

describe("markdownToDelta inline formatting", () => {
  it("keeps unformatted text as a single insert plus terminator", () => {
    expect(markdownToDelta("Plain note")).toEqual([
      { insert: "Plain note" },
      { insert: "\n" },
    ]);
  });

  it("marks bold with ** and __", () => {
    expect(markdownToDelta("**loud**")).toEqual([
      { insert: "loud", attributes: { bold: true } },
      { insert: "\n" },
    ]);
    expect(markdownToDelta("__loud__")).toEqual([
      { insert: "loud", attributes: { bold: true } },
      { insert: "\n" },
    ]);
  });

  it("marks italic without eating bold markers", () => {
    expect(markdownToDelta("*soft*")).toEqual([
      { insert: "soft", attributes: { italic: true } },
      { insert: "\n" },
    ]);
    expect(markdownToDelta("**loud** and *soft*")).toEqual([
      { insert: "loud", attributes: { bold: true } },
      { insert: " and " },
      { insert: "soft", attributes: { italic: true } },
      { insert: "\n" },
    ]);
  });

  it("leaves intra-word underscores alone", () => {
    expect(markdownToDelta("call add_place_now")).toEqual([
      { insert: "call add_place_now" },
      { insert: "\n" },
    ]);
  });

  it("converts links", () => {
    expect(markdownToDelta("[book here](https://example.com/x)")).toEqual([
      { insert: "book here", attributes: { link: "https://example.com/x" } },
      { insert: "\n" },
    ]);
  });

  it("nests attributes for formatted link text", () => {
    expect(markdownToDelta("[**book**](https://e.com)")).toEqual([
      { insert: "book", attributes: { bold: true, link: "https://e.com" } },
      { insert: "\n" },
    ]);
  });

  it("supports strike and inline code, and does not re-parse code contents", () => {
    expect(markdownToDelta("~~gone~~")).toEqual([
      { insert: "gone", attributes: { strike: true } },
      { insert: "\n" },
    ]);
    expect(markdownToDelta("`**literal**`")).toEqual([
      { insert: "**literal**", attributes: { code: true } },
      { insert: "\n" },
    ]);
  });

  it("treats escaped markers as literal text", () => {
    expect(markdownToDelta("a \\*star\\* here")).toEqual([
      { insert: "a *star* here" },
      { insert: "\n" },
    ]);
  });

  it("keeps unmatched markers literal", () => {
    expect(markdownToDelta("2 * 3 = 6")).toEqual([
      { insert: "2 * 3 = 6" },
      { insert: "\n" },
    ]);
  });
});

describe("markdownToDelta line formatting", () => {
  it("puts header attributes on the terminating newline", () => {
    expect(markdownToDelta("## Getting around")).toEqual([
      { insert: "Getting around" },
      { insert: "\n", attributes: { header: 2 } },
    ]);
  });

  it("handles bullet and ordered lists", () => {
    expect(markdownToDelta("- one\n- two")).toEqual([
      { insert: "one" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "two" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
    expect(markdownToDelta("1. first\n2. second")).toEqual([
      { insert: "first" },
      { insert: "\n", attributes: { list: "ordered" } },
      { insert: "second" },
      { insert: "\n", attributes: { list: "ordered" } },
    ]);
  });

  it("reads two-space indentation as list nesting", () => {
    expect(markdownToDelta("- top\n  - nested")).toEqual([
      { insert: "top" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "nested" },
      { insert: "\n", attributes: { list: "bullet", indent: 1 } },
    ]);
  });

  it("handles blockquotes and inline formatting inside a line", () => {
    expect(markdownToDelta("> **Book ahead** — sells out")).toEqual([
      { insert: "Book ahead", attributes: { bold: true } },
      { insert: " — sells out" },
      { insert: "\n", attributes: { blockquote: true } },
    ]);
  });

  it("does not add a blank line for a trailing newline", () => {
    expect(markdownToDelta("one line\n")).toEqual([
      { insert: "one line" },
      { insert: "\n" },
    ]);
  });

  it("preserves intentional blank lines between paragraphs", () => {
    expect(markdownToDelta("a\n\nb")).toEqual([
      { insert: "a" },
      { insert: "\n" },
      { insert: "\n" },
      { insert: "b" },
      { insert: "\n" },
    ]);
  });
});

describe("noteTextToDelta", () => {
  it("stores text verbatim in plain mode", () => {
    expect(noteTextToDelta("**not bold**", "plain")).toEqual([
      { insert: "**not bold**\n" },
    ]);
  });

  it("defaults to markdown", () => {
    expect(noteTextToDelta("**bold**")).toEqual([
      { insert: "bold", attributes: { bold: true } },
      { insert: "\n" },
    ]);
  });
});

describe("composeDelta", () => {
  it("keeps attributes on retained text", () => {
    const current = {
      ops: [
        { insert: "Book ", attributes: { bold: true } },
        { insert: "early" },
      ],
    };
    const result = composeDelta(current, [{ retain: 5 }, { delete: 5 }, { insert: "late" }]);
    expect(result.ops).toEqual([
      { insert: "Book ", attributes: { bold: true } },
      { insert: "late" },
    ]);
  });

  it("applies attributes over a retained range", () => {
    const result = composeDelta({ ops: [{ insert: "hello world" }] }, [
      { retain: 5, attributes: { bold: true } },
    ]);
    expect(result.ops).toEqual([
      { insert: "hello", attributes: { bold: true } },
      { insert: " world" },
    ]);
  });

  it("clears an attribute when handed a null value", () => {
    const result = composeDelta(
      { ops: [{ insert: "bold", attributes: { bold: true } }] },
      [{ retain: 4, attributes: { bold: null } }],
    );
    expect(result.ops).toEqual([{ insert: "bold" }]);
  });

  it("inserts formatted text mid-document", () => {
    const result = composeDelta({ ops: [{ insert: "ab" }] }, [
      { retain: 1 },
      { insert: "X", attributes: { italic: true } },
    ]);
    expect(result.ops).toEqual([
      { insert: "a" },
      { insert: "X", attributes: { italic: true } },
      { insert: "b" },
    ]);
  });

  it("round-trips a markdown note through compose", () => {
    const ops = markdownToDelta("## Day 1\n- **Ramen** at Ichiran");
    const result = composeDelta(undefined, ops);
    expect(deltaToPlainText(result)).toBe("Day 1\nRamen at Ichiran\n");
    expect(result.ops).toEqual([
      { insert: "Day 1" },
      { insert: "\n", attributes: { header: 2 } },
      { insert: "Ramen", attributes: { bold: true } },
      { insert: " at Ichiran" },
      { insert: "\n", attributes: { list: "bullet" } },
    ]);
  });
});

describe("replaceDeltaOps", () => {
  it("deletes existing content before inserting", () => {
    expect(replaceDeltaOps({ ops: [{ insert: "old\n" }] }, [{ insert: "new\n" }])).toEqual([
      { delete: 4 },
      { insert: "new\n" },
    ]);
  });

  it("skips the delete when the field is empty", () => {
    expect(replaceDeltaOps(undefined, [{ insert: "new\n" }])).toEqual([
      { insert: "new\n" },
    ]);
  });
});
