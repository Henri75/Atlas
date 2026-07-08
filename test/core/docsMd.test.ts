import { describe, expect, it } from 'vitest';
import { parseMarkdownDoc } from '@kdbscope/core';

const ctx = {
  projectSlug: 'deepcast',
  sourcePath: '/data/code/DeepCast/docs/adr/20260703-legacy-llm.md',
  modifiedAt: '2026-07-03T12:00:00Z',
};

const DOC = `---
title: some frontmatter
---
# ADR: Legacy LLM path retired

Intro paragraph that is long enough to be interesting and pass the minimum length filter for sections.

## Context

The legacy path carried an idle-in-transaction hazard across LLM calls and was proven dormant via 24h of production logs before deletion.

## Tiny

x
`;

describe('parseMarkdownDoc', () => {
  it('splits on H1/H2, strips frontmatter, skips tiny sections', () => {
    const entries = parseMarkdownDoc(DOC, ctx);
    const titles = entries.map((e) => e.title);
    expect(titles.some((t) => t.includes('ADR: Legacy LLM path retired'))).toBe(true);
    expect(titles.some((t) => t.includes('Context'))).toBe(true);
    expect(titles.some((t) => t.includes('Tiny'))).toBe(false);
    expect(entries.every((e) => e.sourceType === 'doc')).toBe(true);
    expect(entries.every((e) => !e.body.includes('frontmatter'))).toBe(true);
    expect(entries[0]!.occurredAt).toBe('2026-07-03T12:00:00Z');
  });
});
