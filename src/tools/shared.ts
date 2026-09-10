import type { AppContext } from "../context.js";
import type { CacheEntry } from "../cache/trip-cache.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type {
  Block,
  ChecklistItem,
  Geo,
  PlaceData,
  PlaceSuggestion,
  RentalCarEndpoint,
  Section,
  TransitEndpoint,
  TripPlan,
} from "../types.js";
import { isPlaceBlock } from "../types.js";

/**
 * Per-trip mutex — serializes submits against the same trip so concurrent
 * callers can't race each other on the ShareDB version vector. Without this,
 * parallel Promise.all batches of mutations all read the cache at version N
 * simultaneously and submit stale ops that the server rejects as conflicts.
 */
const submitLocks = new Map<string, Promise<unknown>>();

async function withSubmitLock<T>(
  tripKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = submitLocks.get(tripKey) ?? Promise.resolve();
  // Chain regardless of whether the previous op succeeded or failed —
  // one failed op should not permanently block the queue.
  const next = prev.then(fn, fn);
  // The map always holds a never-rejecting tail so the next caller can chain
  // onto it safely. Dead promises are negligible; the map is keyed by trip.
  submitLocks.set(
    tripKey,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Run a mutation transaction against a fresh cache entry while holding the
 * per-trip lock. The callback resolves targets and constructs paths from the
 * locked snapshot, then uses `submit` for one or more batches.
 *
 * Rules:
 * - Per-trip mutex: concurrent calls on the same trip serialize automatically.
 * - Each successful batch is applied to the stable entry before `submit` returns.
 * - Only submit/apply failures invalidate the cache; callback errors do not.
 */
export async function submitOp<T>(
  ctx: AppContext,
  tripKey: string,
  mutate: (
    entry: CacheEntry,
    submit: (ops: Json0Op[]) => Promise<void>,
  ) => Promise<T> | T,
): Promise<T> {
  return withSubmitLock(tripKey, async () => {
    const entry = await ctx.tripCache.getEntry(tripKey);
    const client = ctx.pool.get(tripKey);
    if (!client.isSubscribed) {
      throw new WanderlogError(
        `Trip ${tripKey} is not subscribed`,
        "not_subscribed",
      );
    }

    const submit = async (ops: Json0Op[]): Promise<void> => {
      try {
        await submitWithRateLimitRetry(client, ops);
        ctx.tripCache.applyLocalOp(tripKey, ops, client.version);
      } catch (err) {
        ctx.tripCache.invalidate(tripKey);
        throw err;
      }
    };

    return mutate(entry, submit);
  });
}

const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

// A rate-limited op (code 4001) is rejected before the server processes it —
// it never acks and never applies — so resubmitting the same ops at the same
// version is safe. Burst mutations (e.g. an LLM building a full itinerary)
// hit the limit routinely; waiting out the window beats surfacing an error.
async function submitWithRateLimitRetry(
  client: { submit(ops: Json0Op[]): Promise<void> },
  ops: Json0Op[],
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await client.submit(ops);
      return;
    } catch (err) {
      const isRateLimit =
        err instanceof WanderlogError && err.code === "rate_limited";
      if (!isRateLimit || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((r) =>
        setTimeout(r, RATE_LIMIT_RETRY_DELAYS_MS[attempt]),
      );
      attempt += 1;
    }
  }
}

/** Wanderlog block IDs are 9-digit numeric. Sections use the same format. */
export function generateBlockId(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Build a new custom section matching the shape Wanderlog inserts from its UI.
 * Always type "normal" / mode "placeList" — day sections are managed by update-trip-dates.
 */
export function buildSectionObject(heading: string): Section {
  return {
    id: generateBlockId(),
    type: "normal",
    mode: "placeList",
    heading,
    date: null,
    blocks: [],
    text: { ops: [{ insert: "\n" }] },
    placeMarkerColor: "#3498db",
    placeMarkerIcon: "map-marker",
  };
}

/**
 * Resolves a natural-language section reference to its index and Section object.
 * Resolution order:
 *   1. "places to visit" / "places" → the default placeList section (via findPlacesToVisitSection)
 *   2. Case-insensitive heading match across all sections
 * Returns null when no section matches.
 */
export function findSectionByRef(
  trip: TripPlan,
  ref: string,
): { index: number; section: Section } | null {
  const normalized = ref.trim().toLowerCase();
  if (normalized === "places to visit" || normalized === "places") {
    return findPlacesToVisitSection(trip);
  }
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.heading.trim().toLowerCase() === normalized) {
      return { index: i, section: s };
    }
  }
  return null;
}

