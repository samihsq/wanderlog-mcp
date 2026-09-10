import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { noteTextToDelta } from "../ot/rich-text.js";
import { resolveDay } from "../resolvers/day.js";
import type { PlaceData } from "../types.js";
import {
  buildPlaceAmbiguityText,
  buildPlaceBlock,
  farFromCenterNote,
  findBlockById,
  findDaySectionByDate,
  findPlacesToVisitSection,
  findSectionByRef,
  findTripCenter,
  requireUserId,
  resolvePlaceQuery,
  submitOp,
  tripSearchRadiusM,
  validateTimeInputs,
} from "./shared.js";

export const addPlaceInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to add to. Use wanderlog_list_trips if you don't know the key."),
  place: z
    .string()
    .min(1)
    .describe(
      "Name of the place to add. Examples: 'Sensō-ji', 'Yuigahama Beach', 'Louvre'. Matched against Google Places, biased toward the trip's destination but not restricted to it, so day trips resolve too. Be specific: if the best match is not clearly the place you named, or two matches are equally good, the tool adds nothing and returns candidates for you to choose from.",
    ),
  day: z
    .string()
    .optional()
    .describe(
      "Optional day to add the place to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to add the place to the trip's 'Places to visit' list (unscheduled).",
    ),
  section: z
    .string()
    .optional()
    .describe(
      "Optional custom section to also add the place to, identified by its heading (e.g. 'Food & Drink', 'Must-See Spots'). Can be combined with 'day' to insert the place into both locations in a single call.",
    ),
  note: z
    .string()
    .optional()
    .describe(
      "Optional inline note attached directly to this place. Use for practical context: transit directions, what to order, booking tips, time guidance. Appears on the place itself in Wanderlog (not as a separate note block). Markdown is rendered as rich text: **bold**, *italic*, `code`, [links](https://example.com), \"- \" bullets.",
    ),
  format: z
    .enum(["markdown", "plain"])
    .optional()
    .describe(
      "How to interpret 'note'. \"markdown\" (the default) converts markdown to Wanderlog rich text. \"plain\" stores it verbatim.",
    ),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Optional start time in HH:mm format (e.g. '09:00'). Adds a scheduled time to the place."),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
    .optional()
    .describe("Optional end time in HH:mm format (e.g. '11:30'). Only used with start_time."),
};

export const addPlaceDescription = `
Adds a place to a Wanderlog trip. Searches for the place near the trip's destination, picks the
best match, and inserts it into either a specific day or the general "Places to visit" list.

PREFERRED: Use the "note" parameter to attach practical context directly to each place — transit
directions, what to order, booking tips, time guidance. This is better than a separate
wanderlog_add_note call because the note lives on the place itself in the itinerary. Use the
"start_time" and "end_time" parameters to give the place a scheduled time window.

Use standalone wanderlog_add_note only for freestanding commentary between places (neighborhood
context, multi-stop transit, day-level tips that aren't about a specific place).

Returns a confirmation including the resolved place name, its full address, and where it was
added — check the address, because a name alone can hide a wrong match.
`.trim();

type Args = {
  trip_key: string;
  place: string;
  day?: string;
  section?: string;
  note?: string;
  format?: "markdown" | "plain";
  start_time?: string;
  end_time?: string;
};

