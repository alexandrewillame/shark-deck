import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AppProfile, ProfileTrigger, SwitchRule } from '@shared/types/profiles';
import { uniqueName } from '@shared/naming';
import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * Normalises a profile read off disk:
 *  - `links` defaults to `{}` — a `profiles.json` written by a pre-link-model
 *    build (or hand-edited) can have entries with no `links` key at all,
 *    which used to crash every reader that did `profile.links[model]`
 *    unguarded (e.g. the Auto-Switch screen and the switcher's own apply
 *    loop).
 *  - `triggers` defaults to `[]`, and a legacy plain `string[]` (from before
 *    `ProfileTrigger` existed) is coerced to `{ exe, enabled: true }[]` —
 *    only matters mid-upgrade, since `migrateRulesToProfiles()` is what
 *    actually populates triggers from an old `rules.json`.
 *  - a link's `kind` is dropped. Keyboards used to resolve to a
 *    software-held settings snapshot rather than an onboard slot; they no
 *    longer do (see catalog/r85he.ts), so there is one kind of slot and the
 *    field is gone from the type. The SLOT NUMBER is kept either way, which
 *    is the whole of what an existing profiles.json still means.
 */
function normalize(p: AppProfile): AppProfile {
  const rawTriggers = (p as unknown as { triggers?: unknown }).triggers;
  const triggers: ProfileTrigger[] = Array.isArray(rawTriggers)
    ? rawTriggers.map((t) =>
        typeof t === 'string' ? { exe: t.toLowerCase(), enabled: true } : (t as ProfileTrigger),
      )
    : [];
  const links: AppProfile['links'] = {};
  for (const [model, link] of Object.entries(p.links ?? {})) {
    if (link && typeof link.slot === 'number') links[model] = { slot: link.slot };
  }
  return { ...p, links, triggers };
}

export async function listProfiles(): Promise<AppProfile[]> {
  const raw = await readJson<AppProfile[]>(paths.profiles(), []);
  return raw.map(normalize);
}

/**
 * A process maps to exactly one profile — saving a profile with a given exe
 * in its triggers strips that exe out of every *other* profile's trigger
 * list first, so reassigning it in the Processes panel doesn't leave a stale
 * duplicate behind on its old profile. `isDefault`/`builtIn` can't be cleared
 * by a renderer patch — the default profile is chosen once, in
 * `seedDefaults()`, and stays that way for the life of the install.
 */
export async function saveProfile(p: AppProfile): Promise<AppProfile[]> {
  return withFileLock(paths.profiles(), async () => {
    const all = await listProfiles();
    const id = p.id || randomUUID();
    const existing = all.find((x) => x.id === id);
    // Two profiles with one name are indistinguishable in every <select> that
    // lists them — disambiguate against the others ("gaming" -> "gaming 2").
    const dedupedName = uniqueName(
      p.name,
      all.filter((x) => x.id !== id).map((x) => x.name),
    );
    const incoming = normalize({ ...p, id, name: dedupedName });
    const exes = new Set(incoming.triggers.map((t) => t.exe.toLowerCase()));
    const next = [
      ...all
        .filter((x) => x.id !== id)
        .map((x) =>
          x.triggers.some((t) => exes.has(t.exe.toLowerCase()))
            ? { ...x, triggers: x.triggers.filter((t) => !exes.has(t.exe.toLowerCase())) }
            : x,
        ),
      {
        ...incoming,
        isDefault: existing?.isDefault ?? incoming.isDefault,
        builtIn: existing?.builtIn ?? incoming.builtIn,
      },
    ].sort((a, b) =>
      a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1,
    );
    await writeJson(paths.profiles(), next);
    return next;
  });
}

/**
 * Backfills a trigger's icon once its executable is first seen actually
 * running (see switcher.ts's `tick()`) — a manually-added or scanned Game/App
 * starts out icon-less (there's no path to extract from until it runs) and
 * this is the one place that fills it in, permanently, the first time it can.
 * No-op if the exe isn't found in any profile's triggers (it may have been
 * removed between detection and resolution) or already has an icon.
 */
export async function setTriggerIcon(exe: string, iconDataUrl: string): Promise<AppProfile[]> {
  return withFileLock(paths.profiles(), async () => {
    const all = await listProfiles();
    const lower = exe.toLowerCase();
    let changed = false;
    const next = all.map((p) => {
      if (!p.triggers.some((t) => t.exe === lower && !t.iconDataUrl)) return p;
      changed = true;
      return {
        ...p,
        triggers: p.triggers.map((t) =>
          t.exe === lower && !t.iconDataUrl ? { ...t, iconDataUrl } : t,
        ),
      };
    });
    if (changed) await writeJson(paths.profiles(), next);
    return next;
  });
}

/**
 * Refuses to delete the single default ("Desktop") profile — every other
 * profile falls back to it, so the app must always have exactly one. Returns
 * the list unchanged (rather than throwing) so a stale UI button just no-ops.
 */
export async function deleteProfile(id: string): Promise<AppProfile[]> {
  return withFileLock(paths.profiles(), async () => {
    const all = await listProfiles();
    const target = all.find((p) => p.id === id);
    if (!target || target.isDefault) return all;
    const next = all.filter((p) => p.id !== id);
    await writeJson(paths.profiles(), next);
    return next;
  });
}

