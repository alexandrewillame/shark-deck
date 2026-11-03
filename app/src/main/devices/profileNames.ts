import { paths, readJson, withFileLock, writeJson } from '../store';
import { uniqueName } from '@shared/naming';

/**
 * User-given names for a device's onboard slots (the V8 mouse's four memory
 * banks, the keyboard's four SET_PROFILE slots). An onboard slot has no name
 * field of its own on the wire — the device only ever reports which slot
 * index is active — so there is nothing to read back and nothing to seed; a
 * slot simply has no name until the user gives it one, and every caller falls
 * back to "Profile {n}" until then (see slotLabel() in
 * renderer/state/ui.ts).
 *
 * Keyed by model, not device id — the id embeds the USB path, which changes
 * with the port, so keying by id would silently forget the name on replug.
 */
type Store = Record<string, Record<number, string>>;

async function readStore(): Promise<Store> {
  return readJson<Store>(paths.onboardProfileNames(), {});
}

/** Names set so far for this model's slots, sparse — an unset slot has no entry. */
export async function getOnboardProfileNames(model: string): Promise<Record<number, string>> {
  const store = await readStore();
  return store[model] ?? {};
}

export async function renameOnboardProfile(
  model: string,
  slot: number,
  name: string,
): Promise<Record<number, string>> {
  return withFileLock(paths.onboardProfileNames(), async () => {
    const store = await readStore();
    const forModel = { ...(store[model] ?? {}) };
    const trimmed = name.trim();
    if (trimmed) {
      // Disambiguate against this model's other *named* slots — "gaming" typed
      // over a slot when another slot is already "gaming" becomes "gaming 2".
      // (Unnamed slots show a locale-dependent "Profile N" the main process
      // can't reconstruct, so they aren't considered here.)
      const others = Object.entries(forModel)
        .filter(([s]) => Number(s) !== slot)
        .map(([, v]) => v);
      forModel[slot] = uniqueName(trimmed, others);
    } else delete forModel[slot]; // an empty name clears back to the "Profile {n}" default
    store[model] = forModel;
    await writeJson(paths.onboardProfileNames(), store);
    return forModel;
  });
}
