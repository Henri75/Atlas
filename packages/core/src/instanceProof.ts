import { createHmac } from 'node:crypto';

/**
 * The S8 instance-proof primitive (spec §8): `HMAC-SHA256(token, nonce +
 * canonical-payload)`, plus the deterministic canonicalizer it signs over.
 *
 * Lives in `@atlas/core` — not `packages/api` — because both directions of
 * the protocol need it from host-side code that must not depend on the api
 * package: the `/api/instance` route (packages/api/src/instance.ts, which
 * re-exports these two functions unchanged rather than keeping a second
 * copy) SIGNS a proof; the continuous single-active guard (packages/api/src/
 * guard.ts, via that same re-export) and the host-side resolver (resolve.ts,
 * this package, used by the CLI and the MCP shim) VERIFY one by recomputing
 * it — verification IS recomputation for an HMAC. One implementation, three
 * call sites.
 */

/**
 * Deterministic stringify: object keys sorted (recursively), so identical
 * data always canonicalizes to the same string no matter what order it was
 * built in. The HMAC proof below signs THIS string, never `JSON.stringify`'s
 * insertion-order-dependent one.
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
 * invalidates it, not just a signed subset. Shared by the signer (the
 * `/api/instance` route) and every verifier (guard.ts's `probePeer`,
 * resolve.ts's `probeInstance`), since verification IS recomputation for an
 * HMAC.
 */
export function proofFor(token: string, nonce: string, payload: object): string {
  return createHmac('sha256', token).update(`${nonce}\n${canonicalJson(payload)}`).digest('hex');
}
