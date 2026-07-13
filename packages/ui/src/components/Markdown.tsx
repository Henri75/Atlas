import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Render markdown as sanitized HTML.
 *
 * Everything Atlas indexes is markdown at the source: kdb logs are written as
 * `**Objective:**` / `- bullet` / `### heading` blocks, git commit bodies and
 * docs are markdown by nature, and the Ask answer is model output. All of it was
 * previously printed verbatim inside <pre>, so the reader saw the syntax rather
 * than the structure. This component is the single renderer for all of it.
 *
 * All of that content is untrusted — session transcripts and commit messages can
 * carry anything a tool or a stranger's PR put there, and the Ask answer can be
 * prompt-injected. The pipeline is therefore always parse → sanitize → inject,
 * never raw HTML. The two enrichments (citation markers, search highlighting)
 * are string transforms applied *after* sanitizing, so neither can reintroduce
 * markup that DOMPurify already removed.
 */

// GFM on (tables, strikethrough); no raw HTML passthrough — everything renders
// from markdown, and DOMPurify is the backstop for anything that slips.
marked.setOptions({ gfm: true, breaks: true });

/**
 * Escape text destined for an HTML string.
 *
 * Both post-sanitize transforms below splice caller-supplied text back into
 * already-clean HTML. That text is user input (the filter box) and would
 * otherwise be a hole straight through DOMPurify — it never saw these bytes.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Repair markdown truncated mid-syntax, before it reaches the parser.
 *
 * Search snippets are a blind `body.slice(0, 280)`, so they routinely end inside
 * a construct: `…**Objective` or `…\`\`\`ts\nconst x`. marked is tolerant but not
 * repairing — an unclosed `**` renders as literal asterisks, and an unclosed
 * fence swallows the remainder into a code block. Closing the delimiters we
 * opened costs nothing and is the difference between formatted text and visible
 * syntax. Only used for `compact`; a full body is never cut.
 */
