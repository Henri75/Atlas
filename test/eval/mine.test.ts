import { describe, expect, it } from 'vitest';
import { classify, consolidate, parseTranscriptLine, parseUsageRow } from '@atlas/eval/mine.js';
import type { MinedQuery } from '@atlas/eval/mine.js';

describe('parseUsageRow', () => {
  it('pulls the query and filters out of a GET search row', () => {
    const q = parseUsageRow({
      path: '/api/search',
      query: 'q=worker+pool+resize&project=deepcast&kind=summary&limit=4',
      id: 7,
    })!;
    expect(q.text).toBe('worker pool resize');
    expect(q.filters).toEqual({ project: 'deepcast', kind: 'summary' });
    // `limit` is not a filter — it changes how many hits come back, and the
    // harness sets its own cutoffs.
    expect(q.filters).not.toHaveProperty('limit');
    expect(q.ref).toBe('usage_log#7');
  });

  it('reads a comma-separated project list as a multi-project scope', () => {
    const q = parseUsageRow({ path: '/api/search', query: 'q=x&project=a,b' })!;
    expect(q.filters).toEqual({ projects: ['a', 'b'] });
  });

  /**
   * Ask rows hold the bare question, not a URL query string. Deciding on the
   * path rather than sniffing the text keeps a question that happens to contain
   * "q=" from being parsed as query parameters.
   */
  it('treats an ask row as a bare question', () => {
    const q = parseUsageRow({ path: '/api/ask', query: 'why did q=5 break the parser?' })!;
    expect(q.text).toBe('why did q=5 break the parser?');
    expect(q.filters).toEqual({});
  });

  it('skips rows with nothing to mine', () => {
    // atlas_timeline and friends log only a limit; there is no query in them.
    expect(parseUsageRow({ path: '/api/timeline', query: 'limit=15' })).toBeNull();
    expect(parseUsageRow({ path: '/api/ask', query: '   ' })).toBeNull();
  });

  it('carries the timestamp through as an ISO string', () => {
    const q = parseUsageRow({
      path: '/api/search',
      query: 'q=x',
      at: new Date('2026-07-20T10:00:00.000Z'),
    })!;
    expect(q.at).toBe('2026-07-20T10:00:00.000Z');
  });
});

describe('parseTranscriptLine', () => {
  const line = (content: unknown) =>
    JSON.stringify({ timestamp: '2026-07-22T21:21:18.928Z', message: { content } });

  it('extracts an atlas_ask call', () => {
    const out = parseTranscriptLine(
      line([{ type: 'tool_use', name: 'mcp__atlas__atlas_ask', input: { question: 'why X?' } }]),
      'proj/a.jsonl',
    );
    expect(out).toEqual([
      expect.objectContaining({ text: 'why X?', source: 'transcript', ref: 'proj/a.jsonl' }),
    ]);
  });

  it('extracts an atlas_search call with its scope', () => {
    const out = parseTranscriptLine(
      line([
        {
          type: 'tool_use',
          name: 'mcp__atlas__atlas_search',
          input: { query: 'crash bisect', project: 'deepcast', limit: 10 },
        },
      ]),
      'r',
    );
    expect(out[0]!.filters).toEqual({ project: 'deepcast' });
  });

  /**
   * The tool *schemas* appear in the system prompt of nearly every transcript, so
   * the marker matches hundreds of files that contain no calls at all. Only a
   * tool_use block is a call.
   */
  it('ignores a tool definition that merely mentions the tool name', () => {
    const definition = JSON.stringify({
      message: { content: [{ type: 'text', text: 'you may call mcp__atlas__atlas_ask' }] },
    });
    expect(parseTranscriptLine(definition, 'r')).toEqual([]);
  });

  it('ignores other MCP tools and non-atlas calls', () => {
    const out = parseTranscriptLine(
      line([{ type: 'tool_use', name: 'mcp__atlas__atlas_status', input: {} }]),
      'r',
    );
    expect(out).toEqual([]);
  });

  it('survives malformed lines rather than aborting the scan', () => {
    // A 12 GB scan must not die on one truncated line.
    expect(parseTranscriptLine('{not json', 'r')).toEqual([]);
    expect(parseTranscriptLine('{}', 'r')).toEqual([]);
    expect(parseTranscriptLine(JSON.stringify({ message: { content: 'text' } }), 'r')).toEqual([]);
  });

  it('reads several calls from one assistant message', () => {
    const out = parseTranscriptLine(
      line([
        { type: 'tool_use', name: 'mcp__atlas__atlas_search', input: { query: 'a' } },
        { type: 'tool_use', name: 'mcp__atlas__atlas_search', input: { query: 'b' } },
      ]),
      'r',
    );
    expect(out.map((q) => q.text)).toEqual(['a', 'b']);
  });
});

