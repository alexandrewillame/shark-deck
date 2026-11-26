/**
 * Deciding whether a value the device just reported may replace what a section
 * is showing.
 *
 * The device is polled while its screen is open, because its own buttons can
 * change DPI and polling rate with no app involvement (see `setLiveWatch`).
 * That poll is a *second* writer into state the user is also editing, and the
 * two race in one specific way: a read that started before the user's write
 * lands after it, carrying the pre-write value. Adopting that would drag the
 * control back to where it was a moment after they moved it.
 *
 * Hence the pin. Setting a value optimistically also pins it for a short
 * window; inside that window a report *equal* to the pin is our own write
 * echoing back (adopt it, and stop pinning), and one equal to what the write
 * replaced is the stale read (ignore it). Anything else is the device moving
 * on its own after the write — its DPI button pressed a second after a click
 * (the X8 PRO's owner, 2026-11-25) — and is adopted: the report it came in is
 * the only one, so ignoring it left the screen a stage behind until the next
 * press. Once the window passes, the device is the authority again — that is
 * the whole point of polling it.
 *
 * Pure and separate from React so it can be unit-tested; the harness only
 * collects `src/**\/*.test.ts`, so this cannot live in a `.tsx` file.
 */
export interface LiveSyncInput<T> {
  /** What the device most recently reported, or null if never read. */
  remote: T | null;
  /** What the section is showing right now. */
  local: T | null;
  /** The value we last set optimistically, if the pin is still live. */
  pinnedTo: T | null;
  /** What the writes of this pin replaced: a read that predates them carries
   *  one of these. Absent, any other value counts as such a read. */
  pinnedFrom?: readonly T[];
  /** When that pin expires (epoch ms). */
  pinnedUntil: number;
  now: number;
  /** True while the user is mid-gesture — dragging a handle, typing in a
   *  field. Nothing may move under them, however stale it is. */
  held: boolean;
}

export function nextLiveValue<T>(a: LiveSyncInput<T>): { value: T | null; clearPin: boolean } {
  if (a.remote === null || a.held) return { value: a.local, clearPin: false };
  if (a.now < a.pinnedUntil) {
    if (a.remote === a.pinnedTo) return { value: a.remote, clearPin: true }; // our own write, confirmed
    const stale = !a.pinnedFrom || a.pinnedFrom.includes(a.remote); // a read that predates it
    if (stale) return { value: a.local, clearPin: false };
  }
  return { value: a.remote, clearPin: true };
}
