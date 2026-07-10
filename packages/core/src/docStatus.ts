/**
 * Doc staleness model (spec: docs/superpowers/specs/2026-07-10-docs-staleness-design.md).
 *
 * Two orthogonal signals, only one of which is ever stored:
 * - `archived`: computed from the file's path at scan time and persisted in
 *   entry meta + Qdrant payload. Path conventions are immutable per location,
 *   so storing this cannot drift.
 * - `aging`: derived at QUERY time from the entry's occurredAt. Never stored —
 *   unchanged files are never rescanned, so a stored aging flag would freeze
 *   at whatever was true on index day.
 *
 * Nothing is excluded at index time; staleness only downranks and labels.
 */

/**
 * Bump when doc parsing/classification changes semantics. scanDocs compares it
 * against the per-project `docs_parser_version:<id>` setting and, on mismatch,
 * walks unchanged files once to sync meta + vector payload (no re-embedding).
 */
export const DOCS_PARSER_VERSION = 2;

export const DEFAULT_AGING_MONTHS = 12;
export const DEFAULT_ARCHIVED_PENALTY = 0.6;

/** Status carried on search hits. 'active' is implied by absence. */
export type DocStatus = 'aging' | 'archived';

/** Whole-token match: "old" must not catch "goldilocks" or "scaffold". */
const ARCHIVED_SEGMENT =
  /^_?(archived?s?|legacy|old|deprecated|previous|obsolete|superseded|outdated|backups?|bak)$/i;

/**
 * Does this project-relative path live under an archive-style location?
 * Directory segments and filename-stem tokens both count, so
 * `docs/_legacy/auth.md` and `docs/auth.deprecated.md` are equivalent.
 */
export function isArchivedDocPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const file = parts.pop() ?? '';
  if (parts.some((seg) => ARCHIVED_SEGMENT.test(seg))) return true;
  const stem = file.replace(/\.[^.]+$/, '');
  return stem.split(/[._-]/).some((tok) => ARCHIVED_SEGMENT.test(tok));
}

/** Mean Gregorian month; day-level precision is plenty for a staleness label. */
const MONTH_MS = 30.44 * 24 * 3600 * 1000;

/**
 * Age a doc entry at query time. Missing/invalid dates stay 'active' with no
 * age — "cannot tell" must never render as a stale badge.
 */
export function deriveDocAge(
  occurredAt: string | undefined,
  agingMonths: number,
  nowMs: number,
): { status: 'active' | 'aging'; ageMonths?: number } {
  if (!occurredAt) return { status: 'active' };
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return { status: 'active' };
  const ageMonths = Math.floor((nowMs - t) / MONTH_MS);
  return ageMonths >= agingMonths
    ? { status: 'aging', ageMonths }
    : { status: 'active', ageMonths };
}
