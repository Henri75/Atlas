import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@atlas/core';
import { scanJobId, scheduleScans } from '../../packages/indexer/src/scheduler.js';

/**
 * BullMQ rejects ':' in custom job ids ("Custom Id cannot contain :"), which
 * crash-looped the indexer once. Project slugs and Claude dir names can hold
 * dots, slashes and colons, so ids must always be normalised.
 */
describe('scanJobId', () => {
  it('never contains a colon, even when inputs do', () => {
    const id = scanJobId('deepcast', 'claude_session__-Users-nasta-x:y', false);
    expect(id).not.toContain(':');
  });

  it('normalises every character outside [A-Za-z0-9_-]', () => {
    expect(scanJobId('fwdr.it', 'doc')).toBe('fwdr-it--doc--inc');
    expect(scanJobId('a/b', 'kdb')).toBe('a-b--kdb--inc');
  });

  it('distinguishes full from incremental runs', () => {
    expect(scanJobId('p', 'kdb', true)).toBe('p--kdb--full');
    expect(scanJobId('p', 'kdb', false)).toBe('p--kdb--inc');
  });

  it('is stable so an identical pending job is not queued twice', () => {
    expect(scanJobId('p', 'doc')).toBe(scanJobId('p', 'doc'));
  });

  it('separates distinct claude dirs of the same project', () => {
    const a = scanJobId('deepcast', 'claude_session__-Users-nasta-DeepCast');
    const b = scanJobId('deepcast', 'claude_session__-Volumes-CloudBox-DeepCast');
    expect(a).not.toBe(b);
  });
});

const root = mkdtempSync(join(tmpdir(), 'kdbscope-sched-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'DeepCast/kdb'), { recursive: true });
writeFileSync(join(root, 'DeepCast/kdb/changelog.log'), 'x');

describe('scheduleScans job options', () => {
  const run = async () => {
    const add = vi.fn(async () => {});
    const catalog = { refreshProjectAliases: async () => 0,
    upsertProject: vi.fn(async () => 1) } as any;
    const cfg = parseConfig({ CODE_ROOT: root, CLAUDE_PROJECTS_DIR: join(root, 'nope') });
    await scheduleScans(cfg, catalog, { add } as any);
    return add;
  };

  /**
   * Regression: jobs used `removeOnComplete: 1000`. BullMQ treats add() for a
   * *retained completed* id as a silent no-op, so once a source had been
   * scanned once its deterministic id stayed reserved and every later scan of
   * it was dropped — the index quietly stopped updating.
   */
  it('releases the deterministic job id as soon as the job completes', async () => {
    const add = await run();
    expect(add).toHaveBeenCalled();
    for (const call of add.mock.calls) {
      const opts = (call as any)[2];
      expect(opts.removeOnComplete).toBe(true);
      expect(opts.jobId).toBeTruthy();
    }
  });

  it('still retries failures with backoff', async () => {
    const add = await run();
    const opts = (add.mock.calls[0] as any)[2];
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
  });

  /**
   * The same trap, on the other exit. `removeOnComplete: true` was fixed above;
   * `removeOnFail: 500` sat on the next line and reserved the identical id for
   * the identical reason — BullMQ no-ops add() for a retained id whatever state
   * it is retained in.
   *
   * Found live on 2026-07-29: a Postgres restart on 07-26 failed one scan per
   * source ("the database system is in recovery mode"), and the 48 retained
   * failures then blocked every one of those sources from rescanning for three
   * days. Every project except deepcast — whose jobs happened not to be in
   * flight — silently stopped indexing. Nothing reported it; the scheduler kept
   * logging "140 scan jobs enqueued" a tick, and all but a handful were dropped
   * on the floor.
   *
   * A failed scan does not need retaining to be retried: the next tick is five
   * minutes away, and BullMQ has already spent its three attempts.
   */
  it('releases the job id when the job fails, not just when it completes', async () => {
    const add = await run();
    expect(add).toHaveBeenCalled();
    for (const call of add.mock.calls) {
      const opts = (call as any)[2];
      // Any retention count reserves the id; only true frees it.
      expect(opts.removeOnFail).toBe(true);
    }
  });
});
