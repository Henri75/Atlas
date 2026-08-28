import { describe, expect, it } from 'vitest';
import {
  RELATED_SUBSTANCE_FLOOR,
  SEARCH_SUBSTANCE_FLOOR,
  aggregateMatchScores,
  kindWeight,
  recencyTilt,
  substancePrior,
  substanceScore,
} from '@atlas/core';

describe('aggregateMatchScores', () => {
  it('is never below the single best matching message', () => {
    expect(aggregateMatchScores([0.9, 0.1, 0.1])).toBeGreaterThanOrEqual(0.9);
  });

  it('rewards matching in several places over matching once', () => {
    const spread = aggregateMatchScores([0.6, 0.6, 0.6, 0.6]);
    const single = aggregateMatchScores([0.65]);
    expect(spread).toBeGreaterThan(single);
  });

  it('does not let a long session buy the top spot on volume alone', () => {
    // 40 weak matches (the shape of a 1,304-entry session) must not beat one
    // strong one — this is the failure a plain sum would have.
    const many = aggregateMatchScores(Array.from({ length: 40 }, () => 0.15));
    expect(many).toBeLessThan(aggregateMatchScores([0.9]));
  });

  it('does not depend on input order', () => {
    expect(aggregateMatchScores([0.2, 0.9, 0.5])).toBeCloseTo(aggregateMatchScores([0.9, 0.5, 0.2]));
  });

  it('is 0 for no matches', () => {
    expect(aggregateMatchScores([])).toBe(0);
  });
});

describe('kindWeight', () => {
  it('lifts distilled prose above raw responses and damps actions', () => {
    expect(kindWeight('insight')).toBeGreaterThan(kindWeight('response'));
    expect(kindWeight('action')).toBeLessThan(kindWeight('response'));
  });

  it('treats an unknown or missing kind as a plain response', () => {
    expect(kindWeight(undefined)).toBe(1);
    expect(kindWeight('nonsense')).toBe(1);
  });
});

describe('substanceScore', () => {
  it('is 0 for an empty session and near 1 for a heavy one', () => {
    expect(substanceScore({})).toBe(0);
    expect(
      substanceScore({ entryCount: 400, actionCount: 200, fileCount: 30, durationMs: 6 * 3600_000 }),
    ).toBeCloseTo(1);
  });

  it('separates the median session from a real work session', () => {
    // The measured median: 3 entries, 1.6 minutes, no files.
    const median = substanceScore({ entryCount: 3, actionCount: 1, durationMs: 96_000 });
    // A p90 session: 151 entries.
    const real = substanceScore({ entryCount: 151, actionCount: 60, fileCount: 9, durationMs: 3600_000 });
    expect(real).toBeGreaterThan(median * 4);
  });

  it('credits a short session that edited real files', () => {
    expect(substanceScore({ entryCount: 6, fileCount: 8 })).toBeGreaterThan(
      substanceScore({ entryCount: 6 }),
    );
  });

  it('ignores negative or absurd inputs rather than producing a score out of range', () => {
    const s = substanceScore({ entryCount: -5, actionCount: 1e9, durationMs: -1 });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe('substancePrior', () => {
  it('never zeroes a genuine match', () => {
    expect(substancePrior(0)).toBe(SEARCH_SUBSTANCE_FLOOR);
    expect(substancePrior(1)).toBe(1);
  });

  it('clamps out-of-range input', () => {
    expect(substancePrior(-3)).toBe(SEARCH_SUBSTANCE_FLOOR);
    expect(substancePrior(9)).toBe(1);
  });

  /**
   * Search and related ask different questions of the same number. A tiny
   * session can be exactly what you searched for; it is rarely the WORK on
   * something you did not ask about.
   */
  it('is far less forgiving when a session was proposed rather than requested', () => {
    expect(RELATED_SUBSTANCE_FLOOR).toBeLessThan(SEARCH_SUBSTANCE_FLOOR);
    const trivial = substanceScore({ entryCount: 3, actionCount: 0 });
    expect(substancePrior(trivial, RELATED_SUBSTANCE_FLOOR)).toBeLessThan(
      substancePrior(trivial) / 1.5,
    );
    // A heavy session is unaffected either way — the floor only moves the tail.
    expect(substancePrior(1, RELATED_SUBSTANCE_FLOOR)).toBe(1);
  });
});

describe('recencyTilt', () => {
  const now = Date.parse('2026-08-28T00:00:00Z');

  it('is 1 for today and mildly below 1 for a year ago', () => {
    expect(recencyTilt('2026-08-28T00:00:00Z', now)).toBeCloseTo(1, 2);
    const old = recencyTilt('2025-08-28T00:00:00Z', now);
    expect(old).toBeLessThan(1);
    expect(old).toBeGreaterThan(0.9); // mild: never enough to bury a better answer
  });

  it('is disabled at strength 0 and neutral for unusable timestamps', () => {
    expect(recencyTilt('2020-01-01T00:00:00Z', now, 0)).toBe(1);
    expect(recencyTilt(undefined, now)).toBe(1);
    expect(recencyTilt('not-a-date', now)).toBe(1);
  });

  it('does not exceed 1 for a future timestamp', () => {
    expect(recencyTilt('2030-01-01T00:00:00Z', now)).toBeLessThanOrEqual(1);
  });
});
