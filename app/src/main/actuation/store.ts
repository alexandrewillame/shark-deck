import { randomUUID } from 'node:crypto';
import type { ActuationLayout, KeyGroup } from '@shared/types/keyboard-settings';
import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * Two app-side stores for the Actuation tab, both the same pattern as
 * `main/lighting/store.ts`'s per-key preset library: upsert in place under the
 * per-file lock, mint an id when one is empty, and return the whole new list so
 * the renderer never has to refetch.
 *
 * Neither writes to a device. Applying a layout is a separate, `guardedWrite`n
 * IPC call — see `applyActuationLayout` in main/ipc.ts, which is the same
 * load-here / write-there split the lighting library uses.
 */

// ---------------------------------------------------------------------------
// saved layouts (a whole board's settings, named)
// ---------------------------------------------------------------------------

export async function listActuationLayouts(): Promise<ActuationLayout[]> {
  return readJson<ActuationLayout[]>(paths.actuationLayouts(), []);
}

export async function saveActuationLayout(l: ActuationLayout): Promise<ActuationLayout[]> {
  return withFileLock(paths.actuationLayouts(), async () => {
    const all = await listActuationLayouts();
    const id = l.id || randomUUID();
    const entry: ActuationLayout = { ...l, id, createdAt: l.createdAt || Date.now() };
    const at = all.findIndex((x) => x.id === id);
    const next = at === -1 ? [...all, entry] : all.map((x, i) => (i === at ? entry : x));
    await writeJson(paths.actuationLayouts(), next);
    return next;
  });
}

export async function deleteActuationLayout(id: string): Promise<ActuationLayout[]> {
  return withFileLock(paths.actuationLayouts(), async () => {
    const next = (await listActuationLayouts()).filter((l) => l.id !== id);
    await writeJson(paths.actuationLayouts(), next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// key groups (per model AND per onboard profile)
// ---------------------------------------------------------------------------

/**
 * Per model, because `slots` are that board's matrix indices; and per onboard
 * profile, because a group is derived from the actuation settings, which
 * belong to the profile.
 *
 * They used to be per model only, so every profile reconciled against one
 * shared list: renaming a group on profile 1 renamed the matching group on
 * profile 2, and visiting profile 2 then wrote its partition back over
 * profile 1's names.
 *
 * A model whose entry is still a bare array is that old shape. The list is
 * kept as the fallback for any profile that has no list of its own yet, and
 * each profile's first write takes over from it — so on the first visit every
 * profile shows the names it showed before, and from then on they part ways.
 */
interface ModelGroups {
  /** One list per onboard profile, keyed by its slot number. */
  bySlot: Record<string, KeyGroup[]>;
  /** The pre-per-profile list, read by a profile with none of its own. */
  legacy?: KeyGroup[];
}
type GroupsFile = Record<string, KeyGroup[] | ModelGroups>;

const readGroups = () => readJson<GroupsFile>(paths.keyGroups(), {});

function modelGroups(all: GroupsFile, model: string): ModelGroups {
  const e = all[model];
  if (Array.isArray(e)) return { bySlot: {}, legacy: e };
  return e && typeof e === 'object' && e.bySlot ? e : { bySlot: {} };
}

const listFor = (m: ModelGroups, profile: number): KeyGroup[] =>
  m.bySlot[String(profile)] ?? m.legacy ?? [];

const withList = (
  all: GroupsFile,
  model: string,
  m: ModelGroups,
  profile: number,
  next: KeyGroup[],
): GroupsFile => ({ ...all, [model]: { ...m, bySlot: { ...m.bySlot, [String(profile)]: next } } });

export async function listKeyGroups(model: string, profile: number): Promise<KeyGroup[]> {
  return listFor(modelGroups(await readGroups(), model), profile);
}

/**
 * Upsert one group, and take its keys off every other group in the process.
 *
 * A key belongs to at most one group — that is the whole point of the colour
 * on the board. Enforced here rather than in the renderer so a group saved from
 * anywhere can't leave a slot claimed twice.
 */
export async function saveKeyGroup(
  model: string,
  profile: number,
  g: KeyGroup,
): Promise<KeyGroup[]> {
  return withFileLock(paths.keyGroups(), async () => {
    const all = await readGroups();
    const m = modelGroups(all, model);
    const list = listFor(m, profile);
    const id = g.id || randomUUID();
    const entry: KeyGroup = { ...g, id };
    const claimed = new Set(entry.slots);
    const stripped = list.map((x) =>
      x.id === id ? x : { ...x, slots: x.slots.filter((s) => !claimed.has(s)) },
    );
    const at = stripped.findIndex((x) => x.id === id);
    const next = at === -1 ? [...stripped, entry] : stripped.map((x, i) => (i === at ? entry : x));
    await writeJson(paths.keyGroups(), withList(all, model, m, profile, next));
    return next;
  });
}

export async function deleteKeyGroup(
  model: string,
  profile: number,
  id: string,
): Promise<KeyGroup[]> {
  return withFileLock(paths.keyGroups(), async () => {
    const all = await readGroups();
    const m = modelGroups(all, model);
    const next = listFor(m, profile).filter((g) => g.id !== id);
    await writeJson(paths.keyGroups(), withList(all, model, m, profile, next));
    return next;
  });
}

/**
 * Replace one profile's whole group list in one write.
 *
 * The groups are DERIVED — a group is the set of keys sharing one set of
 * settings, so the list is a function of the board, not a thing anyone builds.
 * Reconciling it against a settings change therefore has to be able to make
 * groups disappear, and `saveKeyGroup` cannot: it upserts, so a bucket that no
 * longer exists stayed in the file with its slots stripped by the next save.
 * The rail filled up with empty rows and the renderer's "is this list already
 * correct?" check never came true, so it reconciled, saved, re-rendered and
 * reconciled again without end.
 *
 * Ids are minted for entries that have none, the same as `saveKeyGroup`, so a
 * freshly derived list can be written without inventing ids in the renderer.
 */
export async function replaceKeyGroups(
  model: string,
  profile: number,
  groups: KeyGroup[],
): Promise<KeyGroup[]> {
  return withFileLock(paths.keyGroups(), async () => {
    const all = await readGroups();
    const next = groups.map((g) => ({ ...g, id: g.id || randomUUID() }));
    await writeJson(
      paths.keyGroups(),
      withList(all, model, modelGroups(all, model), profile, next),
    );
    return next;
  });
}
