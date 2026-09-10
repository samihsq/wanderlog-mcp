import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addNote } from "../../src/tools/add-note.ts";
import type { Block, TripPlan } from "../../src/types.ts";

function place(id: number, name: string): Block {
  return { id, type: "place", place: { name, place_id: `p${id}` } } as Block;
}

function dayTrip(): TripPlan {
  return {
    id: 1,
    key: "T",
    title: "Trip to Tokyo",
    userId: 3656632,
    privacy: "private",
    startDate: "2026-09-12",
    endDate: "2026-09-13",
    days: 2,
    placeCount: 3,
    schemaVersion: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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
        {
          id: 20,
          type: "normal",
          mode: "dayPlan",
          heading: "",
          date: "2026-09-12",
          blocks: [
            place(101, "Omoide Yokocho Memory Lane"),
            place(102, "Kagurazaka"),
            place(103, "Shinjuku Golden-Gai"),
          ],
        },
      ],
    },
  } as unknown as TripPlan;
}

function makeFakeContext(trip: TripPlan): {
  ctx: AppContext;
  submittedOps: Json0Op[][];
  snapshot: () => TripPlan;
} {
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(trip), version: 1, geos: [] };
  const ctx = {
    userId: 3656632,
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
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
  return { ctx, submittedOps, snapshot: () => entry.snapshot };
}

function dayBlocks(trip: TripPlan): Block[] {
  return trip.itinerary.sections[1]!.blocks;
}

describe("addNote placement", () => {
  it("inserts directly below the anchor place rather than at the end of the day", async () => {
    const { ctx, snapshot } = makeFakeContext(dayTrip());
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "10 min walk downhill from here.",
      after: "Kagurazaka",
    });

    expect(result.isError).toBeUndefined();
    const types = dayBlocks(snapshot()).map((b) => b.type);
    expect(types).toEqual(["place", "place", "note", "place"]);
    expect(result.content[0]!.text).toContain("below Kagurazaka");
  });

  it("still appends to the end when 'after' is omitted", async () => {
    const { ctx, snapshot } = makeFakeContext(dayTrip());
    await addNote(ctx, {
      trip_key: "T",
      text: "Day wrap-up.",
      day: "2026-09-12",
    });

    expect(dayBlocks(snapshot()).map((b) => b.type)).toEqual([
      "place",
      "place",
      "place",
      "note",
    ]);
  });

  it("takes the section from the anchor, ignoring a conflicting day", async () => {
    const { ctx, snapshot } = makeFakeContext(dayTrip());
    await addNote(ctx, {
      trip_key: "T",
      text: "Belongs with the first stop.",
      after: "Omoide Yokocho Memory Lane",
      section: "Places to visit",
    });

    expect(snapshot().itinerary.sections[0]!.blocks).toHaveLength(0);
    expect(dayBlocks(snapshot())[1]!.type).toBe("note");
  });

  it("writes the note text at the anchored position", async () => {
    const { ctx, snapshot } = makeFakeContext(dayTrip());
    await addNote(ctx, {
      trip_key: "T",
      text: "**Cash only** past 9pm.",
      after: "Omoide Yokocho Memory Lane",
    });

    const note = dayBlocks(snapshot())[1] as { type: string; text?: { ops?: unknown[] } };
    expect(note.type).toBe("note");
    expect(note.text?.ops).toEqual([
      { insert: "Cash only", attributes: { bold: true } },
      { insert: " past 9pm.\n" },
    ]);
  });

  it("asks which place instead of guessing when the anchor is ambiguous", async () => {
    const trip = dayTrip();
    trip.itinerary.sections[1]!.blocks.push(place(104, "Shibuya Nonbei Yokocho"));
    const { ctx, submittedOps } = makeFakeContext(trip);

    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Which one?",
      after: "yokocho",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("matches 2 places");
    expect(submittedOps).toHaveLength(0);
  });

  it("errors without writing when the anchor does not exist", async () => {
    const { ctx, submittedOps } = makeFakeContext(dayTrip());
    const result = await addNote(ctx, {
      trip_key: "T",
      text: "Orphan.",
      after: "Yuigahama Beach",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Yuigahama Beach");
    expect(submittedOps).toHaveLength(0);
  });
});
