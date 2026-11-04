import type { PerKeyLightingPreset } from '@shared/types/lighting';
import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * App-side per-key lighting preset library — the same pattern as
 * `main/macros/store.ts`'s macro library. A saved static per-key colour
 * layout, named and swappable; "apply" (main/ipc.ts's
 * `applyPerKeyLightingLibraryEntry`) writes one preset's colours straight to
 * the device via `setPerKeyLighting`.
 */
export async function listPerKeyPresets(): Promise<PerKeyLightingPreset[]> {
  return readJson<PerKeyLightingPreset[]>(paths.perKeyLightingLibrary(), []);
}

export async function savePerKeyPreset(p: PerKeyLightingPreset): Promise<PerKeyLightingPreset[]> {
  return withFileLock(paths.perKeyLightingLibrary(), async () => {
    const all = await listPerKeyPresets();
    const id = p.id || crypto.randomUUID();
    const entry = { ...p, id, createdAt: p.createdAt || Date.now() };
    // Upsert in place — filtering then appending moved an edited preset to the
    // bottom of the list on every save (same bug macros/store.ts already fixed).
    const at = all.findIndex((x) => x.id === id);
    const next = at === -1 ? [...all, entry] : all.map((x, i) => (i === at ? entry : x));
    await writeJson(paths.perKeyLightingLibrary(), next);
    return next;
  });
}

export async function deletePerKeyPreset(id: string): Promise<PerKeyLightingPreset[]> {
  return withFileLock(paths.perKeyLightingLibrary(), async () => {
    const next = (await listPerKeyPresets()).filter((p) => p.id !== id);
    await writeJson(paths.perKeyLightingLibrary(), next);
    return next;
  });
}
