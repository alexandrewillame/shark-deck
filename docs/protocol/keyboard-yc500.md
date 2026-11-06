# yc500 keyboards (YC3121 command set)

The older ROYUAN keyboards — the vendor registry's `yc500` family. Driver:
`app/src/main/devices/drivers/yc500-keyboard.ts`. Attack Shark boards on it:

| Model id | Board | Notes |
|---|---|---|
| 1343, 1679 | K75RGB | |
| 1466 | K85 | the only magnetic yc500 board: profile byte counts in fours |
| 1168 | K86 | |
| 1724 | X85 PRO | |
| 1967 | X86 | knob slots 90/91 (turn), 84 (press) |
| 1996 | X98 PRO | |
| 1025 | X65 HE | added by hand to sharkfin's registry from an owner's read sweep |

**No yc500 board has been on our hardware.** Every frame below is
`ported-from-vendor` at best — the facts come from sharkfin's protocol notes
(`docs/PROTOCOL.md`, GPL-3.0-or-later; facts only, no code taken) and
dnim.dev's write-up of the ROYUAN protocol — and `inferred` in practice. Every
write is read back; a backup (the base keymap at least) is taken before the
first one.

## How the family is told apart

`0x8F` (identify, same opcode as gen2) answers the firmware model id as a u32
LE at bytes 1..4 of the 64-byte reply. The family comes from the registry row
for that id (`catalog/keyboards.ts`), **never** from the USB product id — and
nothing else is sent before it is known (`drivers/identify.ts`). The two
families' opcodes collide destructively, so guessing is not an option.

## Framing (identical to gen2)

64-byte feature report 0, usage page 0xFFFF, usage 2. Shark Deck's buffer is
65 bytes (report id first), so byte indexes below are the 64-byte buffer's
(`b0` = opcode) and Shark Deck's are one higher. Checksum `b7 = 0xFF − Σ
b0..b6` (`b8` for 0x07 / 0x08) — the `compx-fea` scheme. A reply is ready
about 100 ms after the request; the next packet is accepted about 70 ms after
a write. The driver reads at growing settle (40 / 60 / 100 / 150 / 250 ms).

## Commands Shark Deck sends

| Opcode | Request | Reply / effect | Provenance |
|---|---|---|---|
| `0x8F` | — | model id, u32 LE at b1..b4 | `verified-capture` on gen2 (same opcode); `ported-from-vendor` here |
| `0x80` | — | revision `(b2 << 8) \| b1`, shown as e.g. 8.14 | `ported-from-vendor` |
| `0x85` / `0x05` | SET `[b1 profile]` | b1 = profile (× 4 on a magnetic board) | `ported-from-vendor` |
| `0x91` / `0x11` | GET `[b1 0]`, SET `[b1 0, b2 ms]` | b2 = debounce, 1..10 ms | `ported-from-vendor` |
| `0x92` / `0x12` | SET values at b8..b15 | four u16 LE seconds: light BT, light 2.4 GHz, deep BT, deep 2.4 GHz (b1..b8 in the reply); 30..36000 s are real values | `ported-from-vendor` |
| `0x87` / `0x07` | `[b1 mode, b2 speed, b3 brightness, b4 option << 4 \| colour mode, b5..b7 RGB]`, checksum at b8 | same layout read back | `ported-from-vendor` |
| `0x88` / `0x08` | side strip, same layout; speed not inverted | answers even on a board with no side LEDs | `ported-from-vendor` |
| `0x89` | `[b1 profile, b2 page 0..7]` | a raw 64-byte page, no echo: slot s is on page s / 16 at offset (s % 16) × 4 | `ported-from-vendor` |
| `0x90` | `[b1 profile, b2 page]` | the Fn layer, same shape | `ported-from-vendor` |
| `0x13` | `[b1 profile, b2 slot]`, quad at b8..b11 | one base-layer slot; read back from its page | `ported-from-vendor` |
| `0x15` | same | one Fn-layer slot | `ported-from-vendor` |
| `0x02` | — | factory reset (about 4 s to come back; **0x01 is gen2's**) | `ported-from-vendor` |

Lighting: the main zone's speed runs 5 (slowest) .. 1 (fastest) on the wire —
gen2's runs 4..0 — and brightness 0..4. White is sent as `FA FA FA`; a colour
under `08 08 08` shows as unlit, so it is raised to that.

Slot quads are the same as gen2's: `00 00 uu 00` a HID usage, `01 …` a mouse
button, `03 00 lo hi` a consumer usage, `09 mode idx 00` a macro, `0A 01 00 00`
Fn. All zero is "falls through" on the Fn layer and dead on the base layer.

## Never sent

| Opcode | Why |
|---|---|
| `0xAC` | erases the flash chip (about a minute). Sits in the 0x80+ "GET" range — which is why no GET is ever guessed at. |
| `0x2C` | erases the display |
| `0x7F`, `0x30` | bootloaders (act only when followed by `55 AA 55 AA`) |
| `0x09`, `0x10` | whole-layer keymap / Fn uploads — rewrite flash (and on gen2, `0x09` is the options register) |
| `0x1A` | the magnetic board-wide record (revision < 2.00) — writes flash |

`yc500-keyboard.test.ts` proves no opcode outside the table above leaves the
driver, from any method.

## The collisions with gen2

| Opcode | yc500 | gen2 |
|---|---|---|
| `0x01` | — | factory reset |
| `0x02` | factory reset | — |
| `0x03` | — | report rate |
| `0x06` | **options** register | debounce |
| `0x09` | **whole-layer keymap upload to flash** | options |
| `0x10` | **whole Fn-layer upload** | single Fn write |
| `0x11` | debounce | sleep timers |
| `0x12` | sleep timers | — |

This is why the yc500 driver extends the bare `Driver` class rather than the
gen2 one: a method it does not implement answers "not supported" and sends
nothing, instead of inheriting a gen2 frame that means something else here.

## Not supported yet

- **Report rate**: the family has no command for it.
- **Options register** (`0x86` / `0x06`): Win lock, WASD swap, backlight off,
  side light off, keyboard lock — no menu maps onto it yet.
- **Macros** (`0x8B` / `0x16`), **per-key colours** (`0x0C` — each upload
  writes flash, and `0x8C` reads back stale data).
- **The K85 1466's magnetic pages** (`0xE5` / `0x65`): 126 one-byte slots in
  0.1 mm steps with per-setting offsets, and below revision 2.00 a board-wide
  record (`0x1A`) instead. That board gets no actuation menu until a driver
  for them is written and checked.
- **The 2.4 GHz receiver** (3151:4011 and others): relay protocol known
  (`0xF7` status, `0xF6 0x0A` select keyboard, `0xFC` release), not driven yet.
