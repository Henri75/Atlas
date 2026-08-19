// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardView } from '../../packages/ui/src/views/DashboardView';

afterEach(cleanup);

const base = {
  projects: 50, entries: 142_555, chunks: 157_135, sessions: 485,
  errors: 841, recentErrors: 0, lastRunAt: new Date().toISOString(),
  bySource: { claude_session: 123_635, doc: 13_119, git_commit: 3_817 },
  embedder: 'ollama/nomic-embed-text', collection: 'kdbscope_ollama_768',
  pending: 0, queue: null, backfill: null,
  health: { postgres: true, qdrant: true, redis: true, ollama: true },
  vectors: { points: 157_369, vectors: 314_201, segments: 7 },
  storage: {
    postgresBytes: 245_298_879,
    qdrantBytes: 2_515_421_157,
    redisMemoryBytes: 4_378_216,
    collections: [{ name: 'kdbscope_ollama_768', bytes: 1_414_856_704, active: true }],
  },
};

const stub = (data: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data, text: async () => '' })));

/** Routes /api/dashboard and /api/machines to different fixtures by URL. */
const stubByUrl = (fixtures: Record<string, unknown>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => fixtures[String(url).split('?')[0]!] ?? {},
      text: async () => '',
    })),
  );

describe('DashboardView', () => {
  it('shows compact headline counts with exact values on hover', async () => {
    stub(base);
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('143k')).toBeTruthy()); // entries
    expect(screen.getByTitle((142_555).toLocaleString())).toBeTruthy();
    expect(screen.getByText('485')).toBeTruthy(); // sessions, small enough to stay exact
  });

  it('reports every service and its state', async () => {
    stub({ ...base, health: { postgres: true, qdrant: false, redis: true, ollama: true } });
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('unreachable')).toBeTruthy());
    expect(screen.getAllByText('running')).toHaveLength(3);
  });

  it('shows storage in binary units', async () => {
    stub(base);
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('2.34 GB')).toBeTruthy()); // qdrant
    expect(screen.getByText('234 MB')).toBeTruthy(); // postgres
  });

  /** "cannot tell" must never render as "uses no disk". */
  it('renders a dash, not a zero, when a size is unknown', async () => {
    stub({ ...base, storage: { postgresBytes: null, qdrantBytes: null, redisMemoryBytes: null, collections: [] } });
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByText('0 B')).toBeNull();
  });

  /**
   * The one actionable fact on the page: switching the embedding model leaves
   * a collection behind that nothing reads. On a real index it is over a GB.
   */
  it('calls out vectors orphaned by an embedding-model change', async () => {
    stub({
      ...base,
      storage: {
        ...base.storage,
        collections: [
          { name: 'kdbscope_ollama_768', bytes: 1_414_856_704, active: true },
          { name: 'kdbscope_bundled_384', bytes: 1_099_511_627, active: false },
        ],
      },
    });
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText(/of stale vectors/)).toBeTruthy());
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
  });

  it('says nothing about stale vectors when there are none', async () => {
    stub(base);
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('ACTIVE')).toBeTruthy());
    expect(screen.queryByText(/of stale vectors/)).toBeNull();
  });

  it('explains an unreachable API rather than rendering an empty page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('Cannot reach the API.')).toBeTruthy());
  });

  /**
   * A single-machine install has nothing to disambiguate — /api/machines
   * answers `{ self: 'local', machines: [] }` in legacy mode — so the Fleet
   * section must be entirely absent, not an empty grid. This is the same
   * "must look exactly as today" contract the badge and dropdown carry.
   */
  it('shows no Fleet section for a single-machine install', async () => {
    stubByUrl({ '/api/dashboard': base, '/api/machines': { self: 'local', machines: [] } });
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('Services')).toBeTruthy());
    expect(screen.queryByText('Fleet')).toBeNull();
  });

  it('renders a card per fleet machine, self marked, with a status pill', async () => {
    stubByUrl({
      '/api/dashboard': base,
      '/api/machines': {
        self: 'nasta-mbp',
        machines: [
          {
            name: 'nasta-mbp', address: '127.0.0.1', user: 'nasta',
            codeRoots: ['/x'], claudeProjects: '/y', enabled: true, sync: null,
          },
          {
            name: 'mac-mini', address: '10.0.0.5', user: 'nasta',
            codeRoots: ['/x'], claudeProjects: '/y', enabled: true,
            sync: {
              lastAttemptAt: new Date().toISOString(),
              lastSuccessAt: new Date().toISOString(),
              status: 'ok', bytes: 1024, durationMs: 500, error: null,
            },
          },
        ],
      },
    });
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('Fleet')).toBeTruthy());
    expect(screen.getByText('nasta-mbp')).toBeTruthy();
    expect(screen.getByText('mac-mini')).toBeTruthy();
    expect(screen.getByText('(self)')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
  });

  /** unreachable/error read as a problem regardless of how stale they are. */
  it('colors an unreachable machine as a problem, not just stale', async () => {
    stubByUrl({
      '/api/dashboard': base,
      '/api/machines': {
        self: 'nasta-mbp',
        machines: [
          {
            name: 'nasta-mbp', address: '127.0.0.1', user: 'nasta',
            codeRoots: ['/x'], claudeProjects: '/y', enabled: true, sync: null,
          },
          {
            name: 'mac-mini', address: '10.0.0.5', user: 'nasta',
            codeRoots: ['/x'], claudeProjects: '/y', enabled: true,
            sync: {
              lastAttemptAt: new Date().toISOString(), lastSuccessAt: null,
              status: 'unreachable', bytes: null, durationMs: null, error: 'timed out',
            },
          },
        ],
      },
    });
    render(<DashboardView onGoTo={() => {}} />);
    await waitFor(() => expect(screen.getByText('unreachable')).toBeTruthy());
  });
});
