import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadMachinesFileIfPresent } from './machines.js';
import type { MachinesFile } from './machines.js';
import { proofFor } from './instanceProof.js';

/**
 * The verified active-instance resolver (spec §8, Task 24) — host-side,
 * shared by the CLI and the `atlas-connect` MCP shim. Given a
 * `config/machines.yaml`, finds the ONE machine currently running an active,
 * proof-verified Atlas instance, never a silent guess: zero, two, or a
 * conflicted responder are all loud, named errors (spec: "the same
 * principle as Ask's `scopeFallback`").
 *
 * `probeInstance` here is a SEPARATE implementation from `guard.ts`'s
 * `probePeer` (api package) — same proof-verification math underneath
 * (`instanceProof.ts`'s `proofFor`, the one thing the spec's
 * one-implementation rule actually targets), but a different wrapper: the
 * guard probes a pre-built peer URL and doesn't need `entries`; the resolver
 * builds the URL from a bare `baseUrl` and DOES need `entries` (to report in
 * error detail, and to hand back to a future dashboard). Two thin wrappers
 * around one proof primitive beats forcing both call sites into a shared
 * shape neither fully wants.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_MCP_PORT = 8711;
const DEFAULT_UI_PORT = 8712;
/**
 * The `/api/instance` port. Not overridable via `resolveActive`'s opts
 * (unlike `mcpPort`/`uiPort`) — matches `config.ts`'s `apiPort` default and
 * `guard.ts`'s peer URLs (`http://<address>:8710/api/instance`), which are
 * likewise fixed at this value. Exported (as `RESOLVER_API_PORT`, distinct
 * from `config.ts`'s overridable `apiPort` config field) so `atlas which`
 * (Task 26) can build the same per-machine probe URLs this module uses
 * internally, instead of a second hard-coded `8710` in the CLI.
 */
export const RESOLVER_API_PORT = 8710;
const API_PORT = RESOLVER_API_PORT;
const CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_CACHE_PATH = join(homedir(), '.atlas', 'active.json');

export type ProbeOutcome =
  | { ok: true; machine: string; bootId: string; state: 'active' | 'conflicted'; entries: number }
  | { ok: false; reason: 'unreachable' | 'bad-proof' | 'no-proof' };

/**
 * Challenge one instance's `/api/instance` and verify its proof — the same
 * nonce-challenge protocol `guard.ts`'s `probePeer` uses, recomputing the
 * HMAC over the response's own payload (everything except `proof`) via the
 * shared `proofFor` (`instanceProof.ts`). Without a token (legacy dev mode),
 * any well-shaped 200 is trusted.
 */
