import { describe, expect, it } from 'vitest';
import {
  rangeDays,
  rangeLabel,
  resolveRange,
  type DateRange,
} from '../../packages/ui/src/dateRange.js';

/** Fixed clock: a range helper tested against the real one is a flaky test. */
const NOW = Date.parse('2026-07-29T12:00:00Z');

describe('rangeDays', () => {
  it.each([
    [{ mode: 'relative', n: 7, unit: 'days' }, 7],
    [{ mode: 'relative', n: 3, unit: 'weeks' }, 21],
    [{ mode: 'relative', n: 2, unit: 'months' }, 60],
  ] as [DateRange, number][])('converts %o to %i days', (range, expected) => {
    expect(rangeDays(range, NOW)).toBe(expected);
  });

  it('counts both ends of an absolute range', () => {
    expect(rangeDays({ mode: 'absolute', from: '2026-07-01', to: '2026-07-31' }, NOW)).toBe(31);
  });

  /**
   * A single-day range is one day, not zero. Zero would ask the aggregates for an
   * empty window and render as "Atlas was never used".
   */
  it('treats a single day as one day, not zero', () => {
    expect(rangeDays({ mode: 'absolute', from: '2026-07-15', to: '2026-07-15' }, NOW)).toBe(1);
  });

  it('falls back to a week rather than NaN on an unparseable date', () => {
    expect(rangeDays({ mode: 'absolute', from: 'not-a-date', to: 'x' }, NOW)).toBe(7);
  });
});

describe('resolveRange', () => {
  it('turns a relative range into an open-ended since', () => {
    const { since, until } = resolveRange({ mode: 'relative', n: 7, unit: 'days' }, NOW);
    expect(since).toBe('2026-07-22T12:00:00.000Z');
    // No upper bound: "the last 7 days" includes anything that lands while you
    // are looking at it.
    expect(until).toBeUndefined();
  });

  /**
   * The end bound is exclusive midnight of the day AFTER `to`. A naive bound of
   * `to` itself returns nothing for a same-day range, because every call that day
   * happened after 00:00.
   */
  it('includes the whole final day', () => {
    const { since, until } = resolveRange(
      { mode: 'absolute', from: '2026-07-15', to: '2026-07-15' },
      NOW,
    );
    expect(since).toBe('2026-07-15T00:00:00.000Z');
    expect(until).toBe('2026-07-16T00:00:00.000Z');
  });

  it('spans a multi-day absolute range inclusively', () => {
    const { since, until } = resolveRange(
      { mode: 'absolute', from: '2026-07-01', to: '2026-07-31' },
      NOW,
    );
    expect(since).toBe('2026-07-01T00:00:00.000Z');
    expect(until).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('rangeLabel', () => {
  it.each([
    [{ mode: 'relative', n: 7, unit: 'days' }, 'last 7 days'],
    [{ mode: 'relative', n: 1, unit: 'day' as never }, 'last 1 day'],
    [{ mode: 'relative', n: 1, unit: 'months' }, 'last 1 month'],
    [{ mode: 'relative', n: 3, unit: 'weeks' }, 'last 3 weeks'],
    [{ mode: 'absolute', from: '2026-07-01', to: '2026-07-31' }, '2026-07-01 → 2026-07-31'],
    [{ mode: 'absolute', from: '2026-07-15', to: '2026-07-15' }, '2026-07-15'],
  ] as [DateRange, string][])('labels %o as "%s"', (range, expected) => {
    expect(rangeLabel(range)).toBe(expected);
  });
});
