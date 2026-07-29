import { describe, expect, it } from 'vitest';
import {
  buildBacklogView,
  backlogLineHash,
  buildBacklogJudgePrompt,
  parseBacklog,
  parseJudgeVerdict,
  proposeMarkerLine,
} from '@atlas/core';
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

  /**
   * Markers carry a date, verdicts carry a timestamp, and comparing them
   * directly reads every same-day marker as midnight — so any verdict recorded
   * that day beat it, including one recorded hours *earlier* in real time.
   *
   * That inverts the contract the whole write-back convention rests on. The
   * marker line in backlog.log is the canonical durable record; the verdict
   * table is working state that survives reindexing. Appending REOPENED and
   * watching an older verdict keep the item resolved would make the file the
   * weaker signal precisely when someone reached for it.
   *
   * Ties go to the file: a verdict must be from a strictly later day, the
   * finest granularity a marker can express.
   */
  it('a same-day marker beats a verdict recorded that same day', () => {
    const item = '- [2026-05-05] fix the thing';
    const reopened = `${item}\n- [2026-07-20] REOPENED [L1#${hashOf(item)}]: it came back`;
    const sameDay: BacklogVerdict = {
      sourcePath: PATH, line: 1, status: 'confirmed-resolved', confidence: 0.9,
      reviewer: 'agent:claude-code', reviewedAt: '2026-07-20T09:15:00Z',
    };
    const view = buildBacklogView(entriesFrom(reopened), [sameDay]);
    expect(view.items[0]!.status).toBe('open');
    expect(view.items[0]!.provenance).toBe('structured');
  });

  it('still lets a verdict from a later day override the marker', () => {
    const item = '- [2026-05-05] fix the thing';
    const reopened = `${item}\n- [2026-07-20] REOPENED [L1#${hashOf(item)}]: it came back`;
    const nextDay: BacklogVerdict = {
      sourcePath: PATH, line: 1, status: 'confirmed-resolved', confidence: 0.9,
      reviewer: 'agent:claude-code', reviewedAt: '2026-07-21T09:15:00Z',
    };
    const view = buildBacklogView(entriesFrom(reopened), [nextDay]);
    expect(view.items[0]!.status).toBe('resolved');
    expect(view.items[0]!.provenance).toBe('reviewed');
    // The file does not say resolved, so the verdict needs writing back.
    expect(view.items[0]!.lints).toContain('not-written-back');
  });

  /**
   * The agreeing case, which is what write-back produces: verdict says
   * resolved, the appended marker says resolved. The file is the record, so it
   * is the file that should be credited — and nothing is outstanding.
   */
  it('credits the file when a written-back verdict agrees with its marker', () => {
    const item = '- [2026-05-05] fix the thing';
    const marked = `${item}\n- [2026-07-20] RESOLVED [L1#${hashOf(item)}]: fixed`;
    const verdict: BacklogVerdict = {
      sourcePath: PATH, line: 1, status: 'confirmed-resolved', confidence: 0.9,
      reviewer: 'agent:claude-code', reviewedAt: '2026-07-20T09:15:00Z',
    };
    const view = buildBacklogView(entriesFrom(marked), [verdict]);
    expect(view.items[0]!.status).toBe('resolved');
    expect(view.items[0]!.provenance).toBe('structured');
    expect(view.items[0]!.lints).not.toContain('not-written-back');
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

  it('emits a protocol-conformant marker line with hash ref', () => {
    const line = proposeMarkerLine(
      'resolved',
      { line: 37, lineHash: 'a3f2c1' },
      'backfill resume cursor persisted',
      '2026-07-29',
      'commit ebcec11',
    );
    expect(line).toBe(
      '- [2026-07-29] RESOLVED [L37#a3f2c1]: backfill resume cursor persisted (evidence: commit ebcec11)',
    );
    // The emitted line must round-trip through the parser as a structured marker.
    const parsed = parseBacklog(line, { projectSlug: 'x', sourcePath: '/x/kdb/backlog.log' });
    expect(parsed[0]!.meta?.marker).toEqual({ kind: 'resolved', targetLine: 37, targetHash: 'a3f2c1' });
  });

  it('omits the hash and evidence when absent', () => {
    expect(proposeMarkerLine('reopened', { line: 5 }, 'regressed', '2026-07-29')).toBe(
      '- [2026-07-29] REOPENED [L5]: regressed',
    );
  });

  /**
   * The line it emits is appended verbatim to an append-only file that the
   * protocol defines as one physical line per item. A summary carrying a
   * newline — and these come from callers, including agents writing free-text
   * notes — would split into two lines, shifting every line number below it and
   * leaving half a marker parsed as a new backlog item.
   */
  it('never emits more than one physical line', () => {
    const line = proposeMarkerLine(
      'resolved',
      { line: 7, lineHash: 'abc123' },
      'fixed the thing\nand also\r\nthis',
      '2026-07-29',
      'commit\ndeadbee',
    );
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('fixed the thing and also this');
  });

  /**
   * A marker summary is a permanent record a human reads later. Cutting the
   * item text at a fixed byte count lands mid-word — the first verdict recorded
   * against this repo produced "...autoSelect calls ollamaAvailable(), a
   * single", which restates nothing.
   */
  it('truncates a long summary on a word boundary and marks the cut', () => {
    const long =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike ' +
      'november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
    const line = proposeMarkerLine('resolved', { line: 1 }, long, '2026-07-29');
    const summary = line.split(']: ')[1]!;
    expect(summary.length).toBeLessThanOrEqual(121);
    expect(summary).toMatch(/…$/);
    // Cut between words, so the last kept word is whole.
    expect(long).toContain(summary.replace(/…$/, '').trim());
  });

  it('leaves a short summary exactly as given', () => {
    const line = proposeMarkerLine('dropped', { line: 2 }, 'no longer relevant', '2026-07-29');
    expect(line).toBe('- [2026-07-29] DROPPED [L2]: no longer relevant');
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

describe('backlog judge', () => {
  it('builds a prompt with the item, its date, and numbered evidence blocks', () => {
    const prompt = buildBacklogJudgePrompt(
      { line: 3, text: 'fix the Makefile build-local target', date: '2026-05-06T00:00:00Z' },
      [
        {
          entryId: 42,
          projectSlug: 'deepcast',
          sourceType: 'kdb_changelog',
          title: 'x',
          snippet: 'build-local now calls docker compose build',
          occurredAt: '2026-05-08T00:00:00Z',
          score: 0.9,
          sourcePath: '/x/kdb/changelog.log',
        },
      ],
    );
    expect(prompt).toContain('fix the Makefile build-local target');
    expect(prompt).toContain('2026-05-06');
    expect(prompt).toContain('[42] kdb_changelog (2026-05-08)');
    expect(prompt).toContain('build-local now calls docker compose build');
  });

  it('parses a well-formed verdict, clamping confidence and filtering citations', () => {
    const v = parseJudgeVerdict(
      '```json\n{"status":"confirmed-resolved","confidence":1.7,"reasoning":"done in changelog","evidence":"changelog 2026-05-08","citations":[42,"junk",7]}\n```',
      new Set([42]),
    );
    expect(v).toEqual({
      status: 'confirmed-resolved',
      confidence: 1,
      reasoning: 'done in changelog',
      evidence: 'changelog 2026-05-08',
      citations: [42],
    });
  });

  it('returns inconclusive on malformed output or unknown status', () => {
    expect(parseJudgeVerdict('not json at all', new Set())).toMatchObject({ status: 'inconclusive' });
    expect(parseJudgeVerdict('{"status":"kinda-done","confidence":0.5}', new Set())).toMatchObject({
      status: 'inconclusive',
    });
  });
});
