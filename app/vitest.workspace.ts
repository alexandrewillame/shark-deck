import { resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

/**
 * Test tiers.
 *
 * vitest 2.1 has no inline `test.projects` -- that is 3.x -- so tiers live in a
 * workspace file and are selected with `--project <name>`.
 *
 * Two constraints that are easy to trip over:
 *  - `reporters`, `silent`, `coverage` and `forceRerunTriggers` are
 *    NonProjectOptions in vitest's own types. They MUST stay in
 *    vitest.config.ts; setting them here is silently ignored.
 *  - `resolve.alias` is NOT inherited from the root config by a workspace
 *    project, hence the repetition below.
 *
 * Tiers:
 *   unit     -- pure/node, co-located with source. The hot path (476 tests).
 *   contract -- the CLAUDE.md wiring invariants. ~1s; run after any edit that
 *               touches IPC, the preload bridge, the catalog or a descriptor.
 *   ui       -- jsdom + React. Matches only *.test.tsx, so the unit tier never
 *               pays the cost of booting a DOM.
 */
const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@': resolve(__dirname, 'src/renderer'),
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      testTimeout: 3_000,
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'contract',
      environment: 'node',
      include: ['test/contract/**/*.test.ts'],
      // AST parses, not I/O, are the slow part here.
      testTimeout: 10_000,
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'ui',
      environment: 'jsdom',
      include: ['src/**/*.test.tsx', 'test/ui/**/*.test.tsx'],
      setupFiles: ['./test/setup.ui.ts'],
      testTimeout: 5_000,
    },
  },
]);
