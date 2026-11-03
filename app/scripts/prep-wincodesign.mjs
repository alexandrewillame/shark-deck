/**
 * Stage electron-builder's `winCodeSign` vendor tools in its cache so a build on
 * a Windows box WITHOUT admin rights or Developer Mode doesn't die extracting
 * them.
 *
 * Why this is needed: even for an unsigned build, electron-builder runs
 * `rcedit` (via app-builder) to stamp the icon and version resources into the
 * exe, and `rcedit-x64.exe` ships inside `winCodeSign-2.6.0.7z`. That archive
 * also contains two macOS symlinks; app-builder extracts it with
 * `7za x -snld` (preserve links), and creating a symlink on Windows needs a
 * privilege an unelevated non-developer account doesn't have — so 7-Zip exits
 * non-zero and electron-builder aborts.
 *
 * This script pre-extracts the archive into app-builder's cache with the
 * `darwin/` folder (the only symlinks) excluded, so the cache lookup hits and
 * app-builder never touches the archive.
 *
 * NO LONGER PART OF THE BUILD. electron-builder 26 stamps the exe with
 * `resedit` (a pure-JS dependency) instead of shelling out to `rcedit`, and it
 * dropped its `7zip-bin` dependency, so an unsigned Windows build never fetches
 * or extracts `winCodeSign-2.6.0.7z` at all — verified by building with an empty
 * winCodeSign cache. The script is kept as a manual escape hatch in case a
 * future electron-builder (or actual code signing) needs those vendor tools
 * again. Run it by hand with:
 *
 *     node scripts/prep-wincodesign.mjs
 *
 * It is idempotent (no-op once the cache is populated), a no-op off Windows,
 * and reuses an already-downloaded archive from the cache instead of
 * re-downloading.
 *
 * On a machine with Developer Mode on (Settings > System > For developers) or an
 * elevated shell you don't need this — `npm run dist` works directly.
 */
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';

const VERSION = 'winCodeSign-2.6.0';
// NB: not `URL` — that would shadow the global URL constructor used in download().
const ARCHIVE_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;

/**
 * SHA-512 of `winCodeSign-2.6.0.7z`. The build EXTRACTS and RUNS
 * `rcedit-x64.exe` / `signtool.exe` from this archive, so a poisoned download
 * (or a poisoned leftover in the cache) would execute attacker code at build
 * time. Pin the hash here — or in `scripts/wincodesign.sha512`, or the
 * `WINCODESIGN_SHA512` env var — and every fetched / reused archive is checked
 * against it. With no pin set the script prints the computed hash and a
 * warning instead of failing, so a maintainer can capture it once from a
 * trusted machine.
 */
const PINNED_SHA512 =
  process.env.WINCODESIGN_SHA512?.trim() ||
  (existsSync(path.resolve('scripts/wincodesign.sha512'))
    ? readFileSync(path.resolve('scripts/wincodesign.sha512'), 'utf8').trim()
    : null);

/** Hosts a redirect from the GitHub release URL is allowed to land on. */
const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

function sha512Of(file) {
  return createHash('sha512').update(readFileSync(file)).digest('hex');
}

/** Throws unless `file`'s hash matches the pin (or warns if no pin is set). */
function verifyHash(file) {
  const actual = sha512Of(file);
  if (!PINNED_SHA512) {
    console.warn(
      `\n!! No winCodeSign hash pinned. Computed SHA-512:\n   ${actual}\n` +
        '   Set WINCODESIGN_SHA512 or write scripts/wincodesign.sha512 to enforce it.\n',
    );
    return;
  }
  if (actual.toLowerCase() !== PINNED_SHA512.toLowerCase()) {
    rmSync(file, { force: true });
    console.error(
      `\nwinCodeSign archive SHA-512 mismatch — refusing to use it.\n` +
        `  expected ${PINNED_SHA512}\n  actual   ${actual}\n`,
    );
    process.exit(1);
  }
}
const cacheDir = path.join(
  process.env.LOCALAPPDATA ?? os.homedir(),
  'electron-builder',
  'Cache',
  'winCodeSign',
);
const dest = path.join(cacheDir, VERSION);
const namedArchive = path.join(cacheDir, `${VERSION}.7z`);
// electron-builder 26 dropped its `7zip-bin` dependency, so the old hardcoded
// node_modules/7zip-bin path no longer resolves. Probe the places a 7-Zip
// binary actually lives, newest-first, and fail with a clear message instead of
// silently reporting every archive as "corrupt".
function findSevenZip() {
  const candidates = [
    path.resolve('node_modules/7zip-bin/win/x64/7za.exe'),
    // electron-builder downloads its own 7za into its cache during a build.
    ...(() => {
      const root = path.join(cacheDir, '..', '7zip@1.0.0');
      if (!existsSync(root)) return [];
      return readdirSync(root)
        .map((e) => path.join(root, e, 'bin', '7za.exe'))
        .filter(existsSync);
    })(),
    // Shipped inside electron-winstaller, which is already in the tree.
    path.resolve('node_modules/electron-winstaller/vendor/7z.exe'),
  ];
  return candidates.find(existsSync) ?? null;
}
// The two files app-builder actually reaches for: rcedit for the resource stamp,
// signtool for (optional) signing. If both are present the cache is good.
const MARKERS = ['rcedit-x64.exe', path.join('windows-10', 'x64', 'signtool.exe')];
const isPrepared = (dir) => MARKERS.every((m) => existsSync(path.join(dir, m)));

