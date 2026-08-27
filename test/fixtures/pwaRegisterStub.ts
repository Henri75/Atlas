/**
 * Stand-in for Vite's `virtual:pwa-register`, which only exists while
 * vite-plugin-pwa is in the pipeline. The UI suite renders App (and therefore
 * src/pwa.ts) under plain vitest, where that module cannot resolve.
 *
 * A service worker is not registrable in jsdom anyway, so the honest stub is
 * one that does nothing and hands back the updater's shape.
 */
export function registerSW(_options?: {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}): (reloadPage?: boolean) => Promise<void> {
  return async () => {};
}
