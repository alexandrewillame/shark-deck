# Supported devices

[Mice](#mice) · [Keyboards](#keyboards) · [Not supported](#not-supported) ·
[Missing a device?](#missing-a-device) · [How devices are recognised](#how-devices-are-recognised)

Every Attack Shark mouse and keyboard we know of, and how well Shark Deck
handles it.

| Status | What it means |
|---|---|
| 🟢 **Tested** | Checked on a real unit: settings read, written and read back. |
| 🟡 **Should work** | Fully supported from the protocol documentation, not yet confirmed on a unit. |
| 🟠 **Partial** | Works with part of its settings (the row says which), not yet confirmed on a unit. |
| ⚪ **Recognised** | Shown in Shark Deck, but nothing can be changed yet. |
| 🔴 **Not supported** | Shark Deck cannot configure it. |

Whatever the status, Shark Deck backs a device up before its first change and
reads every change back. Own a 🟡 or 🟠 device? Tell us whether it works:
[open an issue](https://github.com/alexandrewillame/shark-deck/issues/new/choose).

<!-- generated:lineup — `npm run lineup` rewrites this block -->

**At a glance:** 🟢 Tested 2 · 🟡 Should work 30 · 🟠 Partial 68 · ⚪ Recognised 7

## Mice

| Status | Model | Sensor | DPI | Notes |
|---|---|---|---|---|
| 🟢 Tested | V8 | PAW3950 | 50–42000 |  |
| 🟡 Should work | F1 AIR | PAW3955 | 50–60000 |  |
| 🟡 Should work | R2 | PAW3950 | 50–42000 |  |
| 🟡 Should work | R3 | PAW3395 | 50–26000 |  |
| 🟡 Should work | R3 | PAW3950 | 50–42000 |  |
| 🟡 Should work | R5 ULTRA | PAW3950 | 100–42000 |  |
| 🟡 Should work | R6 | PAW3950 | 100–42000 |  |
| 🟡 Should work | R8 | PAW3950 | 100–42000 |  |
| 🟡 Should work | X11 ULTRA | PAW3950 | 50–42000 |  |
| 🟡 Should work | X3 PRO | PAW3395 | 50–26000 |  |
| 🟠 Partial | MEGA B2 | PAW3955 | 50–60000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | R11 ULTRA | PAW3950 | 50–42000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | R5 TURBO | PAW3955 | 50–60000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | RS3 ULTRA | PAW3955 | 50–52000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | RS6 ULTRA | PAW3955 | 50–52000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | V2 AIR | PAW3955 | 50–60000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | V5 | PAW3950 | 50–42000 | Its sensor’s common settings only: its model number is not known yet. |
| 🟠 Partial | X8 PRO | — | 50–40000 | Through its 8K receiver, not its cable yet. It cannot report its settings: Shark Deck shows what it last sent — [more](../protocol/mouse-beken.md). |
| 🟠 Partial | X8 ULTIMATE / X8 ULTRA | PAW3950 | 50–42000 | Its sensor’s common settings only: its model number is not known yet. |
| ⚪ Recognised | M5 ULTRA (Attack Shark or MAMBASNAKE) | — | — | Its USB ids are another brand’s too; shown until one is confirmed. |
| ⚪ Recognised | R1 / X6 / X3 | — | — | Beken chip: the settings protocol is not confirmed yet — [why](../protocol/mouse-beken.md). |
| ⚪ Recognised | R2 (newer chip) | — | — | Its command set has no driver yet. |
| ⚪ Recognised | X1 | — | — | Beken chip: the settings protocol is not confirmed yet — [why](../protocol/mouse-beken.md). |
| ⚪ Recognised | X11 | — | — | Beken chip: the settings protocol is not confirmed yet — [why](../protocol/mouse-beken.md). |
| ⚪ Recognised | X8 PLUS | — | — | Beken chip: the settings protocol is not confirmed yet — [why](../protocol/mouse-beken.md). |

## Keyboards

One row per firmware model id: a name can cover several versions (wired or wireless, Hall effect or mechanical), and Shark Deck tells them apart when the keyboard connects.

| Status | Model | Model id | Switches | Wireless | Notes |
|---|---|---|---|---|---|
| 🟢 Tested | R85HE | 3123 | Hall effect | — |  |
| 🟡 Should work | K75 RGB | 1343 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | K75 RGB | 1679 | mechanical | — |  |
| 🟡 Should work | K86 | 1168 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | K86 | 2730 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | M86 | 4012 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | R85 Ultra | 2968 | Hall effect | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X60 HE | 2929 | Hall effect | — |  |
| 🟡 Should work | X65 | 2942 | Hall effect | — |  |
| 🟡 Should work | X65 HE | 2268 | Hall effect | — |  |
| 🟡 Should work | X65 Ultra | 4328 | Hall effect | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X68 MAX | 2755 | Hall effect | — |  |
| 🟡 Should work | X82 HE | 3086 | Hall effect | — |  |
| 🟡 Should work | X82 HE | 4327 | Hall effect | — |  |
| 🟡 Should work | X82 PRO HE | 2356 | Hall effect | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X82 PRO HE | 2935 | Hall effect | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X85 PRO | 1724 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X86 | 1967 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X86 | 2408 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X98 HE | 2964 | Hall effect | — |  |
| 🟡 Should work | X98 PRO | 1996 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟡 Should work | X98 PRO | 2934 | mechanical | 2.4 GHz, Bluetooth |  |
| 🟠 Partial | Beat75 | 2633 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | K85 | 1466 | Hall effect | — | No actuation menu yet: its magnetic settings use other units. |
| 🟠 Partial | K85 | 2552 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | K85 | 3334 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | K85 PRO HE | 2978 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | K86 | 4094 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R68 HE | 3650 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R82 HE | 2844 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R82 PRO HE | 2798 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R86 HE | 3909 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R86 HE | 3973 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R86 PRO | 3910 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R86 PRO HE | 2793 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R86 PRO HE | 2982 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R86 Ultra | 3477 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R96 PRO | 3788 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R96 Ultra | 3774 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R98 GT | 3748 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R98 HE | 3743 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R98 HE | 3903 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R98 PRO | 3754 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R98 PRO HE | 4068 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | R98 Ultra | 3737 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X65 (UK) | 3379 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X65 HE | 1025 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X65 PRO HE | 2308 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X65 PRO HE | 2938 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 HE | 2270 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 HE | 2472 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 HE | 2902 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 HE BR | 3957 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 HE V2 | 4298 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 MAX | 3796 | Hall effect | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 PRO HE | 2370 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 PRO HE | 2901 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 Ultra | 2650 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X68 Ultra | 2833 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X820 PRO | 3221 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X820 SE | 3865 | mechanical | — | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X820 Ultra | 2804 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X820 Ultra | 3461 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X820 Ultra | 3922 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X83 PRO | 3870 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X83 PRO | 3886 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X83 PRO | 3908 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X83 PRO | 3991 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X83 Ultra | 3920 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 | 4039 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 MAX | 2864 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 PRO | 2952 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 PRO | 3451 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 PRO | 3504 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 PRO | 4084 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X85 Ultra | 2769 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X87 Ultra | 2660 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X87 Ultra | 2852 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X87 Ultra | 3438 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X96 HE | 2792 | Hall effect | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| 🟠 Partial | X98 PRO | 4109 | mechanical | 2.4 GHz, Bluetooth | Whole-keyboard settings only: its key map is not known yet. |
| ⚪ Recognised | AJAZZ × Attack Shark AK029 V2 | 4244 | Hall effect | 2.4 GHz, Bluetooth | Its command set has no driver yet. |

<!-- /generated:lineup -->

## Not supported

| Status | Device | Why |
|---|---|---|
| 🔴 | X2, X2 PRO, X5 mice | No configuration software exists (PAW3212, fixed DPI steps). |
| 🔴 | G6, A2 mice | "No driver" per the store; buttons not programmable. |
| 🔴 | X75, AKS068, AKS068 PRO | QMK / VIA boards: use [usevia.app](https://usevia.app). |
| 🔴 | AK820, AK820 PRO, AK832 | AJAZZ boards with another command set. |
| 🔴 | X87, X66, X98, M71, M36 HE | In no registry we could find; protocol unknown. |
| 🔴 | K87, K68, K6, M87 | Discontinued; no software. |
| 🔴 | ATTACK SHARK × AJ159P | AJAZZ collaboration mouse; firmware unknown. |
| 🔴 | MEGA B2's magnetic switches and haptics; screens and knobs; the X11 PRO V2's dock | Protocols not known. The rest of those devices is supported where its family is. |

Beken mice with no USB id of their own that we know — X11 SE, X11 PRO V2,
X3 MAX, X3 PRO (first revision), X8 SE, G3, G3 PRO, V3, V3 PRO, V6 — and any
Beken mouse on the generic receiver `1D57:FA60`, which several brands use, are
not claimed at all.

## Missing a device?

1. Download [`tools/SharkDeck-device-report.bat`](../../tools/SharkDeck-device-report.bat)
   (Windows; also attached to each release) and run it. Windows may warn about
   a file from the internet: **More info → Run anyway**. It finds your device
   (one of a brand it does not know, you unplug and plug back in) and reads how
   it identifies itself. It changes nothing on the device and sends nothing
   anywhere.
2. It then makes a **recording**, about 30 minutes. It needs
   [USBPcap](https://github.com/desowin/usbpcap/releases), a free USB capture
   driver (the one Wireshark uses). If it is missing, the tool offers to
   install it: it downloads the official installer, runs it only if it is the
   very file Wireshark ships, makes sure Windows accepts its driver (and takes
   it out again if not), and opens again by itself after the restart USBPcap
   needs. A small window then walks you through the official software,
   one setting at a time, while USBPcap records what the software and the
   device say to each other, the device staying plugged in where it is. Only
   that device's traffic is kept, what you type on it is blanked out, and a
   picture of the official software is taken at each step. It all goes into a
   .zip on your Desktop, the report included. Look through the pictures before
   sending it: anyone can download what is attached to an issue.
3. [Open a "New device" issue](https://github.com/alexandrewillame/shark-deck/issues/new?template=new-device.yml)
   and attach the .zip (or, without a recording, the report the tool saved on
   your Desktop).

A device that speaks a protocol Shark Deck already knows can usually be added
from the report alone, as 🟡 until its owner confirms it. One on a protocol
nobody has documented yet (the original X11, on its Beken chip) is written from
its recording, and stays 🟡 until its owner has tried a test version.

## How devices are recognised

The USB vendor and product id only say which protocol **family** a device
speaks — `3151:5029` is about a hundred boards of several brands, and
`3554:F517` is both the V8's receiver and another brand's mouse. So a device
attaches as "Identifying…", is sent nothing but its family's identify command,
and is bound to a model only by what its firmware answers. Another brand's
device on the same chip gets a "Not an Attack Shark device" card and is never
written to. Details: [`docs/protocol/README.md`](../protocol/README.md).

| Family | USB vendor id | Models | Identified by |
|---|---|---|---|
| ROYUAN keyboards (gen2, yc500) | 3151, 39AB | the keyboards above | firmware model id (`0x8F`) |
| Compx "MOUSE HUB" | 3554 (receivers F517, FB44, FB35; cables F515, F516, FB43) | V8 and its successors | identify reply: cid 124 + model number (mid) + link |
| GearHub-V5 | 3151 (cable 4026, receiver 402D) | R2, R3, X3 PRO (second revision) | device id (`0x8F`) |
| JXC | 373E | R5 ULTRA, R6, R8 | the product id (no model read exists) |
| Beken | 1D57 (X8 PRO 8K receiver FA65) | X11, X8 PRO, X8 PLUS, X1, R1 / X6 / X3 | the product id — the X8 PRO driven through its 8K receiver, the rest shown |

Menus follow the model, never its name: one marketing name can cover several
firmware ids with different hardware (three X87 ULTRA ids, one of them
mechanical). Researched November 2026 from the official store, the
manufacturer's site, the vendor's own device registry (through sharkfin), the
community projects listed in [`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md),
and linux-hardware.org.

## Known gaps

- The R85HE's key map is the only hand-verified one. Imported maps are checked
  against the board's own keymap when it connects; below 90 % agreement the
  board falls back to whole-keyboard settings.
- Over a 2.4 GHz receiver, a factory reset and the live key-travel test need
  the cable.
