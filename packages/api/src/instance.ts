import { randomUUID } from 'node:crypto';
import { canonicalJson, proofFor } from '@atlas/core';

/**
 * The S8 instance protocol (spec §8): `/api/instance` proves the server
 * holds the shared token *and* that the payload is untampered, without the
 * client ever sending the token first. This module holds the pieces that are
 * genuinely process-wide singletons for THIS api process — `bootId`, the
 * single-active guard's `state` — plus `instancePayload`, which builds the
 * response body around them.
 *
 * `canonicalJson`/`proofFor` themselves live in `@atlas/core`
 * (instanceProof.ts, Task 24): the host-side resolver verifies proofs from
 * outside the api package and must not import from it, so the proof math
 * moved to core and this module re-exports it — one implementation, not a
 * local copy that could drift from the one the resolver recomputes against.
 */

export { canonicalJson, proofFor };

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
