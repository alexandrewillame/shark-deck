import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { hardenCsp } from './build/csp';

/**
 * Tightens the renderer CSP at production build time only. The substitution
 * itself lives in build/csp.ts so test/contract/no-network-csp.test.ts can run
 * it against the real index.html -- this plugin is `apply: 'build'`, so a dev
 * run never executes it and nothing else would notice the regex going stale.
 */
function hardenProdCsp(): Plugin {
  return {
    name: 'harden-prod-csp',
    apply: 'build',
    transformIndexHtml: hardenCsp,
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          crash: resolve(__dirname, 'src/preload/crash.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), hardenProdCsp()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          crash: resolve(__dirname, 'src/renderer/crash.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        },
      },
    },
  },
});
