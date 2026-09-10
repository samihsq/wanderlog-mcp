import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addHotel } from "../../src/tools/add-hotel.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import {
  placeMatchScore,
  tripSearchRadiusM,
} from "../../src/tools/shared.ts";
import type { Geo, PlaceData, PlaceSuggestion, TripPlan } from "../../src/types.ts";

const TOKYO: Geo = {
  id: 1,
  name: "Tokyo",
  latitude: 35.6762,
  longitude: 139.6503,
};

function suggestion(main: string, secondary: string, placeId: string): PlaceSuggestion {
  return {
    description: `${main}, ${secondary}`,
    place_id: placeId,
    structured_formatting: { main_text: main, secondary_text: secondary },
  };
}

type AutocompleteCall = { input: string; radius: number };

function makeCtx(opts: {
  /** One entry per autocomplete call, in order. */
  predictions: PlaceSuggestion[][];
  details: Record<string, PlaceData>;
  /** Radii the fake API rejects, standing in for a proxy that caps radius. */
  rejectRadiiOver?: number;
}) {
  const trip = {
    title: "Tokyo trip",
    itinerary: {
      sections: [
        {
          id: 10,
          type: "hotels",
          mode: "placeList",
          heading: "Hotels and lodging",
          date: null,
          blocks: [],
        },
        {
          id: 20,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [],
        },
      ],
    },
  } as unknown as TripPlan;

  const entry = { snapshot: trip, version: 1, geos: [TOKYO] };
  const autocompleteCalls: AutocompleteCall[] = [];
  const detailCalls: string[] = [];
  const submitted: Json0Op[][] = [];
  let call = 0;

  const client = {
    isSubscribed: true,
    version: 1,
    async submit(ops: Json0Op[]) {
      submitted.push(ops);
      this.version++;
    },
  };

  const ctx = {
    userId: 999,
    pool: { get: () => client },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
    rest: {
      async searchPlacesAutocomplete(args: { input: string; radius: number }) {
        autocompleteCalls.push({ input: args.input, radius: args.radius });
        if (opts.rejectRadiiOver !== undefined && args.radius > opts.rejectRadiiOver) {
          throw new Error(`radius ${args.radius} out of range`);
        }
        return opts.predictions[call++] ?? [];
      },
      async getPlaceDetails(placeId: string) {
        detailCalls.push(placeId);
        const detail = opts.details[placeId];
        if (!detail) throw new Error(`no fixture detail for ${placeId}`);
        return detail;
      },
      async getPlacePhotos() {
        return [];
      },
    },
  } as unknown as AppContext;

  return { ctx, entry, autocompleteCalls, detailCalls, submitted };
}

describe("placeMatchScore", () => {
  it("scores an exact match 1 regardless of case, diacritics or punctuation", () => {
    expect(placeMatchScore("Sensō-ji", "Sensō-ji")).toBe(1);
    expect(placeMatchScore("senso ji", "Sensō-ji")).toBe(1);
    expect(placeMatchScore("SENSOJI", "Sensō-ji")).toBe(1);
  });

  it("scores the real-world wrong resolutions below the confidence floor", () => {
    // Live damage: a request for a clothing store at a Jingumae address came
    // back as an unrelated office building at the same address.
    expect(
      placeMatchScore("Chicago Harajuku 6-31-15 Jingumae", "アコルデ神宮前"),
    ).toBeLessThan(0.6);
  });

  it("prefers the tighter name over one padded with extra words", () => {
    const tight = placeMatchScore("Sensō-ji", "Sensō-ji Temple");
    const padded = placeMatchScore("Sensō-ji", "Sensō-ji Main Hall Hozomon Gate");
    expect(tight).toBeGreaterThan(padded);
  });

  it("scores two sibling branches of one chain equally, so neither wins", () => {
    const instruments = placeMatchScore(
      "2nd STREET Shimokitazawa",
      "2nd STREET Shimokitazawa Musical Instruments",
    );
    const clothing = placeMatchScore(
      "2nd STREET Shimokitazawa",
      "2nd STREET Shimokitazawa Clothing Store",
    );
    expect(Math.abs(instruments - clothing)).toBeLessThan(0.1);
  });

  it("ignores bare street numbers, which match every business at an address", () => {
    expect(placeMatchScore("6-31-15", "Some Office Building")).toBe(0);
  });
});

describe("tripSearchRadiusM", () => {
  it("defaults well past the old 15km, so day trips are in reach", () => {
    expect(tripSearchRadiusM(undefined)).toBeGreaterThanOrEqual(100_000);
    expect(tripSearchRadiusM([TOKYO])).toBeGreaterThanOrEqual(100_000);
  });

  it("widens to cover a large geo's own bounds", () => {
    const japan: Geo = {
      ...TOKYO,
      name: "Japan",
      bounds: [129.5, 31.0, 145.8, 45.5],
    };
    expect(tripSearchRadiusM([japan])).toBeGreaterThan(tripSearchRadiusM([TOKYO]));
  });

  it("ignores bounds that are not lat/lng rather than deriving nonsense", () => {
    const broken: Geo = { ...TOKYO, bounds: [1000, 2000, 3000, 4000] };
    expect(tripSearchRadiusM([broken])).toBe(tripSearchRadiusM([TOKYO]));
  });
});

