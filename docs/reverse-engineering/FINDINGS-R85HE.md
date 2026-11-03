# Attack Shark R85HE — protocol findings

Two sources this session:

- **Static** — Driver v4's unpacked Electron renderer
  (`…/Attack Shark Driver v4/resources/app/dist/js`). Re-extract with
  `cd app && npm run extract:kb`; raw dumps in `app/scripts/_raw/kb-*.json`.
- **Live device** — direct `HidD_SetFeature` / `HidD_GetFeature` probing of the
  R85HE's vendor collection with `node-hid` (no vendor app, no Frida). This is
  how the checksum and the `GET_*` reply layouts below were recovered.

Provenance tags per `docs/protocol/README.md`.

## Device

| | |
|---|---|
| VID / PID | `0x3151` / `0x5029` |
| Connection | **wired only** — no dongle; `GET_RF_VERSION` returns nothing |
| Vendor config collection | `HID\VID_3151&PID_5029&MI_02`, interface **2** |
| Usage page / usage | `0xFFFF` / `0x02` |
| Transport | **feature reports** (`HidD_SetFeature` / `HidD_GetFeature`) |
| Report length | **65** bytes = report id `0x00` + 64-byte payload |
| HID `bcdDevice` | `0x0511` (= 1297, matches the firmware version in the `GET_USB_VERSION` reply) |
| Vendor model `id` | **3123** — carried in the `GET_USB_VERSION` reply, `[2..3]` LE |
| Vendor internal name | `ry5088_sg9047_1m_8k`, key layout `Common79_SG9047` |

`0x3151:0x5029` is shared by **~99** different keyboard models (TITAN68HE,
Shine60, R86PROHE, SG9000, …), each with its own key layout. VID/PID does **not**
identify the board — read the model `id` from `GET_USB_VERSION` (see below).

## Frame format — `verified-capture` (2515-frame iot_driver capture, 2026-08-30)

```
byte 0        : 0x00                report id
byte 1        : command
bytes 2..k-1  : arguments (6 slots for most commands; 7 for SET_LEDPARAM / SET_SLEDPARAM)
byte k        : checksum            k = 8 normally, 9 for SET_LEDPARAM (0x07) / SET_SLEDPARAM (0x08)
bytes k+1..   : bulk payload (magnetism values, RGB map, macro steps) — NOT covered by the checksum
```

**Checksum** `frame[k] = (0xFF - (Σ of bytes[1 .. k-1])) & 0xFF`. Only the bytes
*before* the checksum are summed; bulk payload after it is not. Examples from
the capture:

| frame (start) | check |
|---|---|
| `00 03 00 06 00 00 00 00 f6` (SET_REPORT 125 Hz) | 03+06+f6 = 0xFF |
| `00 04 03 00 00 00 00 00 f8` (SET_PROFILE slot 4) | 04+03+f8 = 0xFF |
| `00 65 00 00 59 00 00 00 41` `54 02` (per-key travel) | 65+59+41 = 0xFF, value 0x0254 sits after |
| `00 07 04 02 04 08 fa ff fa f3` (SET_LEDPARAM) | Σ(07..fa) = 0x0C, ck@**9** = 0xF3 |

Position-independent in principle (the firmware only needs the covered bytes to
sum to `0xFF`), which is why the earlier `node-hid` probe with the byte at
index 2 also worked. `ChecksumScheme` `compx-fea` in the code now matches
iot_driver: ck at 8, or 9 for the two LED SETs.

## SET commands — `verified-capture`

Decoded from the capture (`session-r85he.jsonl`). Travel/actuation values are
**`mm × 200`** (firmware ≥ 1280 → multiplier 200), 16-bit little-endian.

