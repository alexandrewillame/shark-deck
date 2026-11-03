import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * The user's chosen cosmetic colour/edition variant per device model —
 * purely a display preference (which product photo to show on the card),
 * never sent to the device. Keyed by model, not device id: the id embeds
 * the USB path, which changes with the port, so keying by id would forget
 * the choice on replug. Two identical units of the same model therefore
 * share one colour — an accepted trade-off, since SharkDeck has no way to
 * tell two same-model devices apart cosmetically anyway.
 */
type Store = Record<string, string>;

async function readStore(): Promise<Store> {
  return readJson<Store>(paths.deviceColors(), {});
}

export async function getDeviceColor(model: string): Promise<string | null> {
  const store = await readStore();
  return store[model] ?? null;
}

export async function setDeviceColor(
  model: string,
  variantId: string | null,
): Promise<string | null> {
  return withFileLock(paths.deviceColors(), async () => {
    const store = await readStore();
    if (variantId) store[model] = variantId;
    else delete store[model];
    await writeJson(paths.deviceColors(), store);
    return variantId;
  });
}
