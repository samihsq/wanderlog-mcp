import type { Block, Section, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";
import { resolveDay } from "./day.js";

export type PlaceRefMatch = {
  sectionIndex: number;
  blockIndex: number;
  section: Section;
  block: Block;
};

export type PlaceRefResult =
  | { kind: "unique"; match: PlaceRefMatch }
  | { kind: "ambiguous"; candidates: PlaceRefMatch[] }
  | { kind: "none" };

const MAX_AMBIGUOUS_CANDIDATES = 10;

type MatchMode = "exact" | "substring" | "refContainsName" | "tokenOverlap";

const MATCH_MODES: MatchMode[] = [
  "exact",
  "substring",
  "refContainsName",
  "tokenOverlap",
];

/** Shortest stored name allowed to match by sitting inside a longer ref. */
const MIN_REVERSE_MATCH_CHARS = 4;

/** Ignored when comparing refs word-by-word; they carry no identity. */
const FILLER_WORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "at",
  "in",
  "on",
  "of",
  "and",
  "to",
  "for",
]);

const HOTEL_KEYWORDS = new Set(["the hotel", "hotel", "my hotel"]);
const FLIGHT_KEYWORDS = new Set(["the flight", "flight", "my flight"]);
const TRAIN_KEYWORDS = new Set(["the train", "train", "my train"]);
const FERRY_KEYWORDS = new Set(["the ferry", "ferry", "my ferry"]);
const BUS_KEYWORDS = new Set(["the bus", "bus", "my bus"]);
const RENTAL_CAR_KEYWORDS = new Set([
  "the rental car",
  "rental car",
  "the car",
  "my rental car",
  "my car",
]);

const WORD_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

type ParsedOrdinal = { position: number | "last"; rest: string };

/**
 * Detects an ordinal prefix on a normalized ref. Returns the 1-based position
 * (or "last") and the remaining ref with the ordinal stripped. Handles:
 *   - numeric suffixes: "1st X", "2nd X", "3rd X", "4th X", ...
 *   - word ordinals: "first X", "second X", ..., "tenth X"
 *   - "last X"
 *
 * Returns null if no ordinal prefix is present.
 */
export function parseOrdinal(ref: string): ParsedOrdinal | null {
  if (ref.startsWith("last ")) {
    const rest = ref.slice(5).trim();
    if (rest) return { position: "last", rest };
  }

  const numMatch = /^(\d+)(?:st|nd|rd|th)\s+(.+)$/.exec(ref);
  if (numMatch) {
    const n = Number.parseInt(numMatch[1]!, 10);
    if (n >= 1) return { position: n, rest: numMatch[2]!.trim() };
  }

  const wordMatch = /^([a-z]+)\s+(.+)$/.exec(ref);
  if (wordMatch) {
    const word = wordMatch[1]!;
    const n = WORD_ORDINALS[word];
    if (n !== undefined) return { position: n, rest: wordMatch[2]!.trim() };
  }

  return null;
}

/**
 * Resolves a free-form natural-language reference to a block in a trip.
 *
 * Strategy order (short-circuits on the first stage that yields candidates):
 *   0. Ordinal prefix ("1st X", "2nd X", "last X", "third X") — strips the
 *      ordinal, resolves the rest via the normal flow, then picks the N-th
 *      (or last) candidate from the resulting list. Combines with compound
 *      refs: "2nd Queenstown Gardens on day 4" is valid.
 *   1. Compound "<thing> on <context>" — left side resolved by stages 2-6,
 *      then filtered to candidates whose parent section matches the context
 *      (currently only day references are understood on the right).
 *   2. Role keywords ("the hotel", "the flight", "the train", "the ferry",
 *      "the bus", "the rental car") — first block in the appropriate role
 *      section.
 *   3. Exact (case-insensitive) match against `block.place.name`.
 *   4. Substring: the stored name contains the ref ("gardens" → "Queenstown
 *      Gardens").
 *   5. Reverse containment: the ref contains the stored name, matched on whole
 *      words ("BerBerJin Harajuku" → a place stored as "BerBerJin"). Stored
 *      names shorter than MIN_REVERSE_MATCH_CHARS are skipped, since a two- or
 *      three-letter name inside a longer ref is coincidence more often than
 *      intent.
 *   6. Token overlap, for refs with two or more meaningful words: every token
 *      of the shorter side must appear on the other side, in any order
 *      ("Harajuku Chicago" → "Chicago Harajuku"). Filler words ("the", "at")
 *      are ignored, so "the park" never reaches this stage.
 *
 * Stages 5 and 6 only run when every tighter stage came up empty, so a ref that
 * used to resolve uniquely cannot become ambiguous. Every stage still returns
 * all of its candidates: multiple hits are reported as ambiguous rather than
 * silently narrowed to one.
 *
 * Diacritics are folded, so "Senso-ji" matches "Sensō-ji" and "Kichijoji"
 * matches "Kichijōji". Whitespace and dashes are collapsed before matching.
 */