### `SET_REPORT` (0x03) — poll rate
`00 03 00 <idx> 00 00 00 00 ck` — `idx` at byte 3: `8000→0, 4000→1, 2000→2,
1000→3, 500→4, 250→5, 125→6` (a list index, matches the driver's map). Byte 2
is always 0. No read-back.

### `SET_PROFILE` (0x04)
`00 04 <slot-1> 00 00 00 00 00 ck` — slot 0-3 at byte 2. No read-back seen →
confirms `softwareProfiles` (nothing persists per slot).

### `SET_KEYMATRIX` (0x0a) — key / DKS / mode-tap / toggle remap
`00 0a <layer> <keySlot> 00 00 <flag6> <subIdx> ck <hi> <lo>` — remapped HID
code as 16-bit BE at bytes [9..10] (F12 = `00 45`). `layer` = 0x03 for base.
`keySlot` = the `ANSI_79_SG9047` slot. For a plain remap: one frame, `subIdx`=0.
For DKS: **four** frames, `subIdx` 0-3, one HID code per depth zone (`flag6`=1
on the last). Mode-tap: two frames. Toggle: one. Right-Ctrl (slot 71) → F12
was `00 0a 03 47 00 00 01 00 aa 00 45`.

### `SET_FN` (0x10) — Fn-layer remap
`00 10 00 00 <keySlot> 00 00 00 ck <hi> <lo>` — `keySlot` at byte **4** (not 3).
Assigning a macro also goes through `SET_FN` (`00 10 00 00 32 00 00 00 bd 09` —
key slot 50, macro ref 0x09 at byte 9).

### `SET_MULTI_MAGNETISM` (0x65) — magnetic per-key & bulk
Two forms share the command:

- **Single key** (the common case): `00 65 <page> 00 <keySlot> <flag5> 00 00 ck
  <valLo> <valHi>`. Byte 3 = `0x00`. Value 16-bit LE after the checksum.
- **Paged bulk** (global actuation): `00 65 <page> 01 <chunkIdx> 00 00 00 ck
  <56 payload bytes>`. Byte 3 = `0x01`. Page 7 = 3 chunks, pages 0/1 = 5 chunks,
  each 56 bytes = 28 × 16-bit LE values in `defaultMatrix` slot order.

**Pages** (corrected from the capture — the earlier map had 6 and 251 wrong):

| page | meaning | seen as |
|---|---|---|
| 0 | press actuation (travel) | `00 65 00 00 <slot> …` value = mm×200 |
| 1 | release point | `00 65 01 00 <slot> 01 …` |
| 4 | DKS actuation points | `00 65 04 00 09 … 8c 00` (0x8c=140=0.7 mm) |
| 5 | mode-tap data | `00 65 05 00 28 01 … 14 00` |
| 6 | **bottom dead zone** | `00 65 06 00 00 01 … 3c 00` (0x3c=60=0.3 mm) |
| 7 | **mode byte** | `00 65 07 00 <slot> … <mode>` — 0 normal, 2 dks, 3 mt, 4 tgl_hold, 5 tgl_dots, 7 snap/SOCD |
| 8 | DKS per-zone detail | `00 65 08 00 09 01 … 01 04 10 40` (4 bytes) |
| 9 | **SOCD / snap pairing** | `00 65 09 00 29 … 28` + `00 65 09 00 28 01 … 29` — each key's slot holds its partner's slot |
| 251 (0xfb) | **top dead zone** | `00 65 fb 00 28 01 … 50 00` (0x50=80=0.4 mm) |
| 252 (0xfc) | switch type | `00 65 fc 00 28 01 …` |

"Rapid trigger" in the vendor UI, applied to a **pair**, is SOCD: mode 7 on both
keys (page 7) + each key's partner slot in page 9.

### `SET_LEDPARAM` (0x07) — whole-board lighting  ·  `SET_SLEDPARAM` (0x08) — side
`00 07 <effect> <speed> <brightness> <option> <r> <g> <b> ck@9` — seven args,
checksum at byte **9**. `speed`/`brightness` are 0-4. `option` 0x08 = dazzle,
0x07 = plain. RGB straight (no white sentinel seen — white was `fa ff fa`, close
but not `FAF0FA`). Side is identical shape with cmd 0x08.

### `SET_USERPIC` (0x0c) — per-key static colour
`00 0c 00 ff <chunkIdx> <len> <last> 00 ck <payload>` — **7 chunks**, byte 5 =
that chunk's payload length and byte 6 = the last-chunk flag: chunks 0-5 are
`38 00` (56 bytes), chunk 6 is `2a 01` (42 bytes, commit).
**6 × 56 + 42 = 378 bytes = 126 slots × 3 RGB.** (An earlier note here said
"5 chunks × 56 = 280 bytes" — a miscount; the capture holds seven `0c` frames.)
The vendor reads the current map first with `GET_USERPIC` (0x8c), 6 chunks, and
sends no separate commit afterwards. Per-key lighting on this board is
**static colour only** — no per-key effect/speed.

### `SET_MACRO` (0x0b)
`00 0b 00 00 0x38 <lastFlag> 00 00 ck <payload>` — byte 4 = chunk length (56),
byte 5 = last flag. Payload starts with a step count then 4-byte steps
`[kind, value, msLo, msHi]`. One captured: `01 00 0c 80 5a 04 0c 00 80 05 …`.

### `SET_MAGNETISM_CAL` (0x1c=28) / `SET_MAGNETISM_MAXIMUM_CALIBRATION` (0x1e=30)
`00 1c 01 …` to start, `00 1c 00 …` to stop (same for 0x1e). The vendor then
floods `GET_MULTI_MAGNETISM` (0x65 GET / cmd 0xe5=229, args `fe 01 <chunk>`) to
watch progress — ~2000 frames in the capture's calibrate step.

## GET argument layouts — `verified-capture`

| GET | frame | note |
|---|---|---|
| `GET_KEYMATRIX` (0x8a=138) | `00 8a 00 ff <chunkIdx> <layer> 00 00 ck` | chunk 0-7, layer 0-3 |
| `GET_USERPIC` (0x8c=140) | `00 8c 00 ff <chunkIdx> 00 00 00 ck` | 6 chunks |
| `GET_MULTI_MAGNETISM` (0xe5=229) | `00 e5 fe 01 <chunkIdx> 00 00 00 ck` | |
| `GET_FN` (0x0d=13 in replies) | reply carries `[13,x,y]` special-key triples matching `defaultFnMatrix` | |

Reply data usually starts at **byte k+1** (right after the echoed query
checksum) — e.g. `GET_SLEEPTIME` pairs at byte 9, `GET_REPORT` poll code at
byte 9 — but the LED GETs write from byte 2. Per-command, as before.

## GET replies — `verified-capture` (layout), values are this board's current state

Reply frame is the same shape: `[00, cmd, ck, data…]`, data at byte 3.

| Command | # | Reply (trailing zeros trimmed) | Reading |
|---|---|---|---|
| `GET_USB_VERSION` | 143 | `00 8f 33 0c 00 00 00 00 11 05` | model id = `[2..3]` LE = `0x0c33` = **3123**; firmware = `[8..9]` LE = `0x0511` = **1297** |
| `GET_RF_VERSION` | 128 | *(no reply)* | wired board — no receiver |
| `GET_REPORT` | 131 | `00 83 7c 01` | poll-rate code at **`[3]` = 0x01** (→ 1000 Hz; the driver's `r[3]` guess had the right offset) |
| `GET_PROFILE` | 132 | `00 84 00 …` | active slot at `[3]` = 0 → slot 1 (driver currently reads `[2]`, which is the checksum — **bug**) |
| `GET_LEDONOFF` | 133 | `00 85 00 …` | lighting on/off |
| `GET_DEBOUNCE` | 134 | `00 86 00 …` | debounce ms at `[3]` (currently 0) |
| `GET_LEDPARAM` | 135 | `00 87 0d 04 01 00 00 c8 c8` | `[3]`=effect `0x0d`, `[4]`=brightness `0x04`, `[5]`=speed `0x01`, `[8..]`=colour `c8 c8 …` |
| `GET_SLEDPARAM` | 136 | `00 88 04 00 01 08 00 bf ff` | side-light: `[3]`=effect, `[4]`=?, `[5]`=brightness, `[6]`=speed, `[8..]`=colour |
| `GET_KBOPTION` | 137 | `00 89 00 00 01` | keyboard options bitfield |
| `GET_SLEEPTIME` | 145 | `00 91 00 00 00 00 00 00 00 3c 00 3c 00 90 06 90 06` | LE pairs from `[9]`: `0x003c`=60 s, `0x003c`=60 s, `0x0690`=1680 s, `0x0690`=1680 s (idle / deep, two contexts) |
| `GET_MACRO` | 139 | `00 ff ff ff …` | empty slot = `0xFF` fill |
| `GET_KEYMATRIX` | 138 | *(no reply to a bare query)* | needs a layer / page argument — TBD |

## Key matrix — `ported-from-vendor` (from chunk `322d1e41.js`)

The R85HE class (`Ry5088_sg9047_1m_8k`, extends `5e635fe2.js`) carries
`defaultMatrix`: **128 slots × 4 bytes**. Slot layout is **column-major**:
`slot = column*6 + row` for the 96-slot main block (16 columns × 6 rows), then
slots 96–101 hold auxiliary defaults (media keys) and 102–104 are `[19,3,x,0]`
"unused" markers.

82 physical positions carry a plain key (`[0,0,<hid usage>,0]`); one more
(`[10,1,0,0]` at slot 65) is the **Fn** layer key — 79 usable keys, matching
the `Common79_SG9047` name and the 737×281 UI grid in chunk `960d1a27.js`.

The decoded grid (slot in brackets):

```
Esc[0]  F1[6]  F2[12] F3[18] F4[24] F5[30] F6[36] F7[42] F8[48] F9[54] F10[60] F11[66] F12[72]
`[1]    1[7]   2[13]  3[19]  4[25]  5[31]  6[37]  7[43]  8[49]  9[55]  0[61]   -[67]   =[73]  Bksp[79] Del[85]
Tab[2]  Q[8]   W[14]  E[20]  R[26]  T[32]  Y[38]  U[44]  I[50]  O[56]  P[62]   [[68]   ][74]  \[80]    PgUp[86]
Caps[3] A[9]   S[15]  D[21]  F[27]  G[33]  H[39]  J[45]  K[51]  L[57]  ;[63]   '[69]   Enter[81]        PgDn[87]
Shift[4] Z[16] X[22]  C[28]  V[34]  B[40]  N[46]  M[52]  ,[58]  .[64]  /[70]   Shift[76] Up[82]
Ctrl[5] Win[11] Alt[17] Space[41]   Fn[65] Ctrl[71] Left[77] Down[83] Right[89]
```

The old `ANSI_75` layout in `app/src/shared/layouts.ts` was **physical/render
order** (82 entries), used directly as the wire index by
`compx-he-keyboard.ts`. That is wrong: magnetism / per-key-lighting / remap
writes are indexed by the **`defaultMatrix` slot** above. Replaced by
`ANSI_79_SG9047` (index = slot).

Full data: `app/scripts/_raw/kb-r85he-layout.json` (slot ↔ key ↔ pixel xy) and
`kb-r85he-matrix.json` (raw `defaultMatrix` / `defaultFnMatrix` /
`defaultFnMacMatrix`).

## Magnetism (MULTI_MAGNETISM, SET 101 / GET 229) — `ported-from-vendor`

From `5e635fe2.js` `getMultiMagnetismInfo` / `_decodeMagnetismKeyModes`.
Paged; each `GET` is `_getMulitMagnetismCMD(page, chunks)` → `chunks` reads of
~56 payload bytes; 2 bytes/key little-endian **indexed by the raw
`defaultMatrix` slot** (not a compacted key index). Values are `mm ×
multiplier`, multiplier from firmware version: `<768 → 10`, `[768,1280) → 100`,
`≥1280 → 200`. This board's firmware is 1297 → **multiplier 200**.

| page | chunks | meaning |
|---|---|---|
| 7 | 2 | mode byte per key: bit7 = rapid-trigger armed, bits0-6 = mode |
| 0 | 4 | press actuation (travel) |
| 1 | 4 | release point (normal mode) |
| 6 | 4 | third travel list — role unconfirmed |
| 2 | 4 | rapid-trigger press sensitivity (only if any key armed) |
| 3 | 4 | rapid-trigger release sensitivity |
| 4 | 4 | dynamic-keystroke actuation points (only if any key in DKS) |
| 10 | 8 | dynamic-keystroke per-zone key actions, 4 bytes/key |
| 5 | 2 | mode-tap data (only if any key in MT) |
| 9 | 2 | SOCD / snap-tap data (only if any key in SNAP) |
| 251 | 2 | top dead zone (only if supported) |
| 252 | 2 | installed switch id (only if switch is replaceable) |

Mode enum (`bits0-6` of the page-7 byte): `0 normal`, `2 dks`, `3 mt`,
`4 tgl_hold`, `5 tgl_dots`, `7 snap`.

`SET_MULTI_MAGNETISM` page write: header `[00, 101, ck, page, 1, chunkIdx,
lastFlag]` + 56 data bytes per chunk, `ceil(bytes/56)` chunks.

> Live read of pages 7/0/1/… did not return in this session — the vendor uses a
> 10-attempt / 10-read retry (`commonMsg(s, Bit7, 10, 10)`) and rapid probing
> wedged the endpoint (see below). Confirm the page reads during the guided
> capture (`CAPTURE-KEYBOARD.md` steps 06–10).

## Command set (5e635fe2 generation) — `ported-from-vendor`

Full list in `app/scripts/_raw/kb-fea-cmd.json` (`"5e635fe2.js"`). Commands the
repo's `KB_CMD` did **not** have:

| # | name | note |
|---|---|---|
| 28 | `SET_MAGNETISM_CAL` | per-key calibration |
| 30 | `SET_MAGNETISM_MAXIMUM_CALIBRATION` | full-travel calibration |
| 23 / 151 | `SET/GET_CMD_AUTOOSEN` | "auto-loosen" (auto-calibrate on connect?) |
| 80 / 208 | `SET/GET_SKU` | SKU string |
| 133 | `GET_LEDONOFF` | lighting master on/off |
| 34/39/40/41/48-50/172-178 | OLED / TFT / flash-chip | screen models only; R85HE has no screen |

`SET_KEYSTROKE` (35) / `GET_KEYSTROKE` (163) exist only in the **`c5a66cc9`**
generation, not the R85HE's class — the `keystroke` capability may have no
backing command on this board. Check during capture.

## How Driver v4 talks to the R85HE — **iot_driver via HidD_SetFeature**  ✓ confirmed

A verbose Frida diagnostic on `iot_driver_v215.exe` (2026-08-30, `/tmp/iotdiag`)
caught the traffic directly:

- **Transport**: `HidD_SetFeature` and `DeviceIoControl(IOCTL_HID_SET_FEATURE
  = 0xb0191)` for writes, `DeviceIoControl(IOCTL_HID_GET_FEATURE = 0xb0192)` /
  `HidD_GetFeature` for reads, on the R85HE MI_02 collection. That handle only
  resolves to `\Device\NNNNN`, which is why the earlier `hook-kb.js`
  (path-filtered on `vid_3151`) dropped every frame. The renderer's
  `navigator.hid.getDevices()` is genuinely **empty** — the WebHID code in the
  bundle is for other product lines; `webhid-capture.mjs` is a dead end here.
- **Frame** (captured, zero-param GETs): `[00, cmd, 0,0,0,0,0,0, ck@8, …]`.
  Checksum at **byte 8**; the firmware only checks `Σ(bytes[1..N]) ≡ 0xFF`.
  `00 88 …00 77` (GET_SLEDPARAM: 0x88+0x77), `00 89 …00 76` (GET_KBOPTION),
  `00 84 …00 7b` (GET_PROFILE). Position-independent — that's why the earlier
  ck@2 direct-probe also worked.
- **Replies** (0xb0192 OUT buffer): `GET_SLEDPARAM` → `00 88 04 00 01 08 00 bf ff`
  (effect 0x04 at [2], colour `bf ff` at [7..8]); `GET_KBOPTION` →
  `00 89 00 00 01`; `GET_PROFILE` → `00 84 03 …` (slot at [2]; byte 8 is the
  stale echoed query checksum). Data offsets are per-command.

→ Capture with **`capture-kb.py`** (Frida on `iot_driver_v215.exe`) — the hook
is fixed to match by frame shape (`00 <cmd> …`) instead of device path.
`webhid-capture.mjs` / `diag-kb.py` are kept only as a record of the WebHID
dead end.

## Vendor-app session notes (2026-08-30, capture-kb.py run — no frames, kept for the WebHID re-run)

The operator's notes on what each step actually did, so the WebHID capture can
be interpreted:

- Poll rate / profile steps: profile was already on slot 1.
- Global actuation max is **3.00 mm**, not 3.4 (UI cap for this board).
- Per-key "right arrow" actuation: was already 3.0 mm, set to **2.995 mm**.
- **Rapid trigger needs a key *pair*** — can't arm one key alone. Bound
  SPACE + B.
- **Top/bottom dead zone is a separate control from rapid trigger.** Defaults:
  top **0.000 mm**, bottom **0.300 mm**. Operator set top 0.400 / bottom 0.400,
  then bottom back to 0.300.
- DKS on keys A/B/C/D: the 4 action keys filled A,B,C,D; points = A press
  0.7 mm, B press 3.2 mm, C release 3.2 mm, D release 0.7 mm.
- Mod-tap: hold-trigger time **200 ms** (default).
- Toggle: key D set to **long-press** (not rapid-fire) → key D.
- Lighting steps were done on the **global / whole-board** effect, not per-key
  (the WebHID re-run has separate `13_perkey_light` / `13_global_light` steps).
- No "Restore Defaults" button was found.

### webhid-capture.mjs run 2 notes (also empty — console bug — kept for run 3)

Step numbers are the banner's `STEP i/39`:

- 10 (`05_profile_1`): profile 1 already selected, nothing to do.
- 17 (`07_key_esc`) done before 18 (`07_key_q`) — order swapped, fine.
- 21 / 22 (`08_rt_press` / `08_rt_release`): **there is no separate "rapid
  trigger sensitivity" control** — nothing to change on these steps.
- 29 (`11_remap_key`): remapped the spare key to **F12** (not F13).
- 33 (`13_perkey_light`): per-key lighting has **only "static colour"** — no
  effect/speed/direction per key. Operator read the layer, applied a few
  per-key colours, then did the global effects. So steps 33 + 34 carry mixed
  per-key-colour and global-effect traffic.

## Note — endpoint lockup

Rapid back-to-back `HidD_SetFeature` calls (dozens/sec during the checksum
sweep) put the MI_02 vendor endpoint into `HidD_SetFeature (0x79) semaphore
timeout` — it stops accepting feature writes while the keyboard keeps typing
normally. It did **not** recover within ~30 s; a **USB replug of the keyboard**
clears it. Pace vendor-channel writes (the vendor app does ~1 per UI action).
`dump-keyboard-state.mjs` / the app's own transport space their writes out.

## Still open (needs the guided vendor-app capture — `CAPTURE-KEYBOARD.md`)

1. `SET_*` frame layouts and their read-back — one write per setting, diffed.
2. `GET_KEYMATRIX` / `GET_FN` argument (layer/page) and reply layout.
3. Live `MULTI_MAGNETISM` page reads + the page-6 role + DKS page-10 encoding.
4. Whether `SET_PROFILE` persists per-slot state (→ `softwareProfiles` vs `profiles`).
5. `SET_MACRO` chunking. ~~`SET_USERPIC` per-key colour map.~~ **Resolved** from
   this capture's own seven `0c` frames: 7 chunks, per-chunk length at byte 5,
   last-chunk/commit flag at byte 6, 378 bytes total. The *read* is resolved
   too: 6 chunks x 64 data bytes from `frame[1]`, no command echo, no checksum
   — same family as `GET_KEYMATRIX` / `GET_MULTI_MAGNETISM`. See
   `../protocol/keyboard-compx.md`.
6. ~~`SET_MAGNETISM_REPORT` (27) live-stream input-report format.~~ **Resolved:**
   there is no input-report stream to decode — live travel is magnetism **page
   254**, read with the ordinary paged `GET_MULTI_MAGNETISM` frame (this
   capture's only such frame is page `0xfe`). Command 27 just arms it. Still
   open: what the page holds *while a key is held*, which needs step 18.
