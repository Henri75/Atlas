import { describe, expect, it, vi } from 'vitest';
import {
  conflictCheckingFetch,
  errorResult,
  type HeaderLike,
  unavailableTool,
  withUpstream,
} from '../../packages/atlas-connect/src/bridge.js';

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

function headerLike(values: Record<string, string>): HeaderLike {
  return { get: (name: string) => values[name] ?? null };
}

/**
 * Regression coverage for the shared-mutable-`lastResponseHeaders` race a
 * code review caught: the SDK's `Client` can have multiple round trips in
 * flight against one memoized connection, so a wrapper that stashes "the
 * most recent response's headers" in a module-level variable for a later,
 * separate check can end up checking the WRONG response — silently missing
 * a real `X-Atlas-State: conflicted`, or firing for a response that never
 * carried it. `conflictCheckingFetch` fixes this by checking each response
 * the instant it's in hand, inside the same closure, with no shared state
 * to race over — these tests deliberately interleave a slow and a fast
 * response to prove that ordering can't corrupt which headers get checked.
 */
describe('conflictCheckingFetch', () => {
  it('checks each response inline — a slow conflicted response and a fast clean one, interleaved, are each checked correctly', async () => {
    const conflicted = headerLike({ 'X-Atlas-State': 'conflicted' });
    const clean = headerLike({});

    // Call 1 is issued FIRST but its underlying fetch resolves SLOWEST;
    // call 2 is issued second but resolves almost immediately. A
    // module-level "last response" variable would end up holding call 2's
    // clean headers by the time anything looked at it — regardless of
    // which call the check was meant to be for.
    const fetchImpl = vi
      .fn<(url: string | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { headers: conflicted } as unknown as Response;
      })
      .mockImplementationOnce(async () => ({ headers: clean }) as unknown as Response);

    const invalidate = vi.fn().mockReturnValue(true);
    const wrapped = conflictCheckingFetch(fetchImpl, undefined, invalidate);

    const p1 = wrapped('https://upstream/mcp'); // slow, conflicted
    const p2 = wrapped('https://upstream/mcp'); // fast, clean
    await Promise.all([p1, p2]);

    // Exactly one invalidate call per response, each with THAT response's
    // own headers — never the other's, regardless of resolution order.
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith(conflicted, undefined);
    expect(invalidate).toHaveBeenCalledWith(clean, undefined);
    // Call 2 (fast/clean) settles before call 1 (slow/conflicted) — proving
    // the conflicted response still gets checked correctly even though it
    // resolves AFTER a clean one already ran, which is exactly the ordering
    // that corrupted a shared "last response" variable.
    expect(invalidate).toHaveBeenNthCalledWith(1, clean, undefined);
    expect(invalidate).toHaveBeenNthCalledWith(2, conflicted, undefined);
  });

  it('never invalidates when no in-flight response carries the conflicted header', async () => {
    const clean = headerLike({});
    const fetchImpl = vi.fn().mockResolvedValue({ headers: clean } as unknown as Response);
    const invalidate = vi.fn().mockReturnValue(false);
    const wrapped = conflictCheckingFetch(fetchImpl, undefined, invalidate);

    await Promise.all([wrapped('a'), wrapped('b'), wrapped('c')]);

    expect(invalidate).toHaveBeenCalledTimes(3);
    for (const [headers] of invalidate.mock.calls) expect(headers).toBe(clean);
  });

  it('passes cachePath through to invalidate', async () => {
    const headers = headerLike({});
    const fetchImpl = vi.fn().mockResolvedValue({ headers } as unknown as Response);
    const invalidate = vi.fn().mockReturnValue(false);
    const wrapped = conflictCheckingFetch(fetchImpl, '/tmp/fake/active.json', invalidate);

    await wrapped('a');

    expect(invalidate).toHaveBeenCalledWith(headers, '/tmp/fake/active.json');
  });

  it('defaults to the real invalidateOnConflictHeader and returns the response unchanged', async () => {
    const headers = headerLike({});
    const fetchImpl = vi.fn().mockResolvedValue({ headers, ok: true } as unknown as Response);
    const wrapped = conflictCheckingFetch(fetchImpl);

    const res = await wrapped('a');

    expect(res).toEqual({ headers, ok: true });
  });
});