export function findBlockById(
  trip: TripPlan,
  blockId: number,
): { sectionIndex: number; blockIndex: number; section: Section; block: Block } | null {
  for (let sectionIndex = 0; sectionIndex < trip.itinerary.sections.length; sectionIndex++) {
    const section = trip.itinerary.sections[sectionIndex]!;
    const blockIndex = section.blocks.findIndex((block) => block.id === blockId);
    if (blockIndex >= 0) {
      return {
        sectionIndex,
        blockIndex,
        section,
        block: section.blocks[blockIndex]!,
      };
    }
  }
  return null;
}

export function assertBlockAtPath(
  trip: TripPlan,
  sectionIndex: number,
  blockIndex: number,
  blockId: number,
): Block {
  const block = trip.itinerary.sections[sectionIndex]?.blocks[blockIndex];
  if (!block || block.id !== blockId) {
    throw new WanderlogError(
      `Block ${blockId} moved while preparing the mutation`,
      "stale_target",
    );
  }
  return block;
}

export function requireUserId(ctx: AppContext): number {
  if (ctx.userId == null) {
    throw new WanderlogError(
      "User ID not available — auth probe has not completed",
      "no_user_id",
    );
  }
  return ctx.userId;
}

/**
 * Build a newly-inserted place block matching Wanderlog's schema.
 * Based on the shape captured in HAR during real trip-add operations.
 */
export function buildPlaceBlock(
  place: PlaceData,
  userId: number,
  extras: {
    hotel?: {
      checkIn: string;
      checkOut: string;
      travelerNames?: string[];
      confirmationNumber?: string | null;
    };
    startTime?: string;
    endTime?: string;
  } = {},
): Block {
  const base: Record<string, unknown> = {
    id: generateBlockId(),
    type: "place",
    place,
    text: { ops: [{ insert: "\n" }] },
    addedBy: { type: "user", userId },
    imageSize: "small",
    upvotedBy: [],
    travelMode: null,
    attachments: [],
  };
  if (extras.hotel) {
    base.hotel = {
      checkIn: extras.hotel.checkIn,
      checkOut: extras.hotel.checkOut,
      travelerNames: extras.hotel.travelerNames ?? [],
      confirmationNumber: extras.hotel.confirmationNumber ?? null,
    };
  }
  if (extras.startTime) base.startTime = extras.startTime;
  if (extras.endTime) base.endTime = extras.endTime;
  return base as unknown as Block;
}

/**
 * Finds the "Places to visit" section (the default normal+placeList section
 * at the top of every trip). Returns its index in trip.itinerary.sections.
 */
export function findPlacesToVisitSection(trip: TripPlan): {
  index: number;
  section: Section;
} | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (
      s.type === "normal" &&
      s.mode === "placeList" &&
      (s.heading === "Places to visit" || s.heading === "")
    ) {
      return { index: i, section: s };
    }
  }
  return null;
}

/** Finds the first hotels-type section in the trip. */
export function findHotelsSection(trip: TripPlan): {
  index: number;
  section: Section;
} | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.type === "hotels") return { index: i, section: s };
  }
  return null;
}

/**
 * Finds a day section by ISO date. Returns null if no matching section exists
 * (e.g. the date is outside the trip range).
 */
