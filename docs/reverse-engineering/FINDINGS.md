# Attack Shark V8 — protocol findings

Two capture sessions against `ATTACK  SHARK MOUSE HUB.exe`:

- **2026-08-13** — profile switching only. `capture.py` / `hook.js`. Raw:
  `session-v8-2026-08-13.jsonl` (also `session.jsonl`).
- **2026-08-30** — full feature sweep, ~117 steps, replies included.
  `capture-mouse.py` / `hook-mouse.js`. Raw: `session-v8.jsonl`. Pre/post device
  state: `v8-preimage.json` / `v8-postimage.json`. Analysis: `v8-analysis.txt`
  (regenerate with `analyze-v8.py`). Vendor config exports:
  `v8-config-export/Profile-{1..4}.bin`.

Canonical summary lives in [`../protocol/README.md`](../protocol/README.md); this
file is the detail and the provenance.

## Device

| | |
|---|---|
| VID / PID | `0x3554` / `0xF517` (Compx 8K wireless dongle) |
| Config collection | `MI_01`, **Col05**, usage page `0xFF02` / usage `0x02` |
| Report length | **17** bytes (byte 0 = report ID `0x08`, then 16) |
| Channel | `WriteFile` / `ReadFile` **output+input reports** — *not* `HidD_SetFeature` |
| Match on | `vid_3554` + `pid_f517` + `mi_01` + `col05`; never the instance suffix |
| Other MI_01 vendor collections | Col01 `ff05`, Col02 `ff03`, Col06 `ff04`, Col07 `ff06` — present, unused by the Hub in either capture |
| Wired interface | plugging the USB-C cable adds `MI_01 & Col08` (`vid=3554 pid=f517 up=0001 usg=0002 if=1`); the Hub keeps talking on the same **dongle** Col05, so wired mode is not a separate protocol path |

## Frame format — `verified-capture`

```
byte  0 : 0x08              report ID
byte  1 : command
bytes 2..: arguments (command-specific)
byte 16 : checksum = (0x55 - Σ bytes[0..15]) & 0xFF
```

Holds in both directions, every packet, both sessions.

### Scalar values carry a companion byte

Every 1-byte setting written through command `0x07` is stored as the pair
`<value> <(0x55 - value) & 0xFF>`, so its `len` is **2**. A 2-byte value
(DPI register, `len` 4) is `<a> <b> <?> <(0x55 - a - b) & 0xFF>`; a 3-byte RGB
(`len` 4) is `<r> <g> <b> <(0x55 - r - g - b) & 0xFF>`. The companion is a
per-field integrity check independent of the frame checksum — the same
`0x55 - Σ` rule, scoped to the field. This is the `01 54` / `06 4f` / `03 52`
pattern visible all through `v8-preimage.json`'s region A.

## Commands