describe("addPlace place resolution", () => {
  it("resolves an exact match in a single search, and echoes name + address", async () => {
    const detail: PlaceData = {
      name: "Sensō-ji",
      place_id: "sensoji",
      formatted_address: "2-3-1 Asakusa, Taito City, Tokyo",
      geometry: { location: { lat: 35.7148, lng: 139.7967 } },
    };
    const { ctx, autocompleteCalls, detailCalls, submitted } = makeCtx({
      predictions: [
        [
          suggestion("Sensō-ji", "Asakusa, Tokyo", "sensoji"),
          suggestion("Sensō-ji Gojunoto Pagoda Ticket Office", "Asakusa, Tokyo", "pagoda"),
        ],
      ],
      details: { sensoji: detail },
    });

    const res = await addPlace(ctx, { trip_key: "trip", place: "Sensō-ji" });

    expect(res.isError).not.toBe(true);
    expect(autocompleteCalls).toHaveLength(1);
    expect(detailCalls).toEqual(["sensoji"]);
    expect(submitted).toHaveLength(1);
    expect(res.content[0]!.text).toContain("Sensō-ji");
    expect(res.content[0]!.text).toContain("2-3-1 Asakusa, Taito City, Tokyo");
  });

  it("returns candidates and writes nothing when the top hit does not match the request", async () => {
    const { ctx, detailCalls, submitted } = makeCtx({
      predictions: [
        [
          suggestion("アコルデ神宮前", "6-31-15 Jingumae, Shibuya City, Tokyo", "office"),
          suggestion("Jingumae Tower Building", "6-35-3 Jingumae, Shibuya City", "tower"),
        ],
      ],
      details: {
        office: {
          name: "アコルデ神宮前",
          place_id: "office",
          formatted_address: "6-31-15 Jingumae, Shibuya City, Tokyo",
        },
        tower: {
          name: "Jingumae Tower Building",
          place_id: "tower",
          formatted_address: "6-35-3 Jingumae, Shibuya City, Tokyo",
        },
      },
    });

    const res = await addPlace(ctx, {
      trip_key: "trip",
      place: "Chicago Harajuku 6-31-15 Jingumae",
    });

    expect(res.isError).toBe(true);
    expect(submitted).toHaveLength(0);
    const text = res.content[0]!.text;
    expect(text).toMatch(/\d\. アコルデ神宮前/);
    expect(text).toMatch(/\d\. Jingumae Tower Building/);
    expect(text).toContain("Nothing was added");
    // A hopeless top hit must not cost more than the one details lookup used
    // to give it a last chance on its full record.
    expect(detailCalls.length).toBeLessThanOrEqual(1);
  });

  it("returns candidates without a details lookup when the top two are effectively tied", async () => {
    const { ctx, detailCalls, submitted } = makeCtx({
      predictions: [
        [
          suggestion(
            "2nd STREET Shimokitazawa Musical Instruments",
            "Kitazawa, Setagaya City, Tokyo",
            "instruments",
          ),
          suggestion(
            "2nd STREET Shimokitazawa Clothing Store",
            "Kitazawa, Setagaya City, Tokyo",
            "clothing",
          ),
        ],
      ],
      details: {},
    });

    const res = await addPlace(ctx, {
      trip_key: "trip",
      place: "2nd STREET Shimokitazawa",
    });

    expect(res.isError).toBe(true);
    expect(submitted).toHaveLength(0);
    expect(detailCalls).toEqual([]);
    expect(res.content[0]!.text).toContain("about equally well");
    expect(res.content[0]!.text).toContain("1. 2nd STREET Shimokitazawa Musical Instruments");
  });

  it("resolves a day-trip place beyond the old 15km radius", async () => {
    const detail: PlaceData = {
      name: "Yuigahama Beach",
      place_id: "yuigahama",
      formatted_address: "Yuigahama, Kamakura, Kanagawa",
      geometry: { location: { lat: 35.3089, lng: 139.5316 } },
    };
    const { ctx, autocompleteCalls, submitted } = makeCtx({
      predictions: [[suggestion("Yuigahama Beach", "Kamakura, Kanagawa", "yuigahama")]],
      details: { yuigahama: detail },
    });

    const res = await addPlace(ctx, {
      trip_key: "trip",
      place: "Yuigahama Beach",
      day: undefined,
    });

    expect(res.isError).not.toBe(true);
    expect(submitted).toHaveLength(1);
    expect(autocompleteCalls[0]!.radius).toBeGreaterThan(15_000);
    expect(res.content[0]!.text).toContain("Yuigahama Beach");
  });

  it("retries without location bias when the biased search finds nothing", async () => {
    const detail: PlaceData = {
      name: "Shisui Premium Outlets",
      place_id: "shisui",
      formatted_address: "2-4-1 Iizumi, Shisui, Inba District, Chiba",
      geometry: { location: { lat: 35.7167, lng: 140.2667 } },
    };
    const { ctx, autocompleteCalls, submitted } = makeCtx({
      predictions: [[], [suggestion("Shisui Premium Outlets", "Shisui, Chiba", "shisui")]],
      details: { shisui: detail },
    });

    const res = await addPlace(ctx, {
      trip_key: "trip",
      place: "Shisui Premium Outlets",
    });

    expect(res.isError).not.toBe(true);
    expect(submitted).toHaveLength(1);
    expect(autocompleteCalls).toHaveLength(2);
    // The fallback drops the bias rather than nudging the radius.
    expect(autocompleteCalls[1]!.radius).toBeGreaterThan(autocompleteCalls[0]!.radius * 10);
    const text = res.content[0]!.text;
    expect(text).toContain("Shisui Premium Outlets");
    expect(text).toMatch(/Resolved \d+ km from the trip center/);
    expect(text).toContain("without location bias");
  });

  it("degrades to the legacy 15km radius if the API rejects a wide one", async () => {
    const detail: PlaceData = {
      name: "Tokyo Skytree",
      place_id: "skytree",
      formatted_address: "1-1-2 Oshiage, Sumida City, Tokyo",
      geometry: { location: { lat: 35.7101, lng: 139.8107 } },
    };
    const { ctx, autocompleteCalls, submitted } = makeCtx({
      predictions: [[suggestion("Tokyo Skytree", "Sumida City, Tokyo", "skytree")]],
      details: { skytree: detail },
      rejectRadiiOver: 15_000,
    });

    const res = await addPlace(ctx, { trip_key: "trip", place: "Tokyo Skytree" });

    expect(res.isError).not.toBe(true);
    expect(submitted).toHaveLength(1);
    expect(autocompleteCalls.map((c) => c.radius)).toEqual([
      autocompleteCalls[0]!.radius,
      15_000,
    ]);
    expect(autocompleteCalls[0]!.radius).toBeGreaterThan(15_000);
  });

  it("says nothing about distance for a place at the trip center", async () => {
    const detail: PlaceData = {
      name: "Tokyo Station",
      place_id: "tokyostation",
      formatted_address: "1 Chome Marunouchi, Chiyoda City, Tokyo",
      geometry: { location: { lat: 35.6812, lng: 139.7671 } },
    };
    const { ctx } = makeCtx({
      predictions: [[suggestion("Tokyo Station", "Chiyoda City, Tokyo", "tokyostation")]],
      details: { tokyostation: detail },
    });

    const res = await addPlace(ctx, { trip_key: "trip", place: "Tokyo Station" });

    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).not.toContain("from the trip center");
  });
});

