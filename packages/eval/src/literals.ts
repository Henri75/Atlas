/**
 * Finding the literal a person would quote.
 *
 * Pool L builds questions around one verbatim token drawn from the source entry
 * — a size, a version, a commit sha, a column name — because that is how people
 * actually ask about something months later ("the 6.8MB json", "the whale's
 * tags_with_counts row"), and because no other pool produces that shape.
 *
 * Pools A and B cannot: A is mined from real traffic, which is thin, and B's
 * generator is explicitly instructed *not* to reuse identifiers or verbatim
 * phrases, since for B that would be leakage. So the corpus of test questions
 * contained no measurements at all — which is why the tokeniser could shred
 * every one of them (`6.8MB` → `["8mb"]`) and the harness score unchanged.
 *
 * Deliberately independent of `isLiteralToken` in `@atlas/core`, which answers a
 * similar question for query weighting. That predicate is part of the retrieval
 * code this pool exists to hold to account; sharing it would let a change to the
 * ranking quietly reshape its own exam.
 */

export type LiteralShape = 'measurement' | 'sha' | 'version' | 'identifier' | 'dotted';

/** Units a number may carry. Kept tight: these are the ones history is written in. */
const UNITS =
  'b|kb|mb|gb|tb|kib|mib|gib|tib|ns|us|ms|s|sec|secs|min|mins|h|hr|hrs|k|m|bn|rps|qps|px';

const MEASUREMENT = new RegExp(`^\\d+(?:\\.\\d+)?(?:${UNITS})$`, 'i');
/**
 * A `v` prefix, or three components. Two bare components is just a decimal —
 * `6.8` is what "6.8 MB" leaves behind once the unit is split off, and a
 * question built around it would match half the corpus and measure nothing.
 */
const VERSION = /^(?:v\d+(?:\.\d+)+|\d+\.\d+(?:\.\d+)+)$/i;
const SHA = /^[0-9a-f]{7,40}$/i;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i;
const DOTTED = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/i;

/**
 * Longest literal worth quoting. A 60-character identifier is real, but nobody
 * retypes it into a question, so a fixture built on one would not resemble the
 * traffic it stands in for.
 */
const MAX_LEN = 40;

/**
 * Which kind of literal this token is, or `null` for ordinary prose.
 *
 * Order matters where shapes overlap. `1.18.2` is a version, not a measurement.
 * A bare integer is deliberately nothing at all: years and counts are everywhere
 * in the corpus, so a question built around `2026` would discriminate nothing.
 */
export function literalShape(token: string): LiteralShape | null {
  if (!token || token.length > MAX_LEN) return null;
  if (VERSION.test(token)) return 'version';
  if (MEASUREMENT.test(token)) return 'measurement';
  // A sha must not be a plain number: `1234567` is a count, `4277bf0b` is a ref.
  if (SHA.test(token) && /[a-f]/i.test(token) && /\d/.test(token)) return 'sha';
  if (IDENTIFIER.test(token)) return 'identifier';
  if (DOTTED.test(token)) return 'dotted';
  return null;
}

/**
 * Priority when a text offers several. Measurements first because they are the
 * shape that actually broke — the tokeniser split them at the decimal point and
 * collided the remainder — while identifiers survived it intact.
 */
const PRIORITY: LiteralShape[] = ['measurement', 'sha', 'version', 'identifier', 'dotted'];

/**
 * The most discriminative literal in `text`, lowercased, or `null` if it has
 * none. Deterministic: same text, same answer, so a regenerated fixture does not
 * quietly become a different test.
 */
export function extractLiteral(text: string): string | null {
  const best = new Map<LiteralShape, string>();
  // Split on whitespace and the punctuation that surrounds a quoted value,
  // keeping `.` and `_` because they are *inside* the literals we are after.
  for (const raw of text.toLowerCase().split(/[^a-z0-9._]+/i)) {
    const token = raw.replace(/^[._]+|[._]+$/g, '');
    const shape = literalShape(token);
    // First occurrence of each shape wins, so the answer does not depend on how
    // many times a later token repeats.
    if (shape && !best.has(shape)) best.set(shape, token);
  }
  for (const shape of PRIORITY) {
    const hit = best.get(shape);
    if (hit) return hit;
  }
  return null;
}

/**
 * How `text` actually spells `literal`, preserving its original casing, or
 * `null` if it does not contain it.
 *
 * The generated question has to quote the literal the way the entry writes it.
 * Asking about `6.8MB` when the entry says `6.8 MB` is a *different* retrieval
 * problem — before 2026-07-29 the two spellings were lexically disjoint — and a
 * fixture that silently normalised one into the other would hide which of them
 * broke.
 */
export function spellingIn(text: string, literal: string): string | null {
  // Escaped, because a literal legitimately contains `.` — unescaped it would
  // match `deepcastxio` as readily as `deepcast.io`.
  const pattern = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.match(new RegExp(pattern, 'i'))?.[0] ?? null;
}