| Cmd | Name | Direction | Provenance | Notes |
|---|---|---|---|---|
| `0x01` | session handshake | rd/wr | verified shape, semantics inferred | `08 01 00 00 00 08 <4 bytes> …`; sent on connect / pair / cable plug+unplug. Reply `08 01 00 00 00 08 <4 bytes> 7c 05 05 …` — the `7c 05 05` tail is constant. SharkDeck never sends it and still works, so it is not a gate for config I/O. |
| `0x02` | *(mis-named)* firmware version | rd/wr | **resolved — carries no version** | `08 02 00 00 00 01 01`. Answers only an echo (selectors 00/01) or the generic ACK (02–05), at every declared length — verified on hardware 2026-09-07. It is not the version command and never was; `0x12` is. |
| `0x12` | **mouse firmware version** | rd/wr | **verified-capture + hardware 2026-09-08** | `08 12 00 00 00 00` → `08 12 00 00 00 02 <major> <minor>`; `03 03` = v3.03, the same hex-digits-as-decimal scheme as everything else here. Answered by the **mouse**, not the dongle, so it works over 2.4 GHz — and a dozing mouse simply does not reply, while the dongle keeps ACKing its own commands. This is what `CS_UsbFinder_GetVersion` wraps. See *Still open* #1. |
| `0x03` | status / liveness poll | rd/wr | verified | Reply `08 03 00 00 00 01 <b6> b3 71 3e …`. `b6` was `0x01` while the mouse was **on** and `0x00` in some frames during `11_*` when it was **off** — first evidence the byte tracks the wireless link, but see *Still open*. `b3 71 3e` is stable (link stats?). |
| `0x04` | battery poll | rd/wr | verified | Reply `08 04 00 00 00 02 <pct> <b7> <mv_hi> <mv_lo>`. `pct` raw percent (`0x55` = 85 here). `b7` toggled `00`/`01` between otherwise-identical frames — candidate **charging / on-cable flag** (session went wired mid-run), not confirmed. `mv` big-endian millivolts. Derive percent from `BATTERY_CURVE`. |
| `0x05` | enter pairing | wr | verified | `08 05 00 00 00 02 00 00 7c`. DLL `CS_UsbServer_EnterDonglePairOnlyCid` (the `0x7c` is its first arg). |
| `0x06` | read pair status | **wr only** | verified (as a *query*) | `08 06 00 00 00 00`. DLL `CS_UsbServer_ReadDonglePairStatus`, polled ~1 Hz while pairing — and **never answered**: 17 writes in `09_pair_start`, zero replies (see the PAIR_STATUS entry in the command summary, the only command there with no `reply:` line). Do not build a completion check on it. SharkDeck probes the link instead — `0x03` byte 6 plus a corroborating `0x04`, both of which the capture shows resuming together when the link returns. |
| `0x07` | **write setting** | wr | **verified** | `08 07 00 <off_hi> <off_lo> <len> <bytes…>`. Offset **big-endian**. This — not `0x09` — is how every DPI / poll / sensor / LOD / button / LED / macro value is written. Block map below. |
| `0x08` | read setting / block | rd/wr | **verified** (shape) + **replies now captured** | `08 08 00 <off_hi> <off_lo> <len>` → reply `08 08 00 <off_hi> <off_lo> <len> <bytes…>`. Offset big-endian, `len` ≤ 10. The Hub's full address sweep is in `v8-vendor-block-map.json`. |
| `0x09` | **restore factory defaults** | wr | **verified** | `08 09 00 00 00 00 00 …`. Sent **once**, only in `08_restore_defaults`. **The current driver's `CMD.WRITE_BLOCK = 0x09` is wrong** — issuing this frame factory-resets the mouse. |
| `0x0E` | get active profile | rd/wr | verified | Reply byte 6 = 0-based slot. |
| `0x0F` | set active profile | wr | verified (2026-08-13) | `08 0F 00 00 00 01 <idx0>`. One write per switch, no preamble. |
| `0x14` | DPI-stage colour table (all stages) | rd | verified use | Reply `08 14 00 00 00 0a <count> <r g b>×3 …` — `02 ff0000 ff0000 ff0000` after a restore. Companion to `0x15`. |
| `0x15` | DPI-stage colour table (active?) | rd/wr | reply captured | `08 15 00 00 00 0a <count> <r g b>×3`. `count` was `01` vs `0x14`'s `02`. |
| `0x16` | long-distance mode | rd/wr | **verified** | `08 16 00 00 00 0a <0|1> …`. DLL `CS_UsbFinder_SetLongRangeMode` / `GetLongRangeMode`. A dedicated command, **not** a region-A bit. |
| `0x17` | ? | rd/wr | reply captured, all-zero | Read once per profile open. |
| `0x19` | ? | rd/wr | reply captured | `08 19 01 00 00 00 …` — payload byte at **[2]**, not the usual [6]. |
| `0x2C` | **receiver LED indication** | rd/wr | **verified** | ONE frame carries all three LEDs: `08 2c 00 00 00 0a <led1> <led2> <led3>`. Re-derived from the raw capture — byte 6 walked while stepping LED 1, byte 7 while stepping LED 2, byte 8 while stepping LED 3 (the earlier "`<A> <B> <C>` = indication / ledIndex / ?" reading was wrong). Stepping LED 1 through Off/ConnQuality/Battery/PollRate gave `00 / 01 / 02 / 03` — which **does not match** the display order of `RECEIVER_LED_INDICATION` in `mouse-options.ts`, and a fourth vendor table (`receiverStatusList`) disagrees again. Value meanings still need the hardware checklist. **The GET is `0x2D`, not `0x2C`** — see the next row. |
| `0x2D` | **receiver LED indication — GET** | rd | **verified (hardware, 2026-09-07)** | `08 2d 00 00 00 00` answers `08 2d 00 00 00 0a <led1> <led2> <led3>` — the same triple `0x2C` sets, in the same value space. Confirmed by round-trip: wrote `2,0,2` via `0x2C`, `0x2D` reported `2,0,2` back, restored. This is the read `0x2C` never had: a zero-length `0x2C` probe answers `08 2c 01 …` with declared length 0 — the generic-ACK shape — so the old driver's probe failed **100% of the time**, not intermittently, and the Receiver LED pane always showed a read failure on a cold start. The `0x2C` len-`0x0a` read shape draws no reply at all. `0x2D` can also answer with the generic ACK (`08 2d 01 00 00 00`), so accept a reply only when byte 2 is not `0x01`, it declares >= 3 bytes, and all three are valid indications. The Hub reads `0x2D` at `01_open_device` and at every profile open, and never reads `0x2C`. |