export function resolvePlaceRef(trip: TripPlan, ref: string): PlaceRefResult {
  const normalized = normalize(ref);
  if (!normalized) {
    return { kind: "none" };
  }

  const sections = trip.itinerary.sections;
  if (sections.length === 0) {
    return { kind: "none" };
  }

  const ordinal = parseOrdinal(normalized);
  const body = ordinal ? ordinal.rest : normalized;

  const compound = splitCompound(body);
  const candidates = compound
    ? filterByContext(trip, findByLeftSide(trip, compound.left), compound.right)
    : findByLeftSide(trip, body);

  if (ordinal) {
    const index =
      ordinal.position === "last" ? candidates.length - 1 : ordinal.position - 1;
    if (index >= 0 && index < candidates.length) {
      return { kind: "unique", match: candidates[index]! };
    }
    // A place name can itself start with an ordinal ("2nd Street
    // Shimokitazawa"). If nothing was there to index into, re-read the ref as a
    // literal name — exact only, so a failed ordinal never becomes a guess.
    return finalize(findExact(trip, normalized));
  }

  return finalize(candidates);
}

function findExact(trip: TripPlan, ref: string): PlaceRefMatch[] {
  const compound = splitCompound(ref);
  if (compound) {
    return filterByContext(
      trip,
      matchPlaceName(trip, compound.left, "exact"),
      compound.right,
    );
  }
  return matchPlaceName(trip, ref, "exact");
}

function findByLeftSide(trip: TripPlan, ref: string): PlaceRefMatch[] {
  const roleMatches = matchRoleKeyword(trip, ref);
  if (roleMatches.length > 0) {
    return roleMatches;
  }

  // Tightest first: each stage only runs when the previous one found nothing,
  // so widening the net can never turn a previously unique ref ambiguous.
  for (const mode of MATCH_MODES) {
    const matches = matchPlaceName(trip, ref, mode);
    if (matches.length > 0) {
      return matches;
    }
  }

  return [];
}

function matchRoleKeyword(trip: TripPlan, ref: string): PlaceRefMatch[] {
  if (HOTEL_KEYWORDS.has(ref)) {
    return firstBlockOfSectionType(trip, (s) => s.type === "hotels");
  }
  if (FLIGHT_KEYWORDS.has(ref)) {
    return firstBlockOfSectionType(trip, (s) => s.type === "flights");
  }
  if (TRAIN_KEYWORDS.has(ref)) {
    return firstBlockOfSectionType(
      trip,
      (s) => s.type === "transit",
      (b) => b.type === "train",
    );
  }
  if (FERRY_KEYWORDS.has(ref)) {
    return firstBlockOfSectionType(
      trip,
      (s) => s.type === "transit",
      (b) => b.type === "ferry",
    );
  }
  if (BUS_KEYWORDS.has(ref)) {
    return firstBlockOfSectionType(
      trip,
      (s) => s.type === "transit",
      (b) => b.type === "bus",
    );
  }
  if (RENTAL_CAR_KEYWORDS.has(ref)) {
    return firstBlockOfSectionType(trip, (s) => s.type === "rentalCars");
  }
  return [];
}

