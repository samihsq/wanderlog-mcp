import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addNote } from "../../src/tools/add-note.ts";
import { addPlace } from "../../src/tools/add-place.ts";
import { findDuplicatePlace } from "../../src/tools/duplicate-guard.ts";
import type {
  Block,
  Geo,
  PlaceData,
  PlaceSuggestion,
  Section,
  TripPlan,
} from "../../src/types.ts";

const TOKYO: Geo = { id: 1, name: "Tokyo", latitude: 35.6762, longitude: 139.6503 };

const SENSOJI: PlaceData = {
  name: "Sensō-ji",
  place_id: "sensoji",
  formatted_address: "2-3-1 Asakusa, Taito City, Tokyo",
  geometry: { location: { lat: 35.7148, lng: 139.7967 } },
};

function suggestion(main: string, secondary: string, placeId: string): PlaceSuggestion {
  return {
    description: `${main}, ${secondary}`,
    place_id: placeId,
    structured_formatting: { main_text: main, secondary_text: secondary },
  };
}

function place(id: number, name: string, extras: Record<string, unknown> = {}): Block {
  return { id, type: "place", place: { name, place_id: `p${id}` }, ...extras } as Block;
}

function twoDayTrip(): TripPlan {
  return {
    id: 1,
    key: "T",
    title: "Trip to Tokyo",
    userId: 3656632,
    privacy: "private",
    startDate: "2026-09-12",
    endDate: "2026-09-13",
    days: 2,
    schemaVersion: 2,
    itinerary: {
      sections: [
        {
          id: 10,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [],
        },
        { id: 20, type: "normal", mode: "dayPlan", heading: "", date: "2026-09-12", blocks: [] },
        { id: 30, type: "normal", mode: "dayPlan", heading: "", date: "2026-09-13", blocks: [] },
      ],
    },
  } as unknown as TripPlan;
}

/** Every autocomplete call returns the same predictions, so a retry resolves alike. */
function makePlaceCtx(trip: TripPlan) {
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [TOKYO] };
  const submitted: Json0Op[][] = [];
  const client = {
    isSubscribed: true,
    version: 1,
    async submit(ops: Json0Op[]) {
      submitted.push(ops);
      this.version++;
    },
  };
  const ctx = {
    userId: 3656632,
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
      async searchPlacesAutocomplete() {
        return [suggestion("Sensō-ji", "Asakusa, Tokyo", "sensoji")];
      },
      async getPlaceDetails() {
        return SENSOJI;
      },
      async getPlacePhotos() {
        return [];
      },
    },
  } as unknown as AppContext;
  return { ctx, submitted, snapshot: () => entry.snapshot };
}

function makeNoteCtx(trip: TripPlan) {
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [TOKYO] };
  const submitted: Json0Op[][] = [];
  const ctx = {
    userId: 3656632,
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submitted.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, submitted, snapshot: () => entry.snapshot };
}

function blocksOn(trip: TripPlan, sectionIndex: number): Block[] {
  return trip.itinerary.sections[sectionIndex]!.blocks;
}

