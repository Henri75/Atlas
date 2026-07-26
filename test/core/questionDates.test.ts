import { describe, expect, it } from 'vitest';
import { extractDateWindow, paddedWindow } from '@atlas/core';

/**
 * Date extraction exists to *add* a measured count to an answer, never to filter
 * retrieval. That asymmetry is why these tests care far more about false
 * positives than false negatives: a missed date degrades to the old behaviour,
 * while an invented one would put a wrong number in front of the model.
 */
describe('extractDateWindow', () => {
  it('finds an ISO date and returns that single day', () => {
    expect(extractDateWindow('what happened on 2026-07-21?')).toEqual({
      since: '2026-07-21T00:00:00.000Z',
      until: '2026-07-21T23:59:59.999Z',
    });
  });

  it('spans from the earliest to the latest date mentioned', () => {
    const w = extractDateWindow('compare 2026-07-01 with 2026-07-21');
    expect(w?.since).toBe('2026-07-01T00:00:00.000Z');
    expect(w?.until).toBe('2026-07-21T23:59:59.999Z');
  });

  it('reads day-month-year and month-day-year prose', () => {
    expect(extractDateWindow('the spike on 21 July 2026')?.since).toBe('2026-07-21T00:00:00.000Z');
    expect(extractDateWindow('the spike on July 21, 2026')?.since).toBe('2026-07-21T00:00:00.000Z');
  });

  it('treats a bare month as the whole month', () => {
    const w = extractDateWindow('what shipped in July 2026?');
    expect(w?.since).toBe('2026-07-01T00:00:00.000Z');
    expect(w?.until).toBe('2026-07-31T23:59:59.999Z');
  });

  it('handles a month with 30 days and a leap February', () => {
    expect(extractDateWindow('June 2026')?.until).toBe('2026-06-30T23:59:59.999Z');
    expect(extractDateWindow('February 2024')?.until).toBe('2024-02-29T23:59:59.999Z');
  });

  it('returns null when no date is named', () => {
    expect(extractDateWindow('why is the videoinsight_low queue starved?')).toBeNull();
    expect(extractDateWindow('what does the drain feature do')).toBeNull();
  });

  /**
   * The dangerous class: text that merely contains digits. Inventing a window
   * from these would attach a confident, irrelevant count to the answer.
   */
  it('does not invent dates from version numbers, ids or times', () => {
    expect(extractDateWindow('why did we move to postgres 18.4?')).toBeNull();
    expect(extractDateWindow('what is entry 640704 about')).toBeNull();
    expect(extractDateWindow('the 429 retries at 21:30')).toBeNull();
    expect(extractDateWindow('bump qdrant to v1.18.2')).toBeNull();
  });

  it('rejects impossible calendar dates rather than rolling them over', () => {
    // JS Date would happily turn month 13 into next January.
    expect(extractDateWindow('2026-13-01')).toBeNull();
    expect(extractDateWindow('2026-02-30')).toBeNull();
  });
});

describe('paddedWindow', () => {
  /**
   * An incident on the 21st is usually written up on the 22nd or later, so a
   * bare "0 entries on 2026-07-21" recreates the dead end this work exists to
   * remove. The padded count gives the model somewhere correct to point.
   */
  it('widens a single day by the given number of days on each side', () => {
    const w = paddedWindow(
      { since: '2026-07-21T00:00:00.000Z', until: '2026-07-21T23:59:59.999Z' },
      3,
    );
    expect(w.since).toBe('2026-07-18T00:00:00.000Z');
    expect(w.until).toBe('2026-07-24T23:59:59.999Z');
  });

  it('pads across a month boundary', () => {
    const w = paddedWindow(
      { since: '2026-07-01T00:00:00.000Z', until: '2026-07-01T23:59:59.999Z' },
      3,
    );
    expect(w.since).toBe('2026-06-28T00:00:00.000Z');
  });
});
