import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@atlas/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      // Subpath alias, not a barrel: the eval package has no index and its
      // modules are imported individually (`@atlas/eval/metrics.js`), matching
      // how they import each other.
      '@atlas/eval': fileURLToPath(new URL('./packages/eval/src', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
