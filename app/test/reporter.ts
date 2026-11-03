import type { Reporter } from 'vitest/reporters';
import { getFullName, getTests } from '@vitest/runner/utils';

/**
 * Quiet reporter: one line on green, only the failures on red.
 *
 * Why not a built-in: measured on this repo, `vitest run` emits 57 lines on a
 * fully green run and `--reporter=dot --silent` bottoms out at 42, because in a
 * non-TTY context (which is every agent and CI invocation) DotReporter degrades
 * to BaseReporter's per-file listing. 42 lines of "checkmark file (n tests)" is
 * 42 lines that say nothing, on every single run.
 *
 * `npm run test:verbose` restores the default reporter when a human wants the
 * file list or a test's own console output.
 */

type FileTask = Parameters<NonNullable<Reporter['onFinished']>>[0][number];

export default class QuietReporter implements Reporter {
  private started = 0;

  onInit() {
    this.started = Date.now();
  }

  /**
   * A test's own console.log is never what someone is looking for in a green
   * run, and on a red run the assertion message is. `silent: true` in
   * vitest.config.ts covers this too; this is belt and braces.
   */
  onUserConsoleLog() {}

  onFinished(files: FileTask[] = [], errors: unknown[] = []) {
    const out: string[] = [];
    const tests = files.flatMap((f) => getTests(f));
    const failed = tests.filter((t) => t.result?.state === 'fail');
    const skipped = tests.filter((t) => t.mode === 'skip' || t.mode === 'todo');

    for (const t of failed) {
      out.push(`\nFAIL ${t.file?.name ?? '?'}`);
      out.push(`  ${getFullName(t, ' > ')}`);
      for (const raw of t.result?.errors ?? []) {
        const e = raw as { message?: string; diff?: string; stack?: string };
        out.push(`    ${e.message ?? 'unknown error'}`);
        if (e.diff) {
          out.push(
            e.diff
              .split('\n')
              .map((l) => `    ${l}`)
              .join('\n'),
          );
        }
        const frame = frameOf(e.stack);
        if (frame) out.push(`    at ${frame}`);
      }
    }

    /**
     * A file that throws while being imported has no leaf tasks at all -- its
     * error hangs off the file task instead. Without this branch a broken
     * import reports as a silent green run, which is the worst possible
     * failure mode for a quiet reporter.
     */
    for (const f of files) {
      if (f.result?.state === 'fail' && getTests(f).length === 0) {
        out.push(`\nFAIL ${f.name} (module did not load)`);
        for (const raw of f.result.errors ?? []) {
          out.push(`    ${(raw as Error)?.message ?? String(raw)}`);
        }
      }
    }

    for (const e of errors) {
      out.push(`\nERROR ${(e as Error)?.stack ?? String(e)}`);
    }

    const ms = Date.now() - this.started;
    const bad = failed.length + errors.length;
    out.push(
      bad
        ? `\nFAIL ${failed.length} failed, ${tests.length - failed.length} passed (${files.length} files, ${ms}ms)`
        : `PASS ${tests.length} tests, ${files.length} files${
            skipped.length ? `, ${skipped.length} skipped` : ''
          } (${ms}ms)`,
    );
    process.stdout.write(`${out.join('\n')}\n`);
  }
}

/** The first stack frame inside this project -- the only one worth printing. */
function frameOf(stack?: string): string | null {
  const line = stack
    ?.split('\n')
    .find((l) => /[\/](src|test|scripts)[\/]/.test(l) && !l.includes('node_modules'));
  return line?.trim().replace(/^at\s+/, '') ?? null;
}