export function findDaySectionByDate(
  trip: TripPlan,
  isoDate: string,
): { index: number; section: Section } | null {
  for (let i = 0; i < trip.itinerary.sections.length; i++) {
    const s = trip.itinerary.sections[i]!;
    if (s.mode === "dayPlan" && s.date === isoDate) {
      return { index: i, section: s };
    }
  }
  return null;
}

/**
 * Returns a search-biasing location for the trip. Tries in order:
 *   1. The first place block with geometry (most specific)
 *   2. The trip's first associated geo (from /api/tripPlans/{key} resources)
 *   3. Null if both are absent
 */
export function findTripCenter(
  trip: TripPlan,
  geos?: Geo[],
): { lat: number; lng: number } | null {
  for (const section of trip.itinerary.sections) {
    for (const block of section.blocks) {
      if (!isPlaceBlock(block)) continue;
      const loc = block.place.geometry?.location;
      if (loc) return loc;
    }
  }
  const first = geos?.[0];
  if (first) return { lat: first.latitude, lng: first.longitude };
  return null;
}

/**
 * Resolves the target section for adding a block — either a specific day
 * or the "Places to visit" list. Shared by add-place, add-note, add-checklist.
 */
export type TargetSection = {
  index: number;
  section: Section;
  label: string;
};

export function findTargetSection(
  trip: TripPlan,
  day?: string,
): TargetSection {
  if (day) {
    const daySection = resolveDay(trip, day);
    const found = findDaySectionByDate(trip, daySection.date!);
    if (!found) {
      throw new WanderlogValidationError(`Day ${day} not found in trip`);
    }
    return { index: found.index, section: found.section, label: `day ${daySection.date}` };
  }
  const places = findPlacesToVisitSection(trip);
  if (!places) {
    throw new WanderlogError(
      "Trip has no 'Places to visit' list",
      "no_places_section",
      "This is unexpected — Wanderlog usually creates one automatically. Try adding to a specific day instead.",
    );
  }
  return { index: places.index, section: places.section, label: "places to visit" };
}

/** Build a note block matching the shape captured from the Wanderlog UI. */
export function buildNoteBlock(userId: number): Record<string, unknown> {
  return {
    id: generateBlockId(),
    type: "note",
    text: { ops: [{ insert: "\n" }] },
    addedBy: { type: "user", userId },
    attachments: [],
  };
}

export function buildTransitBlock(
  type: "ferry" | "bus" | "train",
  userId: number,
  args: {
    carrier: string;
    depart: TransitEndpoint;
    arrive: TransitEndpoint;
    confirmationNumber?: string;
    travelerNames?: string[];
    notes?: string;
  },
): Block {
  const block: Record<string, unknown> = {
    id: generateBlockId(),
    type,
    carrier: args.carrier,
    depart: args.depart,
    arrive: args.arrive,
    addedBy: { type: "user", userId },
    text: { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] },
    attachments: [],
  };
  if (args.confirmationNumber) block.confirmationNumber = args.confirmationNumber;
  if (args.travelerNames && args.travelerNames.length > 0) {
    block.travelerNames = args.travelerNames;
  }
  return block as unknown as Block;
}

export function buildRentalCarBlock(
  userId: number,
  args: {
    pickUp: RentalCarEndpoint;
    dropOff: RentalCarEndpoint;
    confirmationNumber?: string;
    travelerNames?: string[];
    notes?: string;
  },
): Block {
  const block: Record<string, unknown> = {
    id: generateBlockId(),
    type: "rentalCar",
    addedBy: { type: "user", userId },
    pickUp: args.pickUp,
    dropOff: args.dropOff,
    text: { ops: [{ insert: args.notes ? `${args.notes}\n` : "\n" }] },
    attachments: [],
  };
  if (args.confirmationNumber) block.confirmationNumber = args.confirmationNumber;
  if (args.travelerNames && args.travelerNames.length > 0) {
    block.travelerNames = args.travelerNames;
  }
  return block as unknown as Block;
}

const TRANSIT_SECTION_META: Record<
  "transit" | "rentalCars",
  { heading: string; placeMarkerIcon: string; placeMarkerColor: string }
