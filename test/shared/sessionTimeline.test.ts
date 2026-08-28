import { describe, expect, it } from 'vitest';
import {
  SESSION_SECTION_IDS,
  describeBasis,
  describeDid,
  describeTimeline,
  layoutTimeline,
  relatedStrength,
  sectionMeta,
  substanceLabel,
  type TimelineInput,
} from '@atlas/shared';
import { ALL_SECTION_IDS } from '@atlas/core';

const at = (iso: string): string => new Date(iso).toISOString();

function node(id: string, iso: string | undefined, over: Partial<TimelineInput> = {}): TimelineInput {
  return { id, at: iso, kind: 'session', label: id, ...over };
}

describe('layoutTimeline', () => {
  it('keeps chronological order and spans the full axis', () => {
    const l = layoutTimeline([
      node('b', at('2026-08-05T00:00:00Z')),
      node('a', at('2026-08-01T00:00:00Z')),
      node('c', at('2026-08-20T00:00:00Z')),
    ]);
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n.pos]));
    expect(byId.a).toBe(0);
    expect(byId.c).toBe(1);
    expect(byId.a!).toBeLessThan(byId.b!);
    expect(byId.b!).toBeLessThan(byId.c!);
  });

  /**
   * The whole reason the axis is compressed. Linearly, an afternoon inside a
   * three-month span occupies 0.2% of the chart and is unreadable.
   */
  it('keeps a busy afternoon legible inside a three-month span', () => {
    const l = layoutTimeline([
      node('m1', at('2026-05-01T10:00:00Z')),
      node('m2', at('2026-05-01T13:00:00Z')),
      node('m3', at('2026-05-01T16:00:00Z')),
      node('later', at('2026-08-01T10:00:00Z')),
    ]);
    const p = Object.fromEntries(l.nodes.map((n) => [n.id, n.pos]));
    const afternoon = p.m3! - p.m1!;
    const silence = p.later! - p.m3!;
    // Linear time gives the afternoon 6h / 92d ≈ 0.003 of the axis; plain
    // log1p gave it 0.049, still narrower than the nodes drawn on it.
    expect(afternoon).toBeGreaterThan(0.1);
    // …but the three-month silence must still read as much wider than an
    // afternoon, or the axis has stopped meaning anything at all.
    expect(silence).toBeGreaterThan(afternoon * 2);
    expect(l.compressed).toBe(true);
  });

  it('centres a single dated event', () => {
    const l = layoutTimeline([node('only', at('2026-08-01T00:00:00Z'))]);
    expect(l.nodes[0]!.pos).toBe(0.5);
    expect(l.compressed).toBe(false);
  });

  it('spaces evenly, and never divides by zero, when every event shares a timestamp', () => {
    const iso = at('2026-08-01T00:00:00Z');
    const l = layoutTimeline([node('a', iso), node('b', iso), node('c', iso)]);
    expect(l.nodes.map((n) => n.pos)).toEqual([0, 0.5, 1]);
    expect(l.nodes.every((n) => Number.isFinite(n.pos))).toBe(true);
  });

  it('spaces evenly when nothing has a usable timestamp', () => {
    const l = layoutTimeline([node('a', undefined), node('b', 'not-a-date')]);
    expect(l.nodes.map((n) => n.pos)).toEqual([0, 1]);
    expect(l.ticks).toEqual([]);
  });

  it('never drops an undated result from a dated set', () => {
    const l = layoutTimeline([node('a', at('2026-08-01T00:00:00Z')), node('ghost', undefined)]);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(['a', 'ghost']);
  });

  it('handles an empty input', () => {
    const l = layoutTimeline([]);
    expect(l.nodes).toEqual([]);
    expect(l.edges).toEqual([]);
  });

  it('draws the anchor largest and gives every node a clickable size', () => {
    const l = layoutTimeline([
      node('anchor', at('2026-08-01T00:00:00Z'), { kind: 'anchor' }),
      node('tiny', at('2026-08-02T00:00:00Z'), { weight: 0 }),
    ]);
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n.size]));
    expect(byId.anchor).toBe(1);
    expect(byId.tiny).toBeGreaterThan(0);
    expect(byId.tiny!).toBeLessThan(byId.anchor!);
  });

  it('puts context events in their own lane', () => {
    const l = layoutTimeline([
      node('s', at('2026-08-01T00:00:00Z')),
      node('c', at('2026-08-02T00:00:00Z'), { kind: 'event' }),
    ]);
    expect(l.nodes.find((n) => n.id === 's')!.lane).toBe(0);
    expect(l.nodes.find((n) => n.id === 'c')!.lane).toBe(1);
  });

  it('links only nodes that genuinely share files, weighted by how many', () => {
    const l = layoutTimeline([
      node('a', at('2026-08-01T00:00:00Z'), { files: ['x.ts', 'y.ts'] }),
      node('b', at('2026-08-02T00:00:00Z'), { files: ['x.ts', 'y.ts'] }),
      node('c', at('2026-08-03T00:00:00Z'), { files: ['z.ts'] }),
    ]);
    expect(l.edges).toEqual([{ from: 'a', to: 'b', shared: 2 }]);
  });

  it('caps the number of links so a dense set stays readable', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      node(`n${i}`, at(`2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`), { files: ['x.ts'] }),
    );
    expect(layoutTimeline(many, { maxEdges: 5 }).edges).toHaveLength(5);
  });

  it('places ticks at positions events actually occupy', () => {
    const l = layoutTimeline([
      node('a', at('2026-08-01T00:00:00Z')),
      node('b', at('2026-08-10T00:00:00Z')),
      node('c', at('2026-09-20T00:00:00Z')),
    ]);
    expect(l.ticks.length).toBeGreaterThan(0);
    for (const t of l.ticks) {
      expect(l.nodes.some((n) => Math.abs(n.pos - t.pos) < 0.001)).toBe(true);
    }
  });
});

