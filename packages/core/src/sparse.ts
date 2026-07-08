/**
 * Local sparse (BM25-style) encoder. Tokens are hashed to stable u32 indices;
 * values are 1+log(tf). IDF weighting is applied server-side by Qdrant
 * (sparse vector modifier: 'idf'), so the client only supplies term frequency.
 * Works with zero network calls — this is what keeps keyword search alive
 * even when the embedding provider is down.
 */

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have if in into is it its of on or ' +
    'that the their then there these this to was were will with you your not no ' +
    'we they he she i do does did done can could should would may might').split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && t.length <= 40 && !STOPWORDS.has(t));
}

/** FNV-1a 32-bit — stable across runs and processes. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

export function sparseVector(text: string): SparseVector {
  const tf = new Map<number, number>();
  for (const token of tokenize(text)) {
    const idx = fnv1a(token);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }
  const indices = [...tf.keys()].sort((a, b) => a - b);
  return {
    indices,
    values: indices.map((i) => 1 + Math.log(tf.get(i)!)),
  };
}