/**
 * Common game process names, for the seeded "Gaming" profile's triggers.
 *
 * The `.exe` names hold on Linux too: a Steam game run under Proton is
 * matched by the Windows program it runs (platform/linux.ts). CS2 also has a
 * native Linux build, whose binary is plain `cs2`.
 */
const DEFAULT_GAME_PROCESSES = [
  'cs2.exe',
  ...(process.platform === 'linux' ? ['cs2'] : []),
  'csgo.exe',
  'valorant.exe',
  'valorant-win64-shipping.exe',
  'r5apex.exe',
  'overwatch.exe',
  'fortniteclient-win64-shipping.exe',
];

/**
 * First-run seed: a "Desktop" default profile (empty links and triggers — it
 * is never matched by a running process, only ever the fallback) and a
 * "Gaming" profile pre-loaded with common game processes, disabled until the
 * user links it to real device slots. `defaultSlot` gives every model a
 * sensible profile-1/profile-2 default the moment a device is connected,
 * without needing a per-device link stored up front — see `resolveLink()` in
 * shared/types.ts. Only runs once — if `profiles.json` already has anything
 * in it (including a leftover from a pre-trigger-model version), it does
 * nothing.
 */
export async function seedDefaults(): Promise<void> {
  const profiles = await listProfiles();
  if (profiles.length > 0) return;

  const desktop: AppProfile = {
    id: randomUUID(),
    name: 'Desktop',
    builtIn: true,
    isDefault: true,
    // The Windows logo means "the desktop" on Windows only; elsewhere it
    // names the wrong OS.
    icon: { kind: 'builtin', name: process.platform === 'win32' ? 'windows' : 'desktop' },
    defaultSlot: 1,
    triggers: [],
    links: {},
  };
  const gaming: AppProfile = {
    id: randomUUID(),
    name: 'Gaming',
    builtIn: true,
    icon: { kind: 'builtin', name: 'gamepad' },
    defaultSlot: 2,
    triggers: DEFAULT_GAME_PROCESSES.map((exe) => ({ exe, enabled: false })),
    links: {},
  };
  await writeJson(paths.profiles(), [desktop, gaming]);
}

/**
 * One-time upgrade: folds a pre-this-model `rules.json` into each rule's
 * target profile's `triggers` — `rule.enabled` becomes the *trigger's*
 * enabled flag (a disabled rule migrates to disabled triggers, not triggers
 * that silently switch on), `fallbackProfileId` is dropped (every profile
 * now falls back to the single default profile). Renames `rules.json` to
 * `rules.json.migrated` rather than deleting it, so a bad fold is
 * recoverable. Idempotent: a missing or already-renamed `rules.json` is a
 * no-op. Called once from main/index.ts, right after `seedDefaults()`.
 */
export async function migrateRulesToProfiles(): Promise<void> {
  const rulesPath = paths.rules();
  const rules = await readJson<SwitchRule[]>(rulesPath, []);
  if (rules.length === 0) return;

  const profiles = await listProfiles();
  const byId = new Map(profiles.map((p) => [p.id, p]));
  for (const rule of rules) {
    const target = byId.get(rule.profileId);
    if (!target) continue;
    for (const name of rule.processNames) {
      const lower = name.toLowerCase();
      if (target.triggers.some((t) => t.exe === lower)) continue;
      target.triggers.push({ exe: lower, label: rule.gameLabel, enabled: rule.enabled });
    }
  }
  await writeJson(paths.profiles(), [...byId.values()]);

  try {
    await fs.rename(rulesPath, `${rulesPath}.migrated`);
  } catch {
    // best-effort — a permissions error here shouldn't block startup, and
    // the fold above already landed in profiles.json either way.
  }
}

/**
 * Upgrade path for an install that predates the `isDefault` flag: every
 * profile used to carry `builtIn: true` for *both* "Desktop" and "Gaming",
 * with the fallback picked by matching the literal English name "Desktop"
 * (see the old `desktopProfile()` lookup in AutoSwitch.tsx this replaced)
 * rather than a real flag. Without this, an upgrading install would have
 * zero profiles with `isDefault: true` and the switcher would have no
 * fallback to apply at all. Runs on every boot; a no-op once some profile is
 * already flagged (including a fresh install, which `seedDefaults()` already
 * flags correctly). Picks, in order: a profile literally named "Desktop",
 * else the first `builtIn` profile, else just the first profile — closest
 * match to the old behaviour rather than leaving the switcher with nothing.
 */
export async function ensureDefaultProfile(): Promise<void> {
  const profiles = await listProfiles();
  if (profiles.length === 0 || profiles.some((p) => p.isDefault)) return;
  const target =
    profiles.find((p) => p.name === 'Desktop') ?? profiles.find((p) => p.builtIn) ?? profiles[0]!;
  const next = profiles.map((p) =>
    p.id === target.id ? { ...p, isDefault: true, defaultSlot: p.defaultSlot ?? 1 } : p,
  );
  await writeJson(paths.profiles(), next);
}
