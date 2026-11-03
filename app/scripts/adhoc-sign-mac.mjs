/**
 * electron-builder `afterPack` hook. `electron-builder.yml` sets `mac.identity:
 * null` (this project has no Apple Developer ID — see docs/platform-support.md),
 * which skips electron-builder's own signing step entirely. Without *any*
 * signature an Apple Silicon Mac refuses to launch the app outright ("is
 * damaged and can't be opened") — a harder failure than the ordinary
 * Gatekeeper "unidentified developer" prompt an ad-hoc-signed build gets
 * instead. `codesign --sign -` (a literal hyphen, not a real identity) is
 * the standard workaround for unsigned open-source distribution.
 *
 * When a real Developer ID certificate is available, delete this hook and
 * `mac.identity: null` from electron-builder.yml and let electron-builder
 * sign (and optionally notarize) properly instead.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** @param {import('electron-builder').AfterPackContext} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    // `codesign` only exists on macOS. electron-builder can still assemble a
    // mac build's unpacked files cross-platform, but producing a real
    // dmg/zip needs a Mac host regardless of this hook.
    console.log(
      'adhoc-sign-mac: not running on macOS — skipping (a mac target build must run on a Mac).',
    );
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`adhoc-sign-mac: ad-hoc signing ${appPath} (no Developer ID configured)`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
}
