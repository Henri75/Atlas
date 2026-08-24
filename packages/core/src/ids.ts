import { createHash } from 'node:crypto';

/**
 * Deterministic UUID (v5-shaped, SHA-1 based) so re-indexing the same content
 * upserts the same Qdrant point instead of duplicating it.
 */
/**
 * Bump this whenever the id derivation changes: every dedup_key and Qdrant
 * point id changes with it, so the catalog must be rebuilt (the indexer
 * detects the mismatch at boot and reindexes rather than duplicating rows).
 */
export const ID_SCHEME = 'v2';

/**
 * The `kdbscope` here is the tool's former name (it is Atlas now) and is frozen
 * on purpose: it is hashed into every id, so editing this string is exactly as
 * destructive as bumping ID_SCHEME above — every dedup_key and Qdrant point id
 * changes and the whole catalog must be rebuilt. It is a hash input, not a brand.
 */
const NAMESPACE = `kdbscope:${ID_SCHEME}`;

/**
 * Unit separator (U+001F). It cannot occur in a slug, path, ref or number, so
 * joining with it is unambiguous.
 *
 * v1 joined with a space, which made `('line:1', 'fix bug')` and
 * `('line:1 fix', 'bug')` hash identically. Two different entries sharing a
 * dedup_key means the second is silently never indexed — and titles are free
 * text from the user's logs, so this was reachable. Changing the namespace to
 * v2 invalidates the old ids on purpose (see docs/operations.md).
 */
const SEP = '\x1f';

export function deterministicUuid(...parts: string[]): string {
  const digest = createHash('sha1')
    .update(NAMESPACE)
    .update(parts.join(SEP))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
