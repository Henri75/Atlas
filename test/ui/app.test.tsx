// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../packages/ui/src/App';

const fixtures: Record<string, unknown> = {
  '/api/projects': [
    { slug: 'deepcast', name: 'DeepCast', rootPath: '/x/DeepCast', hasKdb: true, entryCount: 42 },
  ],
  '/api/stats': {
    projects: 1, entries: 42, chunks: 100, errors: 0,
    bySource: {}, embedder: 'ollama/nomic-embed-text', collection: 'kdbscope_x',
  },
};

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => ({
    ok: true,
    json: async () => fixtures[String(url).split('?')[0]!] ?? {},
    text: async () => '',
  })),
);

afterEach(cleanup);

describe('App shell', () => {
  it('renders sidebar with projects and stats', async () => {
    render(<App />);
    expect(screen.getByText('Scope')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('deepcast')).toBeTruthy());
    expect(screen.getByText(/42 entries/)).toBeTruthy();
    expect(screen.getByText('Search & Ask')).toBeTruthy();
    expect(screen.getByText('Timeline')).toBeTruthy();
  });

  it('shows the search empty state by default', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText('Ask your codebases what happened.')).toBeTruthy(),
    );
  });

  /**
   * A dead backend used to be swallowed into an empty project list, so "no
   * projects indexed" and "cannot reach the API" looked identical — which is
   * what made a 502 look like a broken sidebar.
   */
  it('says the API is unreachable instead of rendering an empty index', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Cannot reach the API/));
  });
});