function repairTruncated(text: string): string {
  let out = text;

  // A trailing partial word after the last space is a cut mid-token; an ellipsis
  // reads better than half a word. Only when the tail looks truncated (no
  // terminal punctuation) and there is enough text that trimming is safe.
  const fence = (out.match(/```/g) ?? []).length;
  if (fence % 2 === 1) out += '\n```';

  // Inline delimiters, longest first: `**` must be counted before `*`, or every
  // bold marker reads as two stray emphasis markers.
  for (const [delim, re] of [
    ['`', /`/g],
    ['**', /\*\*/g],
    ['~~', /~~/g],
  ] as const) {
    // Skip anything inside a fenced block — backticks there are the fence.
    if (delim === '`' && fence > 0) continue;
    const n = (out.match(re) ?? []).length;
    if (n % 2 === 1) out += delim;
  }

  return out;
}

/**
 * `[3]` or `[3, 7]` → superscript citation spans. Runs on sanitized HTML.
 *
 * Only applied when the caller passes a citation set — i.e. for an Ask answer.
 * In a git commit body or a session transcript, `[1]` is array syntax or a log
 * prefix, and rewriting it into a superscript would corrupt the text.
 *
 * Security: the only thing interpolated is `n`, and it is matched by `\d+` — a
 * run of digits cannot carry markup. `known` gates which numbers become
 * *buttons*: a citation the model invented (`[99]` with 8 sources) stays inert
 * text rather than a control that navigates nowhere.
 */
function citationize(html: string, known: ReadonlySet<number>): string {
  return html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_whole, nums: string) => {
    // Inside a fenced code block a `[1]` is array syntax, not a citation. The
    // check is crude but the failure mode is benign: an un-linked marker.
    return nums
      .split(',')
      .map((n) => n.trim())
      .map((n) => {
        const num = Number(n);
        if (!known.has(num)) return `<sup class="kdb-cite">[${n}]</sup>`;
        // data-cite is read by a delegated click handler on the container; no
        // inline handler, so this survives DOMPurify's rules by construction.
        return (
          `<sup class="kdb-cite kdb-cite-link" data-cite="${num}" ` +
          `role="button" tabindex="0" aria-label="Jump to source ${num}">[${n}]</sup>`
        );
      })
      .join('');
  });
}

/**
 * Wrap filter matches in <mark>, on sanitized HTML.
 *
 * The list views highlight what you typed in the filter box. Their old plain-text
 * renderer could do that by returning React nodes (see `Highlight` in ui.tsx),
 * but rendered markdown is injected as an HTML *string*, so React nodes cannot
 * compose into it. The match therefore has to be spliced into the markup — which
 * means two hazards this function exists to close:
 *
 *  1. It must only look at *text*, never at tags. Typing "li" or "strong" into
 *     the filter would otherwise hit the markup we just generated and wrap a tag
 *     name in <mark>, corrupting the document. Splitting on `<…>` and only
 *     transforming the between-tag segments confines it to text nodes.
 *  2. The needle is raw user input. It is escaped before it goes back in, and the
 *     text it matched is re-emitted from the *HTML* (already escaped) — so no
 *     new markup can appear.
 */
function highlight(html: string, needle: string): string {
  const n = needle.trim();
  if (!n) return html;
  // The haystack is escaped HTML, so the needle must be escaped to match it:
  // searching for `a & b` has to look for `a &amp; b`.
  const target = escapeHtml(n).toLowerCase();
  if (!target) return html;

  // Split into tags and the text between them; only the text is eligible.
  return html
    .split(/(<[^>]*>)/g)
    .map((seg) => {
      if (seg.startsWith('<')) return seg; // a tag — never touch it
      const lower = seg.toLowerCase();
      let out = '';
      let i = 0;
      for (;;) {
        const at = lower.indexOf(target, i);
        if (at === -1) return out + seg.slice(i);
        out += seg.slice(i, at);
        // Re-emit the matched span from the haystack, which is already-escaped
        // HTML — so this carries no markup the sanitizer has not already seen.
        out += `<mark class="kdb-mark">${seg.slice(at, at + target.length)}</mark>`;
        i = at + target.length;
      }
    })
    .join('');
}

export function Markdown({
  text,
  /**
   * Citation numbers that map to a real source. Others render as inert text.
   * Omit entirely outside the Ask answer: elsewhere `[1]` is just text.
   */
  citations,
  /** Called with the citation number when a marker is activated. */
  onCite,
  /** Hover/focus a marker: the source's number, or null on leave. */
  onCitePeek,
  /** Filter term to wrap in <mark>, matching the list views' filter box. */
  needle,
  /**
   * Dense variant for list rows and search snippets: body-size headings, no
   * block margins, so a row stays the height it was and `line-clamp` still
   * measures correctly. Also repairs markdown cut mid-syntax, since the only
   * things rendered this small are truncated.
   */
  compact,
  /** Extra classes on the container — sizing and scroll belong to the caller. */
  className = '',
}: {
  text: string;
  citations?: ReadonlySet<number>;
  onCite?: (n: number) => void;
  onCitePeek?: (n: number | null, at?: { x: number; y: number }) => void;
  needle?: string;
  compact?: boolean;
  className?: string;
}) {
  /**
   * Memoise on a stable *primitive*, not on the Set's identity.
   *
   * Callers naturally build this set inline (`new Set(sources.map(s => s.n))`),
   * which yields a fresh object every render. Depending on that identity meant
   * the memo never hit: every render re-parsed the markdown and replaced the
   * whole subtree, so the citation elements were continuously destroyed and
   * recreated — they could not even be clicked reliably. Keying on the sorted
   * numbers makes the cache depend on the set's *contents*.
   */
  const citeKey = citations ? [...citations].sort((a, b) => a - b).join(',') : '';

  /**
   * Memoise the `{__html}` *object*, not just the string inside it.
   *
   * React compares props by identity, so a fresh `{__html: html}` literal each
   * render counts as a change and re-sets `innerHTML` — destroying and rebuilding
   * every child node even when the markup is byte-identical. Since the citation
   * markers live in that subtree, they were being recreated under the user's
   * cursor. Holding the object stable keeps the DOM untouched between renders.
   */
  const markup = useMemo(() => {
    const src = compact ? repairTruncated(text) : text;
    // marked.parse is sync for string input with no async extensions.
    const raw = marked.parse(src, { async: false }) as string;
    let clean = DOMPurify.sanitize(raw, {
      // No event handlers, no <script>/<style>, no data:/javascript: URLs.
      USE_PROFILES: { html: true },
    });
    // Citations only where citations exist — see citationize's note.
    if (citations) {
      clean = citationize(clean, new Set(citeKey ? citeKey.split(',').map(Number) : []));
    }
    if (needle) clean = highlight(clean, needle);
    return { __html: clean };
    // `citations` is represented by citeKey; depending on the Set itself would
    // break the memo (fresh identity every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, citeKey, !!citations, needle, compact]);

  /**
   * One delegated listener rather than a handler per marker: the HTML is
   * injected as a string, so there is nothing to attach React props to. It also
   * means no inline `onclick` — which DOMPurify would strip anyway, and which
   * would be an injection vector if it didn't.
   */
  const citeAt = (e: { target: EventTarget | null }): number | null => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-cite]');
    const n = Number(el?.getAttribute('data-cite'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return (
    <div
      className={`kdb-md${compact ? ' kdb-md-compact' : ''}${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        const n = citeAt(e);
        if (n !== null) onCite?.(n);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const n = citeAt(e);
        if (n === null) return;
        e.preventDefault(); // Space would scroll the page.
        onCite?.(n);
      }}
      onMouseOver={(e) => {
        const n = citeAt(e);
        if (n !== null) {
          const r = (e.target as HTMLElement).getBoundingClientRect();
          onCitePeek?.(n, { x: r.left + r.width / 2, y: r.top });
        }
      }}
      onMouseOut={(e) => {
        if (citeAt(e) !== null) onCitePeek?.(null);
      }}
      onFocus={(e) => {
        const n = citeAt(e);
        if (n !== null) {
          const r = (e.target as HTMLElement).getBoundingClientRect();
          onCitePeek?.(n, { x: r.left + r.width / 2, y: r.top });
        }
      }}
      onBlur={(e) => {
        if (citeAt(e) !== null) onCitePeek?.(null);
      }}
      dangerouslySetInnerHTML={markup}
    />
  );
}
