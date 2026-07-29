import { describe, expect, it } from 'vitest';
import { buildBacklogView, backlogLineHash, parseBacklog } from '@atlas/core';
import type { BacklogSourceEntry, BacklogVerdict } from '@atlas/core';

/**
 * The view is derived at query time from indexed kdb_backlog entries — the
 * parser stores line-local facts (markers, lineHash), this service does every
 * cross-line judgment: ref verification, fuzzy legacy linking, verdict
 * overlay, latest-signal-wins status.
 */

const PATH = '/data/code/DeepCast/kdb/backlog.log';

/** Build entries via the real parser so tests exercise the true meta shapes. */
function entriesFrom(text: string): BacklogSourceEntry[] {
  return parseBacklog(text, { projectSlug: 'deepcast', sourcePath: PATH }).map((e, i) => ({
    id: i + 1,
    body: e.body,
    component: e.component,
    occurredAt: e.occurredAt,
    sourceRef: e.sourceRef!,
    meta: e.meta,
  }));
}

const hashOf = (line: string) => backlogLineHash(line);

describe('buildBacklogView', () => {
  it('lists plain items as open with default provenance', () => {
    const view = buildBacklogView(entriesFrom('- [2026-05-05] refactor MS5\n- [2026-05-06] fix Makefile'), []);
    expect(view.items).toHaveLength(2);
    expect(view.items[0]!).toMatchObject({ line: 1, status: 'open', provenance: 'default' });
    expect(view.counts).toEqual({ open: 2, resolved: 0, dropped: 0 });
  });

  it('applies a structured RESOLVED marker by line ref and excludes the marker from items', () => {
    const item = '- [2026-05-05] fix the Makefile build-local target';
    const text = `${item}\n- [2026-05-07] RESOLVED [L1#${hashOf(item)}]: Makefile build-local fixed (evidence: commit abc123)`;
    const view = buildBacklogView(entriesFrom(text), []);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]!).toMatchObject({ line: 1, status: 'resolved', provenance: 'structured' });
    expect(view.counts.resolved).toBe(1);
  });

  it('relocates a marker whose line ref is wrong but whose hash matches a unique line', () => {
    const target = '- [2026-05-05] fix the Makefile build-local target';
    const text = [
      '- [2026-05-04] some other item',
      target,
      `- [2026-05-07] RESOLVED [L9#${hashOf(target)}]: Makefile build-local fixed`,
    ].join('\n');
    const view = buildBacklogView(entriesFrom(text), []);
    const fixed = view.items.find((i) => i.line === 2)!;
    expect(fixed.status).toBe('resolved');
    expect(fixed.lints).toContain('relocated');
  });

  it('sends a marker with an unresolvable ref to unlinked and leaves items untouched', () => {
    const text = [
      '- [2026-05-05] item one',
      '- [2026-05-07] RESOLVED [L9#ffffff]: something that matches nothing',
    ].join('\n');
    const view = buildBacklogView(entriesFrom(text), []);
    expect(view.items[0]!.status).toBe('open');
    expect(view.unlinked).toHaveLength(1);
    expect(view.unlinked[0]!.lints).toContain('broken-link');
  });

  it('links a legacy DONE: marker by token containment', () => {
    const text = [
      '- [2026-07-09] Backfill restarts from entry 1 on indexer restart; persist a resume cursor so an interrupted re-embed does not redo finished pages',
      '- [2026-07-09] DONE: backfill resume cursor (persisted per collection in settings)',
    ].join('\n');
    const view = buildBacklogView(entriesFrom(text), []);
    expect(view.items[0]!).toMatchObject({ status: 'resolved', provenance: 'heuristic' });
  });

  it('sends a low-similarity legacy marker to unlinked instead of guessing', () => {
    const text = [
      '- [2026-07-09] Qdrant upserts use wait:true and blow the timeout',
      '- [2026-07-09] DONE: completely unrelated frobnicator work',
    ].join('\n');
    const view = buildBacklogView(entriesFrom(text), []);
    expect(view.items[0]!.status).toBe('open');
    expect(view.unlinked).toHaveLength(1);
  });

  it('sends a near-tie legacy match to unlinked with the candidates listed', () => {
    const text = [
      '- [2026-07-09] retry embed calls on transient failures in the indexer',
      '- [2026-07-09] retry upsert calls on transient failures in the indexer',
      '- [2026-07-10] DONE: retry calls on transient failures indexer',
    ].join('\n');
    const view = buildBacklogView(entriesFrom(text), []);
    expect(view.items.every((i) => i.status === 'open')).toBe(true);
    expect(view.unlinked[0]!.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('REOPENED after RESOLVED wins by file order and reopens the item', () => {
    const item = '- [2026-05-05] flaky healthcheck on dc-transcript';
    const text = [
      item,
      `- [2026-05-06] RESOLVED [L1#${hashOf(item)}]: healthcheck fixed`,
      `- [2026-05-08] REOPENED [L1#${hashOf(item)}]: regressed after the pg18 upgrade`,
    ].join('\n');
    const view = buildBacklogView(entriesFrom(text), []);
    expect(view.items[0]!.status).toBe('open');
    expect(view.items[0]!.provenance).toBe('structured');
    expect(view.items[0]!.markers).toHaveLength(2);
  });

  it('applies a confirmed-resolved verdict with not-written-back badge when no marker exists', () => {
    const verdict: BacklogVerdict = {
      sourcePath: PATH, line: 1, status: 'confirmed-resolved', confidence: 0.9,
      reviewer: 'atlas-llm:test', reviewedAt: '2026-07-28T10:00:00Z',
    };
    const view = buildBacklogView(entriesFrom('- [2026-05-05] fix the thing'), [verdict]);
    expect(view.items[0]!).toMatchObject({ status: 'resolved', provenance: 'reviewed' });
    expect(view.items[0]!.lints).toContain('not-written-back');
  });

  it('likely-resolved and inconclusive verdicts do not flip status', () => {
    const mk = (status: BacklogVerdict['status']): BacklogVerdict => ({
      sourcePath: PATH, line: 1, status, confidence: 0.5,
      reviewer: 'atlas-llm:test', reviewedAt: '2026-07-28T10:00:00Z',
    });
    for (const s of ['likely-resolved', 'inconclusive'] as const) {
      const view = buildBacklogView(entriesFrom('- [2026-05-05] fix the thing'), [mk(s)]);
      expect(view.items[0]!.status).toBe('open');
      expect(view.items[0]!.lints).toContain(s);
    }
  });

  it('a marker dated after the verdict beats the verdict; a newer verdict beats the marker', () => {
    const item = '- [2026-05-05] fix the thing';
    const marked = `${item}\n- [2026-07-20] RESOLVED [L1#${hashOf(item)}]: fixed`;
    const older: BacklogVerdict = {
      sourcePath: PATH, line: 1, status: 'confirmed-open', confidence: 0.8,
      reviewer: 'agent:claude-code', reviewedAt: '2026-07-10T10:00:00Z',
    };
    const newer: BacklogVerdict = { ...older, reviewedAt: '2026-07-25T10:00:00Z' };
    expect(buildBacklogView(entriesFrom(marked), [older]).items[0]!.status).toBe('resolved');
    expect(buildBacklogView(entriesFrom(marked), [newer]).items[0]!.status).toBe('open');
  });

  it('badges a verdict as stale-review when the project has newer activity', () => {
    const verdict: BacklogVerdict = {
      sourcePath: PATH, line: 1, status: 'confirmed-open', confidence: 0.8,
      reviewer: 'atlas-llm:test', reviewedAt: '2026-07-20T10:00:00Z',
    };
    const view = buildBacklogView(entriesFrom('- [2026-05-05] fix the thing'), [verdict], {
      latestActivityAt: '2026-07-28T00:00:00Z',
    });
    expect(view.items[0]!.lints).toContain('stale-review');
  });

  it('flags unstructured items and counts them as open', () => {
    const view = buildBacklogView(
      entriesFrom('VectorStore.updateSparse loses a whole 64-point slice on batch rejection'),
      [],
    );
    expect(view.items[0]!).toMatchObject({ status: 'open' });
    expect(view.items[0]!.lints).toContain('unstructured');
  });
});
