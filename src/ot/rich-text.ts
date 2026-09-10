import { isDeepStrictEqual } from "node:util";
import type { QuillDelta } from "../types.js";

/**
 * Quill Delta helpers.
 *
 * Wanderlog stores notes, place annotations, checklist items and journal
 * entries as Quill Deltas behind ShareDB's "rich-text" subtype. A Delta is a
 * flat list of insert ops; formatting lives in `attributes`:
 *
 *   - inline attributes (bold, italic, strike, code, link) sit on the text run
 *   - line attributes (header, list, blockquote, indent) sit on the "\n" that
 *     terminates the line they apply to
 *
 * That newline placement is the part that is easy to get wrong: a bulleted
 * line is `{insert: "Ramen"}, {insert: "\n", attributes: {list: "bullet"}}`,
 * not an attribute on the text itself.
 */

export type DeltaAttributes = Record<string, unknown>;

export type DeltaOp = {
  insert?: string;
  retain?: number;
  delete?: number;
  attributes?: DeltaAttributes;
};

/** A maximal stretch of text sharing one set of attributes. */
export type Run = { text: string; attributes?: DeltaAttributes };

function normalizeAttributes(
  attributes: DeltaAttributes | undefined,
): DeltaAttributes | undefined {
  if (!attributes) return undefined;
  const entries = Object.entries(attributes).filter(
    ([, value]) => value !== null && value !== undefined && value !== false,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function sameAttributes(
  a: DeltaAttributes | undefined,
  b: DeltaAttributes | undefined,
): boolean {
  return isDeepStrictEqual(normalizeAttributes(a), normalizeAttributes(b));
}

/**
 * Merges `patch` into `base`. A null/undefined/false value in `patch` removes
 * the key, matching Quill's convention for clearing a format over a range.
 */
function mergeAttributes(
  base: DeltaAttributes | undefined,
  patch: DeltaAttributes | undefined,
): DeltaAttributes | undefined {
  if (!patch) return normalizeAttributes(base);
  const merged: DeltaAttributes = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === false) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return normalizeAttributes(merged);
}

export function deltaToRuns(delta: QuillDelta | undefined | null): Run[] {
  const ops = delta?.ops;
  if (!Array.isArray(ops)) return [];
  const runs: Run[] = [];
  for (const op of ops) {
    if (typeof op?.insert !== "string" || op.insert.length === 0) continue;
    runs.push({ text: op.insert, attributes: normalizeAttributes(op.attributes) });
  }
  return runs;
}

/** Collapses adjacent runs that share attributes and drops empty ones. */
export function coalesceRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const attributes = normalizeAttributes(run.attributes);
    const previous = out[out.length - 1];
    if (previous && sameAttributes(previous.attributes, attributes)) {
      previous.text += run.text;
    } else {
      out.push({ text: run.text, attributes });
    }
  }
  return out;
}

export function runsToDelta(runs: Run[]): QuillDelta {
  const ops = coalesceRuns(runs).map((run) =>
    run.attributes ? { insert: run.text, attributes: run.attributes } : { insert: run.text },
  );
  return { ops: ops.length > 0 ? ops : [{ insert: "" }] };
}

export function deltaToPlainText(delta: QuillDelta | undefined | null): string {
  return deltaToRuns(delta)
    .map((run) => run.text)
    .join("");
}

export function deltaLength(delta: QuillDelta | undefined | null): number {
  return deltaToPlainText(delta).length;
}

type Char = { char: string; attributes?: DeltaAttributes };

function runsToChars(runs: Run[]): Char[] {
  const chars: Char[] = [];
  for (const run of runs) {
    for (const char of run.text) {
      chars.push({ char, attributes: run.attributes });
    }
  }
  return chars;
}

function charsToRuns(chars: Char[]): Run[] {
  return coalesceRuns(chars.map((c) => ({ text: c.char, attributes: c.attributes })));
}

/**
 * Applies Delta ops to existing runs, preserving the attributes of text the
 * ops merely retain. Operates per character, which is more than fast enough
 * for note-sized documents and removes every off-by-one an interval-splitting
 * implementation would invite.
 */
export function composeRuns(runs: Run[], ops: DeltaOp[]): Run[] {
  const chars = runsToChars(runs);
  let pos = 0;
  for (const op of ops) {
    if (typeof op.retain === "number") {
      const end = Math.min(pos + op.retain, chars.length);
      if (op.attributes) {
        for (let i = pos; i < end; i++) {
          chars[i] = {
            char: chars[i]!.char,
            attributes: mergeAttributes(chars[i]!.attributes, op.attributes),
          };
        }
      }
      pos += op.retain;
    } else if (typeof op.insert === "string") {
      const attributes = normalizeAttributes(op.attributes);
      const inserted = [...op.insert].map((char) => ({ char, attributes }));
      const at = Math.min(pos, chars.length);
      chars.splice(at, 0, ...inserted);
      pos = at + inserted.length;
    } else if (typeof op.delete === "number") {
      chars.splice(pos, op.delete);
    }
  }
  return charsToRuns(chars);
}

export function composeDelta(
  delta: QuillDelta | undefined | null,
  ops: DeltaOp[],
): QuillDelta {
  return runsToDelta(composeRuns(deltaToRuns(delta), ops));
}

/**
 * Ops that replace a field's whole contents: delete what is there, then insert
 * the new run list. Used by tools whose contract is "set or replace".
 */
export function replaceDeltaOps(
  current: QuillDelta | undefined | null,
  next: DeltaOp[],
): DeltaOp[] {
  const existing = deltaLength(current);
  const ops: DeltaOp[] = [];
  if (existing > 0) ops.push({ delete: existing });
  ops.push(...next);
  return ops;
}

