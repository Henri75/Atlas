/// <reference lib="webworker" />

/**
 * `__WB_MANIFEST` is a build-time placeholder, not a runtime API, so no lib
 * declares it — vite-plugin-pwa substitutes the precache list for it while
 * bundling this file.
 */
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/**
 * The Atlas service worker.
 *
 * Written by hand rather than assembled from workbox-routing: the routing here
 * is four rules, and the two that matter are about what must NEVER be cached —
 * an SSE stream and a Cloudflare Access login redirect. Both are the kind of
 * thing a generic "cache successful responses" recipe gets wrong, and a
 * poisoned cache in a service worker outlives the tab that made it.
 *
 * vite-plugin-pwa (injectManifest) replaces __WB_MANIFEST with the built asset
 * list, so precaching stays exact across releases instead of guessing at globs.
 */

const MANIFEST = self.__WB_MANIFEST;

// Bumping the version retires every previous cache in one step.
const VERSION = 'atlas-v1';
const PRECACHE = `${VERSION}-precache`;
const API_CACHE = `${VERSION}-api`;
const SHELL = '/index.html';

/** Cap the API mirror so a long session cannot grow it without bound. */
const API_CACHE_MAX = 60;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // Revisioned URLs are immutable; `reload` bypasses the HTTP cache so a
      // stale intermediary cannot seed the precache with an old bundle.
      await cache.addAll(
        MANIFEST.map((e) => new Request(e.url, { cache: 'reload' })),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (!key.startsWith(VERSION)) await caches.delete(key);
      }
      // Serve the new assets to already-open tabs rather than waiting for
      // every one of them to be closed.
      await self.clients.claim();
    })(),
  );
});

/** The app asks for this when the user accepts an update prompt. */
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

/**
 * A response is only safe to store if it really came from Atlas.
 *
 * When a Cloudflare Access session expires the edge answers with a redirect to
 * the login page. Fetch follows it, so the SW sees a 200 whose body is
 * Cloudflare's HTML — caching that would pin a login page in place of the API
 * (or worse, of the app shell) until the cache was manually cleared.
 */
function isStorable(res: Response): boolean {
  return res.ok && res.type === 'basic' && !res.redirected;
}

async function trimCache(name: string, max: number): Promise<void> {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) {
    await cache.delete(k);
  }
}

/** Network first, falling back to the last good copy. */
async function apiFetch(request: Request): Promise<Response> {
  const cache = await caches.open(API_CACHE);
  try {
    const fresh = await fetch(request);
    if (isStorable(fresh)) {
      await cache.put(request, fresh.clone());
      void trimCache(API_CACHE, API_CACHE_MAX);
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

/** Cache first: build assets are content-hashed, so they never go stale. */
async function assetFetch(request: Request): Promise<Response> {
  const cached = await caches.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const fresh = await fetch(request);
  if (isStorable(fresh)) {
    const cache = await caches.open(PRECACHE);
    await cache.put(request, fresh.clone());
  }
  return fresh;
}

/** How long a navigation waits for the network before the shell takes over. */
const NAV_TIMEOUT_MS = 3000;

/**
 * Navigations go to the network first, then fall back to the precached shell.
 *
 * The order matters because of Cloudflare Access: when the session expires the
 * edge answers a navigation with a redirect to its login page, and that has to
 * reach the browser. Serving the cached shell first would show a working app
 * whose every request then silently comes back as Cloudflare's HTML.
 *
 * The timeout is what keeps that from costing anything on a bad connection —
 * past it, the shell is served and React renders its own offline state.
 */
async function navigate(request: Request): Promise<Response> {
  const shell = async () => (await caches.match(SHELL)) ?? Response.error();
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('nav timeout')), NAV_TIMEOUT_MS),
    );
    return await Promise.race([fetch(request), timeout]);
  } catch {
    return shell();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only this origin, only GET. A POST is never replayable, and cross-origin
  // requests are none of the worker's business.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // SSE must stream. Answering it from a cache, or holding the body to clone
  // it, turns a live answer into one that arrives all at once at the end.
  if (request.headers.get('accept')?.includes('text/event-stream')) return;
  if (url.pathname.startsWith('/api/ask/stream')) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(apiFetch(request));
    return;
  }
  event.respondWith(assetFetch(request));
});

export {};