Commands `0x0A`–`0x2F` not listed above answered a bare probe with
`08 XX 01 00 00 00 …` (byte 2 = `01`, no payload) — an ACK, not data. See
`v8-direct-probe.json`.

## Block map — region A (per-profile config, `0x0000`–`0x00D8`)

Read with `0x08`, written with `0x07`. **Content follows the active profile** at
these fixed offsets (confirmed: switching profile 1→4 and re-sweeping returns
different bytes at the same addresses; regions B and C do not change). All
offsets **verified** from the 2026-08-30 session unless noted; each was proven by
the pre→post image diff landing exactly the written value.

| Offset | Field | Encoding (before companion byte) |
|---|---|---|
| `0x0000` | **Poll rate** | 1 B bitmask: 125→`08` 250→`04` 500→`02` 1000→`01` 2000→`10` 4000→`20` 8000→`40` |
| `0x0002` | **DPI stage count** | 1 B. The Hub only ever wrote 2 and 4, but `1` is accepted and reads back on hardware (2026-09-08), so the usable range is 1–6 and SharkDeck's one-stage setup is legal. |
| `0x0004` | **Active DPI stage** | 1 B, 0-based |
| `0x0008` | **20K-FPS scan** | 1 B bool |
| `0x000A` | **LOD** | 1 B wire: 1 mm→`01`, 2 mm→`02` (0.7 mm→`03` per `mouse-options.ts`, not re-hit here) |
| `0x000C` | **DPI stage 1 register** | 4 B `[lo, lo, hiWire, companion]`. **`register = round(dpi/50) − 1`** (so `dpi = (register+1)·50`, range 50–42000). `lo = register & 0xFF`; `hiWire = (hb<<2)\|(hb<<6)` where `hb = (register>>8) & 3` (0→`00`, 1→`44`, 2→`88`, 3→`CC`); `companion = (0x55 − lo − lo − hiWire) & 0xFF`. Decoded from `session-v8-verify.jsonl` (400→`07 07 00`, 12800→`ff ff 00`, 20000→`8f 8f 44`, 25950→`06 06 88`). |
| `0x0010` | **DPI stage 2 register** | 4 B, same encoding. Stages 3–6 at `0x0014`, `0x0018`, `0x001C`, `0x0020` (stride 4). |
| `0x002C` | **DPI stage 1 colour** | 3 B RGB |
| `0x0030` | **DPI stage 2 colour** | 3 B RGB. Stages 3–6 presumed `0x0034`, `0x0038`, … |
| `0x004C` | **DPI-indicator LED effect** | 1 B: 0 off / 1 steady / 2 breathing |
| `0x004E` | **DPI-indicator LED brightness** | 1 B, 0–`FF` |
| `0x0052` | DPI-LED — secondary flag | 1 B, written `01` alongside `0x004C` when effect set to steady; role unconfirmed |
| `0x0068` | **Button 3 action** | 4 B `<action> <param> <?> <cksum>` — DPI-switch→`02 01`, DPI-+→`02 02` |
| `0x006C` | **Button 5 action** | Firepower→`04 0A 03` (byte 2 = fire count) / `04 32 03` (byte 2 = `0x32` = interval 50) |
| `0x0070` | **Button 4 action** | Polling-rate-switch→`07 00 00` |
| `0x0074` | **Button 6 action** | Disable→`00`, restore/left-default→`02 01`, DPI-lock→`0A 0F`, combo→`05 00`, scroll-L/R→`03 01`, macro→`06 05 FE`. **"Configuration Switch" produced `00 00 00 55` (= Disable)** — the user reported not finding that option; treat that one value as suspect. |
| `0x00A9` | **Key response time (debounce)** | 1 B ms |
| `0x00AB` | **Motion Sync** | 1 B bool |
| `0x00AD` | **Sleep timer** | 1 B — min→`01`, max→`5A` (90). Unit ≈ the `PERFORMANCE_TIMEOUTS` scale, not seconds. |
| `0x00AF` | **Angle snapping** | 1 B bool |
| `0x00B1` | **Ripple control** | 1 B bool |
| `0x00B9` | **Sensor mode** | 1 B: 0 LP / 1 HP (Corded is cable-auto, no write seen) |

