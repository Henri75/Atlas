import { randomBytes } from 'node:crypto';
import { proofFor } from './instance.js';

/**
 * The continuous single-active guard (spec §8/§10, Task 23): probes every
 * other machine.yaml entry's `/api/instance` and decides, from the S8
 * instance-proof protocol (instance.ts), whether it's talking to a genuine
 * live peer, a hairpin back to itself, or nothing at all.
 */

export type ProbeResult =
  | { ok: true; machine: string; bootId: string; state: string }
  | { ok: false; reason: 'unreachable' | 'bad-proof' | 'no-proof' };

/** ~800ms: long enough that a briefly loaded LAN peer isn't mistaken for asleep, short enough that a boot/tick doesn't stall on a genuinely dead host. */
const DEFAULT_PROBE_TIMEOUT_MS = 800;

/**
 * Challenge one peer's `/api/instance` and verify its proof.
 *
 * With a token configured, this recomputes the expected HMAC over the
 * response's own payload (everything except `proof`) and compares it to
 * what the peer sent — verification IS recomputation for an HMAC, so this
 * calls the exact same `proofFor` the route used to sign it (instance.ts).
 * A plain `!==` string compare is fine here (not timing-safe): the client
 * is verifying a value the peer just handed it in the clear, not defending
 * a secret against a timing side-channel.
 *
 * Without a token (legacy dev mode, no `ATLAS_TOKEN` set anywhere), there is
 * nothing to verify — any well-shaped 200 is trusted.
 */