describe("addPlace duplicate guard", () => {
  it("treats an identical re-add as a no-op and says where the place already is", async () => {
    const { ctx, submitted, snapshot } = makePlaceCtx(twoDayTrip());
    const args = { trip_key: "T", place: "Sensō-ji", day: "day 1", start_time: "08:30" };

    const first = await addPlace(ctx, args);
    expect(first.isError).not.toBe(true);
    const opsAfterFirst = submitted.length;

    const second = await addPlace(ctx, args);

    // Success-shaped: the trip already says what was asked, so this is not a failure.
    expect(second.isError).toBeUndefined();
    expect(second.content[0]!.text).toContain("Sensō-ji is already on day 2026-09-12 at 08:30");
    expect(second.content[0]!.text).toContain("nothing added");
    expect(submitted).toHaveLength(opsAfterFirst);
    expect(blocksOn(snapshot(), 1)).toHaveLength(1);
  });

  it("adds the same place again at a different time on the same day", async () => {
    const { ctx, snapshot } = makePlaceCtx(twoDayTrip());
    await addPlace(ctx, { trip_key: "T", place: "Sensō-ji", day: "day 1", start_time: "08:30" });

    const second = await addPlace(ctx, {
      trip_key: "T",
      place: "Sensō-ji",
      day: "day 1",
      start_time: "20:00",
    });

    expect(second.isError).not.toBe(true);
    expect(second.content[0]!.text).toContain("Added Sensō-ji");
    expect(blocksOn(snapshot(), 1)).toHaveLength(2);
  });

  it("adds the same place at the same time on a different day", async () => {
    const { ctx, snapshot } = makePlaceCtx(twoDayTrip());
    await addPlace(ctx, { trip_key: "T", place: "Sensō-ji", day: "day 1", start_time: "08:30" });

    const second = await addPlace(ctx, {
      trip_key: "T",
      place: "Sensō-ji",
      day: "day 2",
      start_time: "08:30",
    });

    expect(second.isError).not.toBe(true);
    expect(blocksOn(snapshot(), 1)).toHaveLength(1);
    expect(blocksOn(snapshot(), 2)).toHaveLength(1);
  });

  it("treats an untimed re-add of an untimed place as a duplicate", async () => {
    const { ctx, snapshot } = makePlaceCtx(twoDayTrip());
    await addPlace(ctx, { trip_key: "T", place: "Sensō-ji", day: "day 1" });

    const second = await addPlace(ctx, { trip_key: "T", place: "Sensō-ji", day: "day 1" });

    expect(second.isError).toBeUndefined();
    expect(second.content[0]!.text).toContain("is already on day 2026-09-12");
    expect(second.content[0]!.text).not.toContain(" at ");
    expect(blocksOn(snapshot(), 1)).toHaveLength(1);
  });

  it("still writes to the sections that do not already hold the place", async () => {
    const trip = twoDayTrip();
    trip.itinerary.sections[1]!.blocks.push(
      place(101, "Sensō-ji", { place: SENSOJI, startTime: "08:30" }),
    );
    const { ctx, snapshot } = makePlaceCtx(trip);

    const res = await addPlace(ctx, {
      trip_key: "T",
      place: "Sensō-ji",
      day: "day 1",
      section: "Places to visit",
      start_time: "08:30",
    });

    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).toContain('section "Places to visit"');
    expect(res.content[0]!.text).toContain("not added there again");
    expect(blocksOn(snapshot(), 0)).toHaveLength(1);
    expect(blocksOn(snapshot(), 1)).toHaveLength(1);
  });
});

describe("findDuplicatePlace", () => {
  function section(blocks: Block[]): Section {
    return { id: 1, type: "normal", mode: "dayPlan", heading: "", date: null, blocks } as Section;
  }

  it("falls back to a normalized name when a block carries no place_id", () => {
    const untagged = { id: 7, type: "place", place: { name: "senso ji" } } as unknown as Block;
    expect(findDuplicatePlace(section([untagged]), SENSOJI)).toBeTruthy();
  });

  it("trusts place_id over the name when both sides have one", () => {
    const sameName = place(8, "Sensō-ji");
    expect(findDuplicatePlace(section([sameName]), SENSOJI)).toBeUndefined();
  });

  it("ignores non-place blocks and empty times alike", () => {
    const note = { id: 9, type: "note", text: { ops: [{ insert: "Sensō-ji\n" }] } } as Block;
    const blank = place(10, "Sensō-ji", { place: SENSOJI, startTime: "" });
    expect(findDuplicatePlace(section([note, blank]), SENSOJI)).toBeTruthy();
    expect(findDuplicatePlace(section([note, blank]), SENSOJI, "08:30")).toBeUndefined();
  });
});

