# JXC mice (VID 0x373E)

Attack Shark's own firmware on the Compx ODM's vendor id. Driver:
`app/src/main/devices/drivers/jxc-mouse.ts`; models: `catalog/jxc-mice.ts`.

| Model | Cable / receiver | Notes |
|---|---|---|
| R5 ULTRA | 0046 / 0047 | the one checked on hardware (by Dorsal's author); receiver LED on 0047 |
| R6 | 0021 / 0022 | competitive mode only from firmware 0.0.3.1 |
| R8 | 003A / 003B | never tried anywhere |
| M5 ULTRA | 0051 / 0050 | same ids as the MAMBASNAKE M5 Ultra: **named, never driven** |

The VID is shared — CRDRAKO 006A/006B, LAMZU 001C–001E, UNIUS 003C/003D,
RAWM 0098/0099, LunaFury 0032/0033/0054/0084, Vancer 0066/0067 get the
"Not an Attack Shark device" card. The firmware has **no model-id read**: the
PID is the identity.

**Never on our hardware.** Frames are `ported-from-vendor` — Dorsal (MIT)
documents them from a real R5 ULTRA plus an emulator running real firmware;
OpenMouse (AGPL-3.0, facts only) cross-checks — and `inferred` in practice.

## Transport

64-byte feature report 0 on usage page **0xFFFF, usage 0** (not 1 or 2). No
checksum, no handshake. One program at a time owns the interface: quit the
vendor app.

```
request  [00 status] [00] [target] [length tag] [category] [command] [profile/arg] [args…]
reply    [status]    [00] [target] [length tag] [category] [command] [data…]
```

- target `02` = the mouse (cable and receiver alike), `00` = the receiver.
- category: `00` device, `01` profile settings, `02` LED, `03` buttons, `04` macros.
- a read is the command | 0x80; the length tag is per command, copied, never derived.
- reply status: `A1` ok, `A0` only the receiver answered (mouse asleep — keep
  polling), `A2` unsupported or empty, `A3` rejected.
- the reply must echo target and command.
- timing: read 50 ms after the request (100 ms for battery / firmware), then
  poll up to ~1 s.

**Malformed packets crash the firmware**: about a quarter of random packets
rebooted it in the emulator, and R6 0.0.2.0 crashed on all-0xFF or oversized
ones. The driver builds every frame from a fixed table (`JXC_FRAMES`).

## Commands Shark Deck sends

All `ported-from-vendor`. `PP` = profile 1–3.

| Setting | Read | Write | Reply value |
|---|---|---|---|
| firmware | `02 10 00 81` | — | body 6..9 = a.b.c.d |
| battery | `02 02 00 83` | — | body 6 charging, 7 percent |
| active profile | `02 01 00 85 00` | `02 01 00 05 PP` | body 6 |
| debounce | `02 02 00 88 PP` | `02 02 00 08 PP ms` | body 7, 0–20 ms |
| sleep | `02 03 00 87 PP` | `02 03 00 07 PP hi lo` | body 7–8 seconds BE, 65535 = never |
| poll rate | `02 02 01 80 PP` | `02 02 01 00 PP code` | 08=125, 04=250, 02=500, 01=1000, 20=2000, 40=4000, 80=8000 (reads may give 10 for 1000) |
| DPI table | `02 0A 01 81 PP 06` | `02 (2+4n) 01 01 PP n` + n × X hi, X lo, Y hi, Y lo | body 7 count, stages from body 8 |
| active stage | `02 02 01 82 PP` | `02 02 01 02 PP 1..6` | body 7, 1-based |
| lift-off | `02 02 01 88 PP` | `02 02 01 08 PP code` | 87 = 0.7 mm, 01 = 1 mm, 02 = 2 mm |
| angle snap | `02 02 01 84 PP` | `02 02 01 04 PP 0/1` | emulator only |
| motion sync | `02 02 01 89 PP` | `02 02 01 09 PP 0/1` | |
| ripple | `02 02 01 8A PP` | `02 02 01 0A PP 0/1` | |

Cable: 125–1000 Hz; receiver: up to 8000 Hz.

## Never sent

- the bootloader: `02 01 00 00 B0`, and every category `B0` command;
- the per-profile reset `02 01 00 0D PP` (erases the profile);
- no factory reset or pairing command is documented anywhere.

## Not supported yet

Lighting (modes, brightness, stage colours — the colour read layout is
unknown, and the R5 refuses reads of the DPI indicator and "hyper", so a
backup could not hold them), buttons, macros, competitive mode.

## Sources

- Dorsal — <https://github.com/Zelozzzz/dorsal> (MIT): `docs/PROTOCOL.md`,
  `docs/MICE.md`, `src/dorsal/{models,protocol,device,onboard,macros}.py`,
  `tools/virtual_mouse/RESULTS.md`.
- OpenMouse mouse-protocol — <https://github.com/OpenMouse-Project/mouse-protocol>
  (**AGPL-3.0: facts only, no code**): `src/lamzu/`, `src/drivers/lamzu/`,
  `src/compx/codec.ts`, PRs #141 and #142.
