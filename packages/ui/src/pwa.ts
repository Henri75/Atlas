/// <reference types="vite-plugin-pwa/client" />
import { useCallback, useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * The installed-app half of the web client: boot splash handoff, service
 * worker lifecycle, and the install prompt.
 *
 * Kept out of App.tsx because none of it is React's business — it is the
 * document and the worker talking to each other, and the components only need
 * the two booleans that fall out.
 */

/** Matches the native app's minimum splash dwell, so neither one flashes past. */
const MIN_SPLASH_MS = 900;
const FADE_MS = 320;

/**
 * How much longer the splash should stay up, given how long the page has
 * already been open.
 *
 * Pure so the dwell rule is testable without a clock: the DOM side below only
 * has to be trusted to schedule, not to arithmetic.
 */
export function splashDelay(pageAgeMs: number): number {
  return Math.max(0, MIN_SPLASH_MS - pageAgeMs);
}

/**
 * Retire the inline boot splash once React has painted.
 *
 * The element lives in index.html rather than the React tree precisely so it
 * can appear before any of this loads, which also means React cannot unmount
 * it — the handoff has to happen from here.
 *
 * The dwell is measured with performance.now(), which counts from navigation
 * start. Module-evaluation time would be wrong: this bundle is fetched and
 * parsed *after* the splash is already on screen, so it would always
 * over-wait by however long the download took.
 */
export function dismissBootSplash(): void {
  const el = document.getElementById('atlas-boot');
  if (!el) return;
  const wait = splashDelay(performance.now());
  window.setTimeout(() => {
    el.dataset.leaving = 'true';
    // Remove rather than leave a transparent overlay: at z-index 2000 it would
    // otherwise keep swallowing the first click of every session.
    window.setTimeout(() => el.remove(), FADE_MS + 40);
  }, wait);
}

export interface UpdateState {
  /** A new version is installed and waiting for permission to take over. */
  updateReady: boolean;
  /** Activate the waiting worker and reload. */
  applyUpdate: () => void;
  /** Everything needed to run offline is cached (first visit only). */
  offlineReady: boolean;
}

/**
 * Registers the worker and reports its lifecycle.
 *
 * `registerType: 'prompt'` means an update installs but does not activate:
 * a reload in the middle of a streaming answer would lose it, so the choice
 * belongs to the reader.
 */
export function useServiceWorker(): UpdateState {
  const [updateReady, setUpdateReady] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [apply, setApply] = useState<(() => void) | null>(null);

  useEffect(() => {
    // The dev server has no worker unless VITE_PWA_DEV=1; registerSW is a
    // no-op there rather than an error.
    const update = registerSW({
      immediate: true,
      onNeedRefresh: () => setUpdateReady(true),
      onOfflineReady: () => setOfflineReady(true),
    });
    // Store the updater behind a function so useState does not call it.
    setApply(() => () => void update(true));
  }, []);

  const applyUpdate = useCallback(() => {
    apply?.();
  }, [apply]);

  return { updateReady, applyUpdate, offlineReady };
}

/** Chromium's deferred install prompt. Safari and Firefox never fire it. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function useInstallPrompt(): { canInstall: boolean; install: () => void } {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Suppressing the default is what lets us offer installation from our
      // own UI instead of the browser's mini-infobar.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(() => {
    const e = deferred;
    if (!e) return;
    // The event is single-use: whatever the outcome, it cannot be re-prompted.
    setDeferred(null);
    void e.prompt();
  }, [deferred]);

  return { canInstall: deferred !== null, install };
}

/** True when running as an installed app rather than in a browser tab. */
export function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(() => isStandalone());
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const on = () => setStandalone(isStandalone());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return standalone;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari predates display-mode and reports this instead.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/** Online/offline, so the shell can say so rather than just failing calls. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
