# Capturing the R85HE keyboard protocol

`docs/protocol/keyboard-compx.md` marks everything on the R85HE except the
command *numbers* as `ported-from-vendor` or `inferred`. This session promotes
the checksum, the frame layouts, the key-matrix order and the `GET_*` reply
layouts to `verified-capture`.

## Which tool to use — **`capture-kb.py`** (Frida on `iot_driver_v215.exe`)

Confirmed 2026-08-30: Driver v4 configures the R85HE from **`iot_driver_v215.exe`**
via `HidD_SetFeature` / `IOCTL_HID_SET_FEATURE` / `IOCTL_HID_GET_FEATURE`. The
renderer's `navigator.hid` is empty for this keyboard, so `webhid-capture.mjs`
does **not** work here (kept only as a record of that dead end).

`hook-kb.js` was dropping every frame because it filtered by device path
(`vid_3151`) and the handle only resolves to `\Device\NNNNN`. Fixed: it now
matches by **frame shape** — `00 <cmd> …` feature reports — and de-dups the
repeat connect-time GET spam.

```bash
# 1. power-cycle the keyboard, confirm it types
# 2. open Attack Shark Driver v4, wait for the R85HE card (this starts iot_driver)
# 3.
cd docs/reverse-engineering
python capture-kb.py
```

Cyan `[setfeature]` / `[getfeature]` lines are the frames.

The R85HE's vendor collection is `HID\VID_3151&PID_5029&MI_02`, usage page
`0xFFFF` / usage `0x02`, a **feature-report** channel (`HidD_SetFeature` /
`HidD_GetFeature`), 64-byte payload + leading report id.

## ⚠️ This firmware wedges easily

