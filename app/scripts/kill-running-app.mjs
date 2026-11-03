/**
 * Kill any running SharkDeck.exe before a build starts, so electron-builder
 * and organize-dist.mjs never fail because the previous build's exe still
 * has files open (a running instance locks its own DLLs/exe under
 * dist/app/ or release/win-unpacked/).
 *
 * `taskkill /IM` matches by image name across every running instance —
 * including an installed copy the user happens to have open, not just a
 * leftover dev build. That's the point here: any locked SharkDeck.exe must
 * go before packaging can overwrite it.
 *
 * Windows-only (mirrors prep-wincodesign.mjs's platform guard) and
 * non-fatal: exit code 128 from taskkill just means "not running", and any
 * other failure here should not block the build — worst case the existing
 * organize-dist.mjs retry/error-message path still catches a stuck lock.
 */
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('kill-running-app: not Windows — nothing to do.');
  process.exit(0);
}

try {
  execFileSync('taskkill', ['/IM', 'SharkDeck.exe', '/F', '/T'], { stdio: 'pipe' });
  console.log('kill-running-app: stopped a running SharkDeck.exe.');
} catch (err) {
  // taskkill exits non-zero both when nothing matched and on a real error;
  // it prints "not found" to stderr in the harmless case. Only surface the
  // message when it looks like something other than "wasn't running".
  const msg = String(err?.stderr ?? err?.message ?? err);
  if (!/not found/i.test(msg)) {
    console.log(`kill-running-app: taskkill reported: ${msg.trim()}`);
  } else {
    console.log('kill-running-app: SharkDeck.exe was not running.');
  }
}
