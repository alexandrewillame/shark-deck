import { randomUUID } from 'node:crypto';
import type { Macro } from '@shared/types/macros';
import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * App-side macro library — device-independent, since a macro is just a
 * sequence of key/mouse/delay steps. The keyboard driver's own onboard
 * storage has exactly one slot (`readMacros()` always reports it as id
 * `'onboard'`, name "Onboard macro" — see compx-keyboard.ts), so this is
 * where a user's collection of named macros actually lives; `pushMacroToDevice`
 * (main/ipc.ts) is what writes one of them into that single slot.
 */
export async function listLibraryMacros(): Promise<Macro[]> {
  return readJson<Macro[]>(paths.macroLibrary(), []);
}

export async function saveLibraryMacro(m: Macro): Promise<Macro[]> {
  return withFileLock(paths.macroLibrary(), async () => {
    const all = await listLibraryMacros();
    const id = m.id || randomUUID();
    // Upsert in place. Filtering then appending moved an edited macro to the
    // bottom of the library on every save, so the list reshuffled itself under
    // the user each time they touched a macro.
    const at = all.findIndex((x) => x.id === id);
    const next =
      at === -1 ? [...all, { ...m, id }] : all.map((x, i) => (i === at ? { ...m, id } : x));
    await writeJson(paths.macroLibrary(), next);
    return next;
  });
}

export async function deleteLibraryMacro(id: string): Promise<Macro[]> {
  return withFileLock(paths.macroLibrary(), async () => {
    const next = (await listLibraryMacros()).filter((m) => m.id !== id);
    await writeJson(paths.macroLibrary(), next);
    return next;
  });
}