export async function probeInstance(
  baseUrl: string,
  token: string | undefined,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const nonce = randomBytes(8).toString('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never let a pending probe hold the event loop open on its own.
  timer.unref?.();

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/instance?nonce=${nonce}`;
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: 'unreachable' };

    const body = (await res.json()) as Record<string, unknown>;
    if (
      typeof body.machine !== 'string' ||
      typeof body.bootId !== 'string' ||
      typeof body.state !== 'string' ||
      typeof body.entries !== 'number'
    ) {
      // Not shaped like an `/api/instance` response — something else
      // answered on that port, not an Atlas instance. Same bucket as no
      // response at all.
      return { ok: false, reason: 'unreachable' };
    }
    const state = body.state as 'active' | 'conflicted';

    if (!token) {
      return { ok: true, machine: body.machine, bootId: body.bootId, state, entries: body.entries };
    }

    if (typeof body.proof !== 'string') return { ok: false, reason: 'no-proof' };

    const { proof, ...payload } = body;
    if (proofFor(token, nonce, payload) !== proof) return { ok: false, reason: 'bad-proof' };

    return { ok: true, machine: body.machine, bootId: body.bootId, state, entries: body.entries };
  } catch {
    // Network failure, connection refused, non-JSON body, or the abort
    // above firing — an asleep/unreachable machine is the expected steady
    // state (spec §10), never error spam.
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export type AtlasResolveErrorKind =
  | 'no-machines'
  | 'none-reachable'
  | 'multiple-active'
  | 'conflicted'
  | 'token-mismatch';

/**
 * Thrown by `resolveActive` whenever it cannot name exactly one active
 * instance. `detail` always lists every probe result checked (host,
 * outcome, entries when available) plus a remedy line — never just "it
 * failed" (spec: "a loud, named error rather than a quiet guess").
 */
export class AtlasResolveError extends Error {
  readonly kind: AtlasResolveErrorKind;
  readonly detail: string;

  constructor(kind: AtlasResolveErrorKind, detail: string) {
    super(`atlas resolve failed (${kind}):\n${detail}`);
    this.name = 'AtlasResolveError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface ResolvedInstance {
  baseUrl: string;
  mcpUrl: string;
  uiUrl: string;
  machine: string;
  fromCache: boolean;
}

export interface ResolveActiveOpts {
  machinesFile: string;
  token?: string;
  /** `null` disables caching entirely (used by `atlas which` for a fresh probe every time). Defaults to `~/.atlas/active.json`. */
  cachePath?: string | null;
  timeoutMs?: number;
  mcpPort?: number;
  uiPort?: number;
  fetchImpl?: typeof fetch;
  /** Injectable clock for TTL tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheFile {
  baseUrl: string;
  machine: string;
  at: number;
}

function readCache(cachePath: string): CacheFile | null {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as CacheFile;
  } catch {
    return null;
  }
}

function writeCache(cachePath: string, data: CacheFile): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data));
}

function deleteCacheFile(cachePath: string): void {
  try {
    unlinkSync(cachePath);
  } catch {
    // Already gone — nothing to invalidate.
  }
}

function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

function deriveUrls(hostname: string, mcpPort: number, uiPort: number): { mcpUrl: string; uiUrl: string } {
  // Built from the winning machine's ADDRESS + the port conventions, never
  // by arithmetic on baseUrl's own port — a baseUrl could be anything
  // (env override, a tunnel), but the mcp/ui ports are fixed conventions.
  return { mcpUrl: `http://${hostname}:${mcpPort}/mcp`, uiUrl: `http://${hostname}:${uiPort}` };
}

let legacyEnvWarned = false;

/** `ATLAS_API_URL` wins outright; the legacy `KDBSCOPE_API_URL` still works but warns once per process (spec §8: "one variable, one migration"). */
function envOverrideBaseUrl(): string | undefined {
  const primary = process.env.ATLAS_API_URL;
  if (primary) return primary;

  const legacy = process.env.KDBSCOPE_API_URL;
  if (legacy) {
    if (!legacyEnvWarned) {
      console.warn('[atlas] KDBSCOPE_API_URL is deprecated — set ATLAS_API_URL instead');
      legacyEnvWarned = true;
    }
    return legacy;
  }
  return undefined;
}

interface ProbeRow {
  name: string;
  address: string;
  outcome: ProbeOutcome;
}

function formatRow({ name, address, outcome }: ProbeRow): string {
  if (outcome.ok) {
    return `${name} (${address}): ok machine=${outcome.machine} state=${outcome.state} entries=${outcome.entries} bootId=${outcome.bootId}`;
  }
  return `${name} (${address}): ${outcome.reason}`;
}

function detailBlock(rows: ProbeRow[], remedy: string): string {
  return [...rows.map(formatRow), `remedy: ${remedy}`].join('\n');
}

async function probeAll(
  mf: MachinesFile,
  token: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProbeRow[]> {
  return Promise.all(
    mf.machines.map(async (m) => ({
      name: m.name,
      address: m.address,
      outcome: await probeInstance(`http://${m.address}:${API_PORT}`, token, { timeoutMs, fetchImpl }),
    })),
  );
}

/**
 * Probe every configured machine and apply the exactly-one-active rule.
 * Priority when several conditions hold at once (most urgent first):
 *   1. any `conflicted` response ⇒ 'conflicted' — a live split-brain is
 *      more urgent than anything else on the list.
 *   2. any proof failure from a configured machine ⇒ 'token-mismatch' —
 *      a known machine we can't verify is a real misconfiguration; silently
 *      resolving to a DIFFERENT machine instead would hide it, contradicting
 *      the "loud, named error" invariant.
 *   3. zero active ⇒ 'none-reachable'; two-or-more active ⇒ 'multiple-active'.
 */
async function resolveViaProbe(
  mf: MachinesFile,
  token: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  mcpPort: number,
  uiPort: number,
): Promise<{ baseUrl: string; mcpUrl: string; uiUrl: string; machine: string }> {
  const rows = await probeAll(mf, token, timeoutMs, fetchImpl);

  const conflicted = rows.filter((r) => r.outcome.ok && r.outcome.state === 'conflicted');
  if (conflicted.length > 0) {
    const names = conflicted.map((r) => r.name).join(', ');
    throw new AtlasResolveError('conflicted', detailBlock(rows, `run \`make down\` on: ${names}`));
  }

  const mismatched = rows.filter(
    (r) => !r.outcome.ok && (r.outcome.reason === 'bad-proof' || r.outcome.reason === 'no-proof'),
  );
  if (mismatched.length > 0) {
    const names = mismatched.map((r) => r.name).join(', ');
    throw new AtlasResolveError(
      'token-mismatch',
      detailBlock(rows, `token mismatch on ${names} — check Doppler/.env`),
    );
  }

  const active = rows.filter((r) => r.outcome.ok && r.outcome.state === 'active');
  if (active.length === 0) {
    throw new AtlasResolveError(
      'none-reachable',
      detailBlock(rows, 'make sure at least one Atlas instance is running (`make up`)'),
    );
  }
  if (active.length > 1) {
    const names = active.map((r) => r.name).join(', ');
    throw new AtlasResolveError(
      'multiple-active',
      detailBlock(rows, `run \`make down\` on all but one of: ${names}`),
    );
  }

  const winner = active[0]!;
  const baseUrl = `http://${winner.address}:${API_PORT}`;
  return { baseUrl, ...deriveUrls(winner.address, mcpPort, uiPort), machine: winner.name };
}

/**
 * Resolve the currently-active Atlas instance (spec §8).
 *
 * Order: `ATLAS_API_URL`/`KDBSCOPE_API_URL` env override (wins unprobed) →
 * a fresh cache file (trusted blindly within its 5-min TTL — zero network
 * calls) → machines.yaml, probed in full and reduced by the exactly-one-
 * active rule above. A stale or missing cache always falls through to the
 * full probe rather than re-verifying just the cached host first: the full
 * probe already re-checks that host alongside everyone else, so a cheap
 * single-host pre-check would only save one round trip while adding a
 * second code path — not worth it for a resolver that already runs in
 * parallel with an ~800ms timeout.
 */
export async function resolveActive(opts: ResolveActiveOpts): Promise<ResolvedInstance> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const mcpPort = opts.mcpPort ?? DEFAULT_MCP_PORT;
  const uiPort = opts.uiPort ?? DEFAULT_UI_PORT;
  const cachePath = opts.cachePath === null ? null : (opts.cachePath ?? DEFAULT_CACHE_PATH);

  const envOverride = envOverrideBaseUrl();
  if (envOverride) {
    const baseUrl = envOverride.replace(/\/$/, '');
    const hostname = hostnameOf(baseUrl);
    return { baseUrl, ...deriveUrls(hostname, mcpPort, uiPort), machine: hostname, fromCache: false };
  }

  if (cachePath) {
    const cached = readCache(cachePath);
    if (cached && now() - cached.at < CACHE_TTL_MS) {
      const hostname = hostnameOf(cached.baseUrl);
      return {
        baseUrl: cached.baseUrl,
        ...deriveUrls(hostname, mcpPort, uiPort),
        machine: cached.machine,
        fromCache: true,
      };
    }
  }

  const mf = loadMachinesFileIfPresent(opts.machinesFile);
  if (!mf || mf.machines.length === 0) {
    throw new AtlasResolveError(
      'no-machines',
      `no machines configured — checked ${opts.machinesFile}\nremedy: add entries to config/machines.yaml (or point ATLAS_MACHINES_FILE at a file that has them)`,
    );
  }

  const resolved = await resolveViaProbe(mf, opts.token, timeoutMs, fetchImpl, mcpPort, uiPort);

  if (cachePath) {
    writeCache(cachePath, { baseUrl: resolved.baseUrl, machine: resolved.machine, at: now() });
  }

  return { ...resolved, fromCache: false };
}

/**
 * Any Atlas response carrying `X-Atlas-State: conflicted` invalidates the
 * cache, so the NEXT resolve call re-probes immediately instead of trusting
 * a conflicted instance for up to the rest of its 5-min TTL (spec §8: bounds
 * the stale-conflicted window to one request). Called by the CLI's fetch
 * wrapper and the shim's response path (Tasks 25/26) on every response, not
 * just error ones. Returns whether it invalidated — true exactly when the
 * header carried the literal value `conflicted`, regardless of whether a
 * cache file happened to exist to delete.
 */
export function invalidateOnConflictHeader(
  headers: { get(name: string): string | null },
  cachePath: string = DEFAULT_CACHE_PATH,
): boolean {
  if (headers.get('X-Atlas-State') !== 'conflicted') return false;
  deleteCacheFile(cachePath);
  return true;
}
