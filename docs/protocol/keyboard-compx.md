# Compx keyboard protocol (Attack Shark Driver v4 `FEA_CMD_*` family)

Reference for the `compx-keyboard` / `compx-he-keyboard` drivers. Provenance
tags per [`README.md`](README.md). Companion to
[`../reverse-engineering/FINDINGS-R85HE.md`](../reverse-engineering/FINDINGS-R85HE.md)
(how this was recovered) and
[`../reverse-engineering/CAPTURE-KEYBOARD.md`](../reverse-engineering/CAPTURE-KEYBOARD.md)
(how to finish it).

## Transport

| | |
|---|---|
| Collection | vendor `MI_02`, usage page `0xFFFF`, usage `0x02`, interface 2 |
| Reports | **feature** (`HidD_SetFeature` / `HidD_GetFeature`) |
| Length | 65 bytes = report id `0x00` + 64 payload |

Driver v4's Electron renderer does **not** touch HID. It sends
`driver.DriverGrpc/sendMsg { devicePath, msg, checkSumType, dangleDevType }`
over gRPC-web to `http://127.0.0.1:3814`, where `iot_driver_v215.exe` (Rust /
`tonic-web` / hidapi) inserts the checksum named by `checkSumType` and does the
HID write. Schema: [`iot_driver.proto`](iot_driver.proto).

## Frame — `verified-capture`

```
byte 0    reportId  0x00
byte 1    command
byte 2    checksum  = (0xFF - Σ of every byte except byte 2) & 0xFF
byte 3..  arguments / payload
```

No trailing checksum. Proven on the real R85HE: a `GET_MACRO` frame with the
correct byte 2 returns the slot contents; byte 2 off by one returns nothing.
`ChecksumScheme` `compx-fea` in `app/src/main/hid/checksum.ts`; vectors in
`checksum.test.ts`.

The vendor `CheckSumType` enum (`Bit7=0, Bit8=1, None=2`) names *which*
computation `iot_driver` applies — `Bit7` is the rule above. The old
trailing 7-/8-bit complements in `checksum.ts` were a pre-capture guess.

## Commands (`5e635fe2.js` generation)

`KB_CMD` in `compx-keyboard.ts`; the full extracted list is
`app/scripts/_raw/kb-fea-cmd.json` (`"5e635fe2.js"`). `GET_x = SET_x | 0x80`
roughly. Selected:

| # | name | notes |
|---|---|---|
| 1 | `SET_RESET` | restore defaults (arg `0x01`) |
| 3 / 131 | `SET_REPORT` / `GET_REPORT` | poll rate; reply code at data byte 0 (frame [3]) |
| 4 / 132 | `SET_PROFILE` / `GET_PROFILE` | active onboard slot. The write is read back against the GET, and the GET is the driver's liveness ping, so the slot flag itself is solid; what the board stores per slot is still unconfirmed - lighting at least cannot be slot-scoped, see below |
| 6 / 134 | `SET_DEBOUNCE` / `GET_DEBOUNCE` | ms, data byte 0 |
| 7 / 135 | `SET_LEDPARAM` / `GET_LEDPARAM` | main lighting; reply `effect, ?, ?, …, rgb` from byte 2 |
| 8 / 136 | `SET_SLEDPARAM` / `GET_SLEDPARAM` | side lighting |
| 9 / 137 | `SET_KBOPTION` / `GET_KBOPTION` | option bitfield |
| 10 / 138 | `SET_KEYMATRIX` / `GET_KEYMATRIX` | base-layer remap; GET needs a layer/page arg (TBD) |
| 11 / 139 | `SET_MACRO` / `GET_MACRO` | 256-byte payload, 56-byte chunks |
| 12 / 140 | `SET_USERPIC` / `GET_USERPIC` | per-key colour map |
| 16 / 144 | `SET_FN` / `GET_FN` | Fn-layer remap |
| 17 / 145 | `SET_SLEEPTIME` / `GET_SLEEPTIME` | uint16 LE pairs from data offset 7 (frame [9]): idle/deep × 2 contexts |
| 23 / 151 | `SET_CMD_AUTOOSEN` / `GET_CMD_AUTOOSEN` | "auto-loosen" (auto-calibrate?) |
| 27 | `SET_MAGNETISM_REPORT` | enable/disable the live per-key travel stream |
| 28 | `SET_MAGNETISM_CAL` | re-zero the rest point |
| 30 | `SET_MAGNETISM_MAXIMUM_CALIBRATION` | learn full travel |
| 80 / 208 | `SET_SKU` / `GET_SKU` | SKU string |
| 101 / 229 | `SET_MULTI_MAGNETISM` / `GET_MULTI_MAGNETISM` | paged, see below |
| 128 | `GET_RF_VERSION` | wireless boards only |
| 143 | `GET_USB_VERSION` | model id [2..3] LE, firmware [8..9] LE |

`SET_KEYSTROKE=35` / `GET_KEYSTROKE=163` exist only in the `c5a66cc9`
generation, not this one — the `keystroke` capability may have no backing
command on Attack Shark HE boards.

## MULTI_MAGNETISM pages — `verified-capture`

Cross-checked three ways: the 2515-frame capture, qmk.top's `PARAMETER_磁轴`
table (`npm run extract:qmk` -> `scripts/_raw/qmk-magnetism.json`), and a live
read of an R85HE (fw v5.11, model id 3123).

**Writes.** One key: `[page, 0, slot, commit]` + value. Whole page:
`[page, 1, chunkIdx, isLast]` + 56 data bytes.

