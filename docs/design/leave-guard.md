# Leaving with changes nobody applied

Some settings are staged rather than written as they change: a remap waits for
Apply, the lighting editors are previews until Apply to keyboard, a mod-tap or
DKS key waits for its panel's Apply, and a macro is a draft until Save. Leaving
the screen they are on used to throw that work away without a word. Now the
exit asks first, in one prompt shared by the whole app.

Code: `app/src/renderer/state/leaveGuard.ts` (the registry and `confirmLeave`),
`app/src/renderer/components/LeaveDialog.tsx` (the prompt, rendered once by
`App`), `app/src/main/quitGuard.ts` (holding a desktop quit).

## The prompt

Chosen from rendered options (2026-11-05) after checking Apple's HIG, Material
3, Microsoft's ContentDialog guidance, GNOME's HIG and Nielsen Norman Group.
They agree on: a title that names what is at stake, verbs on the buttons, an
obvious safe way to stay, never Discard as the Enter default, and asking only
when something would really be lost.

- **Title** names the change and the exit: "Apply this change before leaving?"
  ("…switching profile?", "…quitting?"; "Save this macro…" for a macro).
- **Body** names the change ("Caps Lock → Esc hasn't been applied to the
  keyboard yet.") and what leaving does ("If you leave now, it's discarded.").
- **Buttons**, in the app's usual order: **Keep editing** (first, so it has the
  focus: Enter, Escape and a click on the backdrop all stay), **Discard and
  leave** (red), **Apply and leave** (primary; writes, then goes, and stays if
  the write fails). The three labels need `.modal-leave`: at least 480 px,
  wider when a translation's buttons need it, so they stay on one row.
- **Several changes** — only the Lighting tab can hold two (a Global effect
  and per-key colours) — are listed, with Keep editing and Discard only:
  the board shows one or the other, never both, so "apply them" has no single
  meaning.
- **No Apply** when the device is not answering, or when the change cannot be
  applied from what is on screen (the Global draft while Per-Key is shown).

## Which exits ask

Each exit calls `confirmLeave(deviceId, proceed, exit)`; only the ones that
LOSE a staged change do.

| Exit | Asks | Why |
|---|---|---|
| Another section on the rail | yes | remounts the pane (`key={active}:{configEpoch}`) |
| Closing the device's tab (×, middle-click, Ctrl+W) | yes | unmounts the screen |
| Remap Base ↔ Fn layer | yes | the staged pick is per key and layer |
| Lighting Main ↔ Side zone | yes | each zone's editor unmounts |
| Actuation Keys → Test | yes | unmounts the key panels |
| Switching profile in the menu | yes ("switch") | profile-scoped panes re-read |
| Quitting the desktop app: tray Exit/Quit, ⌘Q, × when it really quits | yes ("quit") | see below |
| Closing or reloading the page (browser edition) | browser's own box | `beforeunload` is all a page may use |
| Home, Settings, Auto-switch, another device, Ctrl+Tab | no | the device's screen stays mounted behind its tab; nothing is lost |
| Lighting Global ↔ Per-Key | no | both editors live above the two views |
| × while it hides to the tray (the default) | no | the window hides; the renderer keeps everything |
| Another key in Remap or Actuation, Escape, a click off the board | no | that is editing, not leaving: it drops the pick as it always has |

What cannot be asked, because it cannot be cancelled: the device being
unplugged (its tab closes with it) and a profile change made on the device
itself or by auto-switch (the profile-scoped pane re-reads). The change is
dropped in both. A device that only goes offline keeps its tab and the change,
greyed out until it answers again.

## What a pane registers

`usePendingChange(deviceId, { dirty, label, commit, kind })` while mounted.
`dirty` must mean **changed by hand**, not "differs from the board":

| Pane | Dirty when | Label |
|---|---|---|
| Remap (`KeyRemapSection`) | the staged pick differs from the key's binding | "Caps Lock → Esc", "Fn + Caps Lock → Mute" |
| Lighting Global (`MainLightingPane`) | edited since the last read or Apply | "Lighting effect: Breath" |
| Lighting Per-Key (`usePerKeyEditor().edited`) | colours painted, or the brightness slider moved | "Per-key colours" (`plural`: "haven't been applied") |
| Lighting Side (`UnderglowPane`) | differs from the strip | "Side lighting: Always On" |
| Actuation Mod-tap / DKS (`KeyModePanels`) | a new mode, or values changed from the key's | "Mod-tap on Caps Lock" |
| Macros (`MacroEditor`, kind `save`) | the draft differs from the saved macro | the macro's name |

Two traps the Modified pill falls into and the guard must not: while the board
shows its per-key picture, Global holds a fallback effect nobody chose; and a
Global Apply that changes the board's brightness makes the per-key editor
differ without anyone touching it.

## Selections and navigation

Remap and Actuation drop their key selection on a click off the board, and the
staged pick or mode panel goes with it — on `pointerdown`, before any click
handler. So a click on `NAVIGATION_SURFACES` (the title bar, the rail, a pane's
section tabs, a dialog's backdrop) never drops a selection, and neither does
anything while the device's tab is not the one in front. Without that, the rail
click discarded the change before the prompt could ask, and "nothing is lost on
Home" was untrue for Remap.

## Desktop quit

The renderer reports every flip of "anything pending?" (`setPendingChanges`).
While it is true, `main/index.ts` holds `before-quit` and a window close that
would really close, brings the window up and sends `app:quitRequested`; the
renderer shows the prompt on the device holding the change and answers with
`quitApp`. A renderer that reloads or crashes reports nothing pending, and a
Windows session that is ending never waits.
