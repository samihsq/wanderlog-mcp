import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { PlaceData } from "../types.js";
import {
  buildPlaceAmbiguityText,
  buildPlaceBlock,
  farFromCenterNote,
  findHotelsSection,
  findTripCenter,
  requireUserId,
  resolvePlaceQuery,
  submitOp,
  tripSearchRadiusM,
} from "./shared.js";

export const addHotelInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the hotel to."),
  hotel: z
    .string()
    .min(1)
    .describe(
      "Hotel name to search for. Examples: 'Park Hyatt Tokyo', 'Hoshinoya Kyoto'. Matched against Google Places, biased toward the trip's destination but not restricted to it. Be specific: if the best match is not clearly the hotel you named, or two matches are equally good, the tool adds nothing and returns candidates for you to choose from.",
    ),
  check_in: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Check-in date, YYYY-MM-DD."),
  check_out: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Check-out date, YYYY-MM-DD. Must be after check_in."),
};

export const addHotelDescription = `
Adds a hotel booking to a Wanderlog trip with check-in and check-out dates. If the trip does
not yet have a "Hotels and lodging" section, one is created automatically.

Returns confirmation with the resolved hotel name, its full address, and the booking window —
check the address, because a name alone can hide a wrong match.
`.trim();

type Args = {
  trip_key: string;
  hotel: string;
  check_in: string;
  check_out: string;
};

export async function addHotel(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (args.check_out <= args.check_in) {
      throw new WanderlogValidationError(
        `check_out (${args.check_out}) must be after check_in (${args.check_in})`,
      );
    }

    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const center = findTripCenter(entry.snapshot, entry.geos);
    if (!center) {
      throw new WanderlogValidationError(
        `Cannot add hotel to "${entry.snapshot.title}" because no location anchor is available`,
        "This trip has no associated geo and no existing places.",
      );
    }

    const resolution = await resolvePlaceQuery(
      ctx,
      args.hotel,
      center,
      tripSearchRadiusM(entry.geos),
    );
    if (resolution.kind === "none") {
      throw new WanderlogError(
        `No hotel found matching "${args.hotel}" near ${entry.snapshot.title}`,
        "hotel_not_found",
        "Try a more specific name or check the spelling.",
      );
    }
    // Booking the wrong building is worse than asking, so leave the trip
    // untouched and let the caller pick.
    if (resolution.kind === "ambiguous") {
      return {
        content: [
          {
            type: "text",
            text: buildPlaceAmbiguityText({
              query: args.hotel,
              tripTitle: entry.snapshot.title,
              candidates: resolution.candidates,
              reason: resolution.reason,
              toolName: "wanderlog_add_hotel",
              argName: "hotel",
            }),
          },
        ],
        isError: true,
      };
    }
    const detail: PlaceData = resolution.detail;
    const imageKeys = await ctx.rest.getPlacePhotos(detail);

    const tripTitle = await submitOp(ctx, args.trip_key, async (lockedEntry, submit) => {
      const trip = lockedEntry.snapshot;
      const block = buildPlaceBlock(detail, userId, {
        hotel: {
          checkIn: args.check_in,
          checkOut: args.check_out,
          travelerNames: [],
          confirmationNumber: null,
        },
      });
      const existing = findHotelsSection(trip);
      const sectionIndex = existing ? existing.index : Math.min(1, trip.itinerary.sections.length);
      const blockPath = existing
        ? ["itinerary", "sections", sectionIndex, "blocks", existing.section.blocks.length]
        : ["itinerary", "sections", sectionIndex, "blocks", 0];
      const ops: Json0Op[] = existing
        ? [{ p: blockPath, li: block }]
        : [
            {
              p: ["itinerary", "sections", sectionIndex],
              li: {
                id: Math.floor(Math.random() * 1_000_000_000),
                type: "hotels",
                mode: "placeList",
                heading: "Hotels and lodging",
                date: null,
                blocks: [block],
                placeMarkerColor: "#7045af",
                placeMarkerIcon: "bed",
                text: { ops: [{ insert: "\n" }] },
              },
            },
          ];
      if (imageKeys.length > 0) {
        ops.push({ p: [...blockPath, "imageKeys"], oi: imageKeys });
      }
      await submit(ops);
      return trip.title;
    });

    // Echo the resolved address, not just the name: it is the only thing in the
    // transcript that makes a wrong-but-plausible match visible after the write.
    const where = detail.formatted_address ? ` (${detail.formatted_address})` : "";
    const parts = [
      `Added ${detail.name}${where} to "${tripTitle}" · check-in ${args.check_in} → check-out ${args.check_out}.`,
    ];
    const far = farFromCenterNote(resolution.distanceKm, resolution.usedUnbiasedSearch);
    if (far) parts.push(far);
    return { content: [{ type: "text", text: parts.join(" ") }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
