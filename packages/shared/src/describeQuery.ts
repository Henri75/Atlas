/**
 * Turn a recorded `query` into something a human reads.
 *
 * The column holds two different things, because the two route shapes record
 * differently. A GET route stores its raw URL query string:
 *
 *   q=safari+youtube+content+process+crash&project=deepcast&limit=10
 *
 * A POST ask route stores the question as typed. So this splits them apart and
 * decodes the first kind into the search text plus its filters, which is what
 * the reader actually wants — `+` as spaces, `%2B` as a plus, and the paging
 * parameters demoted out of the way.
 *
 * Kept as a pure function away from the component so the parsing edge cases can
 * be tested directly: this runs over data that arrived from a URL, and every
 * assumption about it is one a caller can violate.
 */

export interface DescribedQuery {
  /** The human-readable subject of the call. */
  text: string;
  /** Everything that narrowed it, in a stable order. */
  filters: { key: string; value: string }[];
  /** True when the raw value was a URL query string that has been decoded. */
  decoded: boolean;
}

/**
 * Parameters that are mechanics rather than intent. Shown last, and never
 * mistaken for the subject of the call.
 */
const MECHANICAL = new Set(['limit', 'offset', 'k', 'max_body', 'cursorAt', 'cursorId']);

/** The parameter carrying the actual text, by route. */
const TEXT_KEYS = ['q', 'question'];

/**
 * Does this look like a URL query string rather than prose?
 *
 * Deliberately strict. A real question can easily contain '=' ("what does k=12
 * do?"), so presence of '=' cannot be the test. Requiring the very first token
 * to be `key=` — an unspaced identifier followed by '=' — keeps human questions
 * out, which matters because decoding prose would turn every '+' in it into a
 * space.
 */
function looksLikeQueryString(raw: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(raw);
}

export function describeQuery(raw: string | undefined): DescribedQuery | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  if (!looksLikeQueryString(value)) {
    // Already prose: an ask question, recorded as typed.
    return { text: value, filters: [], decoded: false };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(value);
  } catch {
    // Unparseable: show the raw string rather than nothing. A monitor that hides
    // what it could not read is worse than one that shows it verbatim.
    return { text: value, filters: [], decoded: false };
  }

  let text = '';
  const named: { key: string; value: string }[] = [];
  const mechanical: { key: string; value: string }[] = [];

  for (const [key, v] of params) {
    if (!v) continue;
    if (!text && TEXT_KEYS.includes(key)) {
      text = v;
      continue;
    }
    (MECHANICAL.has(key) ? mechanical : named).push({ key, value: v });
  }

  // Filters before mechanics, each group in the order they appeared, so two
  // calls with the same filters always render identically.
  return {
    text,
    filters: [...named, ...mechanical],
    decoded: true,
  };
}

/** One-line form for a dense table cell. */
export function summarizeQuery(raw: string | undefined): string {
  const d = describeQuery(raw);
  if (!d) return '';
  if (d.text && d.filters.length === 0) return d.text;
  if (!d.text) return d.filters.map((f) => `${f.key}: ${f.value}`).join(' · ');
  return `${d.text} — ${d.filters.map((f) => `${f.key}: ${f.value}`).join(' · ')}`;
}
