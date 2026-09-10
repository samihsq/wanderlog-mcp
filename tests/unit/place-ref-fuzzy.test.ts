import { describe, expect, it } from "vitest";
import { resolvePlaceRef } from "../../src/resolvers/place-ref.ts";
import type { TripPlan } from "../../src/types.ts";
import { isPlaceBlock } from "../../src/types.ts";

/**
 * Names taken from a real Tokyo trip: vintage shops whose stored names carry a
 * neighbourhood qualifier that a spoken ref adds or drops at will, plus two
 * temple names with macrons.
 */
function tokyoTrip(names: string[]): TripPlan {
  return {
    itinerary: {
      sections: [
        {
          id: 1,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: names.map((name, i) => ({
            id: 1000 + i,
            type: "place",
            place: { name, place_id: `ChIJ_fixture_${i}` },
          })),
        },
      ],
    },
  } as unknown as TripPlan;
}

function matchedName(trip: TripPlan, ref: string): string | null {
  const result = resolvePlaceRef(trip, ref);
  if (result.kind !== "unique") return null;
  return isPlaceBlock(result.match.block)
    ? (result.match.block.place.name ?? null)
    : null;
}

describe("resolvePlaceRef reverse containment", () => {
  const trip = tokyoTrip([
    "BerBerJin",
    "Chicago Harajuku",
    "2nd Street Shimokitazawa",
    "Harajuku Chicago Shimokitazawa",
  ]);

  it("matches a ref that adds a neighbourhood the stored name omits", () => {
    expect(matchedName(trip, "BerBerJin Harajuku")).toBe("BerBerJin");
  });

  it("matches a ref that drops the neighbourhood the stored name carries", () => {
    expect(matchedName(trip, "2nd Street")).toBe(null); // ordinal reading, see below
    expect(matchedName(trip, "Street Shimokitazawa")).toBe(
      "2nd Street Shimokitazawa",
    );
  });

  it("still resolves a name that begins with an ordinal", () => {
    expect(matchedName(trip, "2nd Street Shimokitazawa")).toBe(
      "2nd Street Shimokitazawa",
    );
  });

  it("combines with a day context", () => {
    const dated = {
      itinerary: {
        sections: [
          {
            id: 1,
            type: "normal",
            mode: "dayPlan",
            heading: "Day 1",
            date: "2025-11-13",
            blocks: [
              {
                id: 1,
                type: "place",
                place: { name: "BerBerJin", place_id: "ChIJ_a" },
              },
            ],
          },
          {
            id: 2,
            type: "normal",
            mode: "dayPlan",
            heading: "Day 2",
            date: "2025-11-14",
            blocks: [],
          },
        ],
      },
    } as unknown as TripPlan;
    expect(matchedName(dated, "BerBerJin Harajuku on day 1")).toBe("BerBerJin");
    expect(resolvePlaceRef(dated, "BerBerJin Harajuku on day 2").kind).toBe(
      "none",
    );
  });

  it("ignores stored names too short to be more than a coincidence", () => {
    const short = tokyoTrip(["Bar", "Yoyogi Park"]);
    expect(resolvePlaceRef(short, "Sushi Bar Ginza").kind).toBe("none");
  });

  it("only matches whole words, not fragments of one", () => {
    const fragment = tokyoTrip(["Fuji"]);
    expect(resolvePlaceRef(fragment, "Kichijoji station").kind).toBe("none");
  });
});

describe("resolvePlaceRef diacritic folding", () => {
  const trip = tokyoTrip(["Sensō-ji", "Kichijōji", "Kōenji"]);

  it("matches an ASCII ref against a macron'd name", () => {
    expect(matchedName(trip, "Senso-ji")).toBe("Sensō-ji");
    expect(matchedName(trip, "Kichijoji")).toBe("Kichijōji");
    expect(matchedName(trip, "koenji")).toBe("Kōenji");
  });

  it("still matches when the ref carries the diacritics", () => {
    expect(matchedName(trip, "Sensō-ji")).toBe("Sensō-ji");
  });

  it("folds diacritics inside a fuzzy match too", () => {
    expect(matchedName(trip, "Sensoji Temple Asakusa")).toBe(null);
    expect(matchedName(trip, "Senso-ji Asakusa")).toBe("Sensō-ji");
  });
});

describe("resolvePlaceRef token overlap", () => {
  const trip = tokyoTrip([
    "Chicago Harajuku",
    "Harajuku Chicago Shimokitazawa",
    "BerBerJin",
  ]);

  it("matches a reordered multi-word ref", () => {
    const single = tokyoTrip(["Chicago Harajuku", "BerBerJin"]);
    expect(matchedName(single, "Harajuku Chicago")).toBe("Chicago Harajuku");
  });

  it("reports several overlap candidates as ambiguous", () => {
    // No stored name contains this word order, so the tighter stages pass and
    // overlap hits both Chicago shops.
    const result = resolvePlaceRef(trip, "Shimokitazawa Harajuku Chicago");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates.length).toBe(2);
    const names = result.candidates.map((c) =>
      isPlaceBlock(c.block) ? c.block.place.name : "",
    );
    expect(names).toContain("Chicago Harajuku");
    expect(names).toContain("Harajuku Chicago Shimokitazawa");
  });

  it("does not let a filler-word ref match everything", () => {
    const parks = tokyoTrip(["Yoyogi Park", "Ueno Park", "Shinjuku Gyoen"]);
    expect(resolvePlaceRef(parks, "the park").kind).toBe("none");
    expect(resolvePlaceRef(parks, "a park in the city").kind).toBe("none");
  });

  it("requires every word of the shorter side, not just one", () => {
    expect(resolvePlaceRef(trip, "Chicago Ginza").kind).toBe("none");
  });
});

describe("resolvePlaceRef stage priority", () => {
  const trip = tokyoTrip(["BerBerJin", "BerBerJin Harajuku", "Chicago Harajuku"]);

  it("prefers an exact match over any fuzzy candidate", () => {
    expect(matchedName(trip, "BerBerJin Harajuku")).toBe("BerBerJin Harajuku");
    expect(matchedName(trip, "berberjin harajuku")).toBe("BerBerJin Harajuku");
  });

  it("prefers a substring match over reverse containment", () => {
    // "harajuku" is a substring of two stored names, so the looser stages that
    // would also have hit "BerBerJin" never run.
    const result = resolvePlaceRef(trip, "Harajuku");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.candidates.length).toBe(2);
  });

  it("keeps a previously unique ref unique", () => {
    expect(matchedName(trip, "BerBerJin")).toBe("BerBerJin");
    expect(matchedName(trip, "Chicago")).toBe("Chicago Harajuku");
  });
});