**Reads.** `GET_MULTI_MAGNETISM` (229) with `[page, 1, chunkIdx]`. The reply
carries **no command echo and no checksum** — it is 64 raw data bytes starting
at `frame[1]`. Verified: eight consecutive reads after one page-0 request all
returned `00 90 01 90 01 …`, never `0xe5` in byte 1, and byte 8 is data.
Consequently these replies must NOT go through `HidChannel.request()`, which
filters on `reply[1] === command` and verifies a reply checksum; it rejects
every valid frame.

A page is **128 slots** wide (the firmware's matrix size), 64 data bytes per
chunk, so **`chunks / 2` = bytes per key**. Values are indexed by the raw
`defaultMatrix` slot (0..127), not a compacted key index. Travel is
`mm × multiplier`, multiplier by firmware version: `<768 → 10`,
`[768,1280) → 100`, `≥1280 → 200` (the R85HE is 1297 → 200).

One wire unit is therefore **0.005 mm** on the R85HE, and that is the real
resolution of every travel page. The settable ranges (mm), corrected against
a board and now hand-maintained in `src/shared/keyboard-travel.ts` rather than
typed into the extractor:

| setting | pages | min | max | step | default |
|---|---|---|---|---|---|
| actuation / release | 0, 1 | 0.1 | 3.4 | 0.01 | 2.0 (factory release reads 2.8) |
| rapid trigger press / release | 2, 3 | 0.005 | 2.0 | 0.005 | 0.2 |
| dead zone, top and bottom | 251, 6 | 0 | 1.0 | 0.01 | 0.3 |

The 2.0 mm actuation default is `verified-capture`: the live read below
decodes every populated key of an untouched R85HE to 2.0 mm on page 0 and
2.8 mm on page 1 (`KB_FACTORY_RELEASE_MM`). The table used to say 2.5 mm,
which was the vendor's string and never what a factory key holds. Reset
writes 2.0 mm to both pages (linked), so "at the factory settings" means
either release — see `isFactoryDefault` in the renderer.

Rapid trigger does **not** share the actuation range: it used to, which is how
its sliders came to offer 0.01-2.5 mm with a 1.5 mm default. A dead zone of 0
is a real setting, so only the actuation pages carry a 0.1 mm floor.

> **The rapid-trigger scale is `inferred`, not measured.** Pages 2 and 3 are
> all zeros in the only hardware snapshot this repo has, the vendor app the
> protocol was reverse-engineered from exposed no per-key RT sensitivity to
> capture, and the vendor does use different encodings on other pages
> (qmk.top writes DKS points as `(mm - 0.2) x multiplier` — its newer
> firmware family, not confirmed for this board, where SharkDeck writes plain
> `mm x multiplier`; the bottom dead zone is inverted).
> So "RT uses the same `mm x multiplier` as travel" is an assumption. It
> lives behind `rtUnitsPerMm()` in `compx-he-keyboard.ts` precisely so that
> settling it is a one-line change: a board reading exactly 2x what qmk.top
> shows for the same key means the RT wire unit is half a travel unit.
> Confirm with `npm run snapshot:kb` after setting a known value.

| page | chunks | B/key | meaning |
|---|---|---|---|
| 0 | 4 | 2 | press actuation |
| 1 | 4 | 2 | release point |
| 2 | 4 | 2 | rapid-trigger press sensitivity (only if any key armed) |
| 3 | 4 | 2 | rapid-trigger release sensitivity |
| 4 | 4 | 2 | dynamic-keystroke actuation points (only if any key in DKS) |
| 5 | 2 | 1 | mode-tap hold time (`ms / 10`) |
| 6 | 4 | 2 | **bottom** dead zone |
| 7 | 2 | 1 | mode byte per key — see below |
| 8 | 8 | 4 | dynamic-keystroke per-zone key actions |
| 9 | 2 | 1 | SOCD / snap-tap: each key's value is its partner's slot |
| 16 | — | 1 | all-key DKS trigger flags (`所有按键DKS触发标志`) |
| 251 | 2 | 1 | **top** dead zone — `unconfirmed`, see below |
| 252 | 2 | 1 | installed switch id (replaceable-switch boards) — see below |
| 254 | 4 | 2 | live per-key travel (`按键按压行程数值`) — see below |

The DKS zone flags are **written** to page 8 on this board — the vendor's own
write, captured — and **read** (`inferred`) from page 10, which Driver v4's
table lists and which answers with real structure where page 8 answers
nothing. See "DKS zone actions" below.

### The commit flag, and value width

Byte 4 of a single-key write (`00 65 <page> 00 <slot> <commit> …`) is a
**commit** flag, not a per-page constant: the vendor sets it on the LAST write
of a batch and 0 on every earlier one (`setDKSKeySimple` sends
`false, false, true`). The value is **as many bytes as the page is wide**
(`chunks / 2`) — writing 2 bytes to a 1-byte page puts a stray 0 into the next
slot.

### SOCD pairing (page 9) — `verified-capture`

A pair is two keys that each hold the other's matrix slot, both in snap-tap
(mode 7, see the mode byte). Verified end-to-end on an R85HE: writing the
pair produced `p7[A]=7 p7[D]=7`, `p9[A]=21 p9[D]=9` for slots 9 (A) and 21 (D).

SharkDeck writes a pairing as one batch carrying **both** keys, each with its
own mode byte (rapid trigger and full bottom-out bits intact) and its own
page-9 value; a key no longer paired gets `0xFF`. The driver refuses a batch
whose two halves do not name each other (`snapPairMismatch`). It used to write the partner's half itself, which
stamped one key's rapid-trigger bit over the other's mode byte.

**The unpaired sentinel is `0xFF`, not 0** — every unpaired key reads 0xFF, so
clearing a pairing by writing 0 would instead point the key at slot 0 (Esc).

### Mod-tap (page 5) — `verified-capture`

One byte per key, `hold_ms / 10`. Verified: 200 ms wrote `20`, with mode 3 in
page 7.

### DKS zone actions — written to page 8, read from page 10

**The write is `verified-capture`.** The vendor app configuring a DKS key on
this R85HE (`session-r85he.jsonl`, step `09_mode_dks`, slot 9) sends, in order:

```
00 0a 03 09 00 00 00 00 e9  00 04 00 00     SET_KEYMATRIX zone 0  (A)
00 0a 03 09 00 00 00 01 e8  00 05 00 00     zone 1  (B)
00 0a 03 09 00 00 00 02 e7  00 06 00 00     zone 2  (C)
00 0a 03 09 00 00 01 03 e5  00 07 00 00     zone 3  (D), commit
00 65 07 00 09 00 00 00 8a  02              page 7: mode 2 (dks)
00 65 04 00 09 00 00 00 8d  8c 00           page 4: the point, 0.7 mm x 200
00 65 08 00 09 01 00 00 88  01 04 10 40     page 8: zone flags, commit
```

`01 04 10 40` is one tap per action, one action per point (A, B, C, D) — the
packing below. The driver used to write the flags to page 10, and that write
was measured to change nothing; it now writes page 8 like the vendor.

**The read is `inferred`.** Page 8 answers no read on an R85HE (fw v5.11):
its only non-zero bytes sit at offset 7 of each chunk with values
17,16,…,10 — exactly `0xFF - (0xE5+0x08+0x01+chunk)`, our own query checksum
left in the buffer. Page 10 returns 512 bytes = 128 slots x 4, with `0xFFFF`
sentinels at slots 31/63/95/127 — real structure, which the driver decodes as
the flags. No capture shows the vendor reading either, so whether page 10
reflects a page-8 write is for the hardware check to show.

qmk.top's `PARAMETER_磁轴` also calls the flags page **8**; it carries no
Attack Shark board, being a newer firmware family, so that agreement is
suggestive rather than proof.

Each zone byte packs four 2-bit fields, one per trigger point (A press-start,
B press-end, C release-start, D release-end):

```
byte = a | (b << 2) | (c << 4) | (d << 6)
```

0 = nothing, 1 = fire here, 2/3 = held from here to a later point (`A-BS`,
`B-CS`, `C-DS`, `A-CS`, `A-DS`, `B-DS`). Codec and validity rules in
`app/src/shared/dks.ts`, ported from qmk.top's `ws` / `Lu`.

### Multi-frame `SET_KEYMATRIX`

A mod-tap or DKS key carries one binding per **zone**: one `SET_KEYMATRIX`
frame per zone, same slot, differing only in the zone index (frame byte 7),
with commit on the last frame sent — from the vendor's `setDKSKeySimple`,
which loops over its bindings. Each frame is byte for byte the single-zone
remap below with the zone byte set:

```
00 0a 00 <slot> 00 00 <commit> <zone> ck <quad: type sub a b>
```

Zone 0 is the key's own binding — what the Remap tab edits. A DKS key keeps
it there as its first action and sends **three** frames (actions 2-4, zones
1-3). A **mod-tap** key is the other way round: the firmware fires **zone 0
on a HOLD and zone 1 on a TAP**, so it sends **two** frames — the hold in
zone 0, the key's own binding moved to zone 1 as the tap
(`app/src/shared/key-zones.ts`). The DKS zone flags (page 8) are written after
the bindings, the vendor's order.

That mod-tap order is a hardware result, 2026-10-09 (`npm run verify:writes`,
step `mt`): with A's own binding left in zone 0 and Left Ctrl written to zone
1, page 7 = 3 and a 200 ms hold, **tapping A sent Ctrl and holding it repeated
`a`**. It contradicts the reading of the vendor capture below, which had the
tap in zone 0 — the capture records which keys went to which zone, not which
of them the operator meant as the hold.

Because a mod-tap key's own binding leaves zone 0, the driver puts it back
when the key leaves mod-tap — before the pages, for any key in a write that is
not mod-tap but whose recorded entry is (`releaseModTap`), and before a DKS
key's bindings (mod-tap to DKS). A remap of a mod-tap key goes to zone 1 (it
changes what the key types), and the base layer reads back with the tap in
place of the hold. A write to an onboard profile the board is not showing
(`keepZoneBindings`: the comparator's per-key copy, a profile copy) leaves
the bindings alone.

**Open: profiles.** SharkDeck writes the key matrix at layer 0 whichever
profile is active (below). If the board keeps a key matrix per profile, a
mod-tap key's bindings land on profile 1's; if it keeps one for all, a key
that is mod-tap on one profile types its hold on the others, where it is a
plain key. Check on hardware: mod-tap on profile 1, switch, press it.

The capture (`session-r85he.jsonl`) shows the vendor writing every zone,
zone 0 included:

- **mod-tap** (`09_mode_mt`, slot 40): two zone frames, commit on zone 1,
  then page 7 = 3 and page 5 = `0x14` (200 ms) with commit. Read at first as
  zone 0 = the tap; the hardware says zone 0 is the hold (above).
- **toggle** (`09_mode_tgl`, slot 21): zone 0 re-written with the key's own
  binding and commit, then page 7 = 4. SharkDeck does not re-send zone 0 for a
  toggle — the binding is unchanged — and the 2026-10-09 run confirmed the
  firmware does not need it.

Two differences from SharkDeck's frames are open questions for that check. The
vendor's layer byte is `03` where SharkDeck writes `00` — the doc above reads
it as the vendor's current profile — and its quad carries the usage at byte 1
(`00 04 00 00`), where SharkDeck's hardware-verified remap writes byte 2
(`00 00 04 00`), the layout the board's own factory table and `GET_KEYMATRIX`
use. The zone frames follow the verified remap; if a mod-tap or DKS key does
nothing on a board, the vendor's exact form is the next thing to try.

There is no read-back for zones past 0 that the app understands, so the
driver keeps what it wrote (`readKeyZoneBindings`, per model on this
computer). That record is what carries them elsewhere: a backup stores it
(`zone_bindings`) and a restore re-sends it for the keys the backup has in
Mod-tap or DKS, before the pages; a saved Actuation layout keeps the bindings
of its Mod-tap and DKS keys by position, written before its keys on apply.
An entry recorded the old way round (`[null, hold]`) is turned the right way
on apply and on restore, with the key's own binding as its tap.
Profile copy carries none: SharkDeck writes layer 0 whichever profile is
active, so the bindings are not the slot's — and a copy into another slot
leaves them alone. The backup sweep skips page 8
(the read returns our own checksum, which a restore used to write back as
DKS flags); a restore writes a DKS key's flags to page 8 from the page-10
read, last. `ported-from-vendor`; the frames are pinned in
compx-keyboard.test.ts and compx-he-modes.test.ts but not yet exercised on
hardware — Mod-tap and DKS are marked Experimental until they are.

### Profiles and what is slot-scoped

SharkDeck switches a keyboard profile with a single `SET_PROFILE` (see
`catalog/r85he.ts`), not by replaying settings. Two things are worth
recording about what the slot actually covers:

- **Slot-indexed on the wire:** the Fn layer (`SET_FN` byte 3 is the Fn
  profile) and the key matrix (`GET_KEYMATRIX` byte 5 likewise; the vendor
  puts its current profile in `SET_KEYMATRIX`’s layer byte, where SharkDeck
  writes a literal).
- **Not slot-indexed:** lighting. `SET_LEDPARAM` (7), `SET_SLEDPARAM` (8)
  and `SET_USERPIC` (12) carry no slot byte at all. Whether the firmware
  scopes lighting to a profile internally is unknown and unobservable from
  the frames; SharkDeck simply does not write lighting during a switch.

### Mode byte (page 7)

```
bit 7  rapid trigger armed      — INDEPENDENT of the mode in the low nibble
bit 6  full bottom-out
0..3   0 normal · 2 dks · 3 mt · 4 tgl_hold · 5 tgl_dots · 7 snap
```

7 is snap-tap, the key pressed last winning while both are held —
`verified-capture`, and the only snap-tap value the R85HE's vendor app
offers. qmk.top, a newer firmware family, names three more: 8
`snap-neutral`, 9 `snap-priority`, 10 `snap-overridden` (who wins). **They do
nothing on an R85HE**: tried on hardware 2026-10-09 (`verify-he-writes`,
"neither" 8/8 and "A wins" 9/10), page 7 read back the values and the pair
behaved as plain keys. SharkDeck reads 7-10 all as snap-tap — they used to
decode as "normal", which made a pair read back as two plain keys — and
always writes 7, re-sending it for a snap-tap key even when the read-back
looks unchanged, so a key left at 8-10 is put right.

The mode is the low **nibble**, not the low seven bits — masking with `0x7f`
leaves bit 6 in place and makes a full-bottom-out key decode as an unknown
mode. Rapid trigger being a bit, not a mode, is the correction to the earlier
reading that RT "is SOCD on a key pair": a key can be snap/SOCD with or
without RT, and pages 2/3 hold its sensitivity.

### Live read from an R85HE (fw v5.11), for reference

| page | set | distinct |
|---|---|---|
| 0 press | 82/128 | 2.0, 1.0, 0.1 mm |
| 1 release | 82/128 | 2.8, 1.0, 0.1 mm |
| 6 dead zone bottom | 82/128 | 0.3, 0 mm |
| 7 modes | 0/128 | 0 (all normal, RT off) |
| 2, 3 RT | 0/128 | 0 (consistent with RT off) |
| 252 switch type | 0/128 | 0 |

Page 6 decoding to exactly `0.3 mm` — the vendor's own documented default
(`KB_TRAVEL_RANGE.deadzone.default`) — independently confirms both the ×200
multiplier and the 2-byte width.

### Page 254 — live per-key travel — `verified-capture` (frame)

The live travel view is **an ordinary paged read of page 254**, not a pushed
input report. Three sources agree:

- the *only* `GET_MULTI_MAGNETISM` frame anywhere in the Driver-v4 capture is
  page `0xfe` — `00 e5 fe 01 <chunkIdx> 00 00 00 ck` (`FINDINGS-R85HE.md`'s GET
  argument table), which the vendor floods to watch travel while calibrating;
- qmk.top's `PARAMETER_磁轴` names page 254 `liveTravel` and builds it with the
  standard `[GET_MULTI_MAGNETISM, page, 1, chunkIdx, 0, 0, 0, ck]` get frame
  (`scripts/_raw/qmk-magnetism.json`);
- the page table above gives it 2 bytes/key, so 128 slots = 256 bytes = **4
  chunks** of 64.

`SET_MAGNETISM_REPORT` (27) still arms it: qmk's `switchTravelSimulation` sends
`[27, enable]` and then sleeps before doing anything else, so settle after the
enable rather than reading straight into it.

`CompxHeKeyboard.readTravel()` reads it through the same `readMagnetismPage()`
as every other page. It previously polled `HidChannel.readStream()` — an
input-report read with a feature-report fallback — whose byte layout had never
been captured; on a feature-report-only vendor collection like the R85HE's
MI_02 that only ever returned stale endpoint bytes, so the monitor showed
nothing. **`unconfirmed`:** what the page holds *while a key is held* has still
not been observed on hardware.

**Slot 126 is not a key** — observed on an R85HE fw 5.11 (2026-09-22 report).
The page has 128 slots, but the family's matrix is 126 (21 x 6, the size of
the per-key LED map), and slot 126 holds a constant non-sentinel word at rest.
Its value sat between the default 2.5 mm actuation and the 4.2 mm sanity
gate, so it was reported as a key held down permanently, and the Test view
showed a bare "126". Its meaning is **unknown** (trailer, counter and
calibration word are all candidates). `readTravel()` now reports **layout
slots only** (`slot ?? layout index`, as `readMagnetic()` does) and applies the
sanity gate after that filter — an off-layout word above 4.2 mm would
otherwise mark every sample incomplete. The first time an off-layout slot
reads active, its raw value goes to the developer frame log
(`readTravel: page 254 slot N … reads 0x…`), so its meaning can be pinned
down from a capture.

