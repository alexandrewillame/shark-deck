# Beken mice (VID 0x1D57)

X11, X11 SE, X11 PRO V2, R1, X6, X3, X3 MAX, X3 PRO (first revision), X1,
X8 SE, X8 PLUS, X8 PRO, G3, G3 PRO, V3, V3 PRO, V6.

**Shark Deck drives one of them: the X8 PRO through its 8K receiver
(`1D57:FA65`)**, `app/src/main/devices/drivers/beken-8k-mouse.ts`. The others
it shows and never talks to (`app/src/main/devices/catalog/beken-mice.ts`): a
card with the model's name where its PID is its own, "Not supported yet",
nothing read or written. This page records what is known, so a driver can be
written once someone can check it on a mouse.

## The X8 PRO's 8K receiver (FA65)

From an owner's USB recording of the vendor's "Attack Shark Software" 1.0.0.2,
made with the device report tool (78 steps, November 2026,
[issue #1](https://github.com/alexandrewillame/shark-deck/issues/1)). Every
frame Shark Deck sends reproduces a recorded one byte for byte
(`beken-8k-mouse.test.ts`), but none has reached an X8 PRO from Shark Deck yet:
`ported-from-vendor`, and 🟠 in the lineup until its owner has tried it.

**Transport.** Output report 4 on the vendor collection `FF01:0002`
(interface 2), 64 bytes; the receiver answers on input report 4. The mouse's
events come on `FF00:0001` as input report 3, which Shark Deck does not read
yet: `03 08 40 01 <percent>` (battery, every 2 s; `08` is the X8 PRO's model
byte) and `03 08 10 <stage>` (the DPI button).

**Frame.** `04 <len> 00 <cmd> <inner> 01 <body…> <sum>`:

- `<len>`: the bytes from the report id to the end of the checksum;
- byte 2: `00` (the macro upload continues in a second report with `01`);
- `<inner>`: the bytes from `<cmd>` to the end of the body;
- `<sum>`: the 16-bit big-endian sum of every byte before it.

A data block ends its body with the 16-bit sum of its own data bytes.

**Answers.** `04 06 c0 01 00 cb` when the receiver has the frame, then
`04 06 c1 <s> 00 <sum>`: `01` when the mouse took it (10–700 ms in the
recording), `00` after about 2 s without an answer from the mouse.

**Nothing is read.** The vendor software never asks the mouse for anything: it
keeps the settings itself and always writes whole blocks. So does Shark Deck,
keeping each block as it last went out (per model). Until a block has been
sent once, the menus show starting values, and the first change sends the
whole block as shown; the confirmation before the first write says so.

| Command | Block | Content |
|---|---|---|
| `0x04` | DPI and sensor | 47 data bytes: flags A (bit 4 lift-off 2 mm, else 1 mm; bit 0 ripple control), flags B (bit 4 angle snapping; bit 0 motion sync), stage mask (`3f` = six stages), one "doubled" bit per stage, `00`, 8 low bytes, 8 high bytes, active stage (1-based), 8 RGB colours, `02`; then their sum and 4 zeros. A stage is `(raw + 1) × 50`, or `× 100` with its doubled bit: 40000 is raw 399 doubled. |
| `0x05` | power | 8 data bytes: `00 03 a8 00 ff 00` (meaning unknown, sent back unchanged), sleep in half-minutes, key response in 2 ms units; then their sum and 2 zeros. |
| `0x06` | polling | `<code> <FF − code> 00 00 00 00`: 125 Hz `14`, 250 `24`, 500 `34`, 1000 `44`, 2000 `54`, 4000 `64`, 8000 `74`. |
| `0x08` | buttons | 18 slots `[action, modifiers, usage]`, then their sum. Slots 0–2 left, right, middle; 3 the DPI button; 4 forward; 5 backward; 6 `3c` (unknown); 16–17 the wheel. |
| `0x09` | macros | Two reports (byte 2 `00`, then `01`): an index, the repeat count, the event count, then `[delay or flag, key]` pairs. Not decoded far enough to send. |
| `0x0C` | ? | `0c 0a 01 fe 01 fe 00 00 00 00`, sent before every whole-profile write. Never sent by Shark Deck. |

Button actions recorded: `01` off, `02` left, `03` right, `04` middle, `05`
forward, `06` backward, `08` fire, `09` scroll up, `0e` / `0f` DPI + / −,
`11` a key (modifier bits, then its usage: Ctrl + C is `11 01 06`), `12` a
macro, `17` next track, `18` play / pause, `1b` / `1c` volume + / −. Inferred
from the defaults and the run of codes: `0a` scroll down, `0d` DPI loop, `16`
previous, `19` stop, `1a` mute.

Profiles live in the vendor software: switching one rewrites every block
(`0x0C`, `0x04`, `0x05`, `0x06`, `0x08`, a second apart). The vendor's
"Reset Profile", the cable (`2126`), deep sleep, the key-response and sleep
sliders' maxima and macros are not in the recording yet.

## The others: why there is no driver yet

- **Reads need a permission mailbox.** Every read goes through feature report
  `0xA0` (`A0 <id> <len> 00 <param> 00 00 00`, wait 250 ms, GET `A0` byte 1
  = 1 means granted, then GET `<id>` at its declared length). One grant allows
  one read; refusals come in bursts with a cooldown. **Every hardware-verified
  read was on Linux; nothing shows it working on Windows**, and Chromium cannot
  reach the configuration collection at all (it carries only constant items),
  so the browser edition never could.
- **Dangerous neighbours.** Report `0x10` enters the bootloader — the mouse
  re-enumerates as A745:0033 and stays there across replugs. Writing `0x0B`
  unpaired a receiver. `0x0C` changes the profile count. `0x07` and
  `0x22`–`0x2E` are unknown.
- **Pacing.** Over the cable every other write stalls (EPIPE) and has to be
  resent; through a receiver, writes closer than about a second apart froze
  the link until a replug.
- **Per-model differences.** The X11 family encodes DPI through a 220-entry
  table; the X6 and X8 PRO linearly, each differently. The X8 PRO's 8K
  receiver speaks its own protocol (above). Bytes 3 and 4 of the DPI report
  carry angle snap / ripple on one model and lift-off / motion sync on
  another. Button slots rotate between write and read on the X8 PRO.
- **Identification is shaky.** The receiver FA60 is generic (Delux and others
  use it); the model comes from byte 1 of the input report-3 frames, and a
  real X6 sends `0x10`, which is the R1's byte.

## What is known about the others

| Report | Content | Readable |
|---|---|---|
| `0x04` | DPI stages, enable mask, active stage, colours (52 bytes cable / 56 receiver), BE sum checksum | yes (mailbox) |
| `0x05` | light mode / speed / brightness / RGB, sleep (half-minutes), debounce (ms / 2) | yes |
| `0x06` | poll rate: `06 09 01 code FF−code`, 08=125 … 01=1000 (X8 PRO differs) | yes |
| `0x08` | 18 button slots `[action, mods, usage]` | yes, slot order caveats |
| `0x09` | macros, three pages | **no** on the X11 |
| `0x0B` | firmware version | X8 PRO only; writing it unpairs |
| `0x10` | **bootloader — never** | — |
| `0xA0` | read-permission mailbox | — |
| input 3 | `03 model event p1 p2`: battery (`40`), DPI stage (`10`), write ACK (`50`), profile (`80`) | pushed |

PIDs: X11 FA55 (cable) / FA60 (receiver); X8 PRO 2126 / FA65 (8K receiver);
X1 2111; X8 PLUS 2124; R1, X6, X3 FA61 on their cables. Receiver model bytes
(byte 1 of report 3): X11 55, X11 SE 07, X11 PRO A9, R1 10, X6 85 (a real one
sent 10), X3 4D, X3 MAX 4E, X3 PRO 4F or 01, X1 B1, X8 SE 02, X8 PLUS 06,
X8 PRO 08, G3 04, G3 PRO 0E, V3 EA, V3 PRO E5, V6 24.

## Sources

The X8 PRO's 8K receiver: an owner's recording of the vendor software
(issue #1). The rest, provenance as the community tools report it; nothing
there is ours.

- HarukaYamamoto0/attack-shark-x11-driver (MIT) — captures and protocol docs.
- HolyJoey/attack-shark-x11 (MIT) — cable and receiver checked on hardware.
- KaiSta/attackSharkOnLinux (no licence file: facts only) — mailbox timing.
- Zelozzzz/dorsal `xseries.py` (MIT) — the DPI table, 310 vendor packets.
- OpenMouse mouse-protocol (AGPL-3.0: facts only) — issues #161, #171, #253;
  the X8 PRO test document attached to #171.
- clevim/OpenSharkX11, devmarciordg/attackshark-x11-linux,
  akawazak/attack-shark-x11-community-driver, blak0p/attack-shark-linux,
  cyberps96/attack-shark-ctl (MIT); xb-bx/attack-shark-r1-driver (no licence
  file: facts only).
