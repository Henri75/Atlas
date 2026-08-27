import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@atlas/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      // Shared web/native logic is tested from source, so the suite does not
      // depend on a prior `tsc` emit of packages/shared/dist.
      '@atlas/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      // Subpath alias, not a barrel: the eval package has no index and its
      // modules are imported individually (`@atlas/eval/metrics.js`), matching
      // how they import each other.
      '@atlas/eval': fileURLToPath(new URL('./packages/eval/src', import.meta.url)),
      // vite-plugin-pwa injects this virtual module at build time; under plain
      // vitest it does not exist, and every test that renders App imports it.
      'virtual:pwa-register': fileURLToPath(
        new URL('./test/fixtures/pwaRegisterStub.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // Node >= 25 ships a `localStorage` global that is a getter returning
    // undefined unless --localstorage-file is given. Vitest's jsdom environment
    // refuses to overwrite an existing global, so every `@vitest-environment
    // jsdom` test saw `localStorage.getItem` on undefined (43 UI tests, Node
    // 26.7, 2026-08-24). Disabling Node's copy lets jsdom's win.
    execArgv: ['--no-experimental-webstorage'],
  },
});
