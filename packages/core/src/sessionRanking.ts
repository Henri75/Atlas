/**
 * How a *session* is scored, as opposed to how a message is.
 *
 * Atlas's existing search ranks entries — one message, one commit, one log
 * line. Session search has to answer a different question ("which conversation
 * was that?"), and the corpus makes that question hostile in a specific way.
 * Measured 2026-08-28 over 8,395 indexed sessions:
 *
 *   median entries per session   3        (p90 151, max 1,304)
 *   median duration              1.6 min
 *   sessions with >= 20 entries  2,205    (26%)
 *
 * The corpus is dominated by one-minute throwaway sessions. Rank purely by best
 * matching message and a two-message session that happened to contain the query
 * word outranks the three-hour session that actually did the work. Hence a
 * substance prior, and an aggregation rule that rewards a session for matching
 * in several places without simply rewarding it for being long.
 *
 * Everything here is pure and unit-tested: these are the numbers that decide
 * what the user sees, so they must be inspectable without a database.
 */

import type { EntryKind } from './types.js';

/**
 * Per-kind weight applied to a message's score before it is aggregated.
 *
 * `action` entries are 163,960 of the 363,842 session entries — nearly half the
 * corpus — and their bodies are mostly file paths and command heads. They are
 * genuinely useful for "which session touched this file", so they are damped
 * rather than dropped. `insight`/`summary`/`plan` are the classifications the
 * parser already assigns to distilled prose, which is the highest-signal
 * content a session holds, so they are lifted.
 */
export const KIND_WEIGHT: Record<EntryKind, number> = {
  insight: 1.25,
  summary: 1.25,
  plan: 1.25,
  prompt: 1.1,
  response: 1.0,
  action: 0.6,
};

export function kindWeight(kind: string | undefined): number {
  return KIND_WEIGHT[(kind ?? 'response') as EntryKind] ?? 1.0;
}

/** How fast the contribution of each additional matching message decays. */
export const MATCH_DECAY = 0.35;

/**
 * Aggregate a session's member-message scores into one session score.
 *
 *     best + decay * SUM(i >= 2) score_i / i
 *
 * The leading term means a session is never ranked below its single best piece
 * of evidence. The harmonic-decayed tail means a session that matched in six
 * places beats one that matched in one — while a 1,304-entry session that
 * matched weakly in forty places cannot buy its way to the top on volume, which
 * a plain sum would let it do.
 *
 * Input need not be sorted; it is sorted here so callers cannot get it wrong.
 */
export function aggregateMatchScores(scores: readonly number[], decay = MATCH_DECAY): number {
  if (!scores.length) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  let total = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) total += (decay * sorted[i]!) / (i + 1);
  return total;
}

export interface SubstanceInput {
  entryCount?: number;
  actionCount?: number;
  fileCount?: number;
  durationMs?: number;
}

/**
 * How much work a session represents, in [0, 1].
 *
 * Four saturating terms rather than one: the ceilings (60 entries, 40 actions,
 * 8 files, 45 minutes) are each roughly the point past which "more" stops
 * telling you anything about whether the session mattered. A long session with
 * no actions and a short session that edited eight files across forty tool
 * calls are both real work, and neither should need the other's shape to score.
 */
export function substanceScore(i: SubstanceInput): number {
  const cap = (v: number | undefined, ceiling: number) =>
    Math.min(Math.max(v ?? 0, 0) / ceiling, 1);
  return (
    0.4 * cap(i.entryCount, 60) +
    0.25 * cap(i.actionCount, 40) +
    0.2 * cap(i.fileCount, 8) +
    0.15 * cap(i.durationMs == null ? 0 : i.durationMs / 60_000, 45)
  );
}

/**
 * Floor of the substance multiplier when the USER asked for the session.
 *
 * Deliberately not 0: a two-message session that genuinely contains what you
 * searched for must still be findable. This suppresses the flood, it does not
 * censor it — the thing you are looking for is sometimes exactly the
 * ninety-second session where you pasted an error.
 */
export const SEARCH_SUBSTANCE_FLOOR = 0.55;

/**
 * Floor when nobody asked for the session — it was PROPOSED as related.
 *
 * Much lower, and the asymmetry is the point. In search the user's own words
 * are the primary evidence and a tiny session can be exactly the right answer.
 * In "what else worked on this", a three-message session is rarely the WORK on
 * anything; proposing it alongside real sessions is a false positive the reader
 * has to rule out by hand. Measured on the live index: a 3-message security
 * review scored above two substantial file-sharing sessions purely on subject
 * similarity until this floor was separated out.
 */
export const RELATED_SUBSTANCE_FLOOR = 0.25;

/** Substance as a ranking multiplier, in [floor, 1]. */
export function substancePrior(substance: number, floor = SEARCH_SUBSTANCE_FLOOR): number {
  const f = Math.min(Math.max(floor, 0), 1);
  return f + (1 - f) * Math.min(Math.max(substance, 0), 1);
}

/**
 * Mild recency preference, in [1 - strength, 1].
 *
 * Atlas's ranking is otherwise deliberately time-blind (that is why `since`
 * and `until` exist). The tilt here is small on purpose — enough that, given
 * two equally good matches, "the qdrant thing" means the recent one; never
 * enough to bury a year-old session that is the better answer. `strength = 0`
 * disables it entirely.
 */
export function recencyTilt(occurredAt: string | undefined, nowMs: number, strength = 0.1): number {
  if (!occurredAt || strength <= 0) return 1;
  const t = Date.parse(occurredAt);
  if (!Number.isFinite(t)) return 1;
  const years = Math.max(0, (nowMs - t) / (365.25 * 24 * 3600_000));
  return 1 - strength * (1 - Math.exp(-years));
}
