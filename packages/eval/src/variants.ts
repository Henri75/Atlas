import { DEFAULT_RERANK, extractDateWindow, type RerankOptions } from '@atlas/core';
import type { EvalQuery } from './types.js';

/**
 * Ranking configurations to compare.
 *
 * A variant is a *function of the query*, not a fixed object, because one of the
 * proposals under evaluation is conditional: relax the session cap only when the
 * question is time-scoped. Making that a config function keeps it out of core
 * entirely — core never needs to know what a "time-scoped question" is, and the
 * idea can be measured before anything commits to it.
 */
export interface Variant {
  name: string;
  /** One line, printed in the report so a number is never unattributed. */
  what: string;
  options: (q: EvalQuery, nowMs: number) => RerankOptions;
}

/**
 * A question is time-scoped when the caller passed a date filter, or when the
 * text itself names a date or range.
 *
 * `extractDateWindow` is the same parser Ask uses to decide whether to measure a
 * window count, so "time-scoped" means the same thing in both places rather than
 * being reinvented with slightly different rules.
 */
export function isTimeScoped(q: EvalQuery): boolean {
  if (q.filters.since || q.filters.until) return true;
  return extractDateWindow(q.text) !== null;
}

export const VARIANTS: Variant[] = [
  {
    name: 'baseline',
    what: 'shipped configuration: session weight 0.8, 50% session ceiling, 180d/12% recency',
    options: (_q, nowMs) => ({ nowMs }),
  },
  {
    name: 'no-recency',
    what: 'ablation: recency boost off — how much is the Phase 3 time term doing?',
    options: (_q, nowMs) => ({ nowMs, recencyMaxBoost: 0 }),
  },
  {
    name: 'no-source-weight',
    what: 'ablation: every source type weighted 1.0 — how much is source weighting doing?',
    options: (_q, nowMs) => ({ nowMs, sourceWeight: {} }),
  },
  {
    name: 'relax-when-scoped',
    what: 'session ceiling lifted for time-scoped questions only (work item 2, option 2)',
    options: (q, nowMs) => (isTimeScoped(q) ? { nowMs, maxSessionFraction: 1 } : { nowMs }),
  },
  {
    name: 'cap-as-floor',
    what: 'reserve slots for non-session types instead of capping sessions (work item 2, option 3)',
    options: (_q, nowMs) => ({ nowMs, minNonSessionSlots: DEFAULT_FLOOR }),
  },
];

/**
 * Slots reserved for non-session types under `cap-as-floor`.
 *
 * 4 of 12 is the deliberately neutral starting point: it is roughly what the 50%
 * ceiling already yields whenever authoritative hits exist to fill the freed
 * slots, so `floor=4` isolates *removing the ceiling* from *changing the size of
 * the guarantee*. It is swept (`--floor`), not fixed — choosing it from
 * measurements is the entire point of the harness.
 */
export const DEFAULT_FLOOR = 4;

export function variantByName(name: string, floor = DEFAULT_FLOOR): Variant {
  const v = VARIANTS.find((x) => x.name === name);
  if (!v) {
    throw new Error(`unknown variant "${name}" — known: ${VARIANTS.map((x) => x.name).join(', ')}`);
  }
  if (v.name !== 'cap-as-floor' || floor === DEFAULT_FLOOR) return v;
  return {
    ...v,
    name: `cap-as-floor:${floor}`,
    what: v.what.replace('slots', `${floor} slots`),
    options: (_q, nowMs) => ({ nowMs, minNonSessionSlots: floor }),
  };
}

export const BASELINE = VARIANTS[0]!;

/**
 * Sanity check available to tests: the baseline variant must be *exactly* the
 * shipped configuration, or every delta in every report is measured against
 * something the product does not do.
 */
export function baselineMatchesShipped(): boolean {
  const opts = BASELINE.options({} as EvalQuery, 0);
  const keys = Object.keys(opts).filter((k) => k !== 'nowMs');
  return keys.length === 0 && DEFAULT_RERANK.maxSessionFraction === 0.5;
}
