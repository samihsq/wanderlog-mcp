import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { editFlight } from "../../src/tools/edit-flight.ts";
import { editHotel } from "../../src/tools/edit-hotel.ts";
import {
  formatFlightLabel,
  resolveFlightRef,
} from "../../src/resolvers/flight-ref.ts";
import type { FlightBlock, TripPlan } from "../../src/types.ts";

/**
 * Two-leg trip modelled on real Wanderlog data: times are local "HH:mm",
 * `number` is numeric, and the return leg legitimately arrives at an earlier
 * clock time than it departed (eastbound across the date line).
 */
function tokyoTrip(): TripPlan {
  return {
    id: 1,
    key: "T",
    title: "Trip to Tokyo",
    userId: 3656632,
    privacy: "private",
    startDate: "2026-09-11",
    endDate: "2026-09-18",
    days: 8,
    placeCount: 1,
    schemaVersion: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    itinerary: {
      sections: [
        {
          id: 10,
          type: "flights",
          mode: "placeList",
          heading: "Flights",
          date: null,
          blocks: [
            {
              id: 270368616,
              type: "flight",
              flightInfo: {
                airline: {
                  iata: "JL",
                  icao: "JTL",
                  name: "Jet Linx Aviation",
                  localizedName: "Jet Linx Aviation",
                } as FlightBlock["flightInfo"]["airline"],
                number: 57,
              },
              depart: {
                type: "depart",
                date: "2026-09-11",
                time: "13:55",
                airport: {
                  iata: "SFO",
                  name: "San Francisco International Airport",
                  cityName: "San Francisco",
                  googlePlace: { formatted_address: "San Francisco, CA 94128, USA" },
                },
              },
              arrive: {
                type: "arrive",
                date: "2026-09-12",
                time: "16:30",
                airport: { iata: "NRT", name: "Narita Airport", cityName: "Tokyo" },
              },
              confirmationNumber: "",
              travelerNames: [],
            },
            {
              id: 941851908,
              type: "flight",
              flightInfo: {
                airline: { iata: "JL", icao: "JTL", name: "Jet Linx Aviation" },
                number: 58,
              },
              depart: {
                type: "depart",
                date: "2026-09-17",
                time: "18:15",
                airport: { iata: "NRT", name: "Narita Airport", cityName: "Tokyo" },
              },
              arrive: {
                type: "arrive",
                date: "2026-09-17",
                time: "11:55",
                airport: { iata: "SFO", name: "San Francisco International Airport" },
              },
              confirmationNumber: "",
              travelerNames: [],
            },
          ],
        },
        {
          id: 20,
          type: "hotels",
          mode: "placeList",
          heading: "Hotels and lodging",
          date: null,
          blocks: [
            {
              id: 912974937,
              type: "place",
              place: { name: "Hotel Yuni Star-Club", place_id: "p1" },
              hotel: {
                checkIn: "2026-09-12",
                checkOut: "2026-09-17",
                travelerNames: [],
                confirmationNumber: null,
              },
            },
          ],
        },
        {
          id: 30,
          type: "normal",
          mode: "placeList",
          heading: "Places to visit",
          date: null,
          blocks: [
            {
              id: 914016478,
              type: "place",
              place: { name: "Shibuya", place_id: "p2" },
            },
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

function flights(trip: TripPlan): FlightBlock[] {
  return trip.itinerary.sections[0]!.blocks as FlightBlock[];
}

describe("resolveFlightRef", () => {
  const trip = tokyoTrip();

  it("returns every flight when the reference is omitted or generic", () => {
    expect(resolveFlightRef(trip)).toMatchObject({ kind: "ambiguous" });
    expect(resolveFlightRef(trip, "the flight")).toMatchObject({ kind: "ambiguous" });
  });

  it("resolves outbound and return", () => {
    const outbound = resolveFlightRef(trip, "outbound");
    const ret = resolveFlightRef(trip, "return");
    expect(outbound).toMatchObject({ kind: "unique" });
    expect(ret).toMatchObject({ kind: "unique" });
    expect((outbound as { match: { block: FlightBlock } }).match.block.id).toBe(270368616);
    expect((ret as { match: { block: FlightBlock } }).match.block.id).toBe(941851908);
  });

  it("resolves a designator, a bare number and a route", () => {
    for (const ref of ["JL 58", "jl58", "58", "NRT to SFO", "nrt-sfo", "NRT → SFO"]) {
      const result = resolveFlightRef(trip, ref);
      expect(result, ref).toMatchObject({ kind: "unique" });
      expect((result as { match: { block: FlightBlock } }).match.block.id, ref).toBe(941851908);
    }
  });

  it("treats a shared airport code as ambiguous rather than guessing", () => {
    expect(resolveFlightRef(trip, "NRT")).toMatchObject({ kind: "ambiguous" });
  });

  it("resolves by departure date and by ordinal", () => {
    expect(resolveFlightRef(trip, "2026-09-11")).toMatchObject({ kind: "unique" });
    const last = resolveFlightRef(trip, "last flight");
    expect((last as { match: { block: FlightBlock } }).match.block.id).toBe(941851908);
  });

  it("returns none for a reference that matches nothing", () => {
    expect(resolveFlightRef(trip, "UA 100")).toEqual({ kind: "none" });
  });

  it("labels a flight readably", () => {
    expect(formatFlightLabel(flights(trip)[0]!)).toBe("JL 57 · SFO → NRT · 2026-09-11 13:55");
  });
});

describe("editFlight", () => {
  it("corrects a wrong airline name and drops the stale ICAO code", async () => {
    const { ctx, submittedOps, snapshot } = makeFakeContext(tokyoTrip());
    const result = await editFlight(ctx, {
      trip_key: "T",
      flight: "JL 57",
      airline_name: "Japan Airlines",
    });

    expect(result.isError).toBeUndefined();
    const airline = flights(snapshot())[0]!.flightInfo!.airline as Record<string, unknown>;
    expect(airline.name).toBe("Japan Airlines");
    expect(airline.localizedName).toBe("Japan Airlines");
    expect(airline.iata).toBe("JL");
    expect(submittedOps.flat()).not.toHaveLength(0);
  });

  it("removes the ICAO code when the airline code itself changes", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    await editFlight(ctx, {
      trip_key: "T",
      flight: "outbound",
      airline_code: "nh",
      airline_name: "ANA",
    });

    const airline = flights(snapshot())[0]!.flightInfo!.airline as Record<string, unknown>;
    expect(airline.iata).toBe("NH");
    expect("icao" in airline).toBe(false);
  });

  it("updates dates, times and the flight number", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    const result = await editFlight(ctx, {
      trip_key: "T",
      flight: "return",
      depart_date: "2026-09-18",
      depart_time: "09:05",
      flight_number: "59",
    });

    expect(result.isError).toBeUndefined();
    const leg = flights(snapshot())[1]!;
    expect(leg.depart?.date).toBe("2026-09-18");
    expect(leg.depart?.time).toBe("09:05");
    expect(leg.flightInfo?.number).toBe(59);
  });

  it("accepts an arrival earlier than departure (eastbound date line)", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    const result = await editFlight(ctx, {
      trip_key: "T",
      flight: "JL 58",
      depart_time: "18:15",
      arrive_time: "11:00",
    });

    expect(result.isError).toBeUndefined();
    expect(flights(snapshot())[1]!.arrive?.time).toBe("11:00");
  });

  it("drops stale city and cached place data when an airport changes", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    await editFlight(ctx, {
      trip_key: "T",
      flight: "JL 57",
      arrive_airport: "hnd",
      arrive_airport_name: "Haneda Airport",
    });

    const airport = flights(snapshot())[0]!.arrive!.airport as Record<string, unknown>;
    expect(airport.iata).toBe("HND");
    expect(airport.name).toBe("Haneda Airport");
    expect("cityName" in airport).toBe(false);
  });

  it("names the airport by its code when no display name is given", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    await editFlight(ctx, { trip_key: "T", flight: "JL 57", depart_airport: "OAK" });

    const airport = flights(snapshot())[0]!.depart!.airport as Record<string, unknown>;
    expect(airport.iata).toBe("OAK");
    expect(airport.name).toBe("OAK");
    expect("googlePlace" in airport).toBe(false);
  });

  it("sets and clears the confirmation number and travelers", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    await editFlight(ctx, {
      trip_key: "T",
      flight: "JL 57",
      confirmation_number: "XY7Q2P",
      traveler_names: ["Sami H"],
    });
    expect(
      (flights(snapshot())[0] as unknown as Record<string, unknown>).confirmationNumber,
    ).toBe("XY7Q2P");
    expect(flights(snapshot())[0]!.travelerNames).toEqual(["Sami H"]);

    await editFlight(ctx, {
      trip_key: "T",
      flight: "JL 57",
      confirmation_number: "",
      traveler_names: [],
    });
    expect(
      (flights(snapshot())[0] as unknown as Record<string, unknown>).confirmationNumber,
    ).toBe("");
    expect(flights(snapshot())[0]!.travelerNames).toEqual([]);
  });

  it("asks which flight instead of guessing when the reference is ambiguous", async () => {
    const { ctx, submittedOps } = makeFakeContext(tokyoTrip());
    const result = await editFlight(ctx, { trip_key: "T", depart_time: "10:00" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("2 flights");
    expect(result.content[0]!.text).toContain("JL 57");
    expect(submittedOps).toHaveLength(0);
  });

  it("reports no change when the values already match", async () => {
    const { ctx, submittedOps } = makeFakeContext(tokyoTrip());
    const result = await editFlight(ctx, {
      trip_key: "T",
      flight: "JL 57",
      depart_time: "13:55",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("No changes");
    expect(submittedOps).toHaveLength(0);
  });

  it("rejects a call with nothing to edit", async () => {
    const { ctx } = makeFakeContext(tokyoTrip());
    const result = await editFlight(ctx, { trip_key: "T", flight: "JL 57" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Nothing to edit");
  });
});

describe("editHotel", () => {
  it("moves a check-out date", async () => {
    const { ctx, submittedOps, snapshot } = makeFakeContext(tokyoTrip());
    const result = await editHotel(ctx, { trip_key: "T", check_out: "2026-09-18" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("2026-09-12 → 2026-09-18");
    expect(submittedOps[0]![0]).toMatchObject({
      p: ["itinerary", "sections", 1, "blocks", 0, "hotel", "checkOut"],
      od: "2026-09-17",
      oi: "2026-09-18",
    });
    const block = snapshot().itinerary.sections[1]!.blocks[0] as {
      hotel: { checkOut: string };
    };
    expect(block.hotel.checkOut).toBe("2026-09-18");
  });

  it("rejects a check-out on or before the check-in, including against the stored date", async () => {
    const { ctx, submittedOps } = makeFakeContext(tokyoTrip());
    const sameDay = await editHotel(ctx, { trip_key: "T", check_out: "2026-09-12" });
    expect(sameDay.isError).toBe(true);
    expect(sameDay.content[0]!.text).toContain("must be after");

    const backwards = await editHotel(ctx, { trip_key: "T", check_in: "2026-09-20" });
    expect(backwards.isError).toBe(true);
    expect(submittedOps).toHaveLength(0);
  });

  it("accepts a whole stay moved in one call", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    const result = await editHotel(ctx, {
      trip_key: "T",
      check_in: "2026-09-13",
      check_out: "2026-09-18",
    });

    expect(result.isError).toBeUndefined();
    const block = snapshot().itinerary.sections[1]!.blocks[0] as {
      hotel: { checkIn: string; checkOut: string };
    };
    expect(block.hotel).toMatchObject({ checkIn: "2026-09-13", checkOut: "2026-09-18" });
  });

  it("sets a confirmation number that was null, then clears it", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    await editHotel(ctx, { trip_key: "T", confirmation_number: "HZ-4471" });
    let block = snapshot().itinerary.sections[1]!.blocks[0] as {
      hotel: { confirmationNumber: string | null };
    };
    expect(block.hotel.confirmationNumber).toBe("HZ-4471");

    await editHotel(ctx, { trip_key: "T", confirmation_number: "" });
    block = snapshot().itinerary.sections[1]!.blocks[0] as {
      hotel: { confirmationNumber: string | null };
    };
    expect(block.hotel.confirmationNumber).toBeNull();
  });

  it("replaces the traveler list", async () => {
    const { ctx, snapshot } = makeFakeContext(tokyoTrip());
    await editHotel(ctx, { trip_key: "T", traveler_names: ["Sami H", "Guest"] });
    const block = snapshot().itinerary.sections[1]!.blocks[0] as {
      hotel: { travelerNames: string[] };
    };
    expect(block.hotel.travelerNames).toEqual(["Sami H", "Guest"]);
  });

  it("refuses a place that is not a hotel booking", async () => {
    const { ctx, submittedOps } = makeFakeContext(tokyoTrip());
    const result = await editHotel(ctx, {
      trip_key: "T",
      hotel: "Shibuya",
      check_out: "2026-09-18",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not a hotel booking");
    expect(submittedOps).toHaveLength(0);
  });

  it("reports no change when the dates already match", async () => {
    const { ctx, submittedOps } = makeFakeContext(tokyoTrip());
    const result = await editHotel(ctx, { trip_key: "T", check_out: "2026-09-17" });
    expect(result.content[0]!.text).toContain("No changes");
    expect(submittedOps).toHaveLength(0);
  });

  it("rejects a call with nothing to edit", async () => {
    const { ctx } = makeFakeContext(tokyoTrip());
    const result = await editHotel(ctx, { trip_key: "T" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Nothing to edit");
  });
});