A burst of feature-report transactions — or a bare `GET` that actually needs a
page/layer argument — hangs the **whole keyboard MCU** (keys stop working,
LEDs stay on). Driver v4 then can't find the board either; it needs a
**power-cycle** (unplug/replug or the board's own reset) to recover.

Rules for this session:

1. **Never run our probe scripts before Driver v4 has the board.** Recover the
   keyboard, confirm keys type, open Driver v4, wait for the R85HE card to
   appear. Only *then* start `capture-kb.py`.
2. `capture-kb.py` only *observes* `iot_driver_v215.exe` — it sends nothing to
   the keyboard. Driver v4 paces its own I/O (it's the app you normally use),
   so it should not wedge the board. The risk is our `dump:kb` /
   direct-probe scripts, not the capture.
3. If the board wedges mid-session: power-cycle it, reopen Driver v4, wait for
   the card, then `python capture-kb.py` again and resume from the next step.
4. A partial pre-image already exists (`r85he-preimage.json`, 7 verified GET
   replies) — that is enough; do **not** re-run `dump:kb` just to "complete" it.

## Prereqs

- R85HE connected (wired — it has no dongle) **and typing normally**.
- Driver v4 installed, its window open, and **showing the R85HE card**.
- **Close SharkDeck and ATK HUB** — they contend for the HID handle.
- `python -m pip install frida psutil`. Any version: `hook-kb.js` resolves
  exports through an `exportByName` shim, because frida 17 removed the static
  `Module.findExportByName` the agent used to call — which made it install no
  hooks and record nothing at all. `capture-kb.py` now aborts unless the agent
  reports `ready`. See the same section in `CAPTURE-MOUSE.md`.

## Before the capture — pre-image

`r85he-preimage.json` already holds 7 verified GET replies (poll rate, profile,
LED on/off, debounce, LED params, side-LED params, keyboard options). That is
enough baseline. `dump:kb` is now gentle (1:1 I/O, stops after two non-answers)
but still touches the fragile channel — only re-run it if you *need* a fresh
snapshot, and expect a possible power-cycle afterward. To restore the board
after the session, use Driver v4's own **Restore Defaults**.

## Run

```bash
cd docs/reverse-engineering
python capture-kb.py
```

It attaches to `iot_driver_v215.exe`, installs the hooks, then walks the step
list in `capture-kb.py` (`STEPS`). Each step is a **boxed banner** ending in
`> `; do the action in Driver v4, pause ~1 s, then press Enter for the next.

The console only prints real protocol frames (cyan `[setfeature]` /
`[getfeature]` lines). iot_driver re-enumerates the HID collections about once a
second — those `GET_COLLECTION_INFORMATION` / descriptor IOCTLs and its own
socket heartbeat are **hidden** (counted in the banner, still written to the
`.jsonl`). If you see no cyan lines at all across a step that changed a
setting, the frame went out some path the hook missed — note it and continue.

**What Driver v4 exposes for the R85HE.** Its device-table row is
`other:{isSwitchReplaceable:true}` only — **no debounce control, no sleep
timer, no battery** (wired board). The debounce/sleep/battery steps from an
earlier draft are gone. What's left: magnetic actuation (travel / RT / DKS /
modes / dead zone / calibration), key + Fn-layer remap, per-key lighting, side
lighting, polling rate, macros, profile slots, firmware. Any step whose page
you can't find — press Enter to skip it.

The steps, in order:

| group | In the Driver v4 UI | What it pins down |
|---|---|---|
| 01 | (nothing — just Enter) | how `id:3123` is read; `GET_USB_VERSION` reply layout |
| 02 | open every page, change nothing | every `GET_*` reply layout, against the pre-image |
| 04 | poll rate 125 → 8000 in order | `SET_REPORT` arg + confirms `GET_REPORT` `[3]` |
| 05 | profile slot 1 → 4, then re-open actuation | does `SET_PROFILE` persist anything → `softwareProfiles` vs `profiles` |
| 06 | global actuation low / mid / high | travel step multiplier vs firmware version |
| 07 | per-key actuation on Esc, Q, Right-Arrow | **matrix slot order** — cross-check against `kb-r85he-layout.json` |
| 08 | arm rapid trigger on Space, set press + release | pages 2/3, the `0x80` fire bit |
| 09 | one key each: DKS, MT, tgl-hold, tgl-dots, snap | mode enum (0/2/3/4/5/7) + DKS pages 4 & 10 |
| 10 | dead zone on Esc; calibration button if present | page 251; `SET_MAGNETISM_CAL` (28) / `..._MAXIMUM_CALIBRATION` (30) |
| 11 | remap a key; Fn-layer remap; each layer | `SET_KEYMATRIX` (10) / `SET_FN` (16) layout + layer addressing |
| 12 | record a 2-key macro with a delay, assign it | `SET_MACRO` (11) chunking |
| 13 | per-key lighting: effects, brightness, speed, direction, one custom key colour | `SET_LEDPARAM` (7) + `SET_USERPIC` (12) |
| 14 | side lighting: each of the 6 effects | `SET_SLEDPARAM` (8) |
| 17 | Restore Defaults | `SET_RESET` (1) |
| 18 | live per-key travel view (if present), press keys | `SET_MAGNETISM_REPORT` (27) stream format |
| 19 | open the firmware page, **do not** start | version-query shape only |

Output: `session-r85he.jsonl` (one JSON record per packet, each with a `step`
field). **Not** `session.jsonl` — that is the V8 capture.

## After

1. Restore the board: revert the settings from `r85he-preimage.json` in the
   Driver v4 UI (or just Restore Defaults, then re-run `dump-keyboard-state.mjs`
   and diff to confirm it matches the pre-image's factory state).
2. Derive the checksum: take the step-03 `setfeature` frames, drop the last
   byte, and check `bit7 = (0x80 - (Σ body & 0x7f)) & 0x7f` reproduces it. If
   not, fit the real rule and update `app/src/main/hid/checksum.ts` +
   `app/src/main/hid/checksum.test.ts` with the captured vectors.
3. For every `SET_*` step: diff the captured frame against the frame SharkDeck
   builds for the same change (developer HID frame log). Fix any offset in
   `compx-keyboard.ts` / `compx-he-keyboard.ts` the capture contradicts.
4. Write the results into `FINDINGS-R85HE.md` and promote confirmed commands to
   `verified-capture` in `docs/protocol/keyboard-compx.md` and `README.md`.

## 2026-08-31 addendum — specific offsets the current driver guesses at

The steps above already cover the right actions; when you get to them, also
watch for these specific bytes (all implemented against the capture docs
without hardware this session, so none are trusted yet):

- **Step 13 (per-key lighting)**: `SET_USERPIC`'s `lastFlag` byte position
  (compare chunk 4's frame against chunks 0–3 — see `USERPIC_WRITE_CHUNKS` /
  the header-args comment in `compx-keyboard.ts`), and `GET_USERPIC`'s reply
  payload offset (8 vs 9 — `USERPIC_REPLY_OFFSET` in the same file assumes 9).
- **Step 11 (remap)**: `GET_KEYMATRIX`/`GET_FN`'s reply stride/offset
  (`KEYMATRIX_REPLY_OFFSET` assumes 9, 4 bytes/slot) — diff a read against
  `kb-r85he-matrix.json`'s `defaultMatrix`/`defaultFnMatrix` to confirm. Also
  try `SET_FN` on one of the 28 hard-wired slots listed in
  `shared/keyboard-fn-defaults.ts` (e.g. the ↑ arrow) to see whether the
  firmware actually rejects the write or silently accepts and ignores it —
  `KeyRemapSection.tsx`'s "locked" UI is currently a vendor-parity guess, not
  a confirmed refusal.
- **Step 18 (live travel)**: dump ~20 raw stream frames via both an
  input-report read and a feature-report `GetFeature` (see `readStream()` in
  `hid/transport.ts`) to settle which path actually delivers data, the byte
  layout, and the index space (`decodeTravelFrame` in
  `compx-he-keyboard.ts` currently assumes uint16-LE-per-slot from byte 2).
- **New step to add**: page-6 bottom dead zone round trip (set 0.30 mm, read
  back the `0x3c` register at the firmware's ×200 multiplier) — the actuation
  tab now has a bottom-dead-zone slider (`MM_PAGE.DEADZONE_BOTTOM`) that was
  previously read into the driver but never surfaced.
- **Step 13/14 (offsets)**: `GET_LEDPARAM`/`GET_SLEDPARAM`'s brightness/speed
  now decode via `feaPayloadStart()` (byte 2 or 3 depending on whether the
  firmware overwrote the echoed query checksum) — confirm this against a
  fresh capture of brightness 0→100% and speed 0→100%, and check the
  `0xFAF0FA` white-colour sentinel against a real white write (the capture
  showed white travelling as `fa ff fa`, which this driver no longer
  special-cases).

## Free-run mode

To just log everything with timestamps and no script (e.g. to watch what the
app does on connect):

```bash
python capture-kb.py --free
```