> = {
  transit: { heading: "Transit", placeMarkerIcon: "subway", placeMarkerColor: "#17b978" },
  rentalCars: { heading: "Rental cars", placeMarkerIcon: "car", placeMarkerColor: "#38a4a6" },
};

/**
 * Build a JSON0 `li` op that places `block` into the section of `sectionType`.
 * Appends to an existing section's blocks, or inserts a new section (block
 * embedded) at the end of itinerary.sections. Resolve-by-type keeps us safe
 * against unstable indices (invariant #6).
 */
export function sectionInsertOp(
  trip: TripPlan,
  sectionType: "transit" | "rentalCars",
  block: Block,
): Json0Op {
  const sections = trip.itinerary.sections;
  const index = sections.findIndex((s) => s.type === sectionType);
  if (index >= 0) {
    return {
      p: ["itinerary", "sections", index, "blocks", sections[index]!.blocks.length],
      li: block,
    };
  }
  const meta = TRANSIT_SECTION_META[sectionType];
  const section = {
    id: generateBlockId(),
    type: sectionType,
    mode: "placeList",
    heading: meta.heading,
    date: null,
    blocks: [block],
    placeMarkerColor: meta.placeMarkerColor,
    placeMarkerIcon: meta.placeMarkerIcon,
    text: { ops: [{ insert: "\n" }] },
  };
  return { p: ["itinerary", "sections", sections.length], li: section };
}

export function validateChronology(
  startLabel: string,
  startDate: string,
  startTime: string,
  endLabel: string,
  endDate: string,
  endTime: string,
): void {
  for (const [label, d] of [
    [`${startLabel}_date`, startDate],
    [`${endLabel}_date`, endDate],
  ] as const) {
    if (!isValidDate(d)) {
      throw new WanderlogValidationError(`Invalid ${label}: "${d}". Use YYYY-MM-DD.`);
    }
  }
  for (const [label, t] of [
    [`${startLabel}_time`, startTime],
    [`${endLabel}_time`, endTime],
  ] as const) {
    if (!TIME_REGEX.test(t)) {
      throw new WanderlogValidationError(`Invalid ${label}: "${t}". Use HH:mm (00:00–23:59).`);
    }
  }
  // Zero-padded ISO "YYYY-MM-DDTHH:mm" sorts chronologically as a string.
  if (`${endDate}T${endTime}` < `${startDate}T${startTime}`) {
    throw new WanderlogValidationError(
      `${endLabel} (${endDate} ${endTime}) must be on or after ${startLabel} (${startDate} ${startTime}).`,
    );
  }
}

/* --------------------------------------------------------------------------
 * Place-query resolution.
 *
 * Google autocomplete returns a ranked list, and its top hit is regularly a
 * different business at the queried address — a request for a clothing shop
 * came back as the office building next door. Taking predictions[0] blindly
 * turns that into a silently wrong write, so every resolution here is scored
 * against what was actually asked for, and the choice goes back to the caller
 * when the top hit is implausible or effectively tied with the runner-up.
 * ------------------------------------------------------------------------- */

/**
 * Biased-search radius. Day trips are a normal travel pattern — from a Tokyo
 * anchor, Kamakura is ~50km and Shisui ~60km — so the bias has to reach well
 * past the anchor city. Bias is a preference and not a filter, so a generous
 * radius costs nothing but ranking weight.
 */
const DEFAULT_SEARCH_RADIUS_M = 100_000;
const MAX_SEARCH_RADIUS_M = 500_000;
/** Half the earth's circumference: a bias this wide is no bias at all. */
const UNBIASED_SEARCH_RADIUS_M = 20_000_000;
/** The radius these tools shipped with, kept only as a degradation target. */
const LEGACY_SEARCH_RADIUS_M = 15_000;
/** Distance from the trip center past which the confirmation says how far. */
const FAR_FROM_CENTER_KM = 50;
/** Match score below which the resolved name is not a plausible answer. */
const CONFIDENT_SCORE = 0.6;
/** Score gap below which the top two candidates are an arbitrary choice. */
const TIE_GAP = 0.1;
const MAX_PLACE_CANDIDATES = 5;

