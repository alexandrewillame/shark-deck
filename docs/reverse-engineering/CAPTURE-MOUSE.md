# Capturing the V8 mouse protocol

`docs/protocol/README.md` marks everything on the V8 except profile switching as
`inferred` or `ported-from-vendor`. This runbook produces a step-tagged capture
that promotes the DPI / poll-rate / sensor / LOD / LED / firmware / button /
macro paths to `verified-capture`.

The first-generation harness (`capture.py` + `hook.js`, time-driven) is kept for
history — it is the evidence behind the one verified command — but it lost every
device reply to overlapped I/O. Use the step-driven harness below instead.

## What you need

- The V8 mouse **and** its 8K receiver plugged in. A USB-C cable for the wired
  pass (steps `10_*`).
- **ATTACK SHARK MOUSE HUB** installed (the Qt app, not keyboard Driver v4).
  `capture-mouse.py --spawn` finds it automatically.
- `python -m pip install frida psutil`. **Any frida version works** — the
  agents resolve exports through their own `exportByName` shim (see below).
- SharkDeck closed — it holds the vendor collection:
  `node app/scripts/kill-running-app.mjs`.

## 0. Restore point (do this first, once)

```bash
cd app && npm run dump:mouse
```

Writes `docs/reverse-engineering/v8-preimage.json` (full onboard state, all 4
profiles) and `v8-direct-probe.json` (bare-frame reply for every command byte
0x01–0x2F). The session's `08_restore_defaults` step and the general write
traffic change real settings; this is what you diff back against and restore to.

## 1. Run the capture

```bash
cd docs/reverse-engineering
python capture-mouse.py --spawn
```

`--spawn` launches the Hub under Frida so the `CreateFileW` hook sees its HID
handles from the start. `hook-mouse.js`:

- captures **overlapped read completions** (the fix — three independent recovery
  paths: `GetOverlappedResult(Ex)`, `GetQueuedCompletionStatus`, and polling
  `OVERLAPPED.Internal`);
- hooks **every** `HIDUsb.dll` `CS_UsbServer_*` / `CS_UsbFinder_*` export and
  hexdumps its buffers, so each Hub control maps to the frame it emits;
- stamps a monotonic `seq` on every record for exact request/reply pairing.

The script prints one instruction at a time and waits for Enter. Do the action
in the Hub, **pause ~1 s**, then press Enter. Any control you can't find: press
Enter to skip. Output: `session-v8.jsonl` (flushed after every step).

### Keeping the mouse awake

A full run is ~30–45 min and the V8 sleeps on its own. Step `04_sleep_max_FIRST`
sets the sleep timer to maximum early and leaves it there. If the card still
goes offline mid-run, nudge the mouse and redo the last step.

### The step groups

`01` read-all (captures the block read-back with replies) · `02` Keys
(every button action, fire-key, debounce) · `03` Sensor (poll rate ×7, LOD ×3,
sensor mode, DPI stages/colours, motion-sync / angle-snap / ripple one at a
time) · `04` Advanced (sleep, angle mode — a **slider**, not a toggle, so drag
it — 20K scan, long-distance, DPI dynamic curve) · `05` Light (DPI effect, 7 body modes, brightness/speed/colour, the
three receiver LEDs, receiver decorative light) · `06` Macros (record → assign →
export → import → delete) · `07` Profiles (switch 1–4, **export each to
`v8-config-export/`**, import one back) · `08` Settings (device info / firmware,
language, start-at-boot, **Restore Defaults**) · `09` Pair · `10` Wired (cable,
Corded mode, firmware page — **do not start an update**) · `11` Offline (mouse
powered off — settles the `08 03 reply[6]` online-flag question).

### A targeted run: just the angle offset

`Mouse Angle Mode` was the one sensor control with no captured write behind
it: the 2026-08-30 session's step list looked for an on/off toggle, the Hub
only has a slider, so the step was skipped and nothing was recorded. **This run
settled it on 2026-09-10 — the offset is `0x00BD`** (see `FINDINGS.md`). The
mode is kept here as the worked example for any other unmapped control.

`--angle` runs `ANGLE_STEPS` instead of the full script — seven prompts, ~2
minutes, writing `session-v8-angle.jsonl` so it cannot clobber the preserved
full session:

```bash
python capture-mouse.py --spawn --angle
python analyze-v8.py session-v8-angle.jsonl
```

Read the offset off the **SETTING-WRITE MAP**: whichever offset appears under
the `04_angle_*` steps and nowhere else is the angle. Five distinct slider
positions are captured rather than one because the bytes also settle the
*encoding* — `-30..30` two's complement, `0..60` biased and degrees-doubled all
fit a signed byte identically, and only the written values tell them apart.

If no `0x07` write shows up under those steps, look at the command map: the
drag may not be a region-A write at all. That is the case
`app/scripts/watch-region-a.mjs` would be blind to, and the reason this hooks
the Hub's writes instead of diffing the config block.

### If the run records nothing

Fixed 2026-09-10, and worth knowing the shape of it: **frida 17 removed
`Module.findExportByName`** (along with `Module.enumerateExports` and
`Module.findBaseAddress`) — static module lookups moved onto per-module
objects. All three agents called the static form on their first top-level
statement, so on a modern frida the script threw `TypeError: not a function`
at load time, installed **zero** hooks, and the run then walked through every
prompt and wrote an **empty** session file. Nothing in the output said so.

Both fixes are in place:

- `hook-mouse.js` / `hook-kb.js` / `hook.js` resolve every export through
  `exportByName()`, which uses the static call on frida ≤ 16 and
  `Process.findModuleByName(...).findExportByName(...)` (falling back to
  `Module.load`) on 17+.
- `capture-mouse.py` now **refuses to prompt for a step** until the agent has
  reported `ready`, treats a compile or load error as fatal, warns when zero
  `HIDUsb.dll` exports were hooked, and prints a checklist if the run ends with
  no records at all. `capture-kb.py` has the same ready/error gate.

So a repeat of this class of breakage aborts on the spot instead of costing a
run. If a capture still comes back empty, the checklist it prints is the order
to work through — an already-running Hub is the most likely cause, because it
single-instances and `--spawn`'s copy hands over and exits.

## 2. Analyse

```bash
python analyze-v8.py session-v8.jsonl | tee v8-analysis.txt
```

Emits: a per-step timeline (DLL call → write frame → paired reply); a command
map (each `0x08` command byte, its steps, distinct replies); a block-write map
(each `0x09` write: offset ← bytes, tagged with the step and DLL call that
produced it); and a region-A per-step diff (one-setting-at-a-time steps reveal
exactly which byte moved).

## 3. Write it up

- Rewrite **`FINDINGS.md`** (the V8 findings doc) to `FINDINGS-R85HE.md`'s
  structure: `## Device`, `## Frame format`, `## Commands`, `## Reply layouts`,
  `## Still open`. Keep the verified profile-switch section.
- In **`docs/protocol/README.md`**, move each confirmed command from `inferred` /
  `ported-from-vendor` to `verified-capture`; fix any offset the capture
  contradicts. Add captured checksum vectors to
  `app/src/main/hid/checksum.test.ts`.
- Re-run `cd app && npm run dump:mouse -- --out ../docs/reverse-engineering/v8-postimage.json`,
  diff against `v8-preimage.json`, and restore anything the session left changed.
- The driver changes this unblocks (`compx-mouse-8k.ts` `BLOCK` / `RX` maps,
  `PROFILE_DUMP_LEN`, the six unimplemented capabilities, new
  `shared/mouse-options.ts` tables, `known-pids.ts` for the wired interface) are
  follow-up work — land the capture and the findings first.

## Files

| File | Role |
|---|---|
| `capture-mouse.py` / `hook-mouse.js` | step-driven harness (reply-capturing) |
| `analyze-v8.py` | session-v8.jsonl → candidate protocol map |
| `app/scripts/dump-mouse-state.mjs` (`npm run dump:mouse`) | pre/post-image, no vendor app |
| `v8-vendor-block-map.json` | the Hub's own `08 08` address list, extracted from the 2026-08-13 capture |
| `session-v8.jsonl` | this session's raw step-tagged traffic |
| `v8-preimage.json` / `v8-postimage.json` / `v8-direct-probe.json` | restore point + probe |
| `v8-config-export/` | the Hub's exported profile files |
| `capture.py` / `hook.js` / `session.jsonl` / `session-v8-2026-08-13.jsonl` | first-generation harness + preserved original — history, do not overwrite |
