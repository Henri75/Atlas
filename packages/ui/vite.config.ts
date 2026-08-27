import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa';
import { PALETTE, VIEWS } from '@atlas/shared';

const SPLASH_DIR = fileURLToPath(new URL('./public/splash', import.meta.url));

/**
 * iOS ignores the manifest for splash screens and wants one
 * `apple-touch-startup-image` per device geometry, matched by media query.
 * Reading the generated directory keeps that list from drifting away from
 * scripts/app_assets.py — the alternative is fifteen hand-written link tags
 * that silently stop matching the day a device size is added.
 */
function iosSplashLinks(): Plugin {
  return {
    name: 'atlas-ios-splash-links',
    transformIndexHtml(html) {
      const links = readdirSync(SPLASH_DIR)
        .filter((f) => f.endsWith('.png'))
        .map((file) => {
          const [w, h] = file.replace('.png', '').split('x').map(Number);
          if (!w || !h) return '';
          // The files are named in device pixels; the media query is in CSS
          // pixels, so both dimensions divide by the ratio.
          const ratio = w >= 1125 ? 3 : 2;
          const media =
            `(device-width: ${w / ratio}px) and (device-height: ${h / ratio}px) ` +
            `and (-webkit-device-pixel-ratio: ${ratio})`;
          return `<link rel="apple-touch-startup-image" media="${media}" href="/splash/${file}" />`;
        })
        .filter(Boolean)
        .join('\n    ');
      return html.replace('<!--__ATLAS_IOS_SPLASH__-->', links);
    },
  };
}

/**
 * The web app manifest, exported so it is a testable value rather than an
 * anonymous literal buried in build config — test/ui/pwaManifest.test.ts
 * checks every icon it names exists and every shortcut points at a real view.
 */
export const atlasManifest: Partial<ManifestOptions> = {
  name: 'Atlas — project memory, searchable',
  short_name: 'Atlas',
  description:
    'Cross-project history: kdb logs, Claude Code sessions, git commits and docs, searchable and answerable.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'any',
  background_color: PALETTE.bg,
  theme_color: PALETTE.bg,
  categories: ['productivity', 'developer', 'utilities'],
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  // Long-press shortcuts, read from the same VIEWS registry the rail and
  // the settings menu use. Launchers show about four.
  shortcuts: VIEWS.slice(0, 4).map((v) => ({
    name: v.label,
    short_name: v.label,
    url: `/?view=${v.key}`,
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  })),
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    iosSplashLinks(),
    VitePWA({
      // The worker is ours (src/sw.ts); the plugin only injects the precache
      // manifest and wires up registration.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // 'prompt', not 'autoUpdate': reloading underneath someone mid-answer is
      // the one thing an update must never do.
      registerType: 'prompt',
      injectRegister: null,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        // The IBM Plex families plus the iOS splash set push the precache well
        // past the 2 MiB default, and a partial precache is a broken offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // iOS startup images are served by Safari from the network at install
        // time; precaching ~9 MB of them would bloat every first load.
        globIgnores: ['splash/**'],
      },
      manifest: atlasManifest,
      devOptions: {
        // Off by default: a worker caching a dev server's unhashed modules is
        // a debugging trap. `VITE_PWA_DEV=1 npm run dev -w packages/ui` opts in.
        enabled: process.env.VITE_PWA_DEV === '1',
        type: 'module',
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8710',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      /**
       * jsPDF lists html2canvas, canvg and dompurify as *optional* deps: it
       * imports them lazily inside `doc.html()` and its SVG path. We use neither
       * — the PDF is drawn from the answer's markdown and source list with the
       * text API, which is exactly what keeps the output selectable rather than
       * a screenshot. Rollup cannot prove those branches are dead, so without
       * this it bundles ~350 KB of renderers that can never execute.
       */
      external: ['html2canvas', 'canvg', 'dompurify/dist/purify.es.mjs'],
    },
  },
});
