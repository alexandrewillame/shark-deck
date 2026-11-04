# WebHID transport notes

What Chromium's WebHID does differently from node-hid / hidapi, as far as the
browser edition is concerned. The shim (`app/src/web/hid/node-hid-webhid.ts`)
turns WebHID back into hidapi's byte layout so `HidChannel` runs unchanged;
this page records which of its rules have been seen on real hardware.
Provenance tags as in [README.md](README.md).

## Probe of 2026-11-03

Chrome 157 on Windows 11, an Attack Shark R85HE (`3151:5029`, firmware v5.11).
Read-only — `GET_PROFILE`, `GET_USB_VERSION`, `GET_RF_VERSION`,
`GET_LEDPARAM` — once through raw WebHID and once through `HidChannel` over the
shim.

| Finding | Provenance |
|---|---|
| One pick in Chrome's device dialog grants both of the R85HE's vendor interfaces: `FFFF/0001` (input report 5, 31 B) with a Consumer `000C/0001` collection (input report 3, 2 B), and `FFFF/0002` (feature report 0, 64 B) — the config collection, which `findVendorCollection` picks by usage. | `verified-capture` |
| `receiveFeatureReport(0)` returns the 64-byte payload **without** the report-id byte. The shim reads that off the declared report size and hands `HidChannel` 65 bytes, id first, as hidapi does. | `verified-capture` |
| A GET the firmware ignores (sent without its `compx-fea` checksum) comes back as **our own SET buffer**, as it does through hidapi on Windows. `isEcho()` is needed in the browser too, and works because the shim keeps reply and query the same length. | `verified-capture` |
| Replies are byte-identical to the desktop's captures: `00 84 00 00 00 00 00 00 7b` (profile 1), `00 8f 33 0c 00 00 00 00 11 05` (model id 3123, firmware v5.11). Pinned by the shim's test through the real driver. | `verified-capture` |
| The answer is already in the feature buffer when the GET follows the SET by 1–3 ms. `HidChannel`'s 30 ms request pacing stays: it exists for the endpoint lockup, not for latency. | `verified-capture` |
| `sendFeatureReport` on the interface with no feature reports fails with `NotAllowedError: Failed to write the feature report.` | `verified-capture` |
| Output and input reports — the V8 mouse's path: report `0x08` out, replies as input reports, kept to their collection by report id. | `inferred` — not yet run |
| Whether the grant survives an unplug for a board with no USB serial (the R85HE). Chromium's rule says it does not. | `inferred` — not yet run |
| macOS (IOHIDManager) and Linux (hidraw) layouts. | `inferred` |

## First write, 2026-11-03

The same board and browser, through the built edition (`npm run preview:web`
on `127.0.0.1`), with the desktop app quit: the backup `guardedWrite()` takes
was made first, then the Fn layout (Windows / macOS) was set from the General
tab, and the board took it. Run by hand on the real board.

| Finding | Provenance |
|---|---|
| A feature-report `SET` from the browser edition, through the shim's `sendFeatureReport`, reaches the R85HE and takes effect. | `verified-capture` |

## Side finding

`app/scripts/smoke-hid.mjs` sent its R85HE GETs without the `compx-fea`
checksum, so the firmware ignored every one and each R85HE line read "no
answer / echo"; its version decode also read the wrong bytes. Fixed the same
day: signed frames, and the driver's offsets (model id `[2..3]`, firmware
`[8..9]`, RF version `[2..3]`, all little-endian).
