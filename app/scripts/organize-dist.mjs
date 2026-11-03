/**
 * Sort electron-builder's raw output into the workspace's `dist/` tree so the
 * installer, the portable build and the runnable unpacked app are each in an
 * obvious place — and drop the build-debug noise. Cross-platform: this same
 * script runs after `npm run dist` on Windows, macOS and Linux alike (there's
 * no cross-compiling a mac/Linux build from Windows, so each OS always
 * organizes only the artifacts electron-builder just produced for itself).
 *
 *   app/release/                     ->  dist/
 *     win-unpacked/                        app/         (SharkDeck.exe — the launcher)
 *     mac/ or mac-arm64/                   app/          (SharkDeck.app)
 *     linux-unpacked/ (+ -arm64/-arm/…)    app/          (sharkdeck)
 *     *-Setup-*.exe (+ .blockmap)          installer/    (Windows NSIS)
 *     *.dmg                                installer/    (macOS)
 *     *.deb / *.rpm                        installer/    (Linux)
 *     *-portable.exe                       portable/     (Windows)
 *     *.zip                                portable/     (macOS — a relocatable .app archive)
 *     *.AppImage                           portable/     (Linux — one file, no install)
 *     builder-debug.yml, .icon-ico/…       (discarded)
 *
 * electron-builder still writes to `release/` (directories.output in
 * electron-builder.yml); this only runs afterwards, chained in package.json.
 * A plain `npx electron-builder` therefore still behaves normally.
 *
 * A rare but real case this also has to handle: more than one "unpacked app"
 * source directory in the same release/ (e.g. building both mac x64 and
 * arm64 in one invocation) — flattening both into dist/app/ would silently
 * let the second overwrite the first's same-named files. When that happens
 * each arch keeps its own subfolder (dist/app/mac-arm64/, dist/app/mac/, …)
 * instead of flattening.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const releaseDir = path.join(appDir, 'release');
const distDir = path.resolve(appDir, '..', 'dist');

/**
 * `rmSync` that tolerates the transient EPERM/EBUSY Windows throws when a file
 * under `F:\OneDrive\` is momentarily held (OneDrive sync, an antivirus scan, a
 * just-closed SharkDeck.exe). Retries a few times, then reports which path is
 * still locked instead of dumping a raw stack.
 */
function rmDir(dir, label = dir) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (err) {
      if (
        attempt === 6 ||
        (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'ENOTEMPTY')
      ) {
        console.error(
          `organize-dist: could not remove ${label} (${err.code}).\n` +
            `Something still has a file open there — usually a running SharkDeck.exe.\n` +
            `Close it (or: node scripts/kill-running-app.mjs) and re-run. ` +
            `npm run pack/dist/dist:portable do this automatically now.`,
        );
        process.exit(1);
      }
      // Brief, genuinely blocking pause (not a CPU-spinning busy-wait) —
      // the handle usually clears within a second. Atomics.wait needs a
      // SharedArrayBuffer-backed view; a throwaway one is fine here, nothing
      // reads it back.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
}

if (!existsSync(releaseDir)) {
  console.log('organize-dist: no release/ folder — nothing to do.');
  process.exit(0);
}

const out = {
  app: path.join(distDir, 'app'),
  installer: path.join(distDir, 'installer'),
  portable: path.join(distDir, 'portable'),
};
for (const [name, dir] of Object.entries(out)) {
  rmDir(dir, `dist/${name}`);
  mkdirSync(dir, { recursive: true });
}

/** Move a file or directory, replacing whatever is at the destination.
 *  Falls back to copy+delete on EXDEV (source and dest on different
 *  filesystems/mounts — common in CI containers, rare on a plain desktop). */
function move(from, toDir) {
  const to = path.join(toDir, path.basename(from));
  rmDir(to);
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true });
    rmDir(from);
  }
  return to;
}

/** electron-builder's unpacked-app output directory names: `win-unpacked`,
 *  `linux-unpacked` (+ `linux-arm64-unpacked`, `linux-arm-unpacked`, …), and
 *  macOS's un-suffixed `mac` / `mac-arm64`. */
function isUnpackedAppDir(name) {
  return /unpacked$/i.test(name) || /^mac(-arm64)?$/i.test(name);
}

const moved = { app: [], installer: [], portable: [] };
const appSources = [];

for (const entry of readdirSync(releaseDir)) {
  const full = path.join(releaseDir, entry);
  const isDir = statSync(full).isDirectory();

  if (isDir && isUnpackedAppDir(entry)) {
    appSources.push({ entry, full });
  } else if (
    /-Setup-.*\.exe(\.blockmap)?$/i.test(entry) ||
    /^latest(-mac|-linux)?\.yml$/i.test(entry)
  ) {
    moved.installer.push(path.basename(move(full, out.installer)));
  } else if (/portable.*\.exe$/i.test(entry)) {
    moved.portable.push(path.basename(move(full, out.portable)));
  } else if (/\.dmg(\.blockmap)?$/i.test(entry) || /\.(deb|rpm)$/i.test(entry)) {
    moved.installer.push(path.basename(move(full, out.installer)));
  } else if (/\.appimage$/i.test(entry) || /\.zip$/i.test(entry)) {
    moved.portable.push(path.basename(move(full, out.portable)));
  }
  // everything else (builder-debug.yml, .icon-ico, .cache, …) is left in
  // release/ and cleared below.
}