Region A is **216 bytes** (`0x00D8`) — the driver's `PROFILE_DUMP_LEN = 0x60`
is short by more than half.

### Region B — `0x0100`–`0x031F`

Extended button payloads. `0x01A0` (+`0x01AA`) took the HID-usage bytes for
button 6's **combo** and **multimedia** bindings (10-byte records, one region per
button). All `0xFF` when no button uses an extended binding. `RX.BASE = 0x0300`
in the current driver points into this all-`0xFF` area — **there is no receiver
state here**; receiver LED config goes through command `0x2C`.

### Region C — `0x0480`–`0x19AF`, 16 slots × `0x180`

**Macro storage** — confirmed. Recording a macro named "test" and assigning it
wrote, via `0x07` in 10-byte chunks starting at `0x0A80` (slot 4):
name `74 65 73 74` ("test"), then step records at `0x0A9E`+
(`06 81 04 00 …` = key-down/up + timing). Deleting the macro only cleared the
button binding at `0x01A0`, not the slot. Macro *recording* in the Hub produces
**no** device traffic — the whole macro is flushed on **assign**.

## Reply layouts

- `0x03` status: `08 03 00 00 00 01 <link> <s0> <s1> <s2>` — `link` = `01` up.
- `0x04` battery: `08 04 00 00 00 02 <pct> <flag?> <mv_be_hi> <mv_be_lo>`.
- `0x08` block: header echoes `00 <off_hi> <off_lo> <len>`, then `len` bytes.
- `0x12` `03 03` (now decoded — the mouse's own firmware, v3.03) · `0x17` zeros ·
  `0x19` payload at byte 2 · `0x2D` `03 00 02` (now decoded — the receiver LED triple).

## Vendor DLL → wire map (from `hook-mouse.js`'s auto-hooked `HIDUsb.dll`)

`CS_UsbServer_ReadConfig` / `ReadAllFlashData` → the `0x08` sweep ·
`CS_UsbServer_SetCurrentConfig` → `0x0F` · `CS_UsbServer_ReadDPILed` →
`0x08 @ 0x004C` · `CS_UsbServer_ReadBatteryLevel` → `0x04` ·
`CS_UsbServer_ReadVersion` / `CS_UsbFinder_GetVersion` → `0x02` ·
`CS_UsbFinder_SetLongRangeMode` → `0x16` ·
`CS_UsbServer_EnterDonglePairOnlyCid` → `0x05` ·
`CS_UsbServer_ReadDonglePairStatus` → `0x06` ·
`CS_UsbFinder_GetDongleIndicatorLed` / `GetDongleRGBBarMode` /
`Get4KDongleRGBValue` fired at device-open but emitted no `08` frame in this
capture (dongle-side state the Hub caches).

## Not present on the V8 vendor Hub (no captured writes — see below for the restored UI)

Body light strip / `LIGHT_MODES` (steps `05_light_mode_*`, `05_light_*` — "no
such effect"). `Highest performance` + its timeouts (greyed out).
`Mouse Angle Mode` — **zero captured writes, but read this as "never
exercised", not "not implemented"**. The Hub binary carries an `AngleSet`
slider with both `on_AngleSet_sliderMoved` and `on_AngleSet_valueChanged`
handlers, and the string table has `AngularMode` / `AngularModeTips` ("When the
mouse is moved at a certain tilt angle, it will still move in a straight
line"), so it does write on a drag. The 2026-08-30 sweep's step list simply has
no angle step — every step it does have (`anglesnap_*`, `ripple_*`, `mode_*`, …)
produced writes. There is no toggle, only the slider: "off" just means 0°.
**Resolved 2026-09-10: it is `0x00BD`** — see the dedicated section below for
the captured frames and why no candidate sweep could have found it.
`DPI Dynamic Sensitivity` (Classic/Natural/Jump/Custom ran but produced **zero**
device writes — Hub-side only, or needs an Apply the user didn't reach).
Macro export/import. Config *profile* export works (`Profile-*.bin`), import
untested.

### 2026-08-31 addendum — angle mode + DPI-LED speed restored speculatively

Per user request, `angleMode` was re-added to `v8.ts`'s capability list and
wired to a **speculative, unconfirmed** offset (`V8_BLOCK.ANGLE_DEGREES =
0xB3` in `shared/mouse-wire.ts`), chosen by a gap analysis over the complete
set of region-A offsets the Hub ever wrote across both capture sessions
(`session-v8.jsonl` + `session-v8-verify.jsonl`): `0xB3` sits in the same
odd-offset scalar run as `ANGLE_SNAP`/`RIPPLE`/`SENSOR_MODE`, holds a valid
all-zero `(00, 55)` value/companion pair in all four onboard profiles, and was
never touched by the Hub. Alternate candidates if it doesn't hold, in order:
`0xB5`, `0xBD`, `0xBF`, `0xC1` — do not use `0xB7` (=6) or `0xBB` (=10), both
have non-zero defaults so something else already owns them.

Same method for the DPI-indicator LED's new speed control: `V8_BLOCK.
DPI_LED_SPEED = 0x50` sits inside the DPI-LED field group (`0x4C` effect /
`0x4E` brightness / `0x50` / `0x52` flag) with a constant-across-profiles
`(03, 52)` pair never written by the Hub.

**Neither offset is trusted** — both writes go through the normal read-back
diff (`writeSetting`/`writeVerified`), so a wrong guess surfaces as
`verified: 'mismatch'` rather than a silent success, and both are flagged
`[SPECULATIVE]` in `scripts/verify-mouse.mjs`. Confirm on real hardware before
trusting either (see "Still open" #9 below).

## 2026-09-07 hardware sweep — the two speculative offsets

`scripts/verify-mouse.mjs` against a real V8 (24/24 passed). Three results that
change what the code should assume:

- **`0x50` (DPI-LED speed) accepts everything.** Written 0, 1, 2, 3, 4 and 5;
  every one read back. The live default on that mouse was `2` (the capture
  images show `3`). So the "an out-of-range value is why the write is rejected"
  theory is **wrong** — the byte is writable RAM at minimum. What is still
  unproven is whether the firmware *acts* on it: nobody has yet watched a
  breathing LED change pace. It therefore stays `inferred`, and the driver
  writes it via `writeSpeculative` so it cannot report a failure for the
  capture-verified fields beside it.
- **`0x52` (DPI-LED flag) sticks.** Written `01`, read back `01` — so the
  post-image reading of "the flag write did not survive" was a different
  effect, not a failing write. Whether it gates the LED is still unwatched, so
  `readDpiLed` reports the raw byte (`DpiLedSettings.flagRaw`, dev builds only)
  and never lets it override the effect byte: it reads `00` alongside
  `0x4C = 02` in every factory profile, so treating `0` as "off" would
  misreport a brand-new mouse.
- **`0x4E` (DPI-LED brightness) is 0..255, not 0..100.** Read back `135` on
  hardware. The `V8_BLOCK` comment saying `0..100` was stale; the converter
  (`DPI_LED_BRIGHT_MAX = 255`) was right.

## Still open

1. ~~**`0x02` firmware reply**~~ — **resolved 2026-09-08, and the 2026-09-07
   half of this entry was wrong where it mattered.**

   Still true: `0x02` carries no version field at any selector or length
   (selectors `00`/`01` echo the query, `02`–`05` answer the generic ACK at
   every declared length 1–10), and the vendor's own wire-level
   `CS_UsbServer_ReadVersion` returned an empty buffer in the capture (seq
   165/166).

   **Wrong: the conclusion that the mouse's firmware is unobtainable over the
   air.** It is command **`0x12`**, answered by the mouse itself —
   `08 12 00 00 00 00` → `08 12 00 00 00 02 03 03` = v3.03. Confirmed on
   hardware 2026-09-08 through a dongle whose own `bcdDevice` is `0x300`, so
   the two are demonstrably different numbers rather than one value read twice.

   The mistake was reading `CS_UsbFinder_GetVersion`'s `0x303` as `bcdDevice`
   and reasoning backwards from it: because the mouse on USB-C also reports
   `0x303`, the capture was taken to have been recorded with the cable in. It
   was not — the path argument to that call is
   `\\?\hid#vid_3554&pid_f517&mi_01&…`, i.e. **the dongle** (seq 200/205), and
   the `0x12` exchange sits right inside the call (seq 208 write / seq 210
   reply). The agreement between the two `0x303` readings is the *confirmation*
   that `0x12` reports the mouse, not evidence about which cable was plugged in.

   Implemented in `CompxMouse8K.getFirmware`: `bcdDevice` for the receiver,
   `0x12` for the mouse, and the first successful `0x12` cached for the life of
   the driver so a later doze keeps showing it.
2. **`0x03` byte 6 with the mouse fully off** — saw `00` in some `11_*` frames
   but the dongle keeps answering `0x03` on its own, so confirm `00` vs absent.
3. **`0x04` byte 7** as a charging flag — session went wired mid-run; needs an
   on-battery vs on-cable A/B with nothing else changing.
4. **`0x2C` value meanings** — which indication each wire value selects. The
   field roles are settled (byte 6/7/8 = LED 1/2/3) and the GET is now known
   (`0x2D`), so what remains is only the value-to-meaning checklist, which
   needs someone looking at the receiver: set LED 1 to each of 0..4 in turn and
   write down what it actually displays.
5. **`0x09` (restore) scope** — the pre→post diff shows profiles 3 & 4 and most
   of 1 & 2 unchanged after it fired, i.e. it did **not** wipe the block clean in
   this capture. Either it resets a subset, or the Hub re-pushes its cached
   settings afterward. Determine before relying on it.
6. **`0x17` / `0x19`** meanings. (`0x2D` is resolved — the receiver-LED GET;
   `0x12` is resolved — the mouse's firmware version, see #1.)
7. ~~**DPI register ↔ DPI value**~~ — **resolved 2026-08-30** (verify capture):
   `register = round(dpi/50) − 1`, `hb=(reg>>8)&3` smeared into the hi byte as
   `(hb<<2)|(hb<<6)`. Range 50–42000 DPI (vendor UI max is 42000, not 26000).
   Old note kept below for context — cross-reference `0x000C`/`0x0010` bytes with
   `driver_sensor.h` (PAW3950) to get the real CPI.
8. **`Profile-*.bin` format** — 10484-byte QDataStream-ish files with a `Compx` /
   `3950` header and a `28 d0` marker before the config body. Decoding them would
   give the entire region-A/B/C layout without more captures.
9. **`V8_BLOCK.ANGLE_DEGREES` (0xB3) and `DPI_LED_SPEED` (0x50)** — the
   round-trips now pass on hardware (2026-09-07, see the sweep section above),
   so what is left is the half a round-trip cannot answer: whether the firmware
   *acts* on either byte. Both accept and hold what is written, which is
   necessary and not sufficient. Run
   `node scripts/verify-mouse.mjs` with the mouse awake and confirm the
   `[SPECULATIVE]` write round-trips actually hold, and that the effect is
   real (angle compensation measurably shifts cursor direction; the
   breathing DPI-LED's pace visibly changes) — a byte reading back as
   written is necessary but not sufficient proof the firmware acts on it.
10. **Region-A stage/slot counts** — the DPI stage registers/colours and the
    button table are hand-documented here as 6 slots each (`stride 4` at
    `0x000C`/`0x002C`, `0x60`), matching the catalog's declared
    `spec.dpi.stages`/`spec.buttons`. Worth double-checking the full
    pre-image/post-image dumps for whether the firmware's actual region-A
    layout reserves more slots than the Hub UI exposes (would explain any
    leftover non-zero bytes past the 6th stage/button) before relying on the
    stride arithmetic for anything beyond what's already verified.

## What this changes in the app (follow-up)

`compx-mouse-8k.ts`: write command is **`0x07`** (offset BE, companion byte per
field), not `0x09`; `0x09` is restore-defaults (wire up `restoreDefaults()` to
it). Replace the `BLOCK` map with the table above; `PROFILE_DUMP_LEN` → `0xD8`.
`RX.BASE`/`RX.INDICATION*` → command `0x2C`, not a `0x0300` block.
Long-distance mode → `0x16`, drop it from `SENSOR_FLAGS`. Add offsets for
debounce (`0x00A9`), fire-key params (`0x006C`), DPI stage colours
(`0x002C`+). `pairing` → `0x05`/`0x06`. `macros` → region C via `0x07`.
`v8.ts`: drop `angleMode` unless a control is found; body lighting was never
declared (correct). `known-pids.ts`: add the wired `Col08` interface.

## 2026-09-08 session — the mouse's own firmware, and why a write "did not read back"

Three things, all on a real V8 over the 2.4 GHz dongle (the mouse was on
battery; the cable was not plugged in at any point).

### `0x12` is the mouse's firmware version, and it works wirelessly

Supersedes the half of *Still open* #1 that concluded otherwise. The command
was sitting in the capture the whole time, one line either side of the
`CS_UsbFinder_GetVersion` call it implements:

```
seq 208  write  08 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3b
seq 210  read   08 12 00 00 00 02 03 03 00 00 00 00 00 00 00 00 33
seq 209  dll    CS_UsbFinder_GetVersion  leave  ret 0x303
```

`03 03` -> v3.03, matching the `0x303` return exactly. The call's path argument
is the **dongle** (`pid_f517`), which is what makes this a wireless read rather
than a descriptor read — and it is also what invalidates the older inference
that the capture must have been taken on the cable.

Reproduced on hardware 2026-09-08 through a dongle whose own `bcdDevice` is
`0x300`: the two numbers differ, so `0x12` is demonstrably reporting the mouse
and not the receiver.

**How to tell a real reply from the dongle's ACK.** With the mouse dozing,
`0x12` draws no reply at all, while `0x11`, `0x13`, `0x14` and `0x1A` all come
back `08 xx 01 00 …` — the generic-ACK shape. That is the discriminator the
driver uses (byte 2 = `0x00` on a payload, `0x01` on an ACK), and it is also a
neat demonstration that `0x12` crosses the air while those do not.

### A `0x08` reply must be matched by offset, not just by command byte

The reported symptom was intermittent `Setting 0x2 did not read back as
written` / `DPI setting: sent, but the device read back a different value` on
DPI changes that had in fact applied.

Every offset in region A is read with the same command byte, and a read-block
reply echoes its own offset (bytes 3-4) and length (byte 5):

```
08 08 00 19 9f 0a ff ff ff ff ff ff ff ff ff ff 8d
      ^^ ^^ ^^  offset 0x199F, len 0x0A
```

`HidChannel.request` matched on the command byte alone, so **any** `0x08` reply
in the queue was accepted as the answer to whatever had just been asked. Two
things put a foreign one there: our own concurrent reads (a 22-frame `regionA()`
sweep beside a write's read-back), and the vendor Hub polling the same mouse —
Windows delivers every input report to every open handle, which is exactly the
situation the user is in whenever they open the Hub to check whether SharkDeck's
change landed. `DPI_STAGE_COUNT` is where it surfaced because `setDpiStages`
writes that offset first, while a sweep is most likely to still be in flight.

Fixed with an `accept` predicate on `request()`; the V8 driver passes an
offset+length check for every region-A read and every write read-back. A
rejected frame is treated as "no reply yet", so the right one can still arrive
inside the existing attempt budget.

Two hypotheses were tested first and **ruled out**, so they do not need
revisiting:

- *Write-settle timing.* 12 write/read-back round trips at `0x0000` with no
  delay: 12/12 matched immediately, and 12/12 matched again after 30 ms. (A
  settle-and-retry loop was kept anyway in `writeSettingRaw` — it costs nothing
  on the path that already works and `writeVerified` has had one since the
  Compx keyboard needed it — but it is not what was causing this.)
- *A stage-count lower bound.* `0x0002` was written `3`, `2`, `1`, `2`: all four
  accepted and read back. `1` is legal, so SharkDeck's single-stage setup is
  not the trigger and the "2–6" range recorded above was too narrow.

### `Mouse Angle Mode` — **located: `0x00BD`** (2026-09-10)

Settled by a targeted capture (`capture-mouse.py --spawn --angle` ->
`session-v8-angle.jsonl`, 329 records) that hooks the Hub's own writes while
its angle slider is dragged. One `0x07` write per drag, all to the same
offset, and nothing else in region A moved:

| slider | frame | value | companion |
|---|---|---|---|
| +15 | `08 07 00 00 bd 02 0f 46` | `0f` | `46` |
| +30 | `08 07 00 00 bd 02 1e 37` | `1e` | `37` |
| −15 | `08 07 00 00 bd 02 f1 64` | `f1` | `64` |
| −30 | `08 07 00 00 bd 02 e2 73` | `e2` | `73` |
| 0 | `08 07 00 00 bd 02 00 55` | `00` | `55` |

So: **signed byte, two's complement, range −30..30**, with the ordinary
`companion() = (0x55 − v) & 0xff` integrity byte — i.e. exactly what
`scalarBytes(angleToWire(deg))` already produced. `ANGLE_RANGE` is the vendor
slider's own range, now measured rather than assumed. Dragging the slider to a
value it already holds emits nothing, which is why the `04_angle_0` step is
blank.

`0xB3` — the earlier gap-analysis guess — was wrong, and no write/read-back
sweep could have found `0xBD` either: every unclaimed slot in that odd-offset
run (`0xB3`, `0xB5`, `0xBD`, `0xBF`, `0xC1`) accepts a write and reads it
straight back, so four of the five look identical to the right one. Watching
what the vendor tool writes is what separated them. `V8_ANGLE_OFFSET_CONFIRMED`
and `V8_ANGLE_CANDIDATES` are gone; the angle is now an ordinary verified
scalar folded into `worst()` like LOD.

**Note on the harness itself:** this capture only ran after fixing a silent
break — frida 17 removed `Module.findExportByName`, so all three agents threw
at load, installed zero hooks, and wrote an empty session file while the run
looked normal. See the "If the run records nothing" section in
`CAPTURE-MOUSE.md`.

### Two smaller confirmations from the same region-A dump

- **`0x4E` (DPI-LED brightness) really is 0..255** — read back `0xFA` (250),
  which a `0..100` field could not hold. Settles the stale comment for good.
- **`0x50` held `04`** after the previous session's sweep wrote it there, and
  `0x52` held `01`. Both still stick; both still have no observed effect.
