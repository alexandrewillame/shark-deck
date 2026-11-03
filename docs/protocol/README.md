# Attack Shark protocol notes

Everything here was recovered from **files that ship with the vendor software**
— no black-box work beyond the one prior Frida capture in
[`../reverse-engineering/`](../reverse-engineering/) (originally the Python
switcher's `capture/` folder).

## Provenance levels

| Tag | Meaning |
|---|---|
| `verified-capture` | Confirmed against real USB traffic. Safe to rely on. |
| `ported-from-vendor` | Command numbers / frame layout copied verbatim from the vendor JS. The bytes are almost certainly right; the trailing checksum is not yet independently confirmed. |
| `inferred` | Educated reconstruction. Backed up before write, read back after. |

## Sources

- `…/Attack Shark Driver v4/resources/app/dist/js/` — **unpacked** Electron
  renderer. Drives the keyboard over WebHID. `index.b078bf5f.js` holds the
  device table + transport + `CheckSumType {Bit7, Bit8, None}`; `5e635fe2.js`
  is the magnetic-keyboard class (R85HE); `438d24dc.js` is the keyboard base.
- `…/ATTACK  SHARK MOUSE HUB/driver_sensor.h` — plaintext DPI→register tables
  and `SUPPORT_*` sensor-capability macros.
- `…/ATTACK  SHARK MOUSE HUB/usersetting/Config.ini` — declarative per-model
  capability DB (DPI range/grades, button counts, sensor id, battery curve).

- **<https://qmk.top> ("GearHub-V5")** — the vendor's own WebHID configurator,
  one content-hashed bundle, no install needed. The best keyboard source we
  have: unlike Driver v4 (whose renderer hands a checksum-LESS payload to the
  native gRPC service) every byte the device sees is built in JavaScript, so it
  contains the framing, the checksum arithmetic, the full 54-command table, the
  magnetic parameter model, and the key layouts. `npm run extract:qmk`.

  Its `___encodeCmd` independently confirms the `compx-fea` checksum:
  `r[7] = 255 - (sum(r[0..6]) & 255)` over the payload, which is our `k = 8`
  once the leading report id is counted (Bit8 -> `k = 9`). 33 of the 35 entries
  in the hand-built `KB_CMD` matched it exactly on first comparison;
  `src/main/devices/drivers/kb-commands.test.ts` locks that agreement.

  Two caveats. Its device table holds ~38 boards and **no Attack Shark models
  at all** (rongyuan, Hator, JINGSU, akko, 腹灵, URX, XINMENG…), so layouts and
  per-model capabilities for the Attack Shark line still come from Driver v4's
  368-row table; for an unknown board qmk.top falls back to a generic
  descriptor, which is why it can still drive one. And it is a **different
  device generation** from Driver v4: `SET_SKU` (80) / `GET_SKU` (208), which
  `KB_CMD` carries from the `5e635fe2` generation, are
  `FEA_CMD_MOUSE_SET_KEYMATRIX` / `..._GET_KEYMATRIX` in qmk.top's table. No
  driver method sends them, and none should without a capture — a stray 80 is a
  cross-family write.

Re-extract after a vendor update with `npm run extract` and review the diff.

## Mouse — Compx 8K dongle (V8), `3554:F517`

Full detail + provenance: [`../reverse-engineering/FINDINGS.md`](../reverse-engineering/FINDINGS.md).
Two captures: 2026-08-13 (profile switching), 2026-08-30 (full feature sweep,
replies included — `session-v8.jsonl`).

- **Matching a `0x08` reply.** Every region-A offset is read with the same
  command byte, so the command byte alone does not identify an answer — a reply
  echoes its own offset at bytes 3-4 and its length at byte 5, and both must be
  checked. Windows delivers input reports to *every* open handle, so the vendor
  Hub running alongside is enough to put a foreign `0x08` reply in the queue,
  and accepting it produces a spurious "did not read back as written" on a
  write that landed.
- Vendor collection: `MI_01` **Col05**, usage page `0xFF02` / usage `0x02`,
  17-byte `WriteFile`/`ReadFile` reports (no feature reports). The USB-C cable
  adds `Col08` but the Hub keeps using Col05 — wired is not a separate path.
- Checksum: `(0x55 - Σ(bytes[0..15])) & 0xFF`. **verified**, both directions.
- **Scalar values carry a companion byte** `(0x55 - value) & 0xFF` right after
  them (a per-field check, same rule as the frame checksum). A 1-byte setting is
  written as 2 bytes; RGB as `r g b (0x55-r-g-b)`.
- `08 0F 00 00 00 01 <idx0>` — set active profile, 0-based. **verified**
- `08 0E` — get active profile (reply byte 6 = idx0). **verified**
- `08 03` — status / liveness poll, reply `08 03 00 00 00 01 <link> b3 71 3e …`.
  **verified.** `link` was `01` with the mouse on; some frames read `00` while it
  was powered off in the `11_*` steps — first evidence it tracks the wireless
  link, but the dongle keeps answering on its own, so treat "no reply" and
  "`link==0`" the same. `b3 71 3e` is a stable stats triplet.
- `08 04` — battery poll, reply `08 04 00 00 00 02 <pct> <b7> <mv_hi> <mv_lo>`.
  **verified shape.** `pct` = raw percent; derive the shown value from
  `BATTERY_CURVE` (`src/shared/mouse-options.ts`) via the big-endian millivolts.
  `b7` toggled `00`/`01` between otherwise-identical frames as the session went
  wired — a **candidate charging / on-cable flag**, not confirmed.
- `08 07 00 <off_hi> <off_lo> <len> <bytes…>` — **write setting**. **verified.**
  Offset big-endian. This is how *every* DPI / poll / sensor / LOD / button /
  DPI-LED / macro value is written — **not `0x09`**. Block map below.
- `08 08 00 <off_hi> <off_lo> <len>` → reply `08 08 … <len> <bytes…>` — read
  setting / block. **verified**, replies now captured. Offset big-endian, `len`
  ≤ 10. The Hub's full sweep is in
  `../reverse-engineering/v8-vendor-block-map.json`; region A is 216 bytes.
- `08 09 00 00 00 00 …` — **restore factory defaults**. **verified** (sent once,
  only on Restore Defaults). The current driver's `CMD.WRITE_BLOCK = 0x09` is a
  bug — that frame factory-resets the mouse.
- `08 16 …` — long-distance mode (`CS_UsbFinder_SetLongRangeMode`), `0|1`.
  **verified.** A dedicated command, not a `SENSOR_FLAGS` bit.
- `08 2C 00 00 00 0a <led1> <led2> <led3>` — **receiver LED indication** (SET),
  ONE frame for all three physical LEDs. **verified** the command; the per-value
  meanings still need the hardware checklist (three vendor tables + the capture
  step names disagree).
- `08 2D 00 00 00 00` — **receiver LED indication (GET)**, answering
  `08 2d 00 00 00 0a <led1> <led2> <led3>`. **verified on hardware 2026-09-07**
  by a write-then-read round-trip. This is the read `0x2C` does not have: a
  zero-length `0x2C` probe returns the generic ACK (`08 2c 01 …`, declared
  length 0) every time, and its len-`0x0a` read shape draws no reply at all.
  Accept a `0x2D` reply only when byte 2 is not `0x01`, it declares at least 3
  bytes, and all three are valid indication values — it can answer with the
  generic ACK too.
- `08 05` enter pairing (`…EnterDonglePairOnlyCid`). **verified.**
- `08 06` read pair status (`…ReadDonglePairStatus`, ~1 Hz poll). **verified as
  a query only — the receiver never answers it** (17 writes, 0 replies in the
  capture). Pairing completion is therefore probed rather than polled: `0x03`
  byte 6 (the mouse's RF-active bit) corroborated by a `0x04` battery reply,
  which only the mouse can produce. `inferred` for the unpaired case
  specifically — the capture proved *powered-off* drops the bit, not
  *unpaired*. See `getPairingStatus` in `compx-mouse-8k.ts`.
- `08 12 00 00 00 00` → `08 12 00 00 00 02 <major> <minor>` — **the mouse's own
  firmware version. verified-capture + hardware 2026-09-08.** `03 03` = v3.03,
  hex digits read as decimal. The **mouse** answers it, so it works over the
  2.4 GHz link as well as on the cable — this is what the vendor's
  `CS_UsbFinder_GetVersion` wraps (its `0x303` return came through a *dongle*
  path). A dozing mouse does not reply at all, whereas the dongle answers its
  own commands (`0x11`, `0x13`, `0x14`, `0x1A`) with the generic ACK regardless:
  accept a reply only when byte 2 is `0x00`.
- The **receiver's** firmware is separate — `bcdDevice` from the USB device
  descriptor of whichever endpoint enumerated. Over a dongle the two genuinely
  differ (`0x300` receiver vs `0x303` mouse on the reference unit).
- `08 02 00 00 00 01 01` — *not* the firmware version, despite the name in the
  vendor map. **Carries no version, at any selector or length**
  (hardware-probed 2026-09-07): selectors `00`/`01` echo the query, `02`–`05`
  answer the generic ACK. Its wire-level sibling `CS_UsbServer_ReadVersion`
  came back empty in the capture too. Do not decode it.
- `08 01 00 00 00 08 <4 bytes>` — session handshake on connect/pair/plug. Reply
  tail `7c 05 05` is constant. SharkDeck omits it and still works.
- `08 15` / `08 17` / `08 19` — config reads whose meaning is still open
  (`0x14`/`0x15` are the DPI-stage colour table; `0x19`'s payload is at byte
  2). `0x2D` used to be listed here; it is the receiver-LED GET above, and
  `0x12` is the firmware version above.

### Region-A block map (per-profile, `0x0000`–`0x00D8`) — **verified 2026-08-30**

Content follows the active profile at fixed offsets (regions B/C do not).
Written with `0x07` (+ companion byte per field), read with `0x08`.

| Off | Field | Off | Field |
|---|---|---|---|
| `0x00` | poll-rate bitmask | `0x4C` | DPI-LED effect (0/1/2) |
| `0x02` | DPI stage count (1–6) | `0x4E` | DPI-LED brightness (0–255) |
| `0x04` | active DPI stage | `0x68` | button 3 action |
| `0x08` | 20K-FPS scan | `0x6C` | button 5 action (+fire count/interval) |
| `0x0A` | LOD wire value | `0x70` | button 4 action |
| `0x0C` | DPI stage 1 register (4 B, `reg=dpi/50−1`) | `0x74` | button 6 action |
| `0x10` | DPI stage 2 register (→ `0x14`,`0x18`…) | `0xA9` | debounce (ms) |
| `0x2C` | DPI stage 1 colour (RGB) | `0xAB` | Motion Sync |
| `0x30` | DPI stage 2 colour (→ `0x34`,`0x38`…) | `0xAD` | sleep timer |
| | | `0xAF` | angle snapping |
| | | `0xB1` | ripple control |
| | | `0xB9` | sensor mode (0 LP / 1 HP) |
| | | `0xBD` | mouse angle mode (signed °, −30..30) |

Region B (`0x0100`–`0x031F`): extended button payloads (combo/multimedia HID
usages at `0x01A0`+, per button). Region C (`0x0480`–`0x19AF`, 16×`0x180`):
**macro storage** — name + step records, flushed on macro *assign*.

- **Option sets** (`src/shared/mouse-options.ts`, `ported-from-vendor`): LOD
  `0.7→3 1→1 2→2`; poll bitmask `125→8 250→4 500→2 1000→1 2000→16 4000→32
  8000→64` (both confirmed by capture); sensor mode `LP=0 HP=1`.
- **Mouse angle mode** is `0xBD`, a signed byte (two's complement, −30..30),
  written with the ordinary `0x07` + companion encoding — `verified-capture`
  2026-09-10, from hooking the Hub's writes while its slider moved
  (`capture-mouse.py --angle`). There is no separate on/off bit: the vendor UI
  is a slider only, and "off" is 0°, so the app derives its own toggle from
  whether the angle is non-zero.
- **Not on the V8** (no vendor control — do not model): body light strip,
  Highest-performance timeout, DPI dynamic sensitivity, macro export/import.
- Follow-up for the app is listed at the end of `FINDINGS.md`.

## Keyboard — Compx `FEA_CMD_*` family (R85HE), `3151:5029`

Full write-up: [`../reverse-engineering/FINDINGS-R85HE.md`](../reverse-engineering/FINDINGS-R85HE.md)
and the deeper reference [`keyboard-compx.md`](keyboard-compx.md).

- Vendor collection: **`MI_02`** (not `MI_01` — that carries the consumer /
  system / NKRO / mouse / vendor sub-collections), interface 2, usage page
  `0xFFFF` / usage `0x02`, **feature reports**, 65-byte report (id + 64).
- **Wired only** — `GET_RF_VERSION` returns nothing, so no battery.
- **Frame — `verified-capture`:** `[reportId 0, CMD, checksum, ...args]`. The
  checksum is at **byte 2**, `(0xFF - Σ of every other byte) & 0xFF`
  (`ChecksumScheme` `compx-fea`). Args start at byte 3. Proven on the real
  device — a frame with the wrong byte-2 value is rejected. This is what the
  vendor's `CheckSumType.Bit7` enum actually computes; the old trailing
  `bit7`/`bit8` reconstruction in `checksum.ts` was never right.
- **Model identity:** ~99 keyboards share `3151:5029`. The `GET_USB_VERSION`
  (143) reply carries the vendor model `id` at bytes [2..3] LE (0x0c33 = 3123
  for the R85HE) and the firmware uint16 at [8..9] LE (0x0511 = 1297).
- Command numbers (from `5e635fe2.js`) — see `compx-keyboard.ts` `KB_CMD` and
  the generated `shared/keyboard-options.ts`. `SET_REPORT=3` (poll),
  `SET_DEBOUNCE=6`, `SET_LEDPARAM=7`, `SET_SLEDPARAM=8`, `SET_KEYMATRIX=10`,
  `SET_FN=16`, `SET_MACRO=11`, `SET_SLEEPTIME=17`,
  `SET_MAGNETISM_CAL=28` / `..._MAXIMUM_CALIBRATION=30`,
  `SET_MULTI_MAGNETISM=101` (paged; 2 bytes/key LE, indexed by the raw
  `defaultMatrix` slot). `GET_*` reply data starts at byte 2.
- **Key matrix:** `defaultMatrix` in chunk `322d1e41.js` — 128 slots, 4
  bytes/slot, column-major (`slot = col*6 + row`), 79 keys. In
  `shared/layouts.ts` as `ANSI_79_SG9047`, each entry carrying its `slot`.
- **Still `ported-from-vendor` / to confirm** (run
  [`../reverse-engineering/CAPTURE-KEYBOARD.md`](../reverse-engineering/CAPTURE-KEYBOARD.md)):
  every `SET_*` frame layout + read-back, `GET_KEYMATRIX`/`GET_FN` args, the
  live `MULTI_MAGNETISM` page reads and DKS page-10 detail, whether
  `SET_PROFILE` persists per-slot state.