export async function probePeer(
  url: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const nonce = randomBytes(8).toString('hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never let a pending probe hold the event loop open on its own — every
  // real call is awaited so this can't fire after the fact, but a stray
  // handle should not keep a test runner (or the process at shutdown) alive.
  timer.unref?.();

  try {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetchImpl(`${url}${sep}nonce=${nonce}`, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: 'unreachable' };

    const body = (await res.json()) as Record<string, unknown>;
    if (
      typeof body.machine !== 'string' ||
      typeof body.bootId !== 'string' ||
      typeof body.state !== 'string'
    ) {
      // Not shaped like an `/api/instance` response at all — treat the same
      // as no response: something else answered on that port, not a peer.
      return { ok: false, reason: 'unreachable' };
    }

    if (!token) {
      return { ok: true, machine: body.machine, bootId: body.bootId, state: body.state };
    }

    if (typeof body.proof !== 'string') return { ok: false, reason: 'no-proof' };

    const { proof, ...payload } = body;
    if (proofFor(token, nonce, payload) !== proof) return { ok: false, reason: 'bad-proof' };

    return { ok: true, machine: body.machine, bootId: body.bootId, state: body.state };
  } catch {
    // Network failure, connection refused, non-JSON body, or the abort
    // above firing — all read the same to a caller deciding whether a peer
    // is live: it isn't answering right now, and asleep is normal (spec
    // §10: "Machine asleep during resolution" / boot-time peer probing).
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export interface GuardPeer {
  name: string;
  url: string;
}

export interface GuardDeps {
  /**
   * This machine's name. Not used in the hairpin/live-peer decision below —
   * `bootId` is the load-bearing self-check (instance.ts) — kept on the
   * contract for callers (main.ts) and future diagnostics/logging.
   */
  self: string;
  bootId: string;
  peers: GuardPeer[];
  token?: string;
  onConflict: (names: string[]) => void;
  /** Defaults to `console.warn` — callers (main.ts) can leave it unset. */
  warn?: (s: string) => void;
  probe?: typeof probePeer;
}

/**
 * One guard pass: probe every configured peer in parallel, then decide.
 *
 * - A proof-valid responder whose `bootId` differs from ours is a genuine
 *   live peer → collected and handed to `onConflict` once, and only when
 *   the list is non-empty (never `onConflict([])`).
 * - A proof-valid responder whose `bootId` MATCHES ours is a hairpin — a
 *   stale DNS name or reassigned lease routing the probe back to this same
 *   process — and is silently ignored (spec §10). This is the one
 *   comparison the whole self/peer distinction rests on: dropping it turns
 *   every hairpin into a false self-conflict.
 * - A proof failure ('bad-proof' or 'no-proof') from a machine listed in
 *   machines.yaml is a configuration problem (mismatched/missing
 *   `ATLAS_TOKEN` between machines), not evidence of a rogue instance —
 *   logged once per tick with the spec §8 taxonomy text, never a conflict.
 * - 'unreachable' is the expected steady state for a sleeping peer and
 *   produces neither a conflict nor a warning.
 */
export async function guardTick(deps: GuardDeps): Promise<void> {
  const probe = deps.probe ?? probePeer;
  const warn = deps.warn ?? ((s: string) => console.warn(`[guard] ${s}`));

  // `allSettled`, not `all`: the real `probePeer` never rejects (every
  // branch is inside its own try/catch), but an injected `probe` override
  // (tests, or a future caller) might. `Promise.all` would abort the whole
  // tick on one rejection and silently discard every peer that had already
  // resolved — a single flaky probe would blind the guard to a genuine live
  // peer sitting right next to it. A rejection reads the same as any other
  // non-answer: `unreachable`.
  const settled = await Promise.allSettled(deps.peers.map((peer) => probe(peer.url, deps.token)));
  const results = deps.peers.map((peer, i) => {
    const outcome = settled[i]!;
    const result: ProbeResult = outcome.status === 'fulfilled' ? outcome.value : { ok: false, reason: 'unreachable' };
    return { peer, result };
  });

  const live: string[] = [];
  let warned = false;

  for (const { peer, result } of results) {
    if (!result.ok) {
      if ((result.reason === 'bad-proof' || result.reason === 'no-proof') && !warned) {
        warn(`token mismatch on ${peer.name} — check Doppler/.env`);
        warned = true;
      }
      continue;
    }
    // Hairpin guard (spec §10) — the load-bearing check. See doc comment.
    if (result.bootId === deps.bootId) continue;
    live.push(peer.name);
  }

  if (live.length > 0) deps.onConflict(live);
}

export interface BootGuardDeps {
  self: string;
  bootId: string;
  peers: GuardPeer[];
  token?: string;
  /** The `ATLAS_FORCE_ACTIVE=true` escape hatch — proceed past a detected live peer instead of refusing to boot. */
  forceActive: boolean;
  probe?: typeof probePeer;
  /** Shared with `guardTick`'s own token-mismatch warning. Defaults to `console.warn`. */
  warn?: (s: string) => void;
  /** Defaults to `console.error`. Injectable so tests can assert the refusal message without real stderr noise. */
  error?: (s: string) => void;
  /** Defaults to `process.exit`. Injectable so tests can assert a refusal without killing the test runner. */
  exit?: (code: number) => void;
}

/**
 * The boot-time half of the single-active guard (spec §8): one guard pass
 * BEFORE the listener binds. A detected live peer refuses the boot —
 * unless `forceActive` is set, in which case it's logged and boot proceeds.
 * Legacy mode (no peers) is a no-op.
 *
 * Pulled out of `main.ts` specifically so this decision is unit-testable
 * without booting the whole process (Postgres, Redis, BullMQ, embedder
 * resolution): a review caught `ATLAS_FORCE_ACTIVE` throwing a `ZodError`
 * before `main()` even ran, and the reason it slipped through 1224 green
 * tests is that nothing exercised this branch directly — only the schema.
 */
export async function runBootGuard(deps: BootGuardDeps): Promise<void> {
  if (deps.peers.length === 0) return; // legacy mode: guard never runs

  const warn = deps.warn ?? ((s: string) => console.warn(`[guard] ${s}`));
  const error = deps.error ?? ((s: string) => console.error(s));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let live: string[] = [];
  await guardTick({
    self: deps.self,
    bootId: deps.bootId,
    peers: deps.peers,
    token: deps.token,
    onConflict: (names) => {
      live = names;
    },
    warn,
    probe: deps.probe,
  });

  if (live.length === 0) return;

  if (!deps.forceActive) {
    error(
      `[api] REFUSING TO START — live Atlas instance already running on: ${live.join(', ')}. ` +
        'Run `make down` on one of them before starting this one ' +
        '(or set ATLAS_FORCE_ACTIVE=true to override — emergency use only).',
    );
    exit(1);
    return;
  }

  warn(`ATLAS_FORCE_ACTIVE=true — starting anyway despite live peer(s): ${live.join(', ')}`);
}
