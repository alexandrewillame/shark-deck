import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import { hardenWebCsp } from './build/csp';

/**
 * The browser edition: the renderer plus, inside the page, the device layer
 * that runs in Electron's main process on the desktop (src/web/main.ts). A
 * static site in out/web/, published to GitHub Pages by
 * .github/workflows/pages.yml.
 *
 *   npm run dev:web      dev server on http://127.0.0.1:5174 (a secure
 *                        context, so WebHID works there)
 *   npm run build:web    -> out/web/
 *   npm run preview:web  serve the build
 */

const version = (
  JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * Fails the build on any Node or Electron import. Without it Vite swaps a
 * browser-incompatible module for an empty stub and only warns — and
 * `class X extends EventEmitter` from that stub throws the moment the page
 * loads. test/contract/browser-node-free.test.ts checks the same thing
 * without a build.
 */
function nodeFree(): Plugin {
  const banned = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
    'electron',
  ]);
  return {
    name: 'sharkdeck-node-free',
    enforce: 'pre',
    resolveId(id, importer) {
      if (banned.has(id) || id.startsWith('node:')) {
        this.error(
          `"${id}" imported by ${importer ?? '?'}: the browser edition cannot use Node or Electron ` +
            'modules. Keep it out of the code src/web/main.ts reaches.',
        );
      }
      return null;
    },
  };
}

function hardenCspOnBuild(): Plugin {
  return { name: 'harden-web-csp', apply: 'build', transformIndexHtml: hardenWebCsp };
}

const PUBLIC_DIR = resolve(__dirname, 'src/web/public');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(join(dir, e.name))
      : [relative(PUBLIC_DIR, join(dir, e.name)).replace(/\\/g, '/')],
  );
}

/**
 * Builds src/web/sw.ts into out/web/sw.js, with every file of the build as its
 * precache list and an id hashed from all their contents — so any change to
 * the site is a new worker, which is what makes the browser offer the update.
 * `post`, so index.html (emitted by Vite's own HTML plugin) is in the bundle
 * by the time this runs.
 */
function serviceWorker(): Plugin {
  return {
    name: 'sharkdeck-service-worker',
    apply: 'build',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const files = new Map<string, string | Uint8Array>();
      for (const [name, out] of Object.entries(bundle)) {
        if (!name.endsWith('.map')) files.set(name, out.type === 'chunk' ? out.code : out.source);
      }
      for (const name of filesUnder(PUBLIC_DIR)) {
        files.set(name, readFileSync(join(PUBLIC_DIR, name)));
      }
      const precache = [...files.keys()].sort();
      const hash = createHash('sha256');
      for (const name of precache) hash.update(name).update(files.get(name)!);
      const build = `${version}-${hash.digest('hex').slice(0, 12)}`;

      const source = readFileSync(resolve(__dirname, 'src/web/sw.ts'), 'utf8');
      const { code } = await transformWithEsbuild(source, 'sw.ts', {
        loader: 'ts',
        format: 'iife',
        target: 'chrome110',
        minify: true,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source:
          `const __SD_PRECACHE__=${JSON.stringify(precache)};` +
          `const __SD_BUILD__=${JSON.stringify(build)};\n${code}`,
      });
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  // Relative, so the same build works under /shark-deck/ on GitHub Pages and
  // anywhere else it is served from.
  base: './',
  plugins: [nodeFree(), react(), hardenCspOnBuild(), serviceWorker()],
  resolve: {
    alias: {
      // The one module swapped wholesale: transport.ts runs unchanged over a
      // WebHID implementation of the node-hid API it uses.
      'node-hid': resolve(__dirname, 'src/web/hid/node-hid-webhid.ts'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  define: {
    __SD_HOST__: JSON.stringify('browser'),
    __SD_APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    // WebHID is Chromium-only (Chrome/Edge/Opera 89+); no need to transpile
    // for anything older.
    target: 'chrome110',
    // The polyfill loads modules with fetch(), which the page's
    // `connect-src 'none'` forbids. Chromium has native modulepreload.
    modulePreload: { polyfill: false },
    // One page that works offline once installed: splitting it would only
    // add requests to the first visit. ~470 kB gzipped in all.
    chunkSizeWarningLimit: 1000,
  },
  server: { host: '127.0.0.1', port: 5174 },
  preview: { host: '127.0.0.1', port: 4174 },
});
