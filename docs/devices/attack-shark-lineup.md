# Attack Shark product lineup

A reference catalogue of Attack Shark devices, separate from the actual
`DeviceDescriptor` entries in
[`../../app/src/main/devices/catalog/`](../../app/src/main/devices/catalog/)
(which is the real source of truth SharkDeck runs against — this file exists
to plan *adding* new ones, not to duplicate what's already fully wired).

## How to read this table

Every field for the two models already in the catalog is transcribed
directly from their `DeviceDescriptor`/`DeviceSpec` — treat those as
accurate. Every other row is a **stub**: model names Claude has moderate
confidence are real Attack Shark products, with every spec column left
blank rather than guessed. **Do not create a `DeviceDescriptor` from a stub
row's blank fields** — USB VID/PID, exact key/button counts, DPI ranges and
poll rates all have to come from either the real hardware (the same way
V8/R85HE were captured — see
[`../reverse-engineering/`](../reverse-engineering/)) or an authoritative
vendor spec sheet. Fabricating plausible-looking numbers here would be worse
than leaving them blank, since a wrong DPI range or button count silently
produces broken controls instead of an obvious gap.

## Supported today

| Model | Kind | Screen | Keys / layout | Buttons | Wireless | Poll rates (Hz) | Colour/edition photos | Provenance |
|---|---|---|---|---|---|---|---|---|
| **Attack Shark V8** (`attack-shark-v8`) | Mouse | — | — | 6 | Yes (8K dongle) | 125/250/500/1000/2000/4000/8000 | Black, White | `verified-capture` |
| **Attack Shark R85HE** (`attack-shark-r85he`) | Keyboard | No | 75% (`Common79_SG9047`) — 79 keys in a 16×6 slot matrix (`ANSI_79_SG9047`) | — | **No — wired only** (no `GET_RF_VERSION`, no battery) | 125/250/500/1000/2000/4000/8000 | Green, Black·gradient keycaps, White, White·contour keycaps | frame/checksum/matrix `verified-capture`; `SET_*` layouts `ported-from-vendor` |

Both descriptors also declare magnetic-switch/Hall-effect actuation
(R85HE only), per-key + side lighting (R85HE) or DPI-indicator + receiver
lighting (V8), macros, onboard/software profile slots, and auto-switch — see
the catalog files directly for the full `Capability[]` list; this table only
covers the physical-hardware questions the user asked about (screen, key
count, button count).

## Not yet supported — unconfirmed stubs

| Model (working name) | Kind | Notes |
|---|---|---|
| Attack Shark X1 | Keyboard | Compact mechanical, believed to exist in the lineup. Screen/key-count/wireless: **unconfirmed**. |
| Attack Shark F1 | Keyboard | Hot-swap mechanical, believed TKL. Screen/key-count/wireless: **unconfirmed**. |
| Attack Shark X8 | Mouse | Believed to be a lower-tier wired/wireless mouse distinct from the V8. Button count/DPI range: **unconfirmed**. |
| Attack Shark V3 / V6 Pro | Mouse | Believed to exist as other points in the mouse lineup. Specs: **unconfirmed**. |

**Driver v4's full device table** (368 rows: vid/pid/keyLayout/name/displayName/
layer/magnetic/side-light/screen) is now extracted to
[`app/scripts/_raw/kb-devices.json`](../../app/scripts/_raw/kb-devices.json)
by `npm run extract:kb` — a real reference for adding models, though still not
a substitute for a smoke-hid + capture pass on the actual hardware. Note ~99
Attack Shark keyboards share `0x3151:0x5029`; they are told apart by the model
`id` in the `GET_USB_VERSION` reply, which SharkDeck's VID/PID-only matching
does not yet use (`registry.ts`).

If you own one of these (or another Attack Shark model not listed at all),
the fastest path to a real entry is the same one V8/R85HE went through:

1. Find VID/PID and the vendor config collection's usage page/usage —
   `node scripts/smoke-hid.mjs` and/or `HID.devices()` with the vendor
   software's driver installed will show connected collections; cross-check
   against [`known-pids.ts`](../../app/src/main/devices/catalog/known-pids.ts)
   in case it's already a recognized PID under a generic descriptor.
2. Capture real traffic with the vendor app open — see
   [`../reverse-engineering/README.md`](../reverse-engineering/README.md) and
   [`CAPTURE-MOUSE.md`](../reverse-engineering/CAPTURE-MOUSE.md) for the Frida
   hook workflow already used for the V8.
3. Add one new file under `app/src/main/devices/catalog/` (copy `v8.ts` or
   `r85he.ts` as a starting shape) and one line in `catalog/index.ts`'s
   `CATALOG` array — per `CLAUDE.md`, that's the entire integration surface;
   nothing else in the codebase needs to change for a new model to appear.
4. If you have real product photos, drop them in
   [`../../app/assets/devices/`](../../app/assets/devices/) and wire them per
   that folder's README (`DeviceColorVariant` entries + a map entry in
   `deviceArtAssets.ts`) — this is how the V8/R85HE colour photos were added.

## Button-position mapping (mice)

`DeviceSpec.buttonMap` (see `src/shared/types.ts`) can attach an x/y
position to each button index, for a future graphical "click the button you
want to remap" picker instead of a plain numbered list. It's deliberately
**not populated** for the V8 in this pass: the button *index -> physical
button* correspondence itself is `inferred` (see
`docs/protocol/README.md`'s buttons section) and was never captured, so
guessing coordinates on top of an unconfirmed index order would compound
the uncertainty rather than add real value. The empirical way to confirm it
without a fresh USB capture: open the V8 in SharkDeck's Buttons tab, assign
a distinct action to each index one at a time, and note which physical
button each one actually affects.
