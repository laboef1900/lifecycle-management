import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Resolve @lcm/shared to its TypeScript source, not the built dist, so
      // web tests always compile the current source. Without this, a new or
      // changed shared export is invisible to tests until
      // `pnpm --filter @lcm/shared build` runs — a stale-dist footgun that can
      // make tests pass against old code. The production `vite build`
      // (vite.config.ts) still uses the package's dist entry. See issue #265.
      '@lcm/shared': resolve(__dirname, '../../packages/shared/src'),
    },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'playwright'],
    passWithNoTests: true,
    // Node >=22 ships an experimental global `localStorage`/`sessionStorage`
    // (Web Storage API) that requires `--localstorage-file` to actually
    // work; without it, the getter just returns undefined. Vitest's jsdom
    // environment skips installing its own Storage implementation for
    // globals that already exist on `globalThis`, so the Node stub wins and
    // `localStorage` is undefined in tests. Disabling the experimental flag
    // in the test runner process lets jsdom's own (working) Storage take
    // over the global.
    execArgv: ['--no-experimental-webstorage'],
  },
});
