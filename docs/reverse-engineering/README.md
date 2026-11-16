# Reverse-engineering captures

## Any new device: the report tool's recording

For a device on a protocol nobody has documented, the starting point is a
recording its owner makes with `tools/SharkDeck-device-report.bat`: USBPcap
records the official software at work, a step window tags each setting change
with the value it set, and the tool keeps only that device's traffic (key
presses blanked, mouse movement cut to a sample, serial number zeroed). Read it
with

```bash
cd app && npm run device-report -- path/to/SharkDeck-recording-….zip
```

It unpacks next to the .zip and writes `dossier.md` there: the descriptors,
each step's frames with their timing, what the software polls on its own,
encodings fitted to the known values, and checksum candidates. The pictures of
the official software are in `screens/`. Code: `app/src/main/devices/capture/`.

Unlike the Frida harnesses below, which each targeted one vendor app, a USB
recording works whatever the official software is built with, including one
that does its I/O from a service. It needs USBPcap because Windows 11's own
USB trace (`Microsoft-Windows-USB-UCX`, even with `FullDataBusTrace`) records
requests and their lengths but no payload any more (checked 2026-11-15).

## The first two devices

Originally the `capture/` folder of the Python profile switcher (now in
[`../../legacy/attack-shark-profile-switcher/`](../../legacy/attack-shark-profile-switcher/)).

### V8 mouse (Qt "Mouse Hub")

Runbook: [`CAPTURE-MOUSE.md`](CAPTURE-MOUSE.md). Use the step-driven harness
(`capture-mouse.py` / `hook-mouse.js`) — the first-generation one
(`capture.py` / `hook.js`) lost every device reply to overlapped I/O and is kept
only as the evidence behind the one verified command.

| File | What it is |
|---|---|
| `FINDINGS.md` | The V8 8K-dongle frame layout and checksum. Canonical writeup: [`../protocol/README.md`](../protocol/README.md). |
| `capture-mouse.py` | Step-driven Frida host: prints an instruction, waits for Enter, tags packets with the step. Writes `session-v8.jsonl`. `--spawn` / `--process` / `--free [--seconds N]`. |
| `hook-mouse.js` | Frida agent for the Hub — overlapped-read-completion aware, auto-hooks the whole `HIDUsb.dll` `CS_Usb*` surface, monotonic `seq` per packet. |
| `analyze-v8.py` | `session-v8.jsonl` → per-step timeline + command map + block-write map + region-A diff. |
| `v8-vendor-block-map.json` | The Hub's own `08 08` read-address list (regions A/B/C), extracted from the 2026-08-13 capture. |
| `v8-preimage.json` / `v8-postimage.json` | Full onboard state (all 4 profiles) before / after a session — the restore point. From `npm run dump:mouse`. |
| `v8-direct-probe.json` | Bare-frame reply for every command byte 0x01–0x2F (no vendor app). |
| `v8-collections.json` | Every Attack Shark / Compx HID collection present, for cataloguing. |
| `v8-config-export/` | The Hub's exported per-profile config files. |
| `capture.py` / `hook.js` | First-generation time-driven harness. History. |
| `session.jsonl` / `session-v8-2026-08-13.jsonl` | The one prior V8 capture (profile switching) + its preserved copy. Do not overwrite. |

### R85HE keyboard (Electron "Driver v4")

Driver v4's renderer never touches HID — it calls gRPC-web `sendMsg` and the
native `iot_driver_v215.exe` does the I/O. So the harness targets that process.

| File | What it is |
|---|---|
| `FINDINGS-R85HE.md` | Frame format + **verified** checksum, `GET_*` replies, key matrix, magnetism page map. |
| `CAPTURE-KEYBOARD.md` | Step-driven runbook to finish the `SET_*` layouts against Driver v4. |
| `hook-kb.js` | Frida agent for `iot_driver_v215.exe` (`HidD_SetFeature`/`GetFeature`, raw HID, hidapi). |
| `capture-kb.py` | Step-driven capture: prints one instruction, waits for Enter, tags packets. Writes `session-r85he.jsonl`. |
| `r85he-direct-probe.json` | Raw replies from the direct (no-vendor-app) probe that recovered the checksum. |

Also: `probe.py` (HID feature probe — `python probe.py kb` for the keyboard),
`app/scripts/extract-keyboard-protocol.mjs` (`npm run extract:kb`, static),
`app/scripts/dump-keyboard-state.mjs` (`npm run dump:kb`, live pre-image).

Needs `frida` installed; not a runtime dependency of `app/`.
