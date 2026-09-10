import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { noteTextToDelta, replaceDeltaOps } from "../ot/rich-text.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock, type QuillDelta, type TripPlan } from "../types.js";
import {
  buildNoteBlock,
  findBlockById,
  findSectionByRef,
  findTargetSection,
  requireUserId,
  submitOp,
  type TargetSection,
} from "./shared.js";

export const addNoteInputSchema = z
  .object({
    trip_key: z
      .string()
      .min(1)
      .describe(
        "The trip to add the note to. Use wanderlog_list_trips if you don't know the key.",
      ),
    text: z
      .string()
      .min(1)
      .describe(
        "The note text. Markdown is rendered as rich text by default: **bold**, *italic*, ~~strike~~, `code`, [links](https://example.com), # / ## / ### headings, \"- \" bullets, \"1. \" numbered lists, \"> \" quotes, and two-space indentation for nested list items. Can be multi-line. Escape a marker with a backslash to keep it literal, or pass format: \"plain\" to disable parsing entirely.",
      ),
    format: z
      .enum(["markdown", "plain"])
      .optional()
      .describe(
        "How to interpret 'text'. \"markdown\" (the default) converts markdown to Wanderlog rich text. \"plain\" stores the text verbatim, markers and all.",
      ),
    day: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional day to add the note to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. If 'section' is also provided, the section takes precedence. Omit both to add to the 'Places to visit' list.",
      ),
    after: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Insert the note directly BELOW this place instead of at the end of the day. Natural-language place reference, same syntax as wanderlog_annotate_place ('Sensō-ji', 'the hotel', 'Kagurazaka on day 2'). This is how a note becomes connective tissue between two stops rather than a footer. Determines the target section on its own, so 'day' and 'section' are ignored when it is given.",
      ),
    section: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional undated section to add the note to, identified by its heading (e.g. 'Notes', 'Food & Drink', or 'Places to visit'). Matching is case-insensitive and takes precedence over 'day'. Omit both to add to the 'Places to visit' list.",
      ),
  });

export const addNoteDescription = `
Adds a text note to a Wanderlog trip. Notes appear inline between places in a day, acting as
the connective tissue of the itinerary. Every well-built day should have notes between stops.
Supply "day" for a dated itinerary day or "section" for an undated section such as "Notes"
or "Food & Drink". When both are provided, "section" takes precedence. Omit both to add to
the default "Places to visit" list.

When to add a note (do this after adding each place or group of places):
- How to get there: "Walk 15 min along the South Bank, or take the Jubilee line one stop"
- Practical tips: "Book tickets online at least 2 days ahead — sells out in summer"
- Food/drink recs: "Try the salt beef bagel at Beigel Bake — cash only, open 24hrs"
- Time guidance: "Budget 2-3 hours here. Open 10am-6pm, closed Tuesdays"
- Neighborhood context: "This area is great for wandering — no rush, just explore the lanes"

Placement: notes append to the end of the target by default. Pass "after" with the place the
note belongs under to put it in the right spot — a transit note between two stops is useless
at the bottom of the day.

Formatting: 'text' is markdown by default, so use **bold** for emphasis, "- " bullets for
lists of options, "## " headings to group a long note, and [links](https://example.com) for
bookings and maps. Keep it light — a note is a sentence or two, not a document. Pass
format: "plain" when the text must be stored verbatim.

Returns a confirmation of where the note was added.
`.trim();

type Args = z.infer<typeof addNoteInputSchema>;

function evaluateTargetSection(
  trip: TripPlan,
  { day, section }: Pick<Args, "day" | "section">,
): TargetSection {
  if (section !== undefined) {
    const found = findSectionByRef(trip, section);
    if (!found) {
      throw new WanderlogValidationError(
        `Section "${section}" not found in trip "${trip.title}". Use wanderlog_get_trip to see available sections.`,
      );
    }
    if (found.section.mode === "dayPlan") {
      throw new WanderlogValidationError(
        `Section "${found.section.heading || section}" is a dated section. Use the "day" parameter to add a note to an itinerary day.`,
      );
    }
    return {
      index: found.index,
      section: found.section,
      label: `section "${found.section.heading || section}"`,
    };
  }

  if (day !== undefined) return findTargetSection(trip, day);

  return findTargetSection(trip);
}

export async function addNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const userId = requireUserId(ctx);
    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;

      let sectionIndex: number;
      let insertIndex: number;
      let targetLabel: string;

      if (args.after !== undefined) {
        const anchor = resolvePlaceRef(trip, args.after);
        if (anchor.kind === "none") {
          throw new WanderlogError(
            `No place matching "${args.after}" found in "${trip.title}"`,
            "place_ref_not_found",
            {
              hint: "Check the place name, or omit 'after' to append the note to the end of the day.",
            },
          );
        }
        if (anchor.kind === "ambiguous") {
          const lines = anchor.candidates.map((c, i) => {
            const name = isPlaceBlock(c.block) ? c.block.place.name : `block #${c.block.id}`;
            const where = c.section.date ?? (c.section.heading || "unscheduled");
            return `  ${i + 1}. ${name} (${where})`;
          });
          return {
            response: {
              content: [
                {
                  type: "text" as const,
                  text: `"${args.after}" matches ${anchor.candidates.length} places:\n${lines.join("\n")}\n\nRetry with a more specific reference or an ordinal prefix (e.g. "1st ${args.after}").`,
                },
              ],
              isError: true,
            },
          };
        }
        sectionIndex = anchor.match.sectionIndex;
        insertIndex = anchor.match.blockIndex + 1;
        const anchorName = isPlaceBlock(anchor.match.block)
          ? anchor.match.block.place.name
          : `block #${anchor.match.block.id}`;
        const section = anchor.match.section;
        targetLabel = `${section.date ?? (section.heading || "the itinerary")}, below ${anchorName}`;
      } else {
        const target = evaluateTargetSection(trip, args);
        sectionIndex = target.index;
        insertIndex = target.section.blocks.length;
        targetLabel = target.label;
      }

      const block = buildNoteBlock(userId);
      const insertOps: Json0Op[] = [
        {
          p: ["itinerary", "sections", sectionIndex, "blocks", insertIndex],
          li: block,
        },
      ];
      await submit(insertOps);

      const inserted = findBlockById(entry.snapshot, block.id as number);
      if (!inserted || inserted.block.type !== "note") {
        throw new WanderlogError("Inserted note could not be found", "stale_target");
      }
      const textOps: Json0Op[] = [
        {
          p: [
            "itinerary",
            "sections",
            inserted.sectionIndex,
            "blocks",
            inserted.blockIndex,
            "text",
          ],
          t: "rich-text",
          // A fresh note block already holds the "\n" that terminates a Quill
          // document. Replace it instead of inserting before it, or every note
          // ends with a stray blank paragraph.
          o: replaceDeltaOps(
            (inserted.block as { text?: QuillDelta }).text,
            noteTextToDelta(args.text, args.format ?? "markdown"),
          ),
        },
      ];
      await submit(textOps);
      return { targetLabel, tripTitle: entry.snapshot.title };
    });

    if ("response" in result && result.response) return result.response;

    const preview = args.text.length > 60 ? `${args.text.slice(0, 57)}…` : args.text;
    const text = `Added note "${preview}" to ${result.targetLabel} in "${result.tripTitle}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
