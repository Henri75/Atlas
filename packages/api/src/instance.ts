import { createHmac, randomUUID } from 'node:crypto';

/**
 * The S8 instance protocol (spec §8): `/api/instance` proves the server
 * holds the shared token *and* that the payload is untampered, without the
 * client ever sending the token first. This module holds the pieces that are
 * genuinely process-wide singletons — `bootId`, the single-active guard's
 * `state` — plus the pure functions (`canonicalJson`, `proofFor`,
 * `instancePayload`) both the route (signing) and Task 23's guard /
 * Task 24's resolver (verifying, by recomputing the same proof) share.
 */

/**
 * Per-process identity, minted once at module load (i.e. once per process
 * start). The self-recognition key that survives everything `installId`
 * doesn't: a hairpin (stale DNS/lease routing a peer probe back to THIS
 * process) matches on `bootId` and is ignored rather than misread as a
 * conflict; a cloned-volume restore duplicates `installId` but never
 * `bootId`, so a genuine peer with a copied identity is still detected.
 */
export const bootId = randomUUID();

type InstanceState = 'active' | 'conflicted';

let state: InstanceState = 'active';
let peers: string[] = [];

/** Current single-active-guard state (spec §8/§10). */
export function getState(): InstanceState {
  return state;
}

/**
 * Flip to `conflicted` on discovering a live peer (guard.ts, Task 23: a
 * proof-valid responder whose `bootId` differs from ours). Deliberately
 * one-way — there is no `clearConflict`: the spec calls for loud refusal
 * over an automated pick, so recovery is a fresh process start, not a
 * runtime reset.
 */
export function setConflicted(peerNames: string[]): void {
  state = 'conflicted';
  peers = [...peerNames];
}

/** Names of the peer(s) that triggered the current conflict, if any. */
export function conflictPeers(): string[] {
  return peers;
}

/**
 * Deterministic stringify: object keys sorted (recursively), so identical
 * data always canonicalizes to the same string no matter what order it was
 * built in. The HMAC proof below signs THIS string, never
 * `JSON.stringify`'s insertion-order-dependent one.
 *
 * Every field passed in must be defined. `JSON.stringify(undefined)` returns
 * the literal 5-char text `undefined` — not valid JSON, and silently so — so
 * this throws instead: a caller signing an accidentally-incomplete payload
 * (e.g. a field left off during a refactor) should see that at the call
 * site, not sign a corrupt-but-internally-consistent proof that later fails
 * a legitimate verifier for reasons neither side can see.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('canonicalJson: undefined is not valid JSON — every field must be defined');
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * `HMAC-SHA256(token, nonce + '\n' + canonicalJson(payload))` (spec §8).
 * Signs the WHOLE payload — every field the response body carries besides
 * `proof` itself — so a tampered `state`, `machine`, or any other field
 * invalidates it, not just a signed subset. Shared by the route (which
 * computes it once to attach) and the guard/resolver (which recompute it
 * over what they received and compare, since verification IS recomputation
 * for an HMAC).
 */
export function proofFor(token: string, nonce: string, payload: object): string {
  return createHmac('sha256', token).update(`${nonce}\n${canonicalJson(payload)}`).digest('hex');
}

/**
 * The `/api/instance` response body minus `proof` — the route attaches that
 * separately once it knows whether a token is configured (no-token mode
 * omits the key entirely, spec §8).
 */
export function instancePayload(deps: {
  machine: string;
  installId: string;
  entries: number;
}): { machine: string; installId: string; bootId: string; state: InstanceState; entries: number } {
  return {
    machine: deps.machine,
    installId: deps.installId,
    bootId,
    state: getState(),
    entries: deps.entries,
  };
}
