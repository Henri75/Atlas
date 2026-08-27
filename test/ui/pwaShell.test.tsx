// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../packages/ui/src/App';
import { dismissBootSplash, splashDelay } from '../../packages/ui/src/pwa';

/**
 * The installed-app behaviours, which are exactly the ones nobody exercises in
 * a browser tab during development.
 */

/** /api/projects must be an array — the scope bar maps over it on first paint. */
const fixtures: Record<string, unknown> = {
  '/api/projects': [],
  '/api/machines': [],
};

const stubOk = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => fixtures[String(url).split('?')[0]!] ?? {},
      text: async () => '',
    })),
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  document.getElementById('atlas-boot')?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The rail marks the active view with aria-current — the semantic signal. */
const activeView = async (label: string) =>
  waitFor(() =>
    expect(document.querySelector('[aria-current="page"]')?.textContent).toContain(label),
  );

describe('manifest shortcuts', () => {
  it('opens the view named in ?view=', async () => {
    stubOk();
    window.history.replaceState({}, '', '/?view=machines');
    render(<App />);
    await activeView('Machines');
  });

  /**
   * The parameter reaches us from a launcher, so it is untrusted input. An
   * unknown view would otherwise render a shell with no content at all — App
   * checks `view === '…'` seven times with no fallback arm.
   */
  it('falls back to the start view when ?view= is not a real view', async () => {
    stubOk();
    localStorage.setItem('atlas.startView', JSON.stringify('machines'));
    window.history.replaceState({}, '', '/?view=../etc/passwd');
    render(<App />);
    await activeView('Machines');
  });

  it('lets ?view= outrank the persisted start view', async () => {
    stubOk();
    localStorage.setItem('atlas.startView', JSON.stringify('machines'));
    window.history.replaceState({}, '', '/?view=timeline');
    render(<App />);
    await activeView('Timeline');
  });
});

describe('boot splash handoff', () => {
  /**
   * The splash is a fixed overlay at z-index 2000. Fading it without removing
   * it leaves an invisible sheet over the whole app that eats every click.
   */
  /**
   * The dwell rule itself, without a clock. A fast local load would otherwise
   * flash the splash past unreadably, which is worse than no splash at all.
   */
  it('holds the splash for the minimum dwell, and no longer', () => {
    expect(splashDelay(0)).toBe(900);
    expect(splashDelay(300)).toBe(600);
    expect(splashDelay(900)).toBe(0);
    // A slow first load has already paid the dwell — do not add to it.
    expect(splashDelay(5000)).toBe(0);
  });

  it('fades and then removes the inline splash element', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.id = 'atlas-boot';
    document.body.appendChild(el);

    dismissBootSplash();
    expect(document.getElementById('atlas-boot')).not.toBeNull();

    // Past the dwell, it fades...
    act(() => void vi.advanceTimersByTime(1000));
    expect(el.dataset.leaving).toBe('true');

    // ...and only then leaves the document. A faded-but-present overlay at
    // z-index 2000 would swallow the first click of every session.
    act(() => void vi.advanceTimersByTime(400));
    expect(document.getElementById('atlas-boot')).toBeNull();
  });

  it('is a no-op when the page has no splash element', () => {
    expect(() => dismissBootSplash()).not.toThrow();
  });
});
