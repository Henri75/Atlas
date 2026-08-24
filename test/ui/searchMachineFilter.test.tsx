// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../packages/ui/src/App';

/**
 * The "First ingested from" machine filter and the hit-row badge it powers.
 *
 * Both are gated on fleet size (>= 2 machines from /api/machines), not on
 * whether a hit happens to carry a `machine` field — a single-machine
 * install must look exactly as it did before the fleet feature existed, even
 * once entries start carrying real provenance.
 */

const projects = [
  { slug: 'deepcast', name: 'DeepCast', rootPath: '/x/DeepCast', hasKdb: true, entryCount: 12 },
];
const stats = {
  projects: 1, entries: 10, chunks: 10, errors: 0, recentErrors: 0,
  bySource: {}, embedder: 'ollama/nomic-embed-text', collection: 'c',
  pending: 0, queue: null, backfill: null,
};
const hit = {
  entryId: 1, score: 1, projectSlug: 'deepcast', sourceType: 'doc',
  title: 'a doc', snippet: 'body', sourcePath: '/x/DeepCast/doc.md', machine: 'mac-mini',
};
const fleet = {
  self: 'nasta-mbp',
  machines: [
    { name: 'nasta-mbp', address: '127.0.0.1', user: 'nasta', codeRoots: ['/x'], claudeProjects: '/y', enabled: true, sync: null },
    { name: 'mac-mini', address: '10.0.0.5', user: 'nasta', codeRoots: ['/x'], claudeProjects: '/y', enabled: true, sync: null },
  ],
};

const stubByUrl = (fixtures: Record<string, unknown>) => {
  const spy = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => fixtures[String(url).split('?')[0]!] ?? {},
    text: async () => '',
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const search = async () => {
  const el = (await screen.findByLabelText('Search query')) as HTMLTextAreaElement;
  fireEvent.change(el, { target: { value: 'q' } });
  fireEvent.keyDown(el, { key: 'Enter' });
};

describe('Machine filter and badge', () => {
  it('hides the dropdown and the hit-row badge in a single-machine install', async () => {
    stubByUrl({
      '/api/projects': projects,
      '/api/stats': stats,
      '/api/machines': { self: 'local', machines: [] },
      '/api/search': { hits: [hit], mode: 'hybrid', tookMs: 3, degraded: false },
    });
    render(<App />);
    await search();
    await waitFor(() => expect(screen.getByText('a doc')).toBeTruthy());
    expect(screen.queryByLabelText('First ingested from')).toBeNull();
    expect(screen.queryByText('mac-mini')).toBeNull();
  });

  it('shows the dropdown and the hit-row badge once the fleet has 2+ machines', async () => {
    stubByUrl({
      '/api/projects': projects,
      '/api/stats': stats,
      '/api/machines': fleet,
      '/api/search': { hits: [hit], mode: 'hybrid', tookMs: 3, degraded: false },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('First ingested from')).toBeTruthy());
    await search();
    await waitFor(() => expect(screen.getByText('a doc')).toBeTruthy());
    // Once in the dropdown option, once in the hit-row badge.
    expect(screen.getAllByText(/mac-mini/).length).toBeGreaterThanOrEqual(2);
  });

  it('sends the selected machine on search', async () => {
    const spy = stubByUrl({
      '/api/projects': projects,
      '/api/stats': stats,
      '/api/machines': fleet,
      '/api/search': { hits: [], mode: 'hybrid', tookMs: 3, degraded: false },
    });
    render(<App />);
    const select = await screen.findByLabelText('First ingested from');
    fireEvent.change(select, { target: { value: 'mac-mini' } });
    await search();
    await waitFor(() =>
      expect(spy.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/api/search'))).toBe(true),
    );
    const call = spy.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/search'))!;
    expect(new URL(call, 'http://x').searchParams.get('machine')).toBe('mac-mini');
  });
});