/**
 * Fold case, diacritics and punctuation so "Sensō-ji" and "senso ji" compare
 * equal. `src/resolvers/place-ref.ts` normalizes trip-local names with its own
 * copy of this idea; the two are deliberately not shared yet.
 */
export function normalizePlaceText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Bare numbers are dropped: they match every business at a street address. */
function placeTokens(text: string): string[] {
  return normalizePlaceText(text)
    .split(" ")
    .filter((token) => token.length > 0 && !/^\d+$/.test(token));
}

/**
 * How plausibly `candidate` is the place `query` asked for, 0–1. Two
 * hand-rolled measures, the better one wins:
 *   - Dice coefficient over tokens, which rewards overlap while penalizing the
 *     extra words that distinguish a wrong branch ("… Musical Instruments").
 *   - Length ratio of one squashed string inside the other, which catches
 *     spacing differences that tokens miss ("Senso-ji" vs "Sensoji").
 */
export function placeMatchScore(query: string, candidate: string): number {
  const queryTokens = new Set(placeTokens(query));
  const candidateTokens = new Set(placeTokens(candidate));
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  const querySquashed = [...queryTokens].join("");
  const candidateSquashed = [...candidateTokens].join("");
  if (querySquashed === candidateSquashed) return 1;

  let shared = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) shared += 1;
  }
  const dice = (2 * shared) / (queryTokens.size + candidateTokens.size);

  const nested =
    candidateSquashed.includes(querySquashed) ||
    querySquashed.includes(candidateSquashed);
  const containment = nested
    ? Math.min(querySquashed.length, candidateSquashed.length) /
      Math.max(querySquashed.length, candidateSquashed.length)
    : 0;

  return Math.max(dice, containment);
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Search radius for a trip: wide enough for day trips by default, widened to
 * span the destination geo's own bounds when the trip covers a region or a
 * country rather than one city.
 */
export function tripSearchRadiusM(geos?: Geo[]): number {
  let radius = DEFAULT_SEARCH_RADIUS_M;
  for (const geo of geos ?? []) {
    // GeoJSON order: [minLng, minLat, maxLng, maxLat]. Skip anything that
    // doesn't look like that rather than deriving a nonsense radius from it.
    const bounds = geo.bounds;
    if (!bounds) continue;
    const [minLng, minLat, maxLng, maxLat] = bounds;
    if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) continue;
    if (Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) continue;
    const halfDiagonalM =
      (haversineKm({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng }) *
        1000) /
      2;
    radius = Math.max(radius, halfDiagonalM);
  }
  return Math.min(Math.round(radius), MAX_SEARCH_RADIUS_M);
}

export function suggestionName(suggestion: PlaceSuggestion): string {
  const main = suggestion.structured_formatting?.main_text?.trim();
  if (main) return main;
  return (suggestion.description ?? "").split(",")[0]!.trim();
}

export function suggestionAddress(suggestion: PlaceSuggestion): string {
  const secondary = suggestion.structured_formatting?.secondary_text?.trim();
  if (secondary) return secondary;
  return (suggestion.description ?? "").split(",").slice(1).join(",").trim();
}

export type PlaceCandidate = {
  suggestion: PlaceSuggestion;
  name: string;
  score: number;
};

export type PlaceQueryOutcome =
  | { kind: "none" }
  | {
      kind: "resolved";
      detail: PlaceData;
      score: number;
      /** null when the place record carries no geometry. */
      distanceKm: number | null;
      usedUnbiasedSearch: boolean;
    }
  | {
      kind: "ambiguous";
      /** Ordered best-first. Non-empty. */
      candidates: PlaceCandidate[];
      reason: "low_confidence" | "tie";
      usedUnbiasedSearch: boolean;
    };

/**
 * Biased autocomplete first, then the same query with the bias removed. The
 * fallback is what makes a day trip resolve at all: a biased search for a
 * beach 50km outside the anchor city can come back empty.
 */
