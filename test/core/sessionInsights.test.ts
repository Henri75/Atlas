import { describe, expect, it, vi } from 'vitest';
import {
  ALL_SECTION_IDS,
  DEFAULT_SECTION_IDS,
  SessionInsightsService,
  buildNarrativeInput,
  buildNarrativePrompt,
  commandName,
  insightsCacheKey,
  parseActionLine,
  parseNarrative,
  resolveSections,
  rollupActions,
  scanFollowups,
  type SessionRowFull,
} from '@atlas/core';

function row(over: Partial<SessionRowFull> = {}): SessionRowFull {
  return {
    sessionId: 's1',
    projectId: 1,
    projectSlug: 'deepcast',
    title: 'Fix the collector',
    startedAt: '2026-08-10T10:00:00.000Z',
    endedAt: '2026-08-10T12:00:00.000Z',
    promptCount: 3,
    actionCount: 12,
    entryCount: 80,
    filesTouched: ['/repo/a.ts'],
    sourcePath: '/t.jsonl',
    ...over,
  };
}

describe('parseActionLine', () => {
  it('splits on the FIRST separator so a command keeps its own colons', () => {
    expect(parseActionLine('Bash: git commit -m "fix: dedupe results"')).toEqual({
      tool: 'Bash',
      target: 'git commit -m "fix: dedupe results"',
    });
  });

  it('reads an edit target as a path and a bare tool with no target', () => {
    expect(parseActionLine('Edit: packages/core/src/ask.ts')).toEqual({
      tool: 'Edit',
      target: 'packages/core/src/ask.ts',
    });
    expect(parseActionLine('Task')).toEqual({ tool: 'Task' });
  });

  it('rejects prose that merely contains a colon', () => {
    expect(parseActionLine('Note: this is not a tool call')).toBeNull();
    expect(parseActionLine('')).toBeNull();
    expect(parseActionLine('   ')).toBeNull();
  });
});

describe('commandName', () => {
  it('reports the verb after navigation, not the navigation', () => {
    expect(commandName('cd /repo && make test')).toBe('make');
    expect(commandName('FOO=1 npm run build')).toBe('npm');
    expect(commandName('sudo docker ps')).toBe('docker');
  });

  /**
   * Measured regression. A live session reported `DeepCast;` as its top command
   * 145 times, because `;` was not treated as a separator and `cd`'s path
   * argument was read as the verb.
   */
  it('does not report a directory as the command (the DeepCast; regression)', () => {
    expect(commandName('cd /Users/serge/_CODING/DeepCast; make backend-recreate')).toBe('make');
    expect(commandName('cd /repo; ls')).toBe('ls');
    expect(commandName('a | b')).toBe('b');
  });

  it('returns nothing usable rather than a junk token', () => {
    // Targets are truncated at 80 chars by the transcript parser, so a long
    // one-liner can be left with no verb at all.
    expect(commandName('f=/private/tmp/claude-501/-Users-serge--CODING-DeepCast/ee096e22-324b')).toBe('');
    expect(commandName('')).toBe('');
  });

  it('strips a path so the same tool aggregates', () => {
    expect(commandName('/usr/local/bin/psql -c "select 1"')).toBe('psql');
  });
});

describe('rollupActions', () => {
  it('separates edits, commands and agents and counts repeats', () => {
    const r = rollupActions([
      'Edit: a.ts\nBash: make test',
      'Edit: a.ts\nBash: cd x && make test\nSkill: superpowers:tdd',
    ]);
    expect(r.files[0]).toEqual({ path: 'a.ts', count: 2 });
    expect(r.commands[0]).toEqual({ name: 'make', count: 2 });
    expect(r.agents).toContain('superpowers:tdd');
    expect(r.totalActions).toBe(5);
  });

  it('is empty rather than throwing on a session with no actions', () => {
    const r = rollupActions([]);
    expect(r.totalActions).toBe(0);
    expect(r.files).toEqual([]);
  });
});

