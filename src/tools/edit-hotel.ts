import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock, type HotelBooking, type PlaceBlock } from "../types.js";
import { assertBlockAtPath, findBlockById, isValidDate, submitOp } from "./shared.js";

export const editHotelInputSchema = {
  trip_key: z.string().min(1).describe("The trip whose hotel booking to edit."),
  hotel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which hotel to edit. Omit when the trip has one hotel. Otherwise a name or partial name ('Park Hyatt'), or 'the hotel' for the first one. Supports ordinals: '2nd hotel'.",
    ),
  check_in: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional()
    .describe("New check-in date, YYYY-MM-DD. Omit to leave unchanged."),
  check_out: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional()
    .describe("New check-out date, YYYY-MM-DD. Omit to leave unchanged."),
  confirmation_number: z
    .string()
    .optional()
    .describe(
      "Booking confirmation number. Pass an empty string to clear it. Omit to leave unchanged.",
    ),
  traveler_names: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Names on the booking, replacing the current list. Pass an empty array to clear it. Omit to leave unchanged.",
    ),
};

export const editHotelDescription = `
Edits an existing hotel booking on a Wanderlog trip: check-in, check-out, confirmation number,
or the names on the booking. Use this to correct a stay whose dates changed — adding a second
hotel block for the same stay is not the same thing.

Only the fields you supply are modified. If the trip has one hotel, omit 'hotel'. If several
match, a numbered list is returned and nothing changes.

Checking out on or before the check-in date is rejected. To move a stay, send both dates in
one call so the pair is validated together.
`.trim();

type Args = {
  trip_key: string;
  hotel?: string;
  check_in?: string;
  check_out?: string;
  confirmation_number?: string;
  traveler_names?: string[];
};

/** od+oi replacement for an existing key; oi-only insert when the key is absent. */
function replaceField(
  path: (string | number)[],
  oldValue: unknown,
  newValue: unknown,
): Json0Op {
  return oldValue === undefined
    ? { p: path, oi: newValue }
    : { p: path, od: oldValue, oi: newValue };
}

export function buildHotelEditOps(
  block: PlaceBlock,
  blockPath: (string | number)[],
  args: Args,
): { ops: Json0Op[]; changes: string[]; booking: HotelBooking } {
  const current = block.hotel;
  const merged: HotelBooking = {
    checkIn: args.check_in ?? current?.checkIn ?? null,
    checkOut: args.check_out ?? current?.checkOut ?? null,
    travelerNames: args.traveler_names ?? current?.travelerNames ?? [],
    confirmationNumber:
      args.confirmation_number === undefined
        ? (current?.confirmationNumber ?? null)
        : args.confirmation_number === ""
          ? null
          : args.confirmation_number,
  };

  if (merged.checkIn && merged.checkOut && merged.checkOut <= merged.checkIn) {
    throw new WanderlogValidationError(
      `check_out (${merged.checkOut}) must be after check_in (${merged.checkIn}).`,
    );
  }

  const hotelPath = [...blockPath, "hotel"];
  const changes: string[] = [];

  // No booking object yet — write the whole thing in one op rather than
  // several ops against keys that do not exist.
  if (!current) {
    if (args.check_in) changes.push(`check-in → ${merged.checkIn}`);
    if (args.check_out) changes.push(`check-out → ${merged.checkOut}`);
    if (args.confirmation_number !== undefined) {
      changes.push(`confirmation → ${merged.confirmationNumber ?? "(cleared)"}`);
    }
    if (args.traveler_names) {
      changes.push(
        `travelers → ${merged.travelerNames.length > 0 ? merged.travelerNames.join(", ") : "(cleared)"}`,
      );
    }
    return { ops: [{ p: hotelPath, oi: merged }], changes, booking: merged };
  }

  const ops: Json0Op[] = [];
  if (args.check_in !== undefined && args.check_in !== current.checkIn) {
    ops.push(replaceField([...hotelPath, "checkIn"], current.checkIn, args.check_in));
    changes.push(`check-in ${current.checkIn ?? "(unset)"} → ${args.check_in}`);
  }
  if (args.check_out !== undefined && args.check_out !== current.checkOut) {
    ops.push(replaceField([...hotelPath, "checkOut"], current.checkOut, args.check_out));
    changes.push(`check-out ${current.checkOut ?? "(unset)"} → ${args.check_out}`);
  }
  if (
    args.confirmation_number !== undefined &&
    merged.confirmationNumber !== current.confirmationNumber
  ) {
    ops.push(
      replaceField(
        [...hotelPath, "confirmationNumber"],
        current.confirmationNumber,
        merged.confirmationNumber,
      ),
    );
    changes.push(`confirmation → ${merged.confirmationNumber ?? "(cleared)"}`);
  }
  if (
    args.traveler_names !== undefined &&
    JSON.stringify(args.traveler_names) !== JSON.stringify(current.travelerNames ?? [])
  ) {
    ops.push(
      replaceField(
        [...hotelPath, "travelerNames"],
        current.travelerNames,
        args.traveler_names,
      ),
    );
    changes.push(
      `travelers → ${args.traveler_names.length > 0 ? args.traveler_names.join(", ") : "(cleared)"}`,
    );
  }

  return { ops, changes, booking: merged };
}

