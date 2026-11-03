import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Root vitest config. The per-tier settings live in vitest.workspace.ts; only
 * options that vitest treats as non-project-scoped belong here.
 *
 * The `resolve.alias` block is deliberately duplicated from the workspace file:
 * three npm scripts (verify:he, snapshot:kb, verify:writes) run
 * `vite-node --config vitest.config.ts`, and vite-node ignores the workspace
 * file entirely, so removing this would break them.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    // Superseded by vitest.workspace.ts for `vitest run`; kept so a bare
    // `vitest --config vitest.config.ts` still finds the unit tests.
    include: ['src/**/*.test.ts'],
    reporters: ['./test/reporter.ts'],
    silent: true,
    /**
     * `--changed` resolves dependents through the module graph, which cannot
     * see a config or setup file. Without these, editing one of them would run
     * nothing rather than everything.
     */
    forceRerunTriggers: [
      '**/package.json',
      '**/vitest.config.ts',
      '**/vitest.workspace.ts',
      '**/tsconfig.json',
      '**/test/setup.ui.ts',
      '**/test/reporter.ts',
    ],
  },
});