### Page 252 — installed switch id — `inferred`

The id space is `ported-from-vendor`: qmk.top compiles a TypeScript enum
(`t[t.<name>=<id>]=...`) of 127 magnetic switch models with explicit,
**sparse** ids up to 155, plus a name -> colour map that is what tints its
board. Both extracted into `src/shared/keyboard-switches.ts`.
`CompxHeKeyboard.readSwitchTypes()` / `setSwitchTypes()` read and write the
page through the same `readMagnetismPage()` / `writeMagKey()` as every other.

Three things are worth being precise about.

**The id space is not the choice list.** qmk.top offers each board only its own
`other.supportedSwitchTypes`, and across its whole device table that is almost
always **six** entries: the board's stock switch plus 磁玉 / 磁玉pro /
磁玉gaming / 天王 / 万磁王. Offering all 127 would let a user write a magnet
curve the firmware has no table for. Ids 0-5 are that canonical six
(`SWITCH_CHOICES_DEFAULT`), and the R85HE declares them.

**Value 0 is "this model's stock switch", not "unset".** Id 0 names 高特 in the
enum, and qmk.top resolves a stored 0 through
`e === 0 ? this.___utils_getDefaultAxisType() : ...` — so on a board whose
stock switch IS id 0, "never assigned" and "Outemu" are the same reading. The
UI therefore renders a 0 as the first entry of the board's own list rather than
as a pseudo-model called "Factory". (The vendor's English catalogue renders
高特 as "Gateron", which is their mistranslation: Gateron is 佳达隆, which the
same bundle separately spells "Gateron Jade MAX". 高特 is Gaote — Outemu. The
app uses Outemu and keeps the Chinese name as the join key.)

