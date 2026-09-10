import { deltaToPlainText, type DeltaOp } from "../ot/rich-text.js";
import {
  isPlaceBlock,
  type NoteBlock,
  type PlaceBlock,
  type PlaceData,
  type Section,
} from "../types.js";
import { extractDeltaText } from "./remove-note.js";
import { normalizePlaceText } from "./shared.js";

/**
 * Duplicate guards for the insert tools.
 *
 * The trip cache can serve a snapshot that predates our own successful write.
 * An agent then reads back, does not see the block it just added, concludes the
 * write failed and writes again — which is how a live trip ended up with two
 * identical place blocks on one day. These checks make that retry a no-op.
 * Cache drift is inherent to collaborative editing, so this is a permanent
 * layer rather than a workaround for any one bug.
 */

/** A time slot, with "", null and undefined all folded into "no time set". */
function slot(time: string | null | undefined): string | undefined {
  const trimmed = typeof time === "string" ? time.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Google's place_id is the only identity that survives transliteration and
 * chain branches, so it decides whenever both sides have one. Names are the
 * fallback for blocks added before we recorded ids, or by hand in the UI.
 */
function samePlace(a: PlaceData | undefined, b: PlaceData): boolean {
  if (!a) return false;
  if (a.place_id && b.place_id) return a.place_id === b.place_id;
  const nameA = normalizePlaceText(a.name ?? "");
  const nameB = normalizePlaceText(b.name ?? "");
  return nameA.length > 0 && nameA === nameB;
}

export type DuplicatePlace = {
  block: PlaceBlock;
  blockIndex: number;
  startTime?: string;
};

/**
 * The same place in the same section at the same start time. A second visit at
 * a different time (a café at breakfast and again after dinner) is a real
 * itinerary, and so is the same place on another day, so neither matches here.
 */
export function findDuplicatePlace(
  section: Section,
  place: PlaceData,
  startTime?: string,
): DuplicatePlace | undefined {
  const wanted = slot(startTime);
  for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
    const block = section.blocks[blockIndex]!;
    if (!isPlaceBlock(block)) continue;
    if (!samePlace(block.place, place)) continue;
    if (slot(block.startTime) !== wanted) continue;
    return { block, blockIndex, startTime: wanted };
  }
  return undefined;
}

/** Plain text of the delta ops a note write is about to submit. */
export function noteOpsPlainText(ops: DeltaOp[]): string {
  return deltaToPlainText({ ops: ops.map((op) => ({ insert: op.insert })) });
}

export type DuplicateNote = { block: NoteBlock; blockIndex: number };

/**
 * A note in this section whose resolved text is identical to what would be
 * written. The comparison is on plain text, so the same sentence written as
 * markdown and as plain text counts as one note, not two.
 */
export function findDuplicateNote(
  section: Section,
  ops: DeltaOp[],
): DuplicateNote | undefined {
  const wanted = noteOpsPlainText(ops).trim();
  if (wanted.length === 0) return undefined;
  for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
    const block = section.blocks[blockIndex]!;
    if (block.type !== "note") continue;
    const note = block as NoteBlock;
    if (extractDeltaText(note.text).trim() === wanted) return { block: note, blockIndex };
  }
  return undefined;
}