describe("addHotel place resolution", () => {
  const booking = { check_in: "2026-05-03", check_out: "2026-05-06" };

  it("echoes the resolved hotel name and address on success", async () => {
    const detail: PlaceData = {
      name: "Park Hyatt Tokyo",
      place_id: "parkhyatt",
      formatted_address: "3-7-1-2 Nishishinjuku, Shinjuku City, Tokyo",
      geometry: { location: { lat: 35.6857, lng: 139.6907 } },
    };
    const { ctx, autocompleteCalls, submitted } = makeCtx({
      predictions: [[suggestion("Park Hyatt Tokyo", "Nishishinjuku, Tokyo", "parkhyatt")]],
      details: { parkhyatt: detail },
    });

    const res = await addHotel(ctx, { trip_key: "trip", hotel: "Park Hyatt Tokyo", ...booking });

    expect(res.isError).not.toBe(true);
    expect(submitted).toHaveLength(1);
    expect(autocompleteCalls[0]!.radius).toBeGreaterThan(15_000);
    expect(res.content[0]!.text).toContain("3-7-1-2 Nishishinjuku, Shinjuku City, Tokyo");
    expect(res.content[0]!.text).toContain("check-in 2026-05-03");
  });

  it("returns candidates and books nothing when the match is not plausible", async () => {
    const { ctx, submitted } = makeCtx({
      predictions: [
        [
          suggestion("Shinjuku Granbell Hotel", "Kabukicho, Shinjuku City", "granbell"),
          suggestion("Hotel Gracery Shinjuku", "Kabukicho, Shinjuku City", "gracery"),
        ],
      ],
      details: {
        granbell: { name: "Shinjuku Granbell Hotel", place_id: "granbell" },
      },
    });

    const res = await addHotel(ctx, {
      trip_key: "trip",
      hotel: "the cheap hostel near the train station",
      ...booking,
    });

    expect(res.isError).toBe(true);
    expect(submitted).toHaveLength(0);
    expect(res.content[0]!.text).toContain("1. Shinjuku Granbell Hotel");
    expect(res.content[0]!.text).toContain("wanderlog_add_hotel");
  });
});
