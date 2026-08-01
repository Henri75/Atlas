// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../packages/ui/src/App';

/**
 * The composer at the top of Search & Ask.
 *
 * It was a one-line `<input>`, which was fine for `qdrant timeout fix` and
 * hostile for the questions Ask actually exists to answer — you could not see
 * what you had written. It is a textarea in both modes now, and these tests pin
 * the three things that are easy to get wrong when a field grows: that Enter
 * still sends, that Shift+Enter genuinely reaches the browser as a newline, and
 * that an IME committing a candidate is not mistaken for a send.
 */

const fixtures: Record<string, unknown> = {
  '/api/projects': [
    { slug: 'deepcast', name: 'DeepCast', rootPath: '/x/DeepCast', hasKdb: true, entryCount: 12 },
  ],
  '/api/stats': {
    projects: 1, entries: 10, chunks: 10, errors: 0, recentErrors: 0,
    bySource: {}, embedder: 'ollama/nomic-embed-text', collection: 'c',
    pending: 0, queue: null, backfill: null,
  },
  '/api/search': { hits: [], mode: 'hybrid', tookMs: 3, degraded: false },
};

/** Returns the spy so a test can read back the URL the app actually requested. */
const stubOk = () => {
  const spy = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => fixtures[String(url).split('?')[0]!] ?? {},
    text: async () => '',
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
};

const searchCalls = (spy: ReturnType<typeof stubOk>) =>
  spy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/search'));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Atlas opens on Search & Ask, so the composer is on screen from the start. */
const composer = async () => (await screen.findByLabelText('Search query')) as HTMLTextAreaElement;

describe('Search & Ask composer', () => {
  it('is a textarea, so a long question is visible while you write it', async () => {
    stubOk();
    render(<App />);
    expect((await composer()).tagName).toBe('TEXTAREA');
  });

  it('sends on Enter and suppresses the newline that keystroke would insert', async () => {
    const spy = stubOk();
    render(<App />);
    const el = await composer();
    fireEvent.change(el, { target: { value: 'qdrant timeout' } });

    // dispatchEvent returns false when a handler called preventDefault — which
    // is precisely the question here: did the field swallow the newline?
    const notPrevented = fireEvent.keyDown(el, { key: 'Enter' });
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(searchCalls(spy).length).toBe(1));
  });

  it('lets Shift+Enter through as a newline instead of sending', async () => {
    const spy = stubOk();
    render(<App />);
    const el = await composer();
    fireEvent.change(el, { target: { value: 'first line' } });

    const notPrevented = fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    // Default survives, so the browser inserts the line break itself.
    expect(notPrevented).toBe(true);
    expect(searchCalls(spy)).toEqual([]);
  });

  /**
   * With an IME, Enter commits the candidate you are composing. Treating it as
   * a send fires the question mid-word, and `isComposing` is the only thing
   * that distinguishes that keystroke from a real one.
   */
  it('does not send on the Enter that commits an IME candidate', async () => {
    const spy = stubOk();
    render(<App />);
    const el = await composer();
    fireEvent.change(el, { target: { value: '日本語' } });

    fireEvent.keyDown(el, { key: 'Enter', isComposing: true });
    expect(searchCalls(spy)).toEqual([]);
  });

  it('opens taller in Ask mode, where questions are long, and not in Search', async () => {
    stubOk();
    render(<App />);
    const before = await composer();
    expect(before.className).toContain('min-h-0');

    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    const asking = (await screen.findByLabelText('Ask a question')) as HTMLTextAreaElement;
    expect(asking.className).toContain('min-h-[4.5rem]');
    // The very same DOM node: swapping elements would drop focus and caret
    // position for anyone who flips mode mid-sentence.
    expect(asking).toBe(before);
  });

  /**
   * Ask wants the newlines — paragraph structure is meaning to an LLM. A search
   * query is a bag of terms, and the breaks only ever reach the `tsquery` as
   * noise, so they are collapsed on the way out.
   */
  it('collapses newlines out of a pasted multi-line search query', async () => {
    const spy = stubOk();
    render(<App />);
    const el = await composer();
    fireEvent.change(el, { target: { value: '  qdrant\n\n  timeout   fix \n' } });
    fireEvent.keyDown(el, { key: 'Enter' });

    await waitFor(() => expect(searchCalls(spy).length).toBe(1));
    const url = new URL(searchCalls(spy)[0]!, 'http://x');
    expect(url.searchParams.get('q')).toBe('qdrant timeout fix');
  });

  it('says how to get a new line, where the rule is not obvious', async () => {
    stubOk();
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
    const asking = await screen.findByLabelText('Ask a question');
    expect(asking.getAttribute('placeholder')).toMatch(/⇧↵ for a new line/);
  });
});
