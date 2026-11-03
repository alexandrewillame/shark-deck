# Auto-switch design

How game-aware profile switching works, and how it diverges from the Python
switcher it was generalised from
(`legacy/attack-shark-profile-switcher/switcher.py`, reference only).

Moved out of `app/src/main/profiles/switcher.ts`'s header comment: the
comparison against a superseded implementation is orientation, not something
you need in order to edit the switcher correctly.

## A profile is a pure link

An `AppProfile` does not store settings. For each device model it names which
of that device's own onboard slots to select, and applying it is one
`SET_PROFILE` frame per device. `resolveLink()` in
`shared/types/profiles.ts` is what picks a device's slot out of a profile.

The original stored per-device setting snapshots instead, which meant a profile
could drift out of sync with what the device actually held.

### Why there is no second, software-held kind any more

There was one, for keyboards, on the reading that the R85HE's `SET_PROFILE`
"only flips a slot flag" with no storage behind it. SharkDeck therefore kept
four settings snapshots per model and wrote **all** of them to the board on
every switch. Three things came out of that, all reported from real use:

- a keyboard profile switch took about 30 seconds — hundreds of feature
  reports, each paced by the 30 ms settle this firmware needs, dominated by
  79 magnetic keys at 3-8 frames apiece;
- the replay included lighting, so auto-switch returning to "Desktop" stamped
  a snapshot's global effect over per-key lighting the user had just set;
- it needed a "Capture current settings" button, which inverted the model
  people actually have: while slot 1 is selected, editing a setting *is*
  editing slot 1.

Both keyboard descriptors declare real `profiles` now. What is actually known
about the hardware is written up in `catalog/r85he.ts`; the one honest caveat
is that keyboard **lighting** carries no slot byte on the wire, so whether it
follows the active slot is the firmware's business — SharkDeck no longer
writes it on a switch either way.

## Triggers live on the profile

Process names are `AppProfile.triggers`, each independently enable-able, rather
than a separate rule record.

There is no per-rule fallback either: every non-default profile falls back to
the single `isDefault` profile ("Desktop") when none of its enabled triggers
are running. The original supported a fallback per rule, which made the
resolution order hard to predict for anyone with more than two rules.

## What was kept verbatim

Three behaviours carried over unchanged, because they are the point of the
feature:

1. Poll the process list.
2. Act only on **transitions**, not on every tick.
3. **Re-apply** the desired profile whenever a write fails.

(3) is the self-heal after a replug or a sleep, and it is why the switcher
looks like it does more work than it needs to.

## Holding off while a config tab is open

While any device config tab is open, the switcher suspends its poll/push loop
rather than writing a profile underneath the menu someone is looking at — see
`SwitcherState.suspended` and the `setSwitcherSuspended` IPC method. Resuming
forces an immediate re-push of whatever mode should currently be active, so
nothing is left stale by the pause.

`guardedWrite` in `main/ipc.ts` stamps `switcher.noteDeviceWrite()`, which is
how resuming knows whether anything actually changed while it was paused.