async function autocompleteWithFallback(
  ctx: AppContext,
  query: string,
  center: { lat: number; lng: number },
  radiusM: number,
): Promise<{ predictions: PlaceSuggestion[]; usedUnbiasedSearch: boolean }> {
  const location = { latitude: center.lat, longitude: center.lng };
  const search = (radius: number) =>
    ctx.rest.searchPlacesAutocomplete({
      input: query,
      sessionToken: crypto.randomUUID(),
      location,
      radius,
    });

  let biased: PlaceSuggestion[];
  try {
    biased = await search(radiusM);
  } catch (err) {
    // These radii are wider than anything this tool has sent before. If the
    // API turns one down, degrade to the radius that has always worked rather
    // than breaking the search outright.
    if (radiusM <= LEGACY_SEARCH_RADIUS_M) throw err;
    biased = await search(LEGACY_SEARCH_RADIUS_M);
  }
  if (biased.length > 0) {
    return { predictions: biased, usedUnbiasedSearch: false };
  }

  try {
    return { predictions: await search(UNBIASED_SEARCH_RADIUS_M), usedUnbiasedSearch: true };
  } catch {
    // The biased call already succeeded, so auth and the endpoint are fine and
    // this failure is about the request itself. Report the honest "nothing
    // found" for the query instead of a transport error.
    return { predictions: [], usedUnbiasedSearch: false };
  }
}

/**
 * Resolve a place-name query to full PlaceData, or to the candidate list the
 * caller has to choose from. An unambiguous hit costs one autocomplete call
 * plus one details call, same as before.
 */
export async function resolvePlaceQuery(
  ctx: AppContext,
  query: string,
  center: { lat: number; lng: number },
  radiusM: number,
): Promise<PlaceQueryOutcome> {
  const { predictions, usedUnbiasedSearch } = await autocompleteWithFallback(
    ctx,
    query,
    center,
    radiusM,
  );
  if (predictions.length === 0) return { kind: "none" };

  const scored: PlaceCandidate[] = predictions.map((suggestion) => {
    const name = suggestionName(suggestion);
    return { suggestion, name, score: placeMatchScore(query, name) };
  });
  // Sort is stable, so equally-scored candidates keep Google's ranking.
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const runnerUp = scored[1];
  const decisive = !runnerUp || best.score - runnerUp.score >= TIE_GAP;
  const candidates = scored.slice(0, MAX_PLACE_CANDIDATES);

  if (!decisive) {
    return {
      kind: "ambiguous",
      candidates,
      reason: best.score >= CONFIDENT_SCORE ? "tie" : "low_confidence",
      usedUnbiasedSearch,
    };
  }

  const detail = await ctx.rest.getPlaceDetails(best.suggestion.place_id);
  // A prediction's main_text is sometimes a localized or abbreviated form of
  // the real name, so let a clear front-runner prove itself on the full record
  // before making the caller choose.
  const score = Math.max(best.score, placeMatchScore(query, detail.name ?? ""));
  if (score < CONFIDENT_SCORE) {
    return {
      kind: "ambiguous",
      candidates,
      reason: "low_confidence",
      usedUnbiasedSearch,
    };
  }

  const location = detail.geometry?.location;
  return {
    kind: "resolved",
    detail,
    score,
    distanceKm: location ? haversineKm(center, location) : null,
    usedUnbiasedSearch,
  };
}

/**
 * Numbered candidate list in the disambiguation shape used by edit-expense and
 * annotate-place: a text response with isError: true, and nothing written.
 */
export function formatPlaceCandidates(candidates: PlaceCandidate[]): string {
  return candidates
    .map((candidate, i) => {
      const address = suggestionAddress(candidate.suggestion);
      return `  ${i + 1}. ${candidate.name}${address ? ` (${address})` : ""}`;
    })
    .join("\n");
}

