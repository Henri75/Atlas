import { describe, expect, it } from 'vitest';
import { buildAskPrompt } from '@atlas/core';
import type { SearchHit } from '@atlas/core';

const hits: SearchHit[] = [
  {
    entryId: 1,
    score: 0.9,
    projectSlug: 'deepcast',
    sourceType: 'kdb_component',
    component: 'video-import',
    title: 'video-import: timeout fix',
    snippet: 'short snippet',
    occurredAt: '2026-07-08T22:00:00Z',
    sourcePath: '/x/kdb/components/video-import.log',
  },
  {
    entryId: 2,
    score: 0.5,
    projectSlug: 'swan',
    sourceType: 'git_commit',
    title: 'fix: retry logic',
    snippet: 'fallback snippet',
    sourcePath: '/x/.git',
  },
];

describe('buildAskPrompt', () => {
  it('numbers blocks, includes project/source/component/date and full bodies', () => {
    const bodies = new Map([[1, 'FULL BODY ONE '.repeat(10)]]);
    const prompt = buildAskPrompt('what was fixed?', hits, bodies);
    expect(prompt).toContain('[1] deepcast / kdb_component / video-import (2026-07-08)');
    expect(prompt).toContain('FULL BODY ONE');
    // Entry 2 has no body in the map → falls back to its snippet.
    expect(prompt).toContain('[2] swan / git_commit');
    expect(prompt).toContain('fallback snippet');
    expect(prompt.endsWith('Question: what was fixed?')).toBe(true);
  });

  it('caps body length at 1500 chars per block', () => {
    const bodies = new Map([[1, 'y'.repeat(9000)]]);
    const prompt = buildAskPrompt('q', [hits[0]!], bodies);
    const block = prompt.split('Question:')[0]!;
    expect(block.length).toBeLessThan(2000);
  });
});

describe('buildAskPrompt staleness labels', () => {
  it('marks archived and aging blocks so the model can discount them', () => {
    const docHits: SearchHit[] = [
      {
        ...hits[0]!,
        entryId: 3,
        sourceType: 'doc',
        docStatus: 'archived',
        ageMonths: 20,
        sourcePath: '/x/docs/_legacy/auth.md',
      },
      { ...hits[0]!, entryId: 4, sourceType: 'doc', docStatus: 'aging', ageMonths: 14 },
      { ...hits[0]!, entryId: 5, sourceType: 'doc' },
    ];
    const prompt = buildAskPrompt('q', docHits, new Map());
    expect(prompt).toContain('[1] deepcast / doc / video-import (2026-07-08) [ARCHIVED — 20 mo old]');
    expect(prompt).toContain('[2] deepcast / doc / video-import (2026-07-08) [AGING — 14 mo old]');
    // Active blocks stay unlabeled.
    expect(prompt.split('\n\n---\n\n')[2]).not.toContain('[A');
  });
});

/**
 * The 2026-07-15 regression. Ask told an agent "the indexed history for July
 * 2026 concludes on 2026-07-15" because its 14 retrieved blocks stopped there —
 * while 34,825 newer entries sat in the catalog. The agent believed it and
 * abandoned a correct line of investigation.
 *
 * The fix is not to instruct the model harder; it is to put the measurement in
 * front of it so it never has to infer coverage from its sample.
 */
describe('buildAskPrompt coverage block', () => {
  const coverage = [
    { projectSlug: 'deepcast', entries: 151368, oldest: '2025-11-17T19:33:13Z', newest: '2026-07-25T22:49:16Z' },
  ];

  it('states measured coverage per project, not for the index as a whole', () => {
    const prompt = buildAskPrompt('what happened on 2026-07-21?', hits, new Map(), { coverage });
    expect(prompt).toContain('deepcast');
    expect(prompt).toContain('2026-07-25'); // newest, contradicting the retrieved sample
    expect(prompt).toContain('151,368');
  });

  it('reports the asked window AND its neighbourhood', () => {
    const prompt = buildAskPrompt('what happened on 2026-07-21?', hits, new Map(), {
      coverage,
      window: {
        since: '2026-07-21T00:00:00.000Z',
        until: '2026-07-21T23:59:59.999Z',
        exact: 0,
        paddedSince: '2026-07-18T00:00:00.000Z',
        paddedUntil: '2026-07-24T23:59:59.999Z',
        padded: 412,
      },
    });
    // Both numbers must be present: "0 on the day" alone reads as "nothing
    // happened", which is the dead end being fixed.
    expect(prompt).toMatch(/2026-07-21/);
    expect(prompt).toMatch(/\b0\b/);
    expect(prompt).toContain('412');
  });

  it('marks the coverage block as uncitable so it cannot masquerade as a source', () => {
    const prompt = buildAskPrompt('q', hits, new Map(), { coverage });
    const before = prompt.slice(0, prompt.indexOf('Context blocks:'));
    // Numbered citations are reserved for real sources.
    expect(before).not.toMatch(/^\[\d+\]/m);
  });

  it('omits the block entirely when nothing was measured', () => {
    const prompt = buildAskPrompt('q', hits, new Map());
    expect(prompt).not.toContain('INDEX COVERAGE');
    expect(prompt.startsWith('Context blocks:')).toBe(true);
  });
});
