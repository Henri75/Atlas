import { describe, expect, it, vi } from 'vitest';
import { Catalog } from '@atlas/core';

function stubbed(): { cat: Catalog; q: ReturnType<typeof vi.fn> } {
  const cat = Object.create(Catalog.prototype) as Catalog;
  // { id: 1 } so upsertProject's RETURNING id read doesn't throw on the
  // default stub; nothing else in this file inspects the row shape.
  const q = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
  Object.defineProperty(cat, 'pool', { value: { query: q } });
  return { cat, q };
}

describe('machine accessors', () => {
  it('upsertProjectLocation upserts on (project_id, machine)', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProjectLocation({ projectId: 3, machine: 'm4max', rootPath: '/data/remote/m4max/code1/x', hostPath: '/Users/serge/CODING/x', hasKdb: true });
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(project_id, machine\)/);
    expect(q.mock.calls[0]![1]).toEqual([3, 'm4max', '/data/remote/m4max/code1/x', '/Users/serge/CODING/x', true]);
  });

  it('listProjectLocations groups rows by project_id with camelCase fields', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({
      rows: [
        { project_id: 1, machine: 'm1', root_path: '/p1/m1', host_path: '/h1', has_kdb: true },
        { project_id: 1, machine: 'm2', root_path: '/p1/m2', host_path: '/h2', has_kdb: false },
        { project_id: 2, machine: 'm1', root_path: '/p2/m1', host_path: '/h3', has_kdb: true },
      ],
    });
    const result = await cat.listProjectLocations();
    expect(result.get(1)).toEqual([
      { machine: 'm1', rootPath: '/p1/m1', hostPath: '/h1', hasKdb: true },
      { machine: 'm2', rootPath: '/p1/m2', hostPath: '/h2', hasKdb: false },
    ]);
    expect(result.get(2)).toEqual([
      { machine: 'm1', rootPath: '/p2/m1', hostPath: '/h3', hasKdb: true },
    ]);
  });

  it('backfillMachine touches only empty-machine rows', async () => {
    const { cat, q } = stubbed();
    await cat.backfillMachine('nasta-mbp');
    for (const call of q.mock.calls) expect(call[0]).toMatch(/machine = ''/);
  });

  it('upsertProject with isSelf:false leaves root_path alone', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/remote/m4max/code1/x', hasKdb: true }, { isSelf: false });
    expect(q.mock.calls[0]![0]).toMatch(/DO UPDATE SET name = EXCLUDED.name\s+RETURNING/);
  });

  it('upsertProject with isSelf:false inserts an empty root_path', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/remote/m4max/code1/x', hasKdb: true }, { isSelf: false });
    expect(q.mock.calls[0]![1]).toEqual(['x', 'x', '', true]);
  });

  it('upsertProject defaults to isSelf:true and writes root_path/has_kdb on conflict', async () => {
    const { cat, q } = stubbed();
    await cat.upsertProject({ slug: 'x', name: 'x', rootPath: '/data/code/x', hasKdb: true });
    expect(q.mock.calls[0]![0]).toMatch(/DO UPDATE SET root_path = EXCLUDED.root_path, has_kdb = EXCLUDED.has_kdb/);
    expect(q.mock.calls[0]![1]).toEqual(['x', 'x', '/data/code/x', true]);
  });

  it('upsertSession inserts machine and keeps existing non-empty value on conflict', async () => {
    const { cat, q } = stubbed();
    await cat.upsertSession(1, {
      sessionId: 's1', promptCount: 1, actionCount: 0, filesTouched: [],
    } as any, '/path/s1.jsonl', 'm4max');
    expect(q.mock.calls[0]![0]).toMatch(/machine = CASE WHEN sessions\.machine = '' THEN EXCLUDED\.machine ELSE sessions\.machine END/);
    expect(q.mock.calls[0]![1]).toEqual([
      's1', 1, null, null, null, null, 1, 0, JSON.stringify([]), '/path/s1.jsonl', 'm4max',
    ]);
  });

  it('recordSyncStart uses ON CONFLICT and resets error on retry', async () => {
    const { cat, q } = stubbed();
    await cat.recordSyncStart('m4max');
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(machine\)/);
    expect(q.mock.calls[0]![0]).toMatch(/error = NULL/);
    expect(q.mock.calls[0]![1]).toEqual(['m4max']);
  });

  it('recordSyncResult ok branch stamps last_success_at with correct params', async () => {
    const { cat, q } = stubbed();
    q.mockClear();
    await cat.recordSyncResult('m4max', { status: 'ok', bytes: 10, durationMs: 5 });
    expect(q.mock.calls[0]![0]).toMatch(/last_success_at = now\(\)/);
    expect(q.mock.calls[0]![1]).toEqual(['m4max', 10, 5]);
  });

  it('recordSyncResult non-ok branch omits last_success_at with correct params', async () => {
    const { cat, q } = stubbed();
    q.mockClear();
    await cat.recordSyncResult('m4max', { status: 'unreachable', error: 'timeout' });
    expect(q.mock.calls[0]![0]).not.toMatch(/last_success_at = now\(\)/);
    expect(q.mock.calls[0]![1]).toEqual(['m4max', 'unreachable', 'timeout']);
  });

  it('recordSyncResult non-ok with null error defaults correctly', async () => {
    const { cat, q } = stubbed();
    q.mockClear();
    await cat.recordSyncResult('m4max', { status: 'error' });
    expect(q.mock.calls[0]![1]).toEqual(['m4max', 'error', null]);
  });

  it('listMachineSync returns camelCase rows with ISO dates', async () => {
    const { cat, q } = stubbed();
    q.mockResolvedValueOnce({
      rows: [
        {
          machine: 'm1',
          last_attempt_at: new Date('2026-08-19T10:00:00Z'),
          last_success_at: new Date('2026-08-19T09:00:00Z'),
          status: 'ok',
          bytes: 1024,
          duration_ms: 500,
          error: null,
        },
      ],
    });
    const result = await cat.listMachineSync();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      machine: 'm1',
      status: 'ok',
      bytes: 1024,
      durationMs: 500,
      error: null,
    });
    expect(result[0]!.lastAttemptAt).toBe('2026-08-19T10:00:00.000Z');
    expect(result[0]!.lastSuccessAt).toBe('2026-08-19T09:00:00.000Z');
  });
});