**The R85HE does store this page — settled on hardware, after one wrong
conclusion.** An earlier read found 79 slots of zero and the post-write
read-back disagreed with what had just been written, which was written up here
as "this firmware keeps no switch-type table". That was wrong, and the way it
was wrong is worth keeping: the page had simply not committed yet.

Measured with `scripts/diag-switch-write.ts` (this one WRITES, and restores the
value it changed):

```
write slot 39 = 2
  +63ms   reads 1     <- setSwitchTypes' own read-back ran here
  +140ms  reads 2
```

So the board takes roughly 100-140 ms to commit page 252, and a check taken
immediately reports `mismatch` on a write that worked. `setSwitchTypes()` now
waits `SWITCH_READBACK_WAIT_MS` and retries up to `SWITCH_READBACK_TRIES` times,
stopping as soon as the page agrees; on the same hardware that turns the
reported outcome from `mismatch` into `match`.

The cost of getting this wrong was not a stray warning. The Switches view took
the mismatch as proof the firmware ignored the page, said so, and disabled its
own picker — leaving keys that HAD been reassigned with no way back. Read-back
timing is not a detail on a page that is written one key at a time.

`scripts/diag-switch-page.ts` (read-only) prints every slot not on the stock
switch, which is the quick way to check what a board actually holds.


