import { describe, expect, it } from "vitest";
import { resolvePlaceRef } from "../../src/resolvers/place-ref.ts";
import type { TripPlan } from "../../src/types.ts";
import { isPlaceBlock } from "../../src/types.ts";
import { mixedBlocksTrip } from "../fixtures/mixed-blocks-trip.ts";
import { queenstownTrip } from "../fixtures/queenstown-trip.ts";

describe("resolvePlaceRef", () => {
  it("resolves an exact place name on the queenstown fixture", () => {
    const result = resolvePlaceRef(queenstownTrip, "Queenstown Gardens");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.heading).toBe("Places to visit");
    expect(isPlaceBlock(result.match.block)).toBe(true);
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe("Queenstown Gardens");
    }
  });

  it("matches case-insensitively", () => {
    const result = resolvePlaceRef(queenstownTrip, "queenstown gardens");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe("Queenstown Gardens");
    }
  });

  it("matches a substring", () => {
    const result = resolvePlaceRef(queenstownTrip, "Gardens");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe("Queenstown Gardens");
    }
  });

  it("resolves 'the hotel' on the queenstown fixture", () => {
    const result = resolvePlaceRef(queenstownTrip, "the hotel");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.type).toBe("hotels");
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe(
        "Rendezvous Heritage Hotel Queenstown",
      );
    }
  });

  it("resolves 'the hotel' on the mixed-blocks fixture", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "the hotel");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.type).toBe("hotels");
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe(
        "Far East Village Hotel Tokyo, Asakusa",
      );
    }
  });

  it("resolves 'the flight' on the mixed-blocks fixture", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "the flight");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.type).toBe("flights");
    expect(result.match.block.type).toBe("flight");
    if (result.match.block.type === "flight") {
      expect(result.match.block.flightInfo?.number).toBe(890);
    }
  });

  it("resolves 'the train' on the mixed-blocks fixture", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "the train");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.type).toBe("transit");
    expect(result.match.block.type).toBe("train");
    if (result.match.block.type === "train") {
      expect(result.match.block.carrier).toBe("Odakyu Electric Railway");
    }
  });

  it("resolves a place by exact name on the mixed-blocks fixture", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "Sensō-ji");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.date).toBe("2025-11-13");
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe("Sensō-ji");
    }
  });

  it("resolves an ASCII ref against a macron'd name", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "Senso-ji");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    if (isPlaceBlock(result.match.block)) {
      expect(result.match.block.place.name).toBe("Sensō-ji");
    }
  });

  it("resolves a compound 'place on day N' reference", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "Sensō-ji on day 1");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    expect(result.match.section.date).toBe("2025-11-13");
  });

  it("returns none for a compound reference whose context excludes the match", () => {
    const result = resolvePlaceRef(mixedBlocksTrip, "Sensō-ji on day 2");
    expect(result.kind).toBe("none");
  });

  it("returns none for an empty reference", () => {
    expect(resolvePlaceRef(queenstownTrip, "").kind).toBe("none");
    expect(resolvePlaceRef(queenstownTrip, "   ").kind).toBe("none");
  });

  it("returns none for a reference that matches nothing", () => {
    const result = resolvePlaceRef(
      queenstownTrip,
      "nonexistent place name xyz123",
    );
    expect(result.kind).toBe("none");
  });

  it("returns ambiguous when a substring matches multiple places", () => {
    const fixture: TripPlan = {
      ...queenstownTrip,
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "placeList",
            heading: "Cafes",
            date: null,
            blocks: [
              {
                id: 1001,
                type: "place",
                place: {
                  name: "Vudu Cafe & Larder",
                  place_id: "ChIJaaaa",
                },
              },
              {
                id: 1002,
                type: "place",
                place: {
                  name: "Bespoke Cafe",
                  place_id: "ChIJbbbb",
                },
              },
            ],
          },
        ],
      },
    };

    const result = resolvePlaceRef(fixture, "cafe");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates.length).toBe(2);
    const names = result.candidates.map((c) =>
      isPlaceBlock(c.block) ? c.block.place.name : "",
    );
    expect(names).toContain("Vudu Cafe & Larder");
    expect(names).toContain("Bespoke Cafe");
  });

  it("returns the correct sectionIndex/blockIndex coordinates", () => {
    const result = resolvePlaceRef(queenstownTrip, "Queenstown Gardens");
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") return;
    const { sectionIndex, blockIndex } = result.match;
    const section = queenstownTrip.itinerary.sections[sectionIndex];
    expect(section).toBeDefined();
    const block = section!.blocks[blockIndex];
    expect(block).toBeDefined();
    if (block && isPlaceBlock(block)) {
      expect(block.place.name).toBe("Queenstown Gardens");
    }
  });
});

function transitTrip(): TripPlan {
  return {
    itinerary: {
      sections: [
        {
          id: 1,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [],
        },
        {
          id: 2,
          type: "transit",
          mode: "placeList",
          heading: "Transit",
          date: null,
          blocks: [
            { id: 10, type: "ferry", carrier: "CTM" },
            { id: 11, type: "bus", carrier: "FlixBus" },
          ],
        },
        {
          id: 3,
          type: "rentalCars",
          mode: "placeList",
          heading: "Rental cars",
          date: null,
          blocks: [{ id: 20, type: "rentalCar" }],
        },
      ],
    },
  } as unknown as TripPlan;
}

describe("resolvePlaceRef role keywords for transit/rental", () => {
  it("resolves 'the ferry' and 'the bus' to the right transit block", () => {
    const trip = transitTrip();
    const ferry = resolvePlaceRef(trip, "the ferry");
    expect(ferry.kind).toBe("unique");
    expect(ferry.kind === "unique" && ferry.match.block.id).toBe(10);
    const bus = resolvePlaceRef(trip, "the bus");
    expect(bus.kind === "unique" && bus.match.block.id).toBe(11);
  });
  it("resolves 'the rental car' and 'the car' to the rentalCars block", () => {
    const trip = transitTrip();
    for (const ref of ["the rental car", "the car"]) {
      const r = resolvePlaceRef(trip, ref);
      expect(r.kind === "unique" && r.match.block.id).toBe(20);
    }
  });
});