if (process.platform !== 'win32') {
  console.log('Not Windows — nothing to do.');
  process.exit(0);
}
if (isPrepared(dest)) {
  console.log(`Already prepared: ${dest}`);
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });

const sevenZip = findSevenZip();
if (sevenZip == null) {
  console.error();
  console.error('No 7-Zip binary found. electron-builder 26 no longer bundles one,');
  console.error('and it does not need this script either — just run `npm run dist`.');
  console.error('To use this script anyway, run a build first so electron-builder');
  console.error('populates its own 7zip cache, then retry.');
  console.error();
  process.exit(1);
}

function download(url, file, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return reject(new Error(`bad URL: ${url}`));
    }
    if (!ALLOWED_HOSTS.has(host)) {
      return reject(new Error(`refusing redirect to untrusted host: ${host}`));
    }
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301)
          return resolve(download(res.headers.location, file, hops + 1));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const out = createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

/** `7za t` — true if the archive is complete and not corrupt. */
function archiveOk(file) {
  try {
    if (!existsSync(file) || statSync(file).size < 1_000_000) return false;
    execFileSync(sevenZip, ['t', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 1. Get a usable archive at the stable named path. Reuse without hitting the
//    network: the named copy from a previous run, or any leftover `<digits>.7z`
//    app-builder left behind after its own failed extraction (each is a full
//    copy of the same archive). A reused leftover is moved onto the named path
//    so the cleanup sweep below can't delete it.
if (!archiveOk(namedArchive)) {
  const leftover = readdirSync(cacheDir)
    .filter((e) => /^\d+\.7z$/.test(e))
    .map((e) => path.join(cacheDir, e))
    .find(archiveOk);
  if (leftover) {
    console.log(`Reusing cached archive: ${leftover}`);
    // A leftover `<digits>.7z` is attacker-writable like any cache file — hash
    // it before promoting it to the canonical path.
    verifyHash(leftover);
    if (existsSync(namedArchive)) rmSync(namedArchive, { force: true });
    renameSync(leftover, namedArchive);
  } else {
    console.log(`Downloading ${ARCHIVE_URL} …`);
    await download(ARCHIVE_URL, namedArchive);
    if (!archiveOk(namedArchive)) {
      console.error(`\nDownloaded archive is corrupt or incomplete: ${namedArchive}`);
      process.exit(1);
    }
    verifyHash(namedArchive);
  }
} else {
  // A named archive carried over from a previous run is still cache — re-check.
  verifyHash(namedArchive);
}

// 2. Clear app-builder's stale numeric temp dirs / archives from earlier failed
//    runs, and any half-extracted dest, so the extraction below starts clean.
for (const e of readdirSync(cacheDir)) {
  if (/^\d+(\.7z)?$/.test(e)) rmSync(path.join(cacheDir, e), { recursive: true, force: true });
}
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

// 3. Extract everything except the macOS `darwin/` folder (the only symlinks).
console.log('Extracting without the macOS symlink folder …');
try {
  execFileSync(sevenZip, ['x', namedArchive, `-o${dest}`, '-x!darwin', '-y'], { stdio: 'inherit' });
} catch (err) {
  console.error(
    `\nExtraction failed (${err.message}).\n` +
      'Enable Developer Mode (Settings > System > For developers) or run this from\n' +
      'an elevated shell, then retry — either lets 7-Zip create the archive symlinks.',
  );
  process.exit(1);
}

if (!isPrepared(dest)) {
  console.error(`\nExtraction finished but ${dest} is missing expected files.`);
  process.exit(1);
}
console.log(`\nReady: ${dest}`);