### `GET_USERPIC` is in the no-echo family too

The per-key colour map read behaves like the other paged reads: **no command
echo, no checksum, 64 data bytes from `frame[1]`**, six chunks — 6 × 64 = 384 =
128 slots × 3 RGB bytes. qmk.top's `___cmdGetCustomLightLayout` confirms the
geometry independently (it reads six chunks, pads a missing one with
`new Array(64)`, and indexes colours at `slice(pos*3, pos*3+3)`).

So it must not go through `HidChannel.request()` either, and it must be paced.
Routing it through `request()` was doubly bad: the command-byte filter rejected
every chunk, and burning the full 3 × 6 attempt budget on each of six chunks
fired ~126 unpaced feature reports — squarely into the endpoint lockup
described in `FINDINGS-R85HE.md`, which stops the board accepting feature
writes until it is physically replugged.

### `SET_USERPIC` write — `verified-capture`

Settled directly from the seven frames in `session-r85he.jsonl`
(step `13_perkey_colour`), which is the authority — an earlier reading of
"5 × 56 = 280 bytes" was a miscount:

```
00 0c 00 ff 00 38 00 00 bc  <56 bytes>    chunk 0
00 0c 00 ff 01 38 00 00 bb  <56 bytes>    chunk 1
  …                                        chunks 2..5, all len 0x38
00 0c 00 ff 06 2a 01 00 c3  <42 bytes>    chunk 6 — len 0x2a, LAST = 01
```

| byte | meaning |
|---|---|
| 2 | 0 |
| 3 | `0xff` |
| 4 | chunk index, 0..6 |
| 5 | **this chunk's payload length** — `0x38` (56), `0x2a` (42) on the last |
| 6 | **last-chunk flag** — 0, and `1` on chunk 6 |
| 7 | 0 |
| 8 | checksum |
| 9..64 | payload |

**7 chunks, 6 × 56 + 42 = 378 bytes = 126 slots × 3 (RGB).** Byte 5 is a
length, not the constant `0x38` it looks like in chunks 0-5, and byte 6 is what
commits the transfer. Sending neither — a fixed `0x38` and a permanently-zero
byte 6 — is accepted frame by frame and applies nothing, which is exactly how
"painting a key does nothing" presented. `compx-keyboard.test.ts` locks all
seven headers (and their checksums) against the captured bytes.