if (appSources.length === 1) {
  // The common case: move the *contents* up so it's dist/app/SharkDeck.exe
  // (or dist/app/SharkDeck.app, dist/app/sharkdeck), not dist/app/win-unpacked/…
  const { full } = appSources[0];
  mkdirSync(out.app, { recursive: true });
  for (const child of readdirSync(full)) move(path.join(full, child), out.app);
  rmDir(full);
  moved.app.push('(unpacked app)');
} else if (appSources.length > 1) {
  // Multiple architectures built in one pass (e.g. mac x64 + arm64) —
  // flattening both would collide on the same filenames. Keep each under
  // its own subfolder instead.
  for (const { entry, full } of appSources) {
    const dest = path.join(out.app, entry);
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(full)) move(path.join(full, child), dest);
    rmDir(full);
    moved.app.push(`(unpacked app: ${entry})`);
  }
}

rmDir(releaseDir, 'app/release');

/** Best-effort launcher path for the README, matching how electron-builder
 *  actually named this OS's binary. Falls back to a platform-typical guess
 *  if the multi-arch nesting above means there's no single obvious one. */
function findLauncher() {
  if (!existsSync(out.app)) return null;
  const top = readdirSync(out.app);
  if (process.platform === 'darwin') {
    const bundle = top.find((f) => f.endsWith('.app'));
    if (bundle) return `app/${bundle}`;
    for (const entry of top) {
      const sub = path.join(out.app, entry);
      if (statSync(sub).isDirectory()) {
        const nested = readdirSync(sub).find((f) => f.endsWith('.app'));
        if (nested) return `app/${entry}/${nested}`;
      }
    }
    return null;
  }
  if (process.platform === 'linux') {
    // electron-builder names the binary after `executableName`, which
    // defaults to a kebab-case productName — "sharkdeck" here.
    return top.includes('sharkdeck') ? 'app/sharkdeck' : null;
  }
  if (top.includes('SharkDeck.exe')) return 'app/SharkDeck.exe';
  const exe = top.find((f) => f.endsWith('.exe'));
  return exe ? `app/${exe}` : null;
}

const launcher =
  findLauncher() ??
  (process.platform === 'darwin'
    ? 'app/SharkDeck.app'
    : process.platform === 'linux'
      ? 'app/sharkdeck'
      : 'app/SharkDeck.exe');

const unsignedNote =
  process.platform === 'darwin'
    ? `The build is ad-hoc signed, not signed by a real Apple Developer ID, so Gatekeeper blocks the first launch. macOS 15 and later: try to open it once, then System Settings -> Privacy & Security -> Open Anyway. Earlier macOS: right-click -> Open. Or run: \`xattr -dr com.apple.quarantine "dist/${launcher}"\`. See docs/platform-support.md.`
    : process.platform === 'linux'
      ? `The .deb/.rpm installers install the udev rule Attack Shark devices need automatically. Using the AppImage instead? Install the rule once: \`./SharkDeck-*.AppImage --appimage-extract\`, then \`sudo sh squashfs-root/resources/udev/install-udev-rules.sh\` (see docs/platform-support.md).`
      : `The build is unsigned: Windows SmartScreen shows "more info -> run anyway" on first launch.`;

const installerRow =
  process.platform === 'darwin'
    ? '`SharkDeck-*.dmg` — drag-to-Applications installer.'
    : process.platform === 'linux'
      ? '`sharkdeck_*.deb` / `sharkdeck-*.rpm` — installs to /opt, adds a udev rule and a menu entry.'
      : '`SharkDeck-Setup-*.exe` — NSIS installer.';

const portableRow =
  process.platform === 'darwin'
    ? '`SharkDeck-*.zip` — a relocatable `.app`, no installer.'
    : process.platform === 'linux'
      ? '`SharkDeck-*.AppImage` — one self-contained file, no install. `chmod +x` it after a download; it needs libfuse2 and libusb 1.0 (see below for the udev rule).'
      : '`SharkDeck-*-portable.exe` — one self-contained file, no install.';

writeFileSync(
  path.join(distDir, 'README.md'),
  `# SharkDeck — build output

Generated by \`npm run dist\` (from \`../app\`). Disposable — delete and rebuild anytime.

| Folder | What it is | Use it when |
|---|---|---|
| \`app/\` | Unpacked build. **Run \`${launcher}\`.** | You just want to use SharkDeck, no install. |
| \`installer/\` | ${installerRow} | You want it registered as an installed app. |
| \`portable/\` | ${portableRow} | You want a single file to copy elsewhere. |

${unsignedNote} Built ${new Date().toISOString()}.
`,
);

console.log('organize-dist: ->', path.relative(process.cwd(), distDir));
for (const [k, list] of Object.entries(moved)) {
  console.log(`  ${k.padEnd(10)} ${list.length ? list.join(', ') : '(nothing)'}`);
}