describe('consolidate', () => {
  const m = (text: string, over: Partial<MinedQuery> = {}): MinedQuery => ({
    text,
    filters: {},
    source: 'usage_log',
    ...over,
  });

  /**
   * The real log is 60 × `burst N` and 20 × `qdrant quantization concurrency N`
   * — throughput probes from earlier performance work. A literal blocklist would
   * need hand-maintaining for the next probe; the shape (many texts differing
   * only by a number) is what actually identifies them.
   */
  it('drops load-test templates and says exactly what it dropped', () => {
    const mined = [
      ...Array.from({ length: 8 }, (_, i) => m(`burst ${i}`)),
      m('why was nvidia removed from the chain?'),
    ];
    const { queries, report } = consolidate(mined);
    expect(queries).toHaveLength(1);
    expect(report.droppedLoadTests).toEqual([{ template: 'burst #', count: 8 }]);
  });

  it('keeps a genuine query that merely contains a number', () => {
    const { queries } = consolidate([m('qdrant int8 quantization footprint'), m('burst 1')]);
    // One-off numeric text is not a template; both survive.
    expect(queries).toHaveLength(2);
  });

  it('collapses repeats and keeps the earliest provenance', () => {
    const { queries, report } = consolidate([
      m('same question', { at: '2026-07-01T00:00:00.000Z', ref: 'first' }),
      m('same question', { at: '2026-07-20T00:00:00.000Z', ref: 'second' }),
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.provenance.ref).toBe('first');
    // Both sightings are still counted, so the report describes traffic rather
    // than the deduplicated set.
    expect(report.fromUsageLog).toBe(2);
    expect(report.distinct).toBe(1);
  });

  it('treats the same text under different scopes as different queries', () => {
    const { queries } = consolidate([
      m('worker pool resize'),
      m('worker pool resize', { filters: { project: 'deepcast' } }),
    ]);
    expect(queries).toHaveLength(2);
  });

  it('files everything into pool A', () => {
    const { queries } = consolidate([m('x')]);
    expect(queries[0]!.pool).toBe('A');
  });
});

describe('classify', () => {
  it('reads a named date as temporal', () => {
    expect(classify('What happened on 2026-07-21 to cause failed jobs?')).toBe('temporal');
  });

  it('reads root-cause language as incident', () => {
    expect(classify('safari youtube content process crash bisect')).toBe('incident');
    expect(classify('videoinsight_low starvation fix queue workers')).toBe('incident');
  });

  it('reads a rationale question as intent', () => {
    expect(classify('why were the triggers rewritten instead of described?')).toBe('intent');
  });

  it('reads a how-to as procedural', () => {
    expect(classify('how to resize a worker pool safely')).toBe('procedural');
  });

  it('falls back to definitional', () => {
    expect(classify('nexus dynamic weight')).toBe('definitional');
  });

  /**
   * The heuristic keys on whether a date *appears*, and four of the 21 real
   * queries name a date while asking for a rationale. Those were corrected by
   * hand in the fixture, which is why the class is committed data and mining
   * never overwrites it.
   */
  it('is knowingly wrong when a date appears in a rationale question', () => {
    expect(classify('On July 19-20 2026 the chain changed. Why was nvidia removed?')).toBe(
      'temporal',
    );
  });
});