No separate commit command follows: the vendor reads all six `GET_USERPIC`
chunks, writes the seven `SET_USERPIC` chunks, and moves straight on to
`SET_LEDPARAM`.

The vendor's captured frames are 67 bytes because `iot_driver` pads them; only
bytes 0..64 are meaningful, so a 65-byte report carries the declared 56-byte
payload exactly.

### Unsupported pages echo the query

A page this firmware does not implement is not answered at all, and Windows
hands back our own `HidD_SetFeature` buffer. Page 200 returns
`00 e5 c8 01 00 00 00 00 51` — the query verbatim. A paged read must therefore
test for an echo; it cannot rely on a null reply, and it gets no help from
`request()`'s own `isEcho` because these reads bypass `request()` entirely.

Page 251 **is** implemented: read with proper pacing it returns all zeros
across both chunks, stably (no top dead zone configured on this unit). An
earlier reading of `60, 198, 2` was a stale endpoint buffer — `60` is page 6's
`0x003c`, i.e. the 0.3 mm bottom dead zone, bleeding through. Reading pages
back-to-back too quickly returns the previous page's data, which is why the
driver settles between chunks. Still untested against a non-zero top dead
zone.

Mode enum: `0 normal`, `2 dks`, `3 mt`, `4 tgl_hold`, `5 tgl_dots`, `7 snap`
(and `8`-`10`, snap-tap with a set winner — see the mode byte above).

Generated constants: `app/src/shared/keyboard-options.ts`
(`KB_MAGNETISM_PAGES`, `KB_MAGNETISM_PAGE_CHUNKS`, `KB_MAGNETIC_MODES`,
`KB_PERKEY_EFFECTS`, `KB_SIDE_EFFECTS`, `KB_TRAVEL_RANGE`).

## Key matrix reads and writes — `verified-capture`

Settled on a real R85HE; all three of these were wrong before.

**Argument shape.** The two matrix GETs take **different** layouts, and the
chunk index sits in a different slot in each. Args below are frame bytes from 2
onward (byte 1 is the command), matching the vendor's `r[1..]`:

| command | byte 2 | byte 3 | byte 4 | byte 5 |
|---|---|---|---|---|
| `GET_KEYMATRIX` 138 | profile | `0xff` | **chunk** | fnProfile |
| `GET_FN` 144 | fnOS | fnProfile | `0xff` | **chunk** |

`fnOS`: win 0, mac 1, android 2, ios 3 (vendor `___utils_FnOSToNum`). Both are
read from the board's own `KBOPTION` register.

For `GET_KEYMATRIX`, byte 5 is the **Fn profile**, not the layer. Asking for
fnProfile 3 (which the driver did) returns 128 zeroed slots on a board that only
uses profile 0, so the base layer read back empty.

> **This corrects an earlier note here that said `GET_FN` takes only three args
> and that a fourth hangs the MCU.** It takes four, in the order above. What
> hangs the MCU is the *wrong* shape: the driver sent `[0, 0xff, chunk]`, which
> as a `GET_FN` means fnProfile = `0xff` with the chunk left at 0 — an
> out-of-range profile. Measured on a real R85HE (fw v5.11) with a liveness
> probe after every frame (`app/scripts/diag-fn-layer.ts`): the base sweep
> completes all 8 chunks and the board keeps answering, while that `GET_FN`
> frame killed the MCU on **chunk 0** and needed a replug. With the corrected
> shape the Fn sweep returns 128 slots — 22 bound, including slot 36 =
> `0x46` Print Screen and slot 18 = `0xe3` + modifier, both matching
> `KB_FN_DEFAULT_SLOTS` — over three consecutive runs with the board still
> answering. `provenance: ported-from-vendor`, frames confirmed on hardware.

**Reply shape.** Like the paged magnetism reads, these carry no command echo and
no checksum: 64 data bytes start at frame byte **1**, giving exactly 16 four-byte
slots per chunk and 128 slots over 8 chunks. The old offset of 9 also broke the
stride, since 65 - 9 = 56 is not a multiple of 4. Because there is no command
byte, `ch.request()` rejects every chunk — these must use raw paced reads.

Brute-forcing the alignment against `ANSI_79_SG9047` gives exactly one answer:
offset 1 with the HID code at quad byte 2, matching **77 of 77** layout entries.
Through the driver, `readKeyBindings('base')` then matches **78/78** slots.

**Slot quad.** Four bytes, stored verbatim:

```
[type, sub, a, b]
```

`type` selects how `a` and `b` are read — `inferred`, reconstructed from the
vendor's own `defaultMatrix` / `defaultFnMatrix` tables plus a real R85HE.
Decoded by `decodeKeyQuad()` in `src/shared/keyboard-fn-codes.ts`:

| type | meaning | `a` / `b` |
|---|---|---|
| 0 | plain HID usage(s) | **two independent usages**, either order |
| 3 | HID Consumer page (0x0C) | 16-bit usage, little-endian |
| 10 | opaque firmware function | `sub` selects which |
| 13 | lighting control | `sub` = control, `a` = direction |

**Both bytes of a type-0 quad are usages** — not a usage plus a modifier
bitmask, and which one is the modifier is not fixed. The factory Fn+F3 is
`[0,0,227,7]` (L-Win + D, show desktop) and Fn+F5 is `[0,0,227,55]` (L-Win +
`.`), while a user-assigned Fn+8 reads `[0,0,37,230]` — the same pair the
other way round. Reading byte 2 alone reported half of each: "8" for R-Alt+8,
"R-Alt" for 2+R-Alt.

