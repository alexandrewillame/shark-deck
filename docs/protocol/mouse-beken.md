# Beken mice (VID 0x1D57) — not supported yet

X11, X11 SE, X11 PRO V2, R1, X6, X3, X3 MAX, X3 PRO (first revision), X1,
X8 SE, X8 PLUS, X8 PRO, G3, G3 PRO, V3, V3 PRO, V6.

**Shark Deck shows these mice and never talks to them**
(`app/src/main/devices/catalog/beken-mice.ts`): a card with the model's
name where its PID is its own, "Not supported yet", nothing read or written.
This page records what is known, so a driver can be written once someone can
check it on a mouse.

## Why there is no driver yet

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
  receiver (FA65) speaks another protocol (output report 4, 16-bit checksum).
  Bytes 3 and 4 of the DPI report carry angle snap / ripple on one model and
  lift-off / motion sync on another. Button slots rotate between write and
  read on the X8 PRO.
- **Identification is shaky.** The receiver FA60 is generic (Delux and others
  use it); the model comes from byte 1 of the input report-3 frames, and a
  real X6 sends `0x10`, which is the R1's byte.

## What is known

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

Provenance as the community tools report it; nothing here is ours.

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
