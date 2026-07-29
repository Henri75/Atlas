/**
 * The two ways people ask for a time window, reduced to the one pair the API
 * takes (`since`/`until`).
 *
 * Relative ("last 3 weeks") is what you want almost always, because the question
 * is usually "recently". Absolute ("1st to 15th") is what you want when
 * correlating with something that happened on a known date. Supporting only the
 * first makes that second job impossible; supporting only the second makes the
 * common case tedious.
 */

export type RangeUnit = 'days' | 'weeks' | 'months';

export interface RelativeRange {
  mode: 'relative';
  n: number;
  unit: RangeUnit;
}

export interface AbsoluteRange {
  mode: 'absolute';
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive — see resolveRange for how the end is handled. */
  to: string;
}

export type DateRange = RelativeRange | AbsoluteRange;

export const DEFAULT_RANGE: RelativeRange = { mode: 'relative', n: 7, unit: 'days' };

const DAYS_PER: Record<RangeUnit, number> = { days: 1, weeks: 7, months: 30 };

/** Whole days the range spans — what the aggregate endpoints take. */
export function rangeDays(range: DateRange, now = Date.now()): number {
  if (range.mode === 'relative') {
    return Math.max(1, Math.round(range.n * DAYS_PER[range.unit]));
  }
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 7;
  // Inclusive of both ends, and never zero: a single-day range is 1 day, not 0,
  // or the aggregates would be asked for an empty window.
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/**
 * ISO bounds for the call list. `until` is exclusive and set to midnight *after*
 * the chosen end date, so picking the same day for both ends returns that whole
 * day rather than nothing — the mistake a naive `to` bound makes.
 */
export function resolveRange(
  range: DateRange,
  now = Date.now(),
): { since?: string; until?: string } {
  if (range.mode === 'relative') {
    return { since: new Date(now - rangeDays(range, now) * 86_400_000).toISOString() };
  }
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return {
    since: Number.isFinite(from) ? new Date(from).toISOString() : undefined,
    until: Number.isFinite(to) ? new Date(to + 86_400_000).toISOString() : undefined,
  };
}

/** Short label for the current range, for a button or a chart caption. */
export function rangeLabel(range: DateRange): string {
  if (range.mode === 'relative') {
    const unit = range.n === 1 ? range.unit.replace(/s$/, '') : range.unit;
    return `last ${range.n} ${unit}`;
  }
  return range.from === range.to ? range.from : `${range.from} → ${range.to}`;
}