Type 3 and type 0 reach the host and stay remappable; types 10 and 13 are
handled inside the board, so the UI marks them reserved.


The factory quad for A (slot 9) is `[0, 0, 4, 0]`. Writes are
`SET_KEYMATRIX [layer, slot, 0, 0, commit, zone]` + the quad at frame bytes
9..12, with **layer 0** — the same layer the read uses. Verified both
directions on hardware: writing `[0, 0, 5, 0]` to slot 9 changed that slot and
no other, and writing `[0, 0, 4, 0]` restored it exactly.

> `unconfirmed`: `writeVerified`'s read-back reports `match` for these writes
> even when its GET returns stale data — during one run it read the pre-write
> value twice in a row. Trust a separate paced read, not that flag.

**Fn-layer writes are a WHOLE-MATRIX write**, not per-slot — the vendor's
`___cmdSetFnKeyConfig` sends the full 128-slot quad table as 10 chunks of 56
bytes, the same header shape as `SET_USERPIC`:

```
SET_FN (16)  byte2=fnOS  byte3=fnProfile  byte4=0xff  byte5=chunk (0..9)
             byte6=length (56, or 0 on the last)
             byte7=commit (0, or 1 on the last)
             ...then 56 payload bytes
```

The driver previously sent a single-slot `[0, 0, slot, 0, 0, 0, hi, lo]` frame
from the older generation — the same wrong-argument hazard as the GET. It now
does read-modify-write: read the matrix, patch the one quad, send all 10
chunks. `provenance: ported-from-vendor`, **confirmed on hardware**: writing
one binding to an empty slot changed that quad and no other (a whole-matrix diff
before/after showed exactly one slot), and restoring it returned the matrix
byte-identical to the pre-write dump. The commit chunk starts a flash write and
needs the vendor's ~100ms settle before the verification read — without it the
re-read answers nothing and a write that actually landed reports `unverified`.

## Key matrix — `ANSI_79_SG9047`

From chunk `322d1e41.js` (`defaultMatrix`, 128 slots × 4 bytes, column-major,
79 keys) + `960d1a27.js` (the 737×281 UI grid). In `app/src/shared/layouts.ts`,
each entry carrying its `slot`. Every per-key wire op addresses `slot`.

## `KBOPTION` (`SET` 0x09 / `GET` 0x89) — `verified-capture`

Five unrelated switches in one register, so changing one means writing all five;
`CompxKeyboard.setKeyboardOptions()` merges over the last read.

```
byte 2  Fn OS          0 = Windows, 1 = macOS   (mac value `inferred`)
byte 3  Fn profile     active Fn slot
byte 4  anti-mistouch  vendor 防误触, 1 = on
byte 5  RT stab        rt_stabilisation / 25, 0..5; >5 reads back as 0
byte 6  swap WASD      1 = WASD swapped with the arrow cluster
```

Live on an R85HE: read `00 89 00 00 01 00 00 00 76`, write-back
`00 09 00 00 01 00 00 00 f5` -> `verified: match`.

**Byte 6 (swap WASD) does nothing on the R85HE.** The register layout above is
`verified-capture` and the frame checksum checks out, but on hardware (fw v5.11)
toggling the bit changed no key behaviour. Note the capture only ever exercised
the value `0` — the *semantics* of byte 6 are the vendor's own field name, not
something observed. SharkDeck therefore reads and preserves the byte but offers
no control for it; a switch that does nothing is worse than no switch. If a
later capture shows what actually drives the swap on this firmware family, the
UI can come back. See `KeyboardOptions.swapWasd`.

## Slot space vs. modelled keys

An R85HE has 79 keys and `ANSI_79_SG9047` declares 79 slots. Reading page 0 off
the board shows **82** configured slots: the 79 are an exact match, plus 96, 97
and 98. The R85HE and the 89-key R86PROHE share the `ry5088` firmware family, so
the most likely explanation is one image pre-populating slots for the larger
board. Harmless — nothing writes to a slot no layout entry names — but it means
"configured slots" is not a reliable key count.

## GET replies — `verified-capture`

Replies are **not checksummed**. Byte 8 is whatever our query left in the
buffer — our own query's checksum — unless the reply's data runs past byte 8,
in which case it is data. Measured on an R85HE (fw v5.11):

| query | reply | byte 8 |
|---|---|---|
| `GET_PROFILE` | `00 84 00 00 00 00 00 00 7b` | `7b` = our query's checksum |
| `GET_DEBOUNCE` | `00 86 00 00 00 00 00 00 79` | `79` = our query's checksum |
| `GET_KBOPTION` | `00 89 00 00 01 00 00 00 76` | `76` = our query's checksum |
| `GET_REPORT` | `00 83 00 02 00 00 00 00 7c` | `7c` = our query's checksum |
| `GET_USB_VERSION` | `00 8f 33 0c 00 00 00 00 11 05` | `11` = **firmware data** |

So recomputing `0xFF - Σ reply[1..7]` and comparing coincides with the echoed
value only when reply bytes 2..7 are all zero — i.e. it passes for trivial
replies and **rejects exactly the replies that carry information**. Reply
checksum enforcement must stay off for `compx-fea`
(`ENFORCE_COMPX_FEA_REPLY_CHECKSUM` in `hid/transport.ts`); the command byte
filter is still valid and still applied.

This mattered: rejecting `GET_USB_VERSION` made `getFirmware()` return null
forever, so `CompxHeKeyboard.travelMultiplier()` stayed on its fallback of 10
instead of 200, putting **every** magnetic travel value off by 20x in both
directions — a 2.0 mm actuation read back as 40 mm and written as 0.1 mm.