describe('describeTimeline', () => {
  it('says the axis is compressed, so nobody reads it as linear time', () => {
    const l = layoutTimeline([
      node('a', at('2026-05-01T00:00:00Z')),
      node('b', at('2026-08-01T00:00:00Z')),
    ]);
    const text = describeTimeline(l);
    expect(text).toContain('2 sessions');
    expect(text).toContain('not linear time');
  });

  it('counts context records separately from sessions', () => {
    const l = layoutTimeline([
      node('a', at('2026-05-01T00:00:00Z')),
      node('c', at('2026-05-02T00:00:00Z'), { kind: 'event' }),
    ]);
    expect(describeTimeline(l)).toContain('1 related record');
  });
});

describe('section registry parity', () => {
  /**
   * The server decides which sections exist; this package names them. A
   * section added on one side and missing on the other would render as a raw
   * id in both clients, which is exactly the drift this pins.
   */
  it('labels exactly the sections the server can produce', () => {
    expect([...SESSION_SECTION_IDS].sort()).toEqual([...ALL_SECTION_IDS].sort());
  });

  it('marks the LLM-derived sections as such', () => {
    expect(sectionMeta('decisions').source).toBe('llm');
    expect(sectionMeta('problems').source).toBe('llm');
    expect(sectionMeta('followups').source).toBe('mixed');
    expect(sectionMeta('did').source).toBe('facts');
  });

  it('falls back to the raw id rather than throwing on an unknown section', () => {
    expect(sectionMeta('brand-new').label).toBe('brand-new');
  });
});

describe('wording helpers', () => {
  it('bands relatedness rather than exposing a raw score', () => {
    expect(relatedStrength(0.8)).toBe('strong');
    expect(relatedStrength(0.4)).toBe('likely');
    expect(relatedStrength(0.1)).toBe('loose');
  });

  it('warns plainly when the only basis was timing', () => {
    expect(describeBasis(['temporal'])).toContain('not as related work');
    expect(describeBasis(['file', 'semantic'])).toContain('shared files and subject');
    expect(describeBasis([])).toContain('No basis');
  });

  it('describes what was done without emitting empty clauses', () => {
    expect(describeDid({ tools: [], files: [{ path: 'a', count: 1 }], commands: [], agents: [], totalActions: 1 })).toBe(
      '1 file edited',
    );
    expect(describeDid({ tools: [], files: [], commands: [], agents: [], totalActions: 0 })).toBe('');
    expect(describeDid(undefined)).toBe('');
  });

  it('labels session weight in words', () => {
    expect(substanceLabel(0.9)).toBe('deep session');
    expect(substanceLabel(0.05)).toBe('brief session');
  });
});