function firstBlockOfSectionType(
  trip: TripPlan,
  sectionPredicate: (s: Section) => boolean,
  blockPredicate?: (b: Block) => boolean,
): PlaceRefMatch[] {
  const sections = trip.itinerary.sections;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex]!;
    if (!sectionPredicate(section)) continue;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (blockPredicate && !blockPredicate(block)) continue;
      return [{ sectionIndex, blockIndex, section, block }];
    }
  }
  return [];
}

function matchPlaceName(
  trip: TripPlan,
  ref: string,
  mode: MatchMode,
): PlaceRefMatch[] {
  const refTokens = tokenize(ref);
  const refWords = meaningful(refTokens);
  // One meaningful word says too little for token overlap: "the park" would
  // otherwise match every park in the trip.
  if (mode === "tokenOverlap" && refWords.length < 2) return [];

  const matches: PlaceRefMatch[] = [];
  const sections = trip.itinerary.sections;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex]!;
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex]!;
      if (!isPlaceBlock(block)) continue;
      const name = normalize(block.place.name ?? "");
      if (!name) continue;
      if (nameHit(mode, name, ref, refTokens, refWords)) {
        matches.push({ sectionIndex, blockIndex, section, block });
      }
    }
  }
  return matches;
}

function nameHit(
  mode: MatchMode,
  name: string,
  ref: string,
  refTokens: string[],
  refWords: string[],
): boolean {
  switch (mode) {
    case "exact":
      return name === ref;
    case "substring":
      return name.includes(ref);
    case "refContainsName":
      return (
        name.length >= MIN_REVERSE_MATCH_CHARS &&
        containsSequence(refTokens, tokenize(name))
      );
    case "tokenOverlap":
      return tokensOverlap(refWords, meaningful(tokenize(name)));
  }
}

/** True if `needle` appears as a run of whole tokens inside `haystack`. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let all = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * True if every word of the shorter side appears on the longer side, in any
 * order. Both sides need at least two words, so a one-word stored name never
 * matches on overlap alone — the reverse-containment stage covers that case
 * with a word-boundary check instead.
 */
function tokensOverlap(refWords: string[], nameWords: string[]): boolean {
  if (nameWords.length < 2) return false;
  const [shorter, longer] =
    refWords.length <= nameWords.length
      ? [refWords, nameWords]
      : [nameWords, refWords];
  const pool = new Set(longer);
  return shorter.every((t) => pool.has(t));
}

function tokenize(s: string): string[] {
  return s.split(" ").filter(Boolean);
}

function meaningful(tokens: string[]): string[] {
  return tokens.filter((t) => !FILLER_WORDS.has(t) && /[a-z0-9]/.test(t));
}

function splitCompound(ref: string): { left: string; right: string } | null {
  const idx = ref.indexOf(" on ");
  if (idx < 0) return null;
  const left = ref.slice(0, idx).trim();
  const right = ref.slice(idx + 4).trim();
  if (!left || !right) return null;
  return { left, right };
}

function filterByContext(
  trip: TripPlan,
  candidates: PlaceRefMatch[],
  context: string,
): PlaceRefMatch[] {
  if (candidates.length === 0) return candidates;

  const contextSection = tryResolveDay(trip, context);
  if (contextSection) {
    return candidates.filter((c) => c.section === contextSection);
  }

  return [];
}

function tryResolveDay(trip: TripPlan, ref: string): Section | null {
  try {
    return resolveDay(trip, ref);
  } catch {
    return null;
  }
}

function finalize(candidates: PlaceRefMatch[]): PlaceRefResult {
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "unique", match: candidates[0]! };
  return {
    kind: "ambiguous",
    candidates: candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES),
  };
}

function normalize(s: string): string {
  // Collapse runs of whitespace and punctuation dashes (hyphens, en/em-dashes)
  // so "Roppongi Hills - Tokyo City View" matches "Roppongi Hills Tokyo City View".
  // NFD then dropping combining marks folds diacritics, so an ASCII-typed
  // "Senso-ji" reaches "Sensō-ji".
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\s\-–—]+/g, " ")
    .trim()
    .toLowerCase();
}