export function plainTextToDelta(text: string): DeltaOp[] {
  return [{ insert: text.endsWith("\n") ? text : `${text}\n` }];
}

const LINE_PATTERNS: Array<{
  pattern: RegExp;
  attributes: (match: RegExpExecArray) => DeltaAttributes;
}> = [
  { pattern: /^(#{1,3})\s+(.*)$/, attributes: (m) => ({ header: m[1]!.length }) },
  { pattern: /^>\s?(.*)$/, attributes: () => ({ blockquote: true }) },
  { pattern: /^[-*+]\s+(.*)$/, attributes: () => ({ list: "bullet" }) },
  { pattern: /^\d+[.)]\s+(.*)$/, attributes: () => ({ list: "ordered" }) },
];

const INLINE_PATTERNS: Array<{
  pattern: RegExp;
  attributes: (match: RegExpExecArray) => DeltaAttributes;
  /** Which capture group holds the text to keep parsing. */
  body: number;
  /** Inline code is a leaf — its contents are never re-parsed. */
  leaf?: boolean;
}> = [
  {
    pattern: /\[([^\]\n]*)\]\(([^)\s]+)\)/,
    attributes: (m) => ({ link: m[2] }),
    body: 1,
  },
  { pattern: /\*\*([^\n]+?)\*\*/, attributes: () => ({ bold: true }), body: 1 },
  { pattern: /__([^\n]+?)__/, attributes: () => ({ bold: true }), body: 1 },
  { pattern: /~~([^\n]+?)~~/, attributes: () => ({ strike: true }), body: 1 },
  { pattern: /`([^`\n]+?)`/, attributes: () => ({ code: true }), body: 1, leaf: true },
  {
    // Avoid eating the "*" of "**bold**" or intra-word underscores in snake_case.
    pattern: /(?<![*\w])\*([^*\n]+?)\*(?!\*)/,
    attributes: () => ({ italic: true }),
    body: 1,
  },
  {
    pattern: /(?<![_\w])_([^_\n]+?)_(?!\w)/,
    attributes: () => ({ italic: true }),
    body: 1,
  },
];

/** Strips backslash escapes so "\\*literal\\*" renders as "*literal*". */
function unescape(text: string): string {
  return text.replace(/\\([\\`*_~[\]()#>])/g, "$1");
}

function parseInline(text: string, inherited?: DeltaAttributes): DeltaOp[] {
  if (text.length === 0) return [];

  let earliest: { index: number; match: RegExpExecArray; spec: (typeof INLINE_PATTERNS)[number] } | null =
    null;
  for (const spec of INLINE_PATTERNS) {
    const match = spec.pattern.exec(text);
    if (!match) continue;
    // A marker preceded by a backslash is literal, not formatting.
    if (match.index > 0 && text[match.index - 1] === "\\") continue;
    if (!earliest || match.index < earliest.index) {
      earliest = { index: match.index, match, spec };
    }
  }

  if (!earliest) {
    const plain = unescape(text);
    return plain.length > 0
      ? [inherited ? { insert: plain, attributes: inherited } : { insert: plain }]
      : [];
  }

  const { index, match, spec } = earliest;
  const ops: DeltaOp[] = [];
  if (index > 0) ops.push(...parseInline(text.slice(0, index), inherited));

  const attributes = mergeAttributes(inherited, spec.attributes(match));
  const body = match[spec.body] ?? "";
  if (spec.leaf) {
    if (body.length > 0) ops.push({ insert: body, attributes });
  } else {
    ops.push(...parseInline(body, attributes));
  }

  ops.push(...parseInline(text.slice(index + match[0]!.length), inherited));
  return ops;
}

/**
 * Converts a markdown subset to Delta insert ops.
 *
 * Supported: headings (#, ##, ###), bullet and numbered lists (with two-space
 * indentation for nesting), blockquotes, **bold**, __bold__, *italic*,
 * _italic_, ~~strike~~, `code`, and [links](https://example.com). Anything
 * else, including unmatched markers, is kept as literal text, and a marker can
 * be escaped with a backslash.
 */
export function markdownToDelta(markdown: string): DeltaOp[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // A trailing newline in the input would otherwise add a blank line, since
  // every line already contributes its own terminator below.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const ops: DeltaOp[] = [];
  for (const rawLine of lines) {
    const indentMatch = /^(\s*)(.*)$/.exec(rawLine)!;
    const leading = indentMatch[1]!.replace(/\t/g, "  ");
    let body = indentMatch[2]!;
    let lineAttributes: DeltaAttributes | undefined;

    for (const spec of LINE_PATTERNS) {
      const match = spec.pattern.exec(body);
      if (!match) continue;
      lineAttributes = spec.attributes(match);
      body = match[match.length - 1] ?? "";
      break;
    }

    if (lineAttributes?.list) {
      const indent = Math.floor(leading.length / 2);
      if (indent > 0) lineAttributes = { ...lineAttributes, indent };
    } else if (leading.length > 0) {
      // Indentation is only meaningful for lists; elsewhere keep it verbatim.
      body = leading + body;
    }

    ops.push(...parseInline(body));
    ops.push(
      lineAttributes ? { insert: "\n", attributes: lineAttributes } : { insert: "\n" },
    );
  }
  return ops;
}

export type NoteFormat = "markdown" | "plain";

export function noteTextToDelta(text: string, format: NoteFormat = "markdown"): DeltaOp[] {
  return format === "plain" ? plainTextToDelta(text) : markdownToDelta(text);
}
