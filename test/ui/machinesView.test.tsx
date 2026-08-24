// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachinesView } from '../../packages/ui/src/views/MachinesView';

afterEach(cleanup);

const stub = (data: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data, text: async () => '' })));

const fleet = {
  self: 'nasta-mbp',
  machines: [
    {
      name: 'nasta-mbp',
      address: '127.0.0.1',
      user: 'nasta',
      codeRoots: ['/data/code'],
      claudeProjects: '/data/claude',
      enabled: true,
      sync: null,
    },
    {
      name: 'mac-mini',
      address: '10.0.0.5',
      user: 'nasta',
      codeRoots: ['/data/code0'],
      claudeProjects: '/data/claude',
      enabled: true,
      sync: {
        lastAttemptAt: '2026-08-19T00:00:00Z',
        lastSuccessAt: null,
        status: 'unreachable',
        bytes: null,
        durationMs: null,
        error: 'ssh: connect to host 10.0.0.5 port 22: Connection refused',
      },
    },
  ],
};

describe('MachinesView', () => {
  it('renders the fleet, marks self, and shows an unreachable pill', async () => {
    stub(fleet);
    render(<MachinesView />);
    await waitFor(() => expect(screen.getByText('nasta-mbp')).toBeTruthy());
    expect(screen.getByText('mac-mini')).toBeTruthy();
    expect(screen.getByText('(self)')).toBeTruthy();
    expect(screen.getByText('unreachable')).toBeTruthy();
    expect(screen.getByText(/Connection refused/)).toBeTruthy();
    // The never-synced self row reads as 'never' (both the pill and the
    // "last success" cell), not as an error.
    expect(screen.getAllByText('never').length).toBeGreaterThanOrEqual(2);
  });

  it('explains single-machine (legacy) mode instead of an empty table', async () => {
    stub({ self: 'local', machines: [] });
    render(<MachinesView />);
    await waitFor(() => expect(screen.getByText('Single-machine mode.')).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says the API is unreachable rather than rendering a blank page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    render(<MachinesView />);
    await waitFor(() => expect(screen.getByText('Cannot reach the API.')).toBeTruthy());
  });
});
