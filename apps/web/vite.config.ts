import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = `http://localhost:${process.env.LCM_API_PORT ?? '8090'}`;

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  build: {
    // Never inline font files. Vite's default inlines assets under 4 KiB as
    // base64 `data:` URIs, which catches the small @fontsource unicode-range
    // subsets — but the production nginx CSP is `font-src 'self'` (no `data:`,
    // deliberately hardened), so an inlined font is BLOCKED and the app silently
    // falls back to a system face. Emitting fonts as `/assets/*.woff2` files
    // keeps them loadable under the tight CSP (nginx already long-caches them).
    // `false` = never inline for fonts; `undefined` = keep the 4 KiB default for
    // everything else (small SVGs/images still inline as before).
    assetsInlineLimit: (filePath) =>
      /\.(?:woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/healthz': apiTarget,
      '/readyz': apiTarget,
    },
  },
});