export function buildPlaceAmbiguityText(args: {
  query: string;
  tripTitle: string;
  candidates: PlaceCandidate[];
  reason: "low_confidence" | "tie";
  toolName: string;
  argName: string;
}): string {
  const lead =
    args.reason === "tie"
      ? `"${args.query}" matches these ${args.candidates.length} places about equally well — picking one would be a guess:`
      : `No search result for "${args.query}" plausibly is that place, so it was not resolved. Closest candidates:`;
  return [
    lead,
    formatPlaceCandidates(args.candidates),
    "",
    `Nothing was added to "${args.tripTitle}". Re-call ${args.toolName} with "${args.argName}" set to the exact name of the one you want (copy it from this list), or call wanderlog_search_places to see more options.`,
  ].join("\n");
}

/**
 * A wrong city is the failure this catches: a place 400km from the anchor is
 * either a real day trip or a same-named place somewhere else, and the caller
 * can only tell which if the confirmation says so.
 */
export function farFromCenterNote(
  distanceKm: number | null,
  usedUnbiasedSearch: boolean,
): string | null {
  if (distanceKm === null || distanceKm < FAR_FROM_CENTER_KM) return null;
  const how = usedUnbiasedSearch ? ", found without location bias" : "";
  return `Resolved ${Math.round(distanceKm)} km from the trip center${how} — confirm this is the intended city.`;
}

/** Resolve a place-name query to full PlaceData, biased to the trip center. */
export async function resolveEndpointPlace(
  ctx: AppContext,
  trip: TripPlan,
  geos: Geo[] | undefined,
  query: string,
): Promise<PlaceData> {
  const center = findTripCenter(trip, geos);
  if (!center) {
    throw new WanderlogValidationError(
      `Cannot resolve "${query}" in "${trip.title}" because no location anchor is available`,
      "This trip has no associated geo and no existing places.",
    );
  }
  const { predictions } = await autocompleteWithFallback(
    ctx,
    query,
    center,
    tripSearchRadiusM(geos),
  );
  if (predictions.length === 0) {
    throw new WanderlogError(
      `No place found matching "${query}" near ${trip.title}`,
      "place_not_found",
      "Try a more specific name or check the spelling.",
    );
  }
  return ctx.rest.getPlaceDetails(predictions[0]!.place_id);
}

/** Build a checklist block with pre-populated items. */
export function buildChecklistBlock(
  items: string[],
  title: string,
  userId: number,
): Record<string, unknown> {
  const checklistItems: ChecklistItem[] = items.map((text) => ({
    id: generateBlockId(),
    checked: false,
    text: { ops: [{ insert: `${text}\n` }] },
  }));
  return {
    id: generateBlockId(),
    type: "checklist",
    items: checklistItems,
    title,
    addedBy: { type: "user", userId },
    attachments: [],
  };
}

const TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateTimeInputs(startTime?: string, endTime?: string): void {
  if (startTime && !TIME_REGEX.test(startTime)) {
    throw new WanderlogValidationError(
      `Invalid start_time: "${startTime}". Hours must be between 00 and 23, and minutes between 00 and 59.`,
    );
  }
  if (endTime && !TIME_REGEX.test(endTime)) {
    throw new WanderlogValidationError(
      `Invalid end_time: "${endTime}". Hours must be between 00 and 23, and minutes between 00 and 59.`,
    );
  }
  // Format is validated above, so a lexicographic compare on zero-padded HH:mm
  // is equivalent to a chronological compare.
  if (startTime && endTime && startTime >= endTime) {
    throw new WanderlogValidationError(
      `end_time (${endTime}) must be after start_time (${startTime}).`,
    );
  }
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;

  const [year, month, day] = dateStr.split("-").map((s) => parseInt(s, 10));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

export function validateDateRange(startDate: string, endDate: string): void {
  // Both dates are validated as YYYY-MM-DD before this runs, so a
  // lexicographic compare matches chronological order.
  if (startDate > endDate) {
    throw new WanderlogValidationError(
      `end_date (${endDate}) must be on or after start_date (${startDate}).`,
    );
  }
}
