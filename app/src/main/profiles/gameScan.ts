import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ScannedGame } from '@shared/types/diagnostics';
import { platform } from '../platform';

/**
 * Ported from legacy/attack-shark-profile-switcher/detect_games.py. Scans
 * installed Steam (all OSes) and Epic (Windows only — no Linux/macOS Epic
 * launcher exists) titles and heuristically picks the most game-like
 * executable per install dir. The guess is a heuristic — the UI shows it for
 * review. Steam roots, Epic manifests and what counts as a candidate
 * executable are all OS-specific and live behind `platform` (see
 * main/platform/); everything else here — the VDF parsing, the scoring — is
 * identical across OSes.
 */

const SKIP =
  /(unitycrashhandler|unins|setup|vcredist|dxsetup|dotnet|directx|crashhandler|crashreport|easyanticheat|battleye|launcher_helper|redist|installer|updater|report|helper|service|activation|benchmark|editor|server|dedicated|import|convert|compile|resource|console|cfg|vbsp|vrad|vvis|workshop|legacy|tool|shader|_build_|cache|dump|test)/i;
// Forward-slash form: `rel` below is normalized to '/' regardless of OS, so
// these never match on Windows if left as '\\' (a pre-existing bug — see
// docs/platform-support.md).
const PREFERRED_DIRS = ['binaries/win64', 'binaries/win32', 'bin/win64', 'bin'];

async function steamLibraries(): Promise<string[]> {
  const libs: string[] = [];
  for (const root of platform.steamRoots()) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!existsSync(vdf)) continue;
    libs.push(root);
    const text = await fs.readFile(vdf, 'utf8').catch(() => '');
    // VDF escapes path separators as doubled backslashes on every OS Valve
    // writes them from (including a Windows-authored library on a synced
    // drive); unescape to this OS's own separator, not a hardcoded one.
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g))
      libs.push(m[1]!.replace(/\\\\/g, path.sep));
  }
  // One library under several names is scanned once: on Linux ~/.steam/steam
  // and ~/.steam/root are both symlinks to ~/.local/share/Steam, and compared
  // by spelling, every game folder in it was walked three times over. Where
  // they lead is what is compared — case-folded only where the file system
  // folds case itself.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of libs) {
    if (!existsSync(l)) continue;
    const real = await fs.realpath(l).catch(() => l);
    const key = process.platform === 'linux' ? real : real.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

async function steamGames(): Promise<Array<{ name: string; dir: string }>> {
  const games: Array<{ name: string; dir: string }> = [];
  for (const lib of await steamLibraries()) {
    const steamapps = path.join(lib, 'steamapps');
    if (!existsSync(steamapps)) continue;
    for (const entry of await fs.readdir(steamapps).catch(() => [])) {
      if (!entry.startsWith('appmanifest_')) continue;
      const text = await fs.readFile(path.join(steamapps, entry), 'utf8').catch(() => '');
      const name = /"name"\s+"([^"]+)"/.exec(text)?.[1];
      const installdir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1];
      if (!name || !installdir) continue;
      const dir = path.join(steamapps, 'common', installdir);
      if (existsSync(dir)) games.push({ name, dir });
    }
  }
  return games;
}

function scoreExe(file: string, root: string, game: string, size: number): number {
  const rel = path.relative(root, file).toLowerCase().split(path.sep).join('/');
  const stem = path.basename(file, '.exe').toLowerCase();
  const norm = game.toLowerCase().replace(/[^a-z0-9]/g, '');
  const flat = stem.replace(/[^a-z0-9]/g, '');
  let name = 0;
  if (flat && norm) {
    if (flat === norm) name = 12;
    else if (norm.includes(flat) || norm.startsWith(flat)) name = 8;
    else if (flat.length > 3 && norm.replace(/ /g, '').includes(flat)) name = 4;
  }
  const depth = !rel.includes('/') ? 2 : 0;
  const dir = PREFERRED_DIRS.some((p) => rel.includes(p)) ? 3 : 0;
  // size is only a tiebreaker; scale it far below the heuristic bonuses
  return (name + depth + dir) * 1e12 + size;
}

async function findExecutable(root: string, game: string, maxDepth = 4): Promise<string | null> {
  const candidates: Array<{ file: string; size: number }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth >= maxDepth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.test(e.name)) await walk(full, depth + 1);
      } else if (!SKIP.test(e.name) && (await platform.isGameExecutableCandidate(e.name, full))) {
        const size = (await fs.stat(full).catch(() => ({ size: 0 }))).size;
        candidates.push({ file: full, size });
      }
    }
  }
  await walk(root, 0);
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => scoreExe(b.file, root, game, b.size) - scoreExe(a.file, root, game, a.size),
  );
  return path.basename(candidates[0]!.file);
}

export async function scanGames(): Promise<ScannedGame[]> {
  const found = new Map<string, ScannedGame>();
  for (const { name, dir } of (await steamGames()).sort((a, b) => a.name.localeCompare(b.name))) {
    const exe = await findExecutable(dir, name);
    if (exe && !found.has(exe.toLowerCase()))
      found.set(exe.toLowerCase(), { label: name, exe, source: 'steam' });
  }
  for (const g of await platform.extraGameSources()) {
    if (!found.has(g.exe.toLowerCase())) found.set(g.exe.toLowerCase(), g);
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}
