import type { FlightBlock, Section, TripPlan } from "../types.js";
import { parseOrdinal } from "./place-ref.js";

export type FlightRefMatch = {
  sectionIndex: number;
  blockIndex: number;
  section: Section;
  block: FlightBlock;
};

export type FlightRefResult =
  | { kind: "unique"; match: FlightRefMatch }
  | { kind: "ambiguous"; candidates: FlightRefMatch[] }
  | { kind: "none" };

const ANY_FLIGHT_KEYWORDS = new Set([
  "",
  "flight",
  "the flight",
  "my flight",
  "flights",
  "the flights",
]);
const OUTBOUND_KEYWORDS = new Set([
  "outbound",
  "the outbound",
  "outbound flight",
  "the outbound flight",
  "departure",
  "departing flight",
  "there",
]);
const RETURN_KEYWORDS = new Set([
  "return",
  "the return",
  "return flight",
  "the return flight",
  "inbound",
  "inbound flight",
  "home",
  "flight home",
  "the flight home",
]);

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isFlightBlock(block: { type: string }): block is FlightBlock {
  return block.type === "flight";
}

export function collectFlights(trip: TripPlan): FlightRefMatch[] {
  const out: FlightRefMatch[] = [];
  const sections = trip.itinerary.sections;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (!isFlightBlock(block)) continue;
      out.push({ sectionIndex, blockIndex, section, block });
    }
  }
  return out;
}

/** "JL 57 · SFO → NRT · 2026-09-11 13:55" — enough to tell two legs apart. */
export function formatFlightLabel(block: FlightBlock): string {
  const iata = block.flightInfo?.airline?.iata;
  const number = block.flightInfo?.number;
  const designator =
    iata && number !== undefined
      ? `${iata} ${number}`
      : (iata ?? (number !== undefined ? `#${number}` : "Flight"));
  const from = block.depart?.airport?.iata ?? block.depart?.airport?.cityName ?? "?";
  const to = block.arrive?.airport?.iata ?? block.arrive?.airport?.cityName ?? "?";
  const when = [block.depart?.date, block.depart?.time].filter(Boolean).join(" ");
  return [designator, `${from} → ${to}`, when].filter(Boolean).join(" · ");
}

function airportCodes(match: FlightRefMatch): { from?: string; to?: string } {
  return {
    from: match.block.depart?.airport?.iata?.toLowerCase(),
    to: match.block.arrive?.airport?.iata?.toLowerCase(),
  };
}

function splitRoute(ref: string): { from: string; to: string } | null {
  const cleaned = ref.replace(/[→>]+/g, " to ").replace(/\s+/g, " ").trim();
  const match = /^([a-z]{3})\s*(?:to|-|–)\s*([a-z]{3})$/.exec(cleaned);
  if (!match) return null;
  return { from: match[1]!, to: match[2]! };
}

/**
 * Resolves a free-form reference to a flight block.
 *
 * Understood forms, in order: "the flight" / omitted (every flight),
 * "outbound" and "return" (first and last leg), a route ("SFO to NRT",
 * "sfo-nrt", "SFO → NRT"), a designator ("JL57", "JL 57"), a bare flight
 * number ("57"), a single airport code ("NRT", matching either end), a
 * departure date ("2026-09-11"), or a substring of the airline name. An
 * ordinal prefix ("2nd flight", "last flight") picks from the matches.
 */
export function resolveFlightRef(trip: TripPlan, rawRef?: string): FlightRefResult {
  const flights = collectFlights(trip);
  if (flights.length === 0) return { kind: "none" };

  const normalized = normalize(rawRef ?? "");
  const ordinal = normalized ? parseOrdinal(normalized) : null;
  const ref = ordinal ? normalize(ordinal.rest) : normalized;

  const candidates = matchFlights(flights, ref);

  if (ordinal) {
    if (candidates.length === 0) return { kind: "none" };
    const index =
      ordinal.position === "last" ? candidates.length - 1 : ordinal.position - 1;
    if (index < 0 || index >= candidates.length) return { kind: "none" };
    return { kind: "unique", match: candidates[index]! };
  }

  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "unique", match: candidates[0]! };
  return { kind: "ambiguous", candidates };
}

function matchFlights(flights: FlightRefMatch[], ref: string): FlightRefMatch[] {
  if (ANY_FLIGHT_KEYWORDS.has(ref)) return flights;
  if (OUTBOUND_KEYWORDS.has(ref)) return [flights[0]!];
  if (RETURN_KEYWORDS.has(ref)) return [flights[flights.length - 1]!];

  const route = splitRoute(ref);
  if (route) {
    return flights.filter((f) => {
      const { from, to } = airportCodes(f);
      return from === route.from && to === route.to;
    });
  }

  const designator = /^([a-z]{2})\s?(\d{1,4})$/.exec(ref);
  if (designator) {
    const [, airline, number] = designator;
    const hits = flights.filter(
      (f) =>
        f.block.flightInfo?.airline?.iata?.toLowerCase() === airline &&
        String(f.block.flightInfo?.number ?? "") === number,
    );
    if (hits.length > 0) return hits;
  }

  if (/^\d{1,4}$/.test(ref)) {
    const hits = flights.filter(
      (f) => String(f.block.flightInfo?.number ?? "") === ref,
    );
    if (hits.length > 0) return hits;
  }

  if (/^[a-z]{3}$/.test(ref)) {
    const hits = flights.filter((f) => {
      const { from, to } = airportCodes(f);
      return from === ref || to === ref;
    });
    if (hits.length > 0) return hits;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
    const hits = flights.filter((f) => f.block.depart?.date === ref);
    if (hits.length > 0) return hits;
  }

  const byAirline = flights.filter((f) => {
    const name = f.block.flightInfo?.airline?.name?.toLowerCase() ?? "";
    const iata = f.block.flightInfo?.airline?.iata?.toLowerCase() ?? "";
    return (name.length > 0 && name.includes(ref)) || iata === ref;
  });
  if (byAirline.length > 0) return byAirline;

  return [];
}