describe("addNote duplicate guard", () => {
  function noteTrip(): TripPlan {
    const trip = twoDayTrip();
    trip.itinerary.sections[1]!.blocks.push(
      place(101, "Omoide Yokocho Memory Lane"),
      place(102, "Kagurazaka"),
    );
    return trip;
  }

  it("treats an identical note as a no-op", async () => {
    const { ctx, submitted, snapshot } = makeNoteCtx(noteTrip());
    const args = { trip_key: "T", text: "Cash only past 9pm.", day: "2026-09-12" };

    await addNote(ctx, args);
    const opsAfterFirst = submitted.length;
    const second = await addNote(ctx, args);

    expect(second.isError).toBeUndefined();
    expect(second.content[0]!.text).toContain("An identical note is already in day 2026-09-12");
    expect(second.content[0]!.text).toContain("nothing added");
    expect(submitted).toHaveLength(opsAfterFirst);
    expect(blocksOn(snapshot(), 1).filter((b) => b.type === "note")).toHaveLength(1);
  });

  it("compares resolved text, so markdown and plain forms of one note are the same note", async () => {
    const { ctx, snapshot } = makeNoteCtx(noteTrip());
    await addNote(ctx, {
      trip_key: "T",
      text: "**Cash only** past 9pm.",
      day: "2026-09-12",
    });

    const plain = await addNote(ctx, {
      trip_key: "T",
      text: "Cash only past 9pm.",
      day: "2026-09-12",
      format: "plain" as const,
    });
    const markdown = await addNote(ctx, {
      trip_key: "T",
      text: "*Cash only* past 9pm.",
      day: "2026-09-12",
    });

    expect(plain.content[0]!.text).toContain("An identical note is already in");
    expect(markdown.content[0]!.text).toContain("An identical note is already in");
    expect(blocksOn(snapshot(), 1).filter((b) => b.type === "note")).toHaveLength(1);
  });

  it("still adds a note whose text differs only past the trimmed edges", async () => {
    const { ctx, snapshot } = makeNoteCtx(noteTrip());
    await addNote(ctx, { trip_key: "T", text: "Cash only past 9pm.", day: "2026-09-12" });

    const different = await addNote(ctx, {
      trip_key: "T",
      text: "Cash only past 9pm. Bring coins.",
      day: "2026-09-12",
    });

    expect(different.isError).not.toBe(true);
    expect(blocksOn(snapshot(), 1).filter((b) => b.type === "note")).toHaveLength(2);
  });

  it("checks the anchor's section when 'after' is given, wherever the anchor sits", async () => {
    const { ctx, snapshot } = makeNoteCtx(noteTrip());
    const text = "10 min walk downhill from here.";

    const first = await addNote(ctx, { trip_key: "T", text, after: "Kagurazaka" });
    expect(first.isError).toBeUndefined();

    // A different anchor in the same section is still the same section, so the
    // second write would be a duplicate rather than a repositioning.
    const second = await addNote(ctx, {
      trip_key: "T",
      text,
      after: "Omoide Yokocho Memory Lane",
    });

    expect(second.isError).toBeUndefined();
    expect(second.content[0]!.text).toContain("An identical note is already in day 2026-09-12");
    expect(blocksOn(snapshot(), 1).filter((b) => b.type === "note")).toHaveLength(1);
  });

  it("does not let a note in another section block an anchored insert", async () => {
    const { ctx, snapshot } = makeNoteCtx(noteTrip());
    const text = "10 min walk downhill from here.";

    await addNote(ctx, { trip_key: "T", text, section: "Places to visit" });
    const anchored = await addNote(ctx, { trip_key: "T", text, after: "Kagurazaka" });

    expect(anchored.isError).toBeUndefined();
    expect(anchored.content[0]!.text).toContain("below Kagurazaka");
    expect(blocksOn(snapshot(), 0).filter((b) => b.type === "note")).toHaveLength(1);
    expect(blocksOn(snapshot(), 1).filter((b) => b.type === "note")).toHaveLength(1);
  });
});