export async function editHotel(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const hasEdit =
      args.check_in !== undefined ||
      args.check_out !== undefined ||
      args.confirmation_number !== undefined ||
      args.traveler_names !== undefined;
    if (!hasEdit) {
      throw new WanderlogValidationError(
        "Nothing to edit — supply at least one of check_in, check_out, confirmation_number, or traveler_names.",
      );
    }
    for (const [label, value] of [
      ["check_in", args.check_in],
      ["check_out", args.check_out],
    ] as const) {
      if (value !== undefined && !isValidDate(value)) {
        throw new WanderlogValidationError(`Invalid ${label}: "${value}". Use YYYY-MM-DD.`);
      }
    }

    const result = await submitOp(ctx, args.trip_key, async (entry, submit) => {
      const trip = entry.snapshot;
      const resolved = resolvePlaceRef(trip, args.hotel ?? "the hotel");

      if (resolved.kind === "none") {
        throw new WanderlogError(
          args.hotel
            ? `No hotel matching "${args.hotel}" found in "${trip.title}"`
            : `"${trip.title}" has no hotel booking to edit`,
          "hotel_not_found",
          {
            hint: "Use wanderlog_get_trip to see the trip's hotels, or wanderlog_add_hotel to add one.",
          },
        );
      }
      if (resolved.kind === "ambiguous") {
        const lines = resolved.candidates.map((c, i) => {
          const name = isPlaceBlock(c.block) ? c.block.place.name : `block #${c.block.id}`;
          return `  ${i + 1}. ${name} (${c.section.heading || "unscheduled"})`;
        });
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `"${args.hotel}" matches ${resolved.candidates.length} places:\n${lines.join("\n")}\n\nRe-call with a more specific name or an ordinal prefix (e.g. "1st ${args.hotel}").`,
              },
            ],
            isError: true,
          },
        };
      }

      const blockId = resolved.match.block.id;
      const located = findBlockById(trip, blockId);
      if (!located) throw new WanderlogError("Hotel moved or was removed", "stale_target");
      const block = assertBlockAtPath(
        trip,
        located.sectionIndex,
        located.blockIndex,
        blockId,
      );
      if (!isPlaceBlock(block)) {
        throw new WanderlogValidationError(
          `Block #${blockId} is a ${block.type}, not a hotel. Only place blocks carry a hotel booking.`,
        );
      }
      const inHotelsSection = located.section.type === "hotels";
      if (!block.hotel && !inHotelsSection) {
        throw new WanderlogValidationError(
          `"${block.place.name}" is a place in "${located.section.heading || "the itinerary"}", not a hotel booking. Use wanderlog_add_hotel to book a stay.`,
        );
      }

      const blockPath = [
        "itinerary",
        "sections",
        located.sectionIndex,
        "blocks",
        located.blockIndex,
      ];
      const { ops, changes, booking } = buildHotelEditOps(block, blockPath, args);
      if (ops.length === 0) {
        return {
          response: {
            content: [
              {
                type: "text" as const,
                text: `No changes — "${block.place.name}" already has those values.`,
              },
            ],
          },
        };
      }
      await submit(ops);

      // Verify against the post-submit snapshot: a silent no-op here would be
      // indistinguishable from success, and this is booking data.
      const after = findBlockById(entry.snapshot, blockId)?.block;
      const saved = (after as PlaceBlock | undefined)?.hotel;
      if (
        !saved ||
        (args.check_in !== undefined && saved.checkIn !== booking.checkIn) ||
        (args.check_out !== undefined && saved.checkOut !== booking.checkOut) ||
        (args.confirmation_number !== undefined &&
          saved.confirmationNumber !== booking.confirmationNumber) ||
        (args.traveler_names !== undefined &&
          JSON.stringify(saved.travelerNames ?? []) !==
            JSON.stringify(booking.travelerNames))
      ) {
        throw new WanderlogError(
          "Hotel edit could not be verified against the trip after submitting",
          "stale_target",
          { hint: "Re-read the trip with wanderlog_get_trip before retrying." },
        );
      }

      return { name: block.place.name, changes, booking, tripTitle: trip.title };
    });
    if ("response" in result && result.response) return result.response;

    const window =
      result.booking.checkIn && result.booking.checkOut
        ? ` Stay is now ${result.booking.checkIn} → ${result.booking.checkOut}.`
        : "";
    return {
      content: [
        {
          type: "text",
          text: `Updated ${result.name} in "${result.tripTitle}": ${result.changes.join(", ")}.${window}`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
