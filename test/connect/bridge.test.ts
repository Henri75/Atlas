import { describe, expect, it, vi } from 'vitest';
import { errorResult, unavailableTool, withUpstream } from '../../packages/atlas-connect/src/bridge.js';

/**
 * Pure retry/memo semantics for the atlas-connect stdio shim (spec §8, Task
 * 25). The shim itself (main.ts) is a thin wire-up over these three
 * functions — this file is where the actual logic gets exercised, with a
 * fake `connect` standing in for `resolveActive()` + the MCP `Client`.
 */

describe('withUpstream', () => {
  it('memoizes the upstream across two calls sharing the same deps object', async () => {
    const client = { id: 'client-a' };
    const connect = vi.fn().mockResolvedValue(client);
    const deps = { connect };

    const r1 = await withUpstream(deps, async (c: typeof client) => `first:${c.id}`);
    const r2 = await withUpstream(deps, async (c: typeof client) => `second:${c.id}`);

    expect(r1).toBe('first:client-a');
    expect(r2).toBe('second:client-a');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects once after a failure and returns the retried result', async () => {
    const client = { id: 'client-a' };
    const connect = vi.fn().mockResolvedValue(client);
    const deps = { connect };

    let calls = 0;
    const fn = vi.fn(async (c: typeof client) => {
      calls += 1;
      if (calls === 1) throw new Error('mid-session connection failure');
      return `ok:${c.id}`;
    });

    const result = await withUpstream(deps, fn);

    expect(result).toBe('ok:client-a');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('surfaces the second error when both attempts fail', async () => {
    const connect = vi.fn().mockResolvedValue({ id: 'client-a' });
    const deps = { connect };

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'));

    await expect(withUpstream(deps, fn)).rejects.toThrow('second failure');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('resolves fresh when a failure is followed by connect() returning a NEW client (moved upstream)', async () => {
    const clients = [{ id: 'stale' }, { id: 'moved' }];
    const connect = vi.fn().mockImplementation(async () => clients.shift());
    const deps = { connect };

    let calls = 0;
    const fn = vi.fn(async (c: { id: string }) => {
      calls += 1;
      if (calls === 1) {
        expect(c.id).toBe('stale');
        throw new Error('stale upstream gone');
      }
      return c.id;
    });

    const result = await withUpstream(deps, fn);
    expect(result).toBe('moved');
    expect(connect).toHaveBeenCalledTimes(2);

    // The recovered (moved) client is now memoized — a subsequent call
    // reuses it with no further reconnect.
    const again = await withUpstream(deps, async (c: { id: string }) => c.id);
    expect(again).toBe('moved');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not share memo state across two independent deps objects', async () => {
    const connectA = vi.fn().mockResolvedValue({ id: 'a' });
    const connectB = vi.fn().mockResolvedValue({ id: 'b' });

    await withUpstream({ connect: connectA }, async (c: { id: string }) => c.id);
    await withUpstream({ connect: connectB }, async (c: { id: string }) => c.id);

    expect(connectA).toHaveBeenCalledTimes(1);
    expect(connectB).toHaveBeenCalledTimes(1);
  });
});

describe('unavailableTool', () => {
  it('carries the resolver detail text in-band as the single tool description', () => {
    const detail = 'checked nasta-mbp, m4max\nremedy: make up';
    const tool = unavailableTool(detail);

    expect(tool.name).toBe('atlas_unavailable');
    expect(tool.description).toContain(detail);
    expect(tool.inputSchema).toEqual({ type: 'object' });
  });
});

describe('errorResult', () => {
  it('shapes an isError tool result carrying the detail text', () => {
    const result = errorResult('token mismatch on m4max — check Doppler/.env');

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Atlas unreachable: token mismatch on m4max — check Doppler/.env' },
    ]);
  });
});
