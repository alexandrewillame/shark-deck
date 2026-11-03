/**
 * Naming a saved thing — an actuation layout, a per-key lighting preset.
 *
 * Both libraries upsert by `id`, so saving under a name that already existed
 * quietly produced a SECOND entry with the same name: two identical rows, no
 * way to tell which was which, and no way to overwrite the one you meant. The
 * name is the only handle a saved layout has, so it has to behave like one.
 *
 * The rules are the ones `validateGroupName` already applies to key-group
 * names (useKeyGroups.ts) — same problem, same answers — generalised here so
 * the two libraries cannot drift apart from each other or from it.
 */

/**
 * Control characters, which must never reach a name: they are invisible, so
 * two names that look identical would not be, and they break a row's
 * single-line layout.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Long enough for "WASD rapid trigger", short enough for a list row. */
export const SAVED_NAME_MAX = 40;

/**
 * What actually gets stored for what was typed.
 *
 * Runs of whitespace collapse and control characters go, so a name cannot
 * carry invisible differences — `"Fast "` and `"Fast"` are one name, and
 * `"Fa\u0000st"` is not a third one that looks like the first two.
 */
export function cleanSavedName(raw: string): string {
  return raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, SAVED_NAME_MAX);
}

/**
 * The existing entry this name would collide with, if any.
 *
 * Case- and whitespace-insensitive, because two rows reading "fast" and
 * "Fast " are the same row to anyone looking at the list. `selfId` excludes
 * the entry being renamed, which is not a clash with itself.
 */
export function savedNameClash<T extends { id: string; name: string }>(
  list: readonly T[],
  name: string,
  selfId?: string,
): T | undefined {
  const key = cleanSavedName(name).toLowerCase();
  if (!key) return undefined;
  return list.find((e) => e.id !== selfId && cleanSavedName(e.name).toLowerCase() === key);
}

/**
 * The first numbered default a new entry can take — "Layout 1", then
 * "Layout 2", the lowest number no existing entry already has (by the same
 * rules as `savedNameClash`, so "layout 1 " counts as taken).
 *
 * Saving should be one click: a name field that starts empty made the first
 * thing every save asked for a name nobody had thought of yet.
 */
export function nextSavedName(
  list: readonly { id: string; name: string }[],
  format: (n: number) => string,
): string {
  for (let n = 1; ; n++) {
    const name = format(n);
    if (!savedNameClash(list, name)) return name;
  }
}
