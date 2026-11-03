/**
 * Macro steps and the macro record itself.
 *
 * Split out of the former shared/types.ts.
 */

export interface MacroStep {
  type: 'key' | 'mouse' | 'delay' | 'move';
  action?: 'down' | 'up';
  value?: number | string;
  dx?: number;
  dy?: number;
  ms?: number;
}

export interface Macro {
  id: string;
  name: string;
  repeatCount: number;
  steps: MacroStep[];
}

// ---------------------------------------------------------------------------
// Profiles + automatic game-aware switching.
//
// Two layers, deliberately kept separate:
//  - An AppProfile ("Gaming", "Desktop") is a pure LINK: for each device model
//    it names which per-device slot to select. It carries no settings itself.
//  - A per-device slot is either a real hardware profile (`onboard`, e.g. the
//    V8 mouse's four onboard memory banks — switching it is the one
//    `verified-capture` write in the app) or an onboard profile slot (e.g. the
//    R85HE keyboard, whose SET_PROFILE only flips a flag with no known
//    per-slot hardware storage — SharkDeck keeps the settings itself and
//    replays them on select). Software slots are configured on the device's
//    own Profile tab, not here.
//
// There is no separate "rule" record: a profile owns its own list of trigger
// processes (`triggers`), each independently enable-able, and there is no
// per-profile fallback either — every non-default profile falls back to the
// single `isDefault` profile ("Desktop") when none of its triggers match a
// running process. `SwitchRule` below is retained only as the shape of a
// pre-this-model `rules.json`, for the one-time migration in
// `main/profiles/store.ts`.
// ---------------------------------------------------------------------------