describe('scanFollowups', () => {
  it('captures the sentence around a marker, not the whole message', () => {
    const found = scanFollowups([
      {
        id: 1,
        body: 'We shipped the fix. This is a TEMPORARY PATCH until the upstream lands. Everything else is fine.',
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.marker).toBe('temporary-patch');
    expect(found[0]!.sentence).toBe('This is a TEMPORARY PATCH until the upstream lands.');
  });

  it('finds the project conventions that actually matter here', () => {
    const markers = scanFollowups([
      { id: 1, body: 'Appended one line to kdb/backlog.log for the follow-up.' },
      { id: 2, body: 'The cause is unverified so far.' },
    ]).map((m) => m.marker);
    expect(markers).toContain('backlog');
    expect(markers).toContain('unverified');
  });

  it('does not report the same loose end twice', () => {
    const found = scanFollowups([
      { id: 1, body: 'TODO: rebuild the index.' },
      { id: 2, body: 'TODO: rebuild the index.' },
    ]);
    expect(found).toHaveLength(1);
  });

  it('caps its output', () => {
    const body = Array.from({ length: 60 }, (_, i) => `TODO item ${i}.`).join(' ');
    expect(scanFollowups([{ id: 1, body }]).length).toBeLessThanOrEqual(25);
  });

  it('returns nothing for prose with no markers', () => {
    expect(scanFollowups([{ id: 1, body: 'All done and verified in CI.' }])).toEqual([]);
  });
});

describe('resolveSections', () => {
  it('defaults to every default section', () => {
    expect(resolveSections()).toEqual(DEFAULT_SECTION_IDS);
    expect(resolveSections([])).toEqual(DEFAULT_SECTION_IDS);
  });

  it('honours a subset and drops ids it does not know', () => {
    expect(resolveSections(['overview', 'nonsense'])).toEqual(['overview']);
  });

  it('falls back to defaults when nothing requested is valid', () => {
    expect(resolveSections(['nope'])).toEqual(DEFAULT_SECTION_IDS);
  });

  it('every default is a real section', () => {
    expect(DEFAULT_SECTION_IDS.every((id) => ALL_SECTION_IDS.includes(id))).toBe(true);
  });
});

describe('insightsCacheKey', () => {
  const base = {
    sessionId: 's1',
    sections: ['overview', 'decisions'],
    llm: true,
    model: 'gemini-2.5-flash',
    entryCount: 10,
    endedAt: '2026-08-10T12:00:00.000Z',
  };

  it('is stable and order-insensitive across section ordering', () => {
    expect(insightsCacheKey(base)).toBe(
      insightsCacheKey({ ...base, sections: ['decisions', 'overview'] }),
    );
  });

  it.each([
    ['a grown session', { entryCount: 11 }],
    ['a later end', { endedAt: '2026-08-10T13:00:00.000Z' }],
    ['a different model', { model: 'other' }],
    ['the llm switched off', { llm: false }],
    ['a different section set', { sections: ['overview'] }],
  ])('misses for %s', (_label, over) => {
    expect(insightsCacheKey({ ...base, ...(over as any) })).not.toBe(insightsCacheKey(base));
  });
});

describe('parseNarrative', () => {
  it('reads a plain JSON object', () => {
    const n = parseNarrative('{"headline":"Fixed the collector","summary":["a","b"]}');
    expect(n?.headline).toBe('Fixed the collector');
    expect(n?.summary).toEqual(['a', 'b']);
  });

  it('survives a code fence and a sentence of preamble', () => {
    const n = parseNarrative('Sure! Here you go:\n```json\n{"headline":"x"}\n```');
    expect(n?.headline).toBe('x');
  });

  it('accepts a bare string where a list of objects was asked for', () => {
    const n = parseNarrative('{"decisions":["use RRF"]}');
    expect(n?.decisions).toEqual([{ text: 'use RRF' }]);
  });

  it('drops entries with no text rather than rendering blanks', () => {
    const n = parseNarrative('{"decisions":[{"why":"reason with no decision"}],"headline":"x"}');
    expect(n?.decisions).toBeUndefined();
  });

  it('returns undefined for junk, so the caller can report honestly', () => {
    expect(parseNarrative('not json at all')).toBeUndefined();
    expect(parseNarrative('')).toBeUndefined();
    expect(parseNarrative('{"unrelated": 3}')).toBeUndefined();
  });
});

describe('buildNarrativeInput', () => {
  const facts: any = {
    overview: {},
    goals: [{ entryId: 1, text: 'make the collector stop dropping rows' }],
    highlights: [{ entryId: 2, kind: 'insight', text: 'the bottleneck was the lock, not the CPU' }],
    followupMarkers: [{ entryId: 3, marker: 'todo', sentence: 'TODO: add the regression test.' }],
    did: { files: [{ path: 'a.ts', count: 2 }], commands: [{ name: 'make', count: 3 }], tools: [], agents: [], totalActions: 5 },
    trail: [{ entryId: 4, sourceType: 'git_commit', title: 'bugfix(collector): hold the lock briefly' }],
  };

  it('carries every kind of evidence the model needs', () => {
    const text = buildNarrativeInput(facts);
    expect(text).toContain('ASKED:');
    expect(text).toContain('INSIGHT:');
    expect(text).toContain('LOOSE END (todo)');
    expect(text).toContain('EDITED:');
    expect(text).toContain('RECORDED (git_commit)');
  });

  it('respects the budget — the largest session here is 1,304 entries', () => {
    const huge: any = {
      overview: {},
      highlights: Array.from({ length: 500 }, (_, i) => ({ entryId: i, kind: 'insight', text: 'x'.repeat(1000) })),
    };
    expect(buildNarrativeInput(huge).length).toBeLessThanOrEqual(14_000);
  });

  it('is empty for a session with no prose at all', () => {
    expect(buildNarrativeInput({ overview: {} } as any)).toBe('');
  });
});

describe('buildNarrativePrompt', () => {
  it('asks only for the sections that were requested', () => {
    const p = buildNarrativePrompt('evidence', ['overview', 'decisions']);
    expect(p).toContain('"decisions"');
    expect(p).not.toContain('"problems"');
  });
});

/** Catalog/LLM stand-ins: the seams that matter are caching and degradation. */
function makeService(over: { rows?: SessionRowFull[]; cache?: Map<string, any> } = {}) {
  const cache = over.cache ?? new Map<string, any>();
  const puts: string[] = [];
  const catalog = {
    sessionRows: async (ids: string[]) => (over.rows ?? [row()]).filter((r) => ids.includes(r.sessionId)),
    sessionKindCounts: async () => ({ prompt: 3, insight: 2 }),
    sessionEntriesByKind: async (_id: string, kinds: string[]) =>
      kinds.includes('prompt')
        ? [{ id: 1, title: 't', body: 'make the collector stop dropping rows', occurredAt: undefined, kind: 'prompt' }]
        : kinds.includes('action')
          ? [{ id: 3, title: 't', body: 'Edit: a.ts\nBash: make test', kind: 'action' }]
          : [{ id: 2, title: 't', body: 'the bottleneck was the lock', kind: 'insight' }],
    entriesInWindow: async () => [],
    normalizeFiles: async (paths: string[]) => paths,
    getSessionInsights: async (id: string, key: string) => cache.get(`${id}:${key}`) ?? null,
    putSessionInsights: async (id: string, key: string, payload: unknown) => {
      puts.push(key);
      cache.set(`${id}:${key}`, { payload, generatedAt: '2026-08-10T12:00:00.000Z' });
    },
  } as any;
  return { catalog, cache, puts };
}

describe('SessionInsightsService', () => {
  const llmCfg = { provider: 'g2p', model: 'm', baseUrl: 'http://x/v1' } as any;

  it('returns null for a session that does not exist', async () => {
    const { catalog } = makeService({ rows: [] });
    expect(await new SessionInsightsService(catalog, llmCfg).insights('ghost')).toBeNull();
  });

  it('produces a complete factual report with the LLM off', async () => {
    const { catalog } = makeService();
    const r = await new SessionInsightsService(catalog, llmCfg).insights('s1', { llm: false });
    expect(r!.llm.status).toBe('off');
    expect(r!.narrative).toBeUndefined();
    expect(r!.facts.overview.title).toBe('Fix the collector');
    expect(r!.facts.goals?.[0]!.text).toContain('collector');
    expect(r!.facts.did?.commands[0]!.name).toBe('make');
  });

  it('caches a report and serves the second call from it', async () => {
    const { catalog, puts } = makeService();
    const svc = new SessionInsightsService(catalog, llmCfg);
    const first = await svc.insights('s1', { llm: false });
    const second = await svc.insights('s1', { llm: false });
    expect(first!.cached).toBe(false);
    expect(second!.cached).toBe(true);
    expect(puts).toHaveLength(1);
  });

  it('regenerates when asked to refresh', async () => {
    const { catalog, puts } = makeService();
    const svc = new SessionInsightsService(catalog, llmCfg);
    await svc.insights('s1', { llm: false });
    const again = await svc.insights('s1', { llm: false, refresh: true });
    expect(again!.cached).toBe(false);
    expect(puts).toHaveLength(2);
  });

  it('keeps the facts and says so when the LLM call fails', async () => {
    const { catalog, puts } = makeService();
    // 400 rather than 500 on purpose: llm.ts retries 429/5xx three times with
    // backoff, and this test is about the degradation contract, not the retry
    // policy (which llmComplete.test.ts already pins).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })));
    const r = await new SessionInsightsService(catalog, llmCfg).insights('s1', {
      sections: ['overview', 'goals', 'decisions'],
    });
    expect(r!.llm.status).toBe('unavailable');
    expect(r!.facts.goals).toBeTruthy();
    // A transient gateway failure must not be cached as if it were the answer.
    expect(puts).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('shares one generation between concurrent callers', async () => {
    const { catalog, puts } = makeService();
    const svc = new SessionInsightsService(catalog, llmCfg);
    const [a, b] = await Promise.all([
      svc.insights('s1', { llm: false }),
      svc.insights('s1', { llm: false }),
    ]);
    expect(puts).toHaveLength(1);
    expect(a!.sessionId).toBe(b!.sessionId);
  });

  it('ranks trail records that touched the same files above nearby noise', async () => {
    const { catalog } = makeService();
    // A busy project records a lot in six hours; the commit sharing a file is
    // this session's trail, the one that merely happened nearby is background.
    catalog.entriesInWindow = async () => [
      { id: 1, sourceType: 'kdb_changelog', title: 'unrelated work', meta: {} },
      { id: 2, sourceType: 'git_commit', title: 'the actual fix', meta: { files: ['/repo/a.ts'] } },
    ];
    const r = await new SessionInsightsService(catalog, llmCfg).insights('s1', {
      sections: ['trail'],
      llm: false,
    });
    expect(r!.facts.trail![0]).toMatchObject({ entryId: 2, sharedFiles: ['/repo/a.ts'] });
    expect(r!.facts.trail![1]!.sharedFiles).toBeUndefined();
  });

  it('does not call the LLM when no LLM section was requested', async () => {
    const { catalog } = makeService();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await new SessionInsightsService(catalog, llmCfg).insights('s1', {
      sections: ['overview', 'did'],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r!.llm.status).toBe('off');
    vi.unstubAllGlobals();
  });
});