export async function addPlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    validateTimeInputs(args.start_time, args.end_time);
    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const center = findTripCenter(entry.snapshot, entry.geos);
    if (!center) {
      throw new WanderlogValidationError(
        `Cannot add places to "${entry.snapshot.title}" because no location anchor is available`,
        "This trip has no associated geo and no existing places. Add a place via the Wanderlog UI first.",
      );
    }
    const resolution = await resolvePlaceQuery(
      ctx,
      args.place,
      center,
      tripSearchRadiusM(entry.geos),
    );
    if (resolution.kind === "none") {
      throw new WanderlogError(
        `No place found matching "${args.place}" near ${entry.snapshot.title}`,
        "place_not_found",
        {
          hint: "Try a more specific name, or widen the search with wanderlog_search_places first.",
          followUps: [
            `Call wanderlog_search_places with trip_key "${args.trip_key}" and a broader query to see nearby candidates.`,
            "Retry wanderlog_add_place with a more specific place name (include the city or neighborhood).",
          ],
        },
      );
    }
    // Guessing between candidates is how the wrong place gets written silently,
    // so hand the choice back and leave the trip untouched.
    if (resolution.kind === "ambiguous") {
      return {
        content: [
          {
            type: "text",
            text: buildPlaceAmbiguityText({
              query: args.place,
              tripTitle: entry.snapshot.title,
              candidates: resolution.candidates,
              reason: resolution.reason,
              toolName: "wanderlog_add_place",
              argName: "place",
            }),
          },
        ],
        isError: true,
      };
    }
    const detail: PlaceData = resolution.detail;
    const imageKeys = await ctx.rest.getPlacePhotos(detail);

    const mutation = await submitOp(ctx, args.trip_key, async (lockedEntry, submit) => {
      const trip = lockedEntry.snapshot;
      type Target = { sectionId: number; label: string };
      const targets: Target[] = [];

      if (args.day) {
        const daySection = resolveDay(trip, args.day);
        const found = findDaySectionByDate(trip, daySection.date!);
        if (!found) {
          throw new WanderlogValidationError(`Day ${args.day} not found in trip`);
        }
        targets.push({ sectionId: found.section.id, label: `day ${daySection.date}` });
      }
      if (args.section) {
        const found = findSectionByRef(trip, args.section);
        if (!found) {
          throw new WanderlogValidationError(
            `Section "${args.section}" not found in trip "${trip.title}". Use wanderlog_get_trip to see available sections.`,
          );
        }
        targets.push({ sectionId: found.section.id, label: `section "${args.section}"` });
      }
      if (targets.length === 0) {
        const places = findPlacesToVisitSection(trip);
        if (!places) {
          throw new WanderlogError(
            "Trip has no 'Places to visit' list",
            "no_places_section",
            "This is unexpected — Wanderlog usually creates one automatically. Try adding to a specific day instead.",
          );
        }
        targets.push({ sectionId: places.section.id, label: "places to visit" });
      }

      for (const target of targets) {
        const sectionIndex = lockedEntry.snapshot.itinerary.sections.findIndex(
          (section) => section.id === target.sectionId,
        );
        if (sectionIndex < 0) {
          throw new WanderlogError("Target section moved or was removed", "stale_target");
        }
        const section = lockedEntry.snapshot.itinerary.sections[sectionIndex]!;
        const block = buildPlaceBlock(detail, userId);
        const blockPath = [
          "itinerary",
          "sections",
          sectionIndex,
          "blocks",
          section.blocks.length,
        ];
        const insertOps: Json0Op[] = [{ p: blockPath, li: block }];
        if (imageKeys.length > 0) {
          insertOps.push({ p: [...blockPath, "imageKeys"], oi: imageKeys });
        }
        await submit(insertOps);

        if (args.note) {
          const inserted = findBlockById(lockedEntry.snapshot, block.id);
          if (!inserted || inserted.block.type !== "place") {
            throw new WanderlogError("Inserted place could not be found", "stale_target");
          }
          await submit([
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
              o: noteTextToDelta(args.note, args.format ?? "markdown"),
            },
          ]);
        }

        if (args.start_time || args.end_time) {
          const inserted = findBlockById(lockedEntry.snapshot, block.id);
          if (!inserted || inserted.block.type !== "place") {
            throw new WanderlogError("Inserted place could not be found", "stale_target");
          }
          const currentPath = [
            "itinerary",
            "sections",
            inserted.sectionIndex,
            "blocks",
            inserted.blockIndex,
          ];
          const timeOps: Json0Op[] = [];
          if (args.start_time) {
            timeOps.push({ p: [...currentPath, "startTime"], oi: args.start_time });
          }
          if (args.end_time) {
            timeOps.push({ p: [...currentPath, "endTime"], oi: args.end_time });
          }
          await submit(timeOps);
        }
      }
      return {
        labelList: targets.map((target) => target.label).join(" and "),
        tripTitle: trip.title,
      };
    });

    // Echo the resolved address, not just the name: it is the only thing in the
    // transcript that makes a wrong-but-plausible match visible after the write.
    const where = detail.formatted_address ? ` (${detail.formatted_address})` : "";
    const parts = [
      `Added ${detail.name}${where} to ${mutation.labelList} in "${mutation.tripTitle}".`,
    ];
    if (args.start_time) {
      parts.push(`Scheduled: ${args.start_time}${args.end_time ? `–${args.end_time}` : ""}.`);
    }
    if (args.note) {
      const preview = args.note.length > 60 ? `${args.note.slice(0, 57)}…` : args.note;
      parts.push(`Note: "${preview}"`);
    }
    const far = farFromCenterNote(resolution.distanceKm, resolution.usedUnbiasedSearch);
    if (far) parts.push(far);
    const text = parts.join(" ");
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