Data offsets, from the table above: `GET_USB_VERSION` is
`[00, 8f, id lo, id hi, 00, 00, 00, 00, fw lo, fw hi]` — model id uint16 (the
vendor reads uint32; the high half is zero for every id in either registry) at
bytes 2..3, firmware uint16 at 8..9. `GET_REPORT`'s rate index is at byte 3.
`GET_KBOPTION` is `[FnOS, fnProfile, anti-mistouch, RTStab/25, swapWASD]` from
byte 2. Paged `GET_MULTI_MAGNETISM` is the exception to all of this: no command
echo at all, data from byte 1 (see above).


## Main lighting — `SET_LEDPARAM` / `GET_LEDPARAM`

Frame, from the vendor bundle's `setLightSetting` (`app/scripts/_raw/qmk-bundle.js`),
shifted by one because our frame byte 1 is the command:

```
SET_LEDPARAM (7)  byte2=effect  byte3=speed  byte4=brightness  byte5=option  byte6..8=r,g,b
GET_LEDPARAM (135) reply, from the payload start: same order
                  [0]=effect  [1]=speed  [2]=brightness  [3]=option  [4..6]=r,g,b
```

**The reply order matches the write order — resolved, not assumed.** This was an
open question (`roadmap.md`): `FINDINGS-R85HE.md:163` read the reply as *effect,
brightness, speed*, the opposite of the write, which would have meant the main
zone's brightness and speed were swapped on every read. The vendor's own
`getLightSetting` settles it:

```js
const i = this.LIGHT_LIST[e[1]] ?? "LightOff",
      r = this.LIGHT_MAXSPEED - e[2],   // speed  <- byte 2
      o = e[3],                          // bright <- byte 3
      a = e[4], l = a >> 4, d = a & 15;  // option -> direction, colour mode
let f = { r: e[5], g: e[6], b: e[7] };
```

The captured reply `00 87 0d 04 01 00 00 c8 c8` decodes coherently under that
order and only that one: effect 13 `LightUserPicture`, speed wire 4, brightness
wire 1, option 0 — which is exactly what the vendor writes for
`LightUserPicture` — and rgb `00 c8 c8`, its `(0, 200, 200)` sentinel. Read the
other way round it claims brightness 4 with a speed of 1 on an effect whose
speed the vendor always sends as 0. `readLighting` already mirrored the write
order and is correct; `FINDINGS-R85HE.md:163` is not.

**Applying a per-key picture carries a brightness.** The painted map only shows
while the main effect is the per-key layer, so `setPerKeyLighting` follows its
7-chunk `SET_USERPIC` burst with a `SET_LEDPARAM` onto effect 13 — and that
frame must carry a brightness. Taking it from a fresh `GET_LEDPARAM` is what
made an apply look like it *disabled* the lighting: any zero (lighting off, or a
stale answer landing right behind the burst) was written straight back, leaving
the keys painted and dark. The caller now states it (`PerKeyLightingOpts`), and
a board with nothing to say falls back to full rather than to whatever it just
reported. The vendor is blunter still — its own per-key apply sends
`bright: light.type === 'LightUserPicture' ? light.bright : 4`, i.e. keep it only
when already on this layer, otherwise jump to wire 4.

**The effect index is the wire value**, and the list is the vendor's
`LIGHT_LIST` — 26 entries, 0 `LightOff` through 25 `LightUserColor`. It lives in
`app/src/shared/lighting.ts` as `KB_LIGHT_EFFECTS_TABLE` and is locked to the bundle
by `lighting.test.ts`, because it had previously drifted with no test and a
docstring crediting a Driver-v4 symbol that does not exist.

**Speed is inverted.** The vendor sends `LIGHT_MAXSPEED - speed` with
`LIGHT_MAXSPEED = 4`, so **wire 0 is fastest** and 4 is slowest. This driver
mapped UI 100% straight to wire 4, i.e. the speed slider ran backwards.
`provenance: ported-from-vendor` — worth a visual confirmation on hardware,
since a reversed animation is only obvious to the eye.

**The option byte packs two things:**

```
option = direction << 4 | colourMode
  colourMode: 7 = LIGHT_NORMAL (single colour), 8 = LIGHT_DAZZLE (rainbow)
  LightUserPicture     -> option = direction << 4          (no colour nibble)
LightMusicFollow2/3  -> option = direction << 4 | (dazzle ? 0 : 4)
  LightScreenColor     -> option = 0
```

`direction` indexes the effect's own `options` list in the vendor
`lightLayout` — e.g. Wave has right/left/down/up, Snake zigzag/spiral,
Kaleidoscope outward/inward, Circle Wave CCW/CW, Line Wave right/left. The high
nibble was never sent (always 0), so every directional effect was stuck on its
first option.

**Per-effect parameters** come from that same `lightLayout`: `maxValue` means a
brightness control applies, `maxSpeed` a speed control, `rgb` a single custom
colour, `dazzle` the rainbow mode. **The absence of `maxSpeed` means the effect
has no speed at all** — `LightAlwaysOn` is the obvious case, and rendering a live
speed slider for it was a long-standing UI bug. Note also that Wave,
Kaleidoscope, Circle Wave and Dazzing all carry `rgb:!0`: a hand-kept
`RAINBOW_EFFECTS` list had them as colourless and hid a picker the board
honours. That set is now derived from the table.

**Side lighting** uses a different, shorter list — the vendor's
`SIDE_LIGUT_LIST` (their typo): 0 Off, 1 Always On, 2 Breath, 3 Neon, 4 Wave,
**5 Snake**, 20 MusicFollow3, 21 ScreenColor, 22 MusicFollow2. Snake is 5 here,
not the main list's 7; it had been carried over from the main list and tagged
`inferred "pending a capture"`, when the answer was already in the repo's own
extract. The three high entries were missing entirely.
