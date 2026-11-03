/**
 * Profiles and auto-switch. The one runtime export in this tree lives here:
 * `resolveLink` is a function, not a type, so it must be imported as a value.
 *
 * Split out of the former shared/types.ts.
 */
import type { DeviceKind } from './device';
/**
 * Which of a device's own onboard slots a profile selects.
 *
 * It used to carry a `kind` of `'onboard' | 'software'`, because keyboards
 * were modelled as software-held setting snapshots. They are not — both
 * keyboard descriptors declare real onboard slots now (see
 * catalog/r85he.ts), so there is only one kind and the field is gone. A
 * stored link from before that carries `kind: 'software'` keeps its slot
 * number; main/profiles/store.ts drops the field on read.
 */
export interface DeviceProfileLink {
  slot: number;
}

/** A small built-in icon set for a profile with no exe icon of its own (the
 *  default "Desktop" profile, or one not yet linked to any trigger). Kept
 *  local to this file — deliberately not the renderer's own `IconName` union,
 *  since `shared/` is imported by the main process too and shouldn't depend
 *  on renderer UI code. */
export type ProfileIcon =
  { kind: 'builtin'; name: 'windows' | 'desktop' | 'gamepad' } | { kind: 'exe'; dataUrl: string };

/** One process that activates a profile while it's running. `enabled: false`
 *  keeps the association (and its label) but stops it from firing — the
 *  per-process on/off slider in the Auto-Switch Processes panel, which
 *  replaces the old per-*rule* enable flag. */
export interface ProfileTrigger {
  /** process image name, lowercase, no path */
  exe: string;
  /** display label — the game name from the scanner, else the exe name.
   *  User-editable in the Auto-Switch "Games / Apps" list. */
  label?: string;
  /** Position in the single flat, user-reorderable Games / Apps list (across
   *  every mode). Absent on older records — those sort last, by label. */
  order?: number;
  enabled: boolean;
  /** snapshotted at assignment time from the Processes panel's source row
   *  (a scanned game has none, a running process usually does) — resolving
   *  an icon live from just an exe name isn't reliable, so this is captured
   *  once rather than looked up later. */
  iconDataUrl?: string | null;
}

export interface AppProfile {
  id: string;
  name: string;
  /** true for the seeded "Desktop" / "Gaming" profiles — still renamable, just flagged so the UI can label them. */
  builtIn?: boolean;
  /** The single fallback profile every other profile switches back to when
   *  none of its triggers match. Exactly one profile has this set; it cannot
   *  be deleted (see main/profiles/store.ts). */
  isDefault?: boolean;
  icon?: ProfileIcon;
  /** Empty on the default profile — it is never matched by a running process. */
  triggers: ProfileTrigger[];
  /** Slot used for a device model with no explicit entry in `links` below
   *  (Desktop defaults to 1, Gaming to 2, for every model) — resolved lazily
   *  per model with `resolveLink()` so a freshly-connected device doesn't
   *  need its own stored link to get a sensible default. */
  defaultSlot?: number;
  /** device model slug -> which per-device slot this profile selects */
  links: Record<string, DeviceProfileLink>;
}

/**
 * Resolves which slot a profile selects for one connected device: an explicit
 * `links[device.model]` entry if the profile has one, else
 * `profile.defaultSlot ?? 1`. Shared by the switcher engine
 * (main/profiles/switcher.ts) and the Auto-Switch screen so
 * "Desktop -> Profile 1" / "Gaming -> Profile 2" show up for a device with no
 * stored link at all, not just an explicitly-linked one.
 *
 * It used to also validate a stored `kind` against what the device supports,
 * because a link could name the software kind for a device that only had
 * onboard slots (or the reverse), and the mismatch made a renamed slot read
 * back as a generic "Profile N". With one kind of slot there is nothing left
 * to mismatch.
 */
export function resolveLink(
  profile: Pick<AppProfile, 'links' | 'defaultSlot'>,
  device: { model: string },
): DeviceProfileLink {
  return { slot: profile.links[device.model]?.slot ?? profile.defaultSlot ?? 1 };
}

/**
 * @deprecated Superseded by `AppProfile.triggers` — a rule used to be a
 * separate record pointing at a profile. Kept only as the shape of a
 * pre-this-model `rules.json` for `migrateRulesToProfiles()` in
 * main/profiles/store.ts to read and fold in; nothing else should produce or
 * consume this type.
 */
export interface SwitchRule {
  id: string;
  enabled: boolean;
  /** matched case-insensitively against process image names, no path */
  processNames: string[];
  gameLabel: string;
  /** profile id to apply while any process matches */
  profileId: string;
  /** profile id to restore when none match; null = previous */
  fallbackProfileId: string | null;
}

