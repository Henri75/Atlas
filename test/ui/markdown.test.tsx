// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from '../../packages/ui/src/components/Markdown';

afterEach(cleanup);

/**
 * Everything this renders is untrusted: kdb log bodies, git commit messages and
 * session transcripts are indexed from arbitrary sources, and the Ask answer is
 * model output that can be prompt-injected. These pin the pipeline: markdown
 * renders, and injected markup is stripped before it can reach the DOM.
 */
describe('Markdown', () => {
  it('renders markdown structure as HTML', () => {
    const { container } = render(<Markdown text={'## Heading\n\n- one\n- two\n\n**bold**'} />);
    expect(container.querySelector('h2')?.textContent).toBe('Heading');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('renders a kdb component entry as structure, not as syntax', () => {
    // The shape every kdb component log is written in. Before this component was
    // wired into the views, the reader saw the asterisks.
    const { container } = render(
      <Markdown text={'**Objective:**\n- Stop the timeout\n\n**Status:**\n- Completed'} />,
    );
    expect(container.querySelectorAll('strong')).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    // The literal markers are gone from the rendered text.
    expect(container.textContent).not.toContain('**');
  });

  it('strips a script tag from untrusted answer text', () => {
    const { container } = render(
      <Markdown text={'safe text<script>window.__xss = 1</script> after'} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('__xss');
  });

  it('strips an inline event handler from injected markup', () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)">'} />);
    const img = container.querySelector('img');
    // The tag may survive; the handler must not.
    expect(img?.getAttribute('onerror')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('renders a fenced code block', () => {
    const { container } = render(<Markdown text={'```\nnexus-ctl drain podcast\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toContain('nexus-ctl drain');
  });
});

/**
 * Citations are interactive, and that interactivity must not become an injection
 * vector: the transform still runs on already-sanitized HTML, and the only thing
 * interpolated into it is a run of digits.
 */
describe('Markdown — citation links', () => {
  const known = new Set([1, 2]);

  it('links a citation that has a matching source', () => {
    const { container } = render(<Markdown text="grounded [1]" citations={known} />);
    const cite = container.querySelector('sup.kdb-cite-link');
    expect(cite?.getAttribute('data-cite')).toBe('1');
    expect(cite?.getAttribute('role')).toBe('button');
  });

  it('leaves a citation with no source inert', () => {
    // Models invent citations. A [9] with two sources must not become a control
    // that navigates nowhere.
    const { container } = render(<Markdown text="invented [9]" citations={known} />);
    expect(container.querySelector('sup.kdb-cite-link')).toBeNull();
    expect(container.querySelector('sup.kdb-cite')?.textContent).toBe('[9]');
  });

  it('reports the citation number when one is activated', async () => {
    const seen: number[] = [];
    const { container } = render(
      <Markdown text="see [2]" citations={known} onCite={(n) => seen.push(n)} />,
    );
    (container.querySelector('sup.kdb-cite-link') as HTMLElement).click();
    expect(seen).toEqual([2]);
  });

  it('never emits an inline event handler', () => {
    // The click path is a delegated React listener reading data-cite. An inline
    // onclick would be both stripped by DOMPurify and an injection vector.
    const { container } = render(<Markdown text="a [1] b" citations={known} />);
    expect(container.innerHTML).not.toContain('onclick');
  });

  it('does not let injected markup ride in on a citation', () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)"> [1]'} citations={known} />,
    );
    expect(container.innerHTML).not.toContain('onerror');
    // The legitimate citation still linkifies.
    expect(container.querySelector('sup.kdb-cite-link')).toBeTruthy();
  });

  it('leaves [n] completely alone when there are no citations', () => {
    // The component now renders git commit bodies and session transcripts too,
    // where `[1]` is array syntax or a log prefix — not a citation. Rewriting it
    // into an amber superscript there would be corruption, not enrichment. The
    // transform therefore only runs when the caller passes a citation set.
    const { container } = render(<Markdown text="const first = items[0] and rows[1]" />);
    expect(container.querySelector('sup.kdb-cite')).toBeNull();
    expect(container.textContent).toContain('rows[1]');
  });

  it('still marks an unknown citation inert when a source list IS supplied', () => {
    const { container } = render(<Markdown text="invented [9]" citations={new Set([1])} />);
    expect(container.querySelector('sup.kdb-cite')?.textContent).toBe('[9]');
    expect(container.querySelector('sup.kdb-cite-link')).toBeNull();
  });
});

/**
 * The list views highlight the filter term inside the body. The old plain-text
 * renderer did that by returning React nodes; rendered markdown is injected as an
 * HTML *string*, so the match has to be spliced into the markup instead. That
 * splice is the dangerous part, and these are the two ways it can go wrong.
 */
describe('Markdown — filter highlighting', () => {
  it('wraps the match in <mark> inside rendered markdown', () => {
    const { container } = render(<Markdown text={'**Objective:** stop the timeout'} needle="timeout" />);
    const mark = container.querySelector('mark.kdb-mark');
    expect(mark?.textContent).toBe('timeout');
    // Structure survives the splice.
    expect(container.querySelector('strong')?.textContent).toBe('Objective:');
  });

  it('matches case-insensitively, like the plain-text filter it replaces', () => {
    const { container } = render(<Markdown text="Qdrant timed out" needle="qdrant" />);
    expect(container.querySelector('mark.kdb-mark')?.textContent).toBe('Qdrant');
  });

  it('does not corrupt markup when the needle matches a tag name', () => {
    // Typing "li" or "strong" into the filter box must not reach into the HTML we
    // just generated and wrap a tag name. If the transform looked at tags rather
    // than only text nodes, this test finds it: the list would be destroyed.
    const { container } = render(<Markdown text={'- lithium\n- sodium'} needle="li" />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    // The match landed in the *text*, not in the tag.
    expect(container.querySelector('mark.kdb-mark')?.textContent).toBe('li');
    expect(container.textContent).toContain('lithium');
  });

  it('escapes a needle carrying markup rather than injecting it', () => {
    // The needle is raw user input spliced back into sanitized HTML — the one
    // place DOMPurify never sees. It must be escaped on the way in.
    const { container } = render(
      <Markdown text={'a <script>x</script> b'} needle="<script>" />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('<script>');
  });

  it('matches text containing an HTML entity', () => {
    // The haystack is escaped HTML, so `&` lives there as `&amp;`. Searching for
    // the literal `&` only works if the needle is escaped to match.
    const { container } = render(<Markdown text="Tom & Jerry" needle="Tom & Jerry" />);
    expect(container.querySelector('mark.kdb-mark')?.textContent).toBe('Tom & Jerry');
  });

  it('renders unchanged when the needle is empty', () => {
    const { container } = render(<Markdown text="**bold**" needle="" />);
    expect(container.querySelector('mark.kdb-mark')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });
});

/**
 * Search snippets are a blind `body.slice(0, 280)`, so they routinely end inside
 * a markdown construct. marked is tolerant but not *repairing*: given an unclosed
 * `**` it emits literal asterisks — precisely the syntax we are rendering to get
 * rid of — and an unclosed fence swallows the rest of the snippet.
 */
describe('Markdown — compact (truncated snippets)', () => {
  it('closes a bold marker left dangling by the cut', () => {
    const { container } = render(<Markdown text="fixed the **timeout" compact />);
    expect(container.querySelector('strong')?.textContent).toBe('timeout');
    expect(container.textContent).not.toContain('**');
  });

  it('closes a code span left dangling by the cut', () => {
    const { container } = render(<Markdown text="run `make ps" compact />);
    expect(container.querySelector('code')?.textContent).toBe('make ps');
    expect(container.textContent).not.toContain('`');
  });

  it('closes a fence left open by the cut', () => {
    const { container } = render(<Markdown text={'see:\n```ts\nconst x = 1'} compact />);
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1');
  });

  it('leaves balanced markdown untouched', () => {
    const { container } = render(<Markdown text="**done** and `ok`" compact />);
    expect(container.querySelector('strong')?.textContent).toBe('done');
    expect(container.querySelector('code')?.textContent).toBe('ok');
  });

  it('applies the compact class so blocks collapse to row height', () => {
    // A `### heading` in a two-line result row would otherwise blow the row's
    // height and stop line-clamp measuring correctly.
    const { container } = render(<Markdown text="### Heading" compact />);
    expect(container.querySelector('.kdb-md-compact')).toBeTruthy();
    expect(container.querySelector('h3')?.textContent).toBe('Heading');
  });

  it('does not repair a full body, which is never cut', () => {
    // A lone `**` in prose is not a truncation — without `compact` it stays as
    // written rather than being "helpfully" closed.
    const { container } = render(<Markdown text="a ** b" />);
    expect(container.querySelector('strong')).toBeNull();
  });
});

/**
 * Found in a real browser, invisible to a single-snapshot test: passing a fresh
 * `new Set()` each render gave the memo a new dependency identity every time, so
 * the answer was re-parsed and its DOM replaced continuously — the citation
 * elements were destroyed and rebuilt faster than they could be clicked.
 * The memo must key on the set's *contents*, not its identity.
 */
describe('Markdown — render stability', () => {
  it('reuses the parsed HTML when an equal-but-new citation Set is passed', () => {
    const { container, rerender } = render(
      <Markdown text="cited [1]" citations={new Set([1])} />,
    );
    const first = container.querySelector('sup.kdb-cite-link');

    // Exactly what a parent does when it builds the set inline in render.
    rerender(<Markdown text="cited [1]" citations={new Set([1])} />);
    const second = container.querySelector('sup.kdb-cite-link');

    // Same node object: the subtree was not rebuilt.
    expect(second).toBe(first);
  });

  it('re-renders when the citation set genuinely changes', () => {
    const { container, rerender } = render(<Markdown text="a [1] b [2]" citations={new Set([1])} />);
    expect(container.querySelectorAll('sup.kdb-cite-link')).toHaveLength(1);

    rerender(<Markdown text="a [1] b [2]" citations={new Set([1, 2])} />);
    expect(container.querySelectorAll('sup.kdb-cite-link')).toHaveLength(2);
  });
});
