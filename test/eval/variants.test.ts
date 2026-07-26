import { describe, expect, it } from 'vitest';
import { rerankForContext } from '@atlas/core';
import type { SearchHit } from '@atlas/core';
import {
  BASELINE,
  DEFAULT_FLOOR,
  VARIANTS,
  baselineMatchesShipped,
  isTimeScoped,
  variantByName,
} from '@atlas/eval/variants.js';
import { queryId } from '@atlas/eval/pools.js';
import type { EvalQuery } from '@atlas/eval/types.js';

const NOW = Date.parse('2026-07-26T00:00:00.000Z');

const query = (text: string, filters: EvalQuery['filters'] = {}): EvalQuery => ({
  id: queryId(text, filters),
  pool: 'A',
  text,
  class: 'temporal',
  filters,
  provenance: { source: 'usage_log' },
});

const hit = (id: number, score: number, sourceType: SearchHit['sourceType']): SearchHit => ({
  entryId: id,
  score,
  projectSlug: 'p',
  sourceType,
  title: `t${id}`,
  snippet: 's',
  occurredAt: new Date(NOW - 864e5).toISOString(),
  sourcePath: `/x${id}`,
});

/** Sessions out-weigh everything else, so the cap is observable. */
const pool = (): SearchHit[] => [
  hit(1, 0.99, 'claude_session'),
  hit(2, 0.98, 'claude_session'),
  hit(3, 0.97, 'claude_session'),
  hit(4, 0.96, 'claude_session'),
  hit(5, 0.5, 'doc'),
  hit(6, 0.48, 'kdb_component'),
];

const sessionsIn = (hits: SearchHit[]) =>
  hits.filter((h) => h.sourceType === 'claude_session').length;

describe('variants', () => {
  /**
   * The single most important property in the harness: if the baseline is not
   * byte-identical to the shipped configuration, every delta in every report is
   * measured against something the product does not do.
   */
  it('baseline passes no ranking overrides at all', () => {
    expect(baselineMatchesShipped()).toBe(true);
    expect(Object.keys(BASELINE.options(query('x'), NOW))).toEqual(['nowMs']);
  });

  it('every variant has a name and a one-line description', () => {
    for (const v of VARIANTS) {
      expect(v.name).toMatch(/^[a-z-]+$/);
      expect(v.what.length).toBeGreaterThan(20);
    }
    // Names are unique — a report keyed on them would silently merge otherwise.
    expect(new Set(VARIANTS.map((v) => v.name)).size).toBe(VARIANTS.length);
  });

  it('pins the clock on every variant so runs are reproducible', () => {
    for (const v of VARIANTS) {
      expect(v.options(query('what happened on 2026-07-21?'), NOW).nowMs).toBe(NOW);
    }
  });

  it('no-recency removes the time term', () => {
    const v = variantByName('no-recency');
    expect(v.options(query('x'), NOW).recencyMaxBoost).toBe(0);
  });

  it('no-source-weight flattens type weighting', () => {
    const v = variantByName('no-source-weight');
    expect(v.options(query('x'), NOW).sourceWeight).toEqual({});
  });

  it('rejects an unknown variant by name instead of falling back', () => {
    expect(() => variantByName('nope')).toThrow(/unknown variant/);
  });
});

describe('relax-when-scoped', () => {
  const v = variantByName('relax-when-scoped');

  it('lifts the cap only when the question carries time intent', () => {
    expect(v.options(query('what happened on 2026-07-21?'), NOW).maxSessionFraction).toBe(1);
    expect(v.options(query('what is the NEXUS drain feature?'), NOW).maxSessionFraction).toBeUndefined();
  });

  it('counts an explicit date filter as time intent', () => {
    expect(v.options(query('anything', { since: '2026-07-01' }), NOW).maxSessionFraction).toBe(1);
  });

  it('changes what reaches the context window for a temporal question', () => {
    const temporal = query('what happened on 2026-07-21?');
    const definitional = query('what is the drain feature?');
    expect(sessionsIn(rerankForContext(pool(), 4, v.options(temporal, NOW)))).toBe(4);
    // The definitional question keeps the shipped protection: this is the whole
    // proposal — recover recent-dense questions without reopening the bug where
    // Ask answers "what is X" from chatter about X.
    expect(sessionsIn(rerankForContext(pool(), 4, v.options(definitional, NOW)))).toBe(2);
  });
});

describe('isTimeScoped', () => {
  it('recognises dates in the text and date filters, and nothing else', () => {
    expect(isTimeScoped(query('what happened on 2026-07-21?'))).toBe(true);
    expect(isTimeScoped(query('x', { until: '2026-07-01' }))).toBe(true);
    expect(isTimeScoped(query('why was nvidia removed from the chain?'))).toBe(false);
  });
});

describe('cap-as-floor', () => {
  it('defaults to reserving DEFAULT_FLOOR slots', () => {
    expect(variantByName('cap-as-floor').options(query('x'), NOW).minNonSessionSlots).toBe(
      DEFAULT_FLOOR,
    );
  });

  it('is swept by floor value, and the swept name says which', () => {
    const v = variantByName('cap-as-floor', 2);
    expect(v.name).toBe('cap-as-floor:2');
    expect(v.options(query('x'), NOW).minNonSessionSlots).toBe(2);
  });

  it('keeps the authoritative guarantee while letting sessions take the rest', () => {
    const out = rerankForContext(pool(), 6, variantByName('cap-as-floor', 2).options(query('x'), NOW));
    // 2 slots reserved → at most 4 sessions, and the reserved slots are filled.
    expect(sessionsIn(out)).toBe(4);
    expect(out.some((h) => h.sourceType === 'doc')).toBe(true);
    expect(out.some((h) => h.sourceType === 'kdb_component')).toBe(true);
  });

  it('does not starve a genuinely session-only answer', () => {
    const sessionsOnly = pool().filter((h) => h.sourceType === 'claude_session');
    const out = rerankForContext(sessionsOnly, 4, variantByName('cap-as-floor', 3).options(query('x'), NOW));
    expect(out).toHaveLength(4);
  });
});