export interface SwitcherState {
  running: boolean;
  /** True while a device config tab is open in the UI — auto-switch holds
   *  off rather than writing profiles underneath someone editing a device.
   *  Orthogonal to `running`: a suspended switcher can still be "on". */
  suspended: boolean;
  activeProfileId: string | null;
  pinnedProfileId: string | null;
  /** pre-formatted, English-only summary — kept for the Auto-Switch screen's
   *  own log-style display; the profile-switch overlay uses `lastSwitch`
   *  instead, since that's translatable and structured. */
  lastEvent: string | null;
  /** the most recent profile switch the engine actually applied, structured
   *  enough to drive the on-screen overlay (main/overlayWindow.ts) without
   *  parsing `lastEvent`. Null until the first switch of this run. */
  lastSwitch: SwitchApplication | null;
  /**
   * The mode currently being written to the hardware, if any.
   *
   * Applying a profile is a burst of feature-report writes, and the board
   * does not answer its own input endpoint promptly while that runs — the
   * keyboard visibly stalls for a moment. Without this the UI said nothing at
   * all, so the stall read as a fault rather than as work in progress.
   */
  applying: { profileId: string; profileName: string } | null;
  /**
   * The mode in force right now, and what put it there — as of the last poll,
   * whether or not anything had to be written for it. Null while SharkDeck is
   * not choosing modes at all (auto-switch off, nothing pinned).
   *
   * `lastSwitch` cannot answer "which mode, and why": it only changes when a
   * write happens, and a re-push after leaving a device menu recorded itself
   * as a manual switch with no executable — so the topbar read "Gaming" one
   * moment and "Gaming · cs2.exe" the next, with the game running throughout.
   */
  current: CurrentMode | null;
}

/** See SwitcherState.current. */
export interface CurrentMode {
  profileId: string;
  profileName: string;
  /** The fallback profile — what is in force when nothing triggers. */
  isDefault: boolean;
  /** Held by a pin rather than chosen by auto-switch. */
  pinned: boolean;
  /** The running executable whose trigger chose this mode; '' when no
   *  trigger did (the default profile, or a pin). */
  exe: string;
  /** That trigger's icon, when one has been captured. */
  exeIcon: string | null;
}

/** One profile switch the engine applied — see SwitcherState.lastSwitch. */
export interface SwitchApplication {
  at: number;
  profileId: string;
  profileName: string;
  /** what triggered it — 'game'/'desktop' fire the on-screen overlay; a
   *  manual pin or Apply-profile click does not, matching the legacy
   *  switcher's popup, which only ever fired on real game transitions. */
  reason: 'game' | 'desktop' | 'pin' | 'manual';
  /** The executable behind the switch — the one that started for 'game', the
   *  one that exited for 'desktop'; '' for the other reasons. */
  context: string;
  /** That executable's icon, when its trigger has one (a data: URL). */
  exeIcon?: string | null;
  devices: {
    id: string;
    displayName: string;
    slot: number;
    ok: boolean;
  }[];
}

/** Colour palettes shipped in styles.css as `:root[data-palette="…"]`. */

/**
 * One comparable slice of an onboard profile slot.
 *
 * Deliberately coarser than the settings themselves: the compare popup asks
 * "is this the same on both slots", and a field is the unit the user can copy
 * across. Reads that have no per-slot meaning (firmware, battery, macros) are
 * not here.
 */
export type ProfileField =
  | 'pollRate'
  | 'debounce'
  | 'power'
  | 'sensor'
  | 'dpiStages'
  | 'buttons'
  | 'lighting'
  | 'sideLighting'
  | 'perKeyLighting'
  | 'keyRemapBase'
  | 'keyRemapFn'
  | 'magnetic'
  | 'switchTypes';

/**
 * Every `ProfileField`, at runtime, in display order.
 *
 * The type alias above is erased, so the compare popup and `copyProfile`'s
 * "all fields" default need a real array. Kept next to the union rather than
 * derived from it, with the same order, so the two are read together — a
 * field added to one and not the other is a field that never appears.
 */
export const PROFILE_FIELDS: readonly ProfileField[] = [
  'pollRate',
  'debounce',
  'power',
  'sensor',
  'dpiStages',
  'buttons',
  'lighting',
  'sideLighting',
  'perKeyLighting',
  'keyRemapBase',
  'keyRemapFn',
  'magnetic',
  'switchTypes',
];

/**
 * The fields that actually follow the onboard slot on a device of this kind.
 *
 * On a keyboard that is the actuation settings only. Every other keyboard
 * read is slot-blind on the wire: the lighting frames (`SET_LEDPARAM`,
 * `SET_SLEDPARAM`, `SET_USERPIC`) carry no slot byte at all, the key matrix
 * is read and written at a fixed layer, the Fn layer follows `KBOPTION`
 * rather than the slot, there is one onboard macro slot, and poll rate and
 * debounce are single registers. Only the magnetism pages change when
 * `SET_PROFILE` does — see docs/protocol/keyboard-compx.md, "Profiles and
 * what is slot-scoped". So comparing or copying anything else between slots
 * would show differences that are not there and write settings that do not
 * move.
 *
 * Mice keep every field: a mouse's onboard slot does carry its DPI stages,
 * buttons, lighting and the rest.
 */
export function profileFieldsFor(kind: DeviceKind): readonly ProfileField[] {
  return kind === 'keyboard' ? ['magnetic'] : PROFILE_FIELDS;
}

/** What one slot holds. `null` where the device has no read for that field. */
export interface ProfileSnapshot {
  slot: number;
  values: Partial<Record<ProfileField, unknown>>;
  /** Set when the slot could not be read at all; `values` is then empty. */
  error?: string;
}

/**
 * Every slot, read one at a time.
 *
 * The device only ever exposes the slot it is ON — no read takes a profile
 * argument — so this is a switch-read-switch sweep, and it is slow: one
 * SET_PROFILE plus a full read per slot. `restoredTo` is the slot the device
 * was on beforehand and is on again afterwards.
 */
export interface ProfileSnapshots {
  slots: ProfileSnapshot[];
  restoredTo: number;
  /** Fields this device can actually report, in display order. */
  fields: ProfileField[];
}
