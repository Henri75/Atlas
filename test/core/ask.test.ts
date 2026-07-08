import { describe, expect, it } from 'vitest';
import { buildAskPrompt } from '@kdbscope/core';
import type { SearchHit } from '@kdbscope/core';

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
