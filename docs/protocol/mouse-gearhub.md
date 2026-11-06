# GearHub-V5 mice (VID 0x3151)

Mice on the same ROYUAN chip as the keyboards. Driver:
`app/src/main/devices/drivers/gearhub-mouse.ts`; models:
`catalog/gearhub-mice.ts`.

| Device id | Model | Sensor | DPI |
|---|---|---|---|
| 1893, 3009 | R2 | PAW3950 | 50–42000 |
| 1643, 3485 | R3 | PAW3395 | 50–26000 |
| 3309, 3310 | R3 (PAW3950 revision) | PAW3950 | 50–42000 |
| 1660 | X3 PRO (second revision) | PAW3395 | 50–26000 |
| 3016 | R2 on PID 0x5043 | — | another MCU and command set: **named, never driven** |

Cable 3151:**4026** (wired, 1000 Hz at most, no battery); receiver
3151:**402D**, which carries the mouse's packets (see
[receiver-relay.md](receiver-relay.md), target `0x05`).

**Never on our hardware.** `ported-from-vendor`: OpenMouse's GearHub driver
(AGPL-3.0 — facts only) with an R2 1893 read and written on hardware by a
contributor, and innox2-mac (MIT). `inferred` in practice.

## Framing

The keyboards' framing: 64-byte feature report 0, usage page 0xFFFF usage 2,
`b0` opcode, `b1..b6` parameters, `b7 = 0xFF − Σ b0..b6`, data from `b8` —
the `compx-fea` checksum at Shark Deck's byte 8. A GET is the SET | 0x80; the
reply's `b7` is the request's checksum echoed, not a check of its own.
Unsupported commands, and reads that come too early, return the previous
reply, so the opcode echo is checked.

## Commands Shark Deck sends

| Opcode | What | Notes |
|---|---|---|
| `0x8F` | identify | `b1..b4` device id, u32 LE |
| `0x80` | firmware | `b1` minor, `b2` major (v3.03) |
| `0xD3` / `0x53` | the options block | 64 bytes; written back **whole**, read-modified: "settings only take effect that way" |
| `0xD4` / `0x54` | the DPI table | `[54, PP, active, count, 0, 0, 0, ck]` + data |

Options block, by body byte: `9` poll code (08=125, 04=250, 02=500,
01=1000, 84=2000, 82=4000, 81=8000), `10` debounce ms, `12–13` flags (bit 2
ripple), `40–41` sleep Bluetooth and `44–45` sleep 2.4 GHz (u16 LE seconds,
0 = never), `52` lift-off index (PAW3950: 0.7 / 1 / 2 mm; PAW3395: 1 / 2 mm),
`53` angle snap. Unknown bytes — the vendor writer sets `17` = FF and
`18` = 08 — are carried through as read.

DPI table, by body byte: `2` active stage (0-based), `3` count, X at
`8 + 2i` and Y at `24 + 2i` (u16 LE), RGB at `40 + 3i`, eight stages. A live
R2 reply: `d4 00 02 06 00 00 00 2b 90 01 20 03 40 06 80 0c 00 19 90 65` =
400 / 800 / 1600 / 3200 / 6400 / 26000, stage 3 active.

## Never sent

Factory reset `02`; pairing `01`, `61` / `E1`; the MCU and OLED bootloaders
`40` / `41` / `C0` / `C1` and `30` / `31`; factory commands `7A`–`7D`; rapid
fire `55`; recoil `60` / `E0`; and the keyboard family's `7F` (bootloader),
`2C` / `AC` (erase), `1C` / `1E` (calibration). Opcode meanings differ between
families on this chip — the driver only sends its own table.

## Not supported yet

Profiles (the tools that drive these mice always use profile 0; switching is
unverified), button remapping (the slot order differs between models),
macros, Bluetooth (3151:402C, a different report), the factory reset.

## Sources

- OpenMouse mouse-protocol — <https://github.com/OpenMouse-Project/mouse-protocol>
  (**AGPL-3.0: facts only, no code**): `src/gearhub/index.ts`,
  `src/drivers/gearhub/hid.ts` and its tests, PRs #59, #72, #81, #169, #256.
- innox2-mac — <https://github.com/codewithwan/innox2-mac> (MIT).
- AJAZZ control center's opcode table —
  <https://github.com/Aiacos/ajazz-control-center> (GPL-3.0-or-later): opcode names only.
