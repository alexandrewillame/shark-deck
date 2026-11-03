/**
 * Returns `desired` if nothing in `taken` already uses it (case-insensitively,
 * trimmed), otherwise the first `"desired N"` — N counting from 2 — that is
 * free. Used wherever the user names a profile / Auto-Switch mode / device
 * slot: two entries with the same name render as two identical <option>s,
 * which reads exactly like "the rename silently didn't take".
 *
 *   uniqueName('gaming', ['gaming'])            -> 'gaming 2'
 *   uniqueName('gaming', ['gaming', 'gaming 2']) -> 'gaming 3'
 *   uniqueName('Profile 2', ['Profile 2'])      -> 'Profile 2 2'
 */
export function uniqueName(desired: string, taken: Iterable<string>): string {
  const base = desired.trim();
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim().toLowerCase());
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
