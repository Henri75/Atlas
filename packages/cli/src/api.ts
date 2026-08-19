/**
 * REST client for the atlas CLI. Base URL resolution (spec §8): an
 * `ATLAS_API_URL`/legacy `KDBSCOPE_API_URL` env override (handled entirely
 * by `resolveActive`, including its one-time deprecation warning for the
 * legacy name) → a localhost fast path (keeps every single-machine
 * invocation instant, zero config) → the full resolver (`config/
 * machines.yaml`, probed and cached). See `computeBaseUrl`.
 */

import { AtlasResolveError, invalidateOnConflictHeader, machinesFilePath, readToken, resolveActive } from '@atlas/core';

const LOCALHOST_BASE = 'http://127.0.0.1:8710';
const LOCALHOST_PROBE_TIMEOUT_MS = 300;

/** Label CLI traffic for the API's agent-usage telemetry. */
const CLIENT_HEADERS = { 'x-atlas-client': 'cli' };

/**
 * True iff `${LOCALHOST_BASE}/api/health` answers ok within the timeout.
 * `/api/health` is exempt from the bearer-token check (`packages/api/src/
 * app.ts`), so this stays a fast, tokenless probe even on a token-protected
 * instance — the point is only "is *something* Atlas-shaped listening
 * locally," not authentication.
 */
async function localhostReachable(fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCALHOST_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetchImpl(`${LOCALHOST_BASE}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ComputeBaseUrlOpts {
  fetchImpl?: typeof fetch;
  machinesFile?: string;
  /**
   * Injectable for tests, so they never read this machine's real
   * `~/.atlas/credentials` (passed straight through to `readToken`, which
   * defaults it to the real path when omitted). Deliberately a PATH, not a
   * `token` value override: `readToken`'s own absent/malformed/empty rules
   * stay the one place "no token" is decided, rather than a second means
   * (an explicit `undefined` token) that `??` couldn't actually express
   * ("provided but undefined" and "not provided" are indistinguishable
   * through a default parameter).
   */
  credentialsPath?: string;
  timeoutMs?: number;
  /** Injectable for tests, so they never touch this machine's real `~/.atlas/active.json`. `null` disables caching, matching `resolveActive`'s own opt. */
  cachePath?: string | null;
}

/**
 * The pure decision logic behind `baseUrl()` — every dependency is
 * injectable, so the ordering below is testable without a live server or
 * touching this machine's real `~/.atlas/credentials` or resolver cache.
 * `baseUrl()` is the thin memoized wrapper actually used by
 * `get`/`post`/`postStream`.
 *
 * Order: an `ATLAS_API_URL`/legacy `KDBSCOPE_API_URL` env override is
 * delegated entirely to `resolveActive` — it already checks both (primary
 * wins, legacy warns once), and it reads real `process.env` directly (it
 * takes no injectable env of its own), so the presence check below reads
 * real `process.env` too rather than inventing a parallel injection point
 * `resolveActive` couldn't honor anyway. Only the *presence* check is
 * duplicated here, to decide whether to skip the localhost probe — never
 * the value or the warning, both of which stay solely in `resolveActive`.
 * → localhost fast path → the full resolver (`config/machines.yaml`,
 * probed and cached).
 */
export async function computeBaseUrl(opts: ComputeBaseUrlOpts = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const machinesFile = opts.machinesFile ?? machinesFilePath();
  const token = readToken(opts.credentialsPath);
  const timeoutMs = opts.timeoutMs;
  const cachePath = opts.cachePath;

  if (process.env.ATLAS_API_URL || process.env.KDBSCOPE_API_URL) {
    const resolved = await resolveActive({ machinesFile, token, fetchImpl, timeoutMs, cachePath });
    return resolved.baseUrl;
  }

  if (await localhostReachable(fetchImpl)) return LOCALHOST_BASE;

  const resolved = await resolveActive({ machinesFile, token, fetchImpl, timeoutMs, cachePath });
  return resolved.baseUrl;
}

let memo: Promise<string> | undefined;

/**
 * Memoized per process: every `get`/`post`/`postStream` call within one CLI
 * invocation shares a single resolution, so a multi-call command (e.g.
 * `backlog` with no project, which calls the API once per project) doesn't
 * re-probe per request.
 */
function baseUrl(): Promise<string> {
  if (!memo) memo = computeBaseUrl();
  return memo;
}

/** `AtlasResolveError.detail` already carries the hosts checked + a remedy — print it and stop, rather than surfacing a generic thrown-error stack. */
async function resolvedBaseUrl(): Promise<string> {
  try {
    return await baseUrl();
  } catch (e) {
    if (e instanceof AtlasResolveError) {
      console.error(e.detail);
      process.exit(1);
    }
    throw e;
  }
}

function authHeader(): Record<string, string> {
  const token = readToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Every response — success or failure alike — passes through
 * `invalidateOnConflictHeader` (Task 24), so a conflicted instance is
 * abandoned after one request, not left cached for up to the rest of its
 * 5-minute TTL.
 */
async function doFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await resolvedBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...CLIENT_HEADERS, ...authHeader(), ...(init.headers as Record<string, string> | undefined) },
  });
  invalidateOnConflictHeader(res.headers);
  return res;
}

export async function get(path: string): Promise<any> {
  const res = await doFetch(path);
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function post(path: string, body: unknown): Promise<any> {
  const res = await doFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export type AskEvent =
  | { type: 'sources'; sources: any[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; model: string; degraded: boolean }
  | { type: 'error'; message: string };

/** Consume the Ask SSE stream from the API, yielding events as they arrive. */
export async function* postStream(
  path: string,
  body: unknown,
): AsyncGenerator<AskEvent, void, unknown> {
  const res = await doFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!record.startsWith('data:')) continue;
        try {
          yield JSON.parse(record.slice(5).trim()) as AskEvent;
        } catch {
          // Skip a malformed frame rather than aborting the answer.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
