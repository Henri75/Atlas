/**
 * Local sparse (BM25-style) encoder. Tokens are hashed to stable u32 indices;
 * values are 1+log(tf). IDF weighting is applied server-side by Qdrant
 * (sparse vector modifier: 'idf'), so the client only supplies term frequency.
 * Works with zero network calls — this is what keeps keyword search alive
 * even when the embedding provider is down.
 *
 * ## Why the tokeniser is not a plain `split(/\W+/)`
 *
 * It was, and it silently destroyed every literal in the corpus. `.` was a
 * separator and single characters were dropped, so `6.8MB` indexed as `["8mb"]`
 * — the significant digit gone, and the remainder sharing one bucket with
 * `1.8MB`, `0.8MB` and `8MB`. The spaced spelling `6.8 MB` produced `["mb"]`,
 * a token set with *nothing* in common with the unspaced one, so a document
 * written one way was lexically unreachable from a question written the other.
 *
 * Measured consequence (2026-07-29): asking about a "6.8MB json" ranked the
 * filler word "quite" (IDF 17.5) above the only discriminative term in the
 * question (`8mb`, IDF 16.4), and the two entries that answered it did not
 * appear in the top 100. Version strings (`v1.18.2` → `v1`,`18`), IPs, prices
 * and durations were shredded the same way.
 *
 * The invariant that replaces it: **a literal survives tokenisation whole, and
 * its spaced and unspaced spellings produce the same tokens.**
 */

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have if in into is it its of on or ' +
    'that the their then there these this to was were will with you your not no ' +
    'we they he she i do does did done can could should would may might').split(' '),
);

/**
 * Bumped whenever tokenisation changes the tokens a given text produces.
 *
 * Stored sparse vectors and query sparse vectors must come from the same
 * tokeniser or they simply stop matching — a silent, total failure of keyword
 * search that no health check would see. The indexer compares this against the
 * `sparse_version` setting and rebuilds the sparse side of the collection when
 * they differ (`rebuildSparseVectors`), which is cheap because sparse vectors
 * are computed locally: no embedding provider, no re-parsing of sources.
 *
 * 1 → the original `split(/[^a-z0-9_]+/)`.
 * 2 → literal-preserving: decimals, versions, dotted/underscored identifiers,
 *     and number+unit canonicalisation.
 */
export const SPARSE_VERSION = 2;

/**
 * Units that may be written with or without a space after the number.
 *
 * Only joined when the preceding run is *purely* numeric, so "3 s3 buckets"
 * cannot become `3s3` — `s3` is not a member. Deliberately limited to the
 * measurements that actually appear in engineering history (sizes, durations,
 * magnitudes); a longer list buys nothing and risks fusing ordinary prose.
 */
const UNITS = new Set(
  ('b kb mb gb tb pb kib mib gib tib bit bits byte bytes ' +
    'ns us ms sec secs s min mins m h hr hrs d day days ' +
    'k bn req rps qps px pt').split(' '),
);

/** A run that is nothing but a number: `6`, `6.8`, `1.2.3`. */
const PURE_NUMBER = /^\d+(?:\.\d+)*$/;
/** A number immediately followed by letters: `6.8mb`, `621k`, `500ms`. */
const NUMBER_UNIT = /^(\d+(?:\.\d+)?)([a-z]+)$/;

function keep(token: string): boolean {
  return token.length >= 2 && token.length <= 40 && !STOPWORDS.has(token);
}

/**
 * Should a dotted run also be emitted as its dot-separated parts?
 *
 * Only when every segment starts with a letter. That one condition separates
 * the two kinds of dotted run cleanly:
 *
 *  - `mv_user_metadata_aggregations.tags_with_counts`, `deepcast.io` — compound
 *    identifiers, where the parts are meaningful on their own and splitting is
 *    what keeps a search for `tags_with_counts` working.
 *  - `6.8mb`, `v1.18.2`, `127.0.0.1` — single atomic values, where splitting is
 *    exactly the bug: it invents `8mb` out of `6.8mb` and loses the `6`.
 */
function splittable(segments: string[]): boolean {
  return segments.every((s) => /^[a-z]/.test(s));
}

export function tokenize(text: string): string[] {
  // `.` is kept inside runs here and resolved below, rather than being treated
  // as a separator up front — that decision cannot be revisited once the
  // information is gone.
  const runs = text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    // Sentence punctuation rides along on the last word ("large." / "...done").
    .map((r) => r.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);

  const out: string[] = [];
  const push = (t: string) => {
    if (keep(t)) out.push(t);
  };

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    push(run);

    // "6.8 MB" must produce what "6.8MB" produces, or a document written one
    // way is unreachable from a question written the other.
    if (PURE_NUMBER.test(run)) {
      const next = runs[i + 1];
      if (next && UNITS.has(next)) {
        push(`${run}${next}`);
        push(next);
        i++; // the unit is consumed; emitting it twice would inflate its tf
      }
      continue;
    }

    // ...and symmetrically, "6.8MB" produces the parts that "6.8 MB" produces.
    const numberUnit = NUMBER_UNIT.exec(run);
    if (numberUnit && UNITS.has(numberUnit[2]!)) {
      push(numberUnit[1]!);
      push(numberUnit[2]!);
      continue;
    }

    if (run.includes('.')) {
      const segments = run.split('.').filter(Boolean);
      if (segments.length > 1 && splittable(segments)) for (const s of segments) push(s);
    }
  }
  return out;
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

/**
 * Extra query-side weight for a token that looks like a literal rather than
 * prose — a size, a version, a commit sha, a column name, a path.
 *
 * Term frequency alone cannot express "this is the term I actually mean". In a
 * conversational question the discriminative literal appears once, exactly as
 * often as every filler word around it, so IDF is the only thing separating
 * them — and IDF is a property of the corpus, not of the question. The measured
 * failure this exists to prevent: a 19-token question in which the size that
 * uniquely identified the answer carried less weight than the word "quite",
 * because both occurred once and the corpus happened to make them comparably
 * rare.
 *
 * Applied to queries only. Documents are left at honest term frequency: this is
 * a statement about what the *asker* means, and baking it into the index would
 * distort the IDF statistics the whole ranking rests on.
 */
const LITERAL_BOOST = 3;

/** Does this token carry the shape of an identifier or a measurement? */
export function isLiteralToken(token: string): boolean {
  // Mixed digits and letters: `6.8mb`, `v1.18.2`, `4277bf0b`, `500ms`.
  if (/\d/.test(token) && /[a-z]/.test(token)) return true;
  // Compound identifiers: `tags_with_counts`, `mv_user_metadata_aggregations`.
  if (token.includes('_')) return true;
  // Dotted names and versions: `deepcast.io`, `1.18.2`, `127.0.0.1`.
  if (token.includes('.')) return true;
  // A bare number long enough to be a figure rather than an index: `621`, `2026`.
  if (/^\d{3,}$/.test(token)) return true;
  return false;
}

export interface SparseOptions {
  /**
   * Up-weight literal-shaped tokens. Set for queries, never for documents.
   */
  boostLiterals?: boolean;
}

export function sparseVector(text: string, opts: SparseOptions = {}): SparseVector {
  const tf = new Map<number, number>();
  const literal = new Set<number>();
  for (const token of tokenize(text)) {
    const idx = fnv1a(token);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
    if (opts.boostLiterals && isLiteralToken(token)) literal.add(idx);
  }
  const indices = [...tf.keys()].sort((a, b) => a - b);
  return {
    indices,
    values: indices.map((i) => (1 + Math.log(tf.get(i)!)) * (literal.has(i) ? LITERAL_BOOST : 1)),
  };
}
