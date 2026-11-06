# Attack Shark lineup

Every Attack Shark keyboard and mouse we could find, what it runs on, and
what Shark Deck does with it. Researched November 2026 from the official
store (attackshark.com and its UK mirror), the manufacturer's site
(attackshark.cn), the vendor's own device registry (through sharkfin), the
community protocol projects listed in
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md), and linux-hardware.org.

**Only two devices have been checked on hardware: the R85HE and the V8.**
Everything else Shark Deck drives is built from protocol documentation and
ships unverified: every write is read back, and a backup is taken before the
first one (CLAUDE.md invariant #1).

## How a device is recognised

The USB vendor and product id only say which protocol **family** a device
speaks — `3151:5029` is about a hundred boards of several brands, and
`3554:F517` is both the V8's receiver and another brand's mouse. So a device
attaches as "Identifying…", is sent nothing but its family's identify
command, and is bound to a model only from what its firmware answers. Another
brand's device on the same chip gets a "Not an Attack Shark device" card and
is never written to. Details: [`docs/protocol/README.md`](../protocol/README.md).

| Platform | VID | Models | Identified by |
|---|---|---|---|
| ROYUAN keyboards (gen2, yc500) | 3151, 39AB | the keyboards below | firmware model id (`0x8F`) |
| Compx "MOUSE HUB" | 3554 | V8 and its successors | identify reply: cid 124 + model (mid) + link |
| GearHub-V5 | 3151 | R2, R3, X3 PRO (second revision) | device id (`0x8F`) |
| JXC | 373E | R5 ULTRA, R6, R8 | the PID (no model read exists) |
| Beken | 1D57 | X11 family, X3/X6/X8/G3/V3/V6 families, R1, X1 | the PID — shown, not driven |
| none | — | X2, X2 PRO, X5, G6, A2 | no configuration at all |

## What each support level means

- **checked on hardware** — frames confirmed on a real unit (captures and
  read-back sweeps).
- **driven, not yet checked** — Shark Deck reads and writes it, from the
  protocol facts in [`docs/protocol/`](../protocol/). Expect the occasional
  "did not read back as written".
- **driven by its sensor class** — a Compx Hub mouse whose model number (mid)
  no source has mapped yet: it gets the settings every mouse of its sensor
  class shares, and nothing model-specific.
- **named only** — Shark Deck shows the card with its name and changes
  nothing: no driver for its command set yet.

Menus follow the model, never its name: one marketing name can cover several
firmware ids with different hardware (three X87 ULTRA ids, one of them
mechanical). A board whose key map is not known gets whole-board settings
only — actuation for every key at once — rather than per-key settings
addressed to guessed keys.

## Supported models

<!-- generated:lineup — `npm run lineup` rewrites this block -->

### Keyboards

82 Attack Shark model ids from the vendor's registry (via sharkfin).

| Model | Model id | USB | Command set | Switches | Key map | Wireless | Colours (photos) | Shark Deck |
|---|---|---|---|---|---|---|---|---|
| AJAZZ × Attack Shark AK029 V2 | 4244 | 3151:5029 | unknown | Hall effect (the vendor offers no settings) | — | 2.4 GHz, Bluetooth | — | named only |
| Beat75 | 2633 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| K75 RGB | 1343 | 3151:4015 | yc500 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| K75 RGB | 1679 | 3151:4015 | yc500 | mechanical | imported, checked at connect | no | — | driven, not yet checked |
| K85 | 1466 | 3151:502d | yc500 | Hall effect (no actuation menu yet) | imported, checked at connect | no | Grey, Blue, Starry Black | driven, not yet checked |
| K85 | 2552 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Grey, Blue, Starry Black | driven, not yet checked |
| K85 | 3334 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Grey, Blue, Starry Black | driven, not yet checked |
| K85 PRO HE | 2978 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| K86 | 1168 | 3151:4015 | yc500 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Retro Grey, Retro Blue, Lavender Blue | driven, not yet checked |
| K86 | 2730 | 3151:5002 | gen2 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Retro Grey, Retro Blue, Lavender Blue | driven, not yet checked |
| K86 | 4094 | 3151:5056 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Retro Grey, Retro Blue, Lavender Blue | driven, not yet checked |
| M86 | 4012 | 3151:5056 | gen2 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Gradient Black, Pink, White, Black | driven, not yet checked |
| R68 HE | 3650 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Ink Shade, Ice Ninja, Lake Green, Black | driven, not yet checked |
| R82 HE | 2844 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Black, White Contours, Pink Contours, Black Gradient | driven, not yet checked |
| R82 PRO HE | 2798 | 3151:502f | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R85HE | 3123 | 3151:5029 | gen2 | Hall effect | verified | no | Black, Grey Gradient, White, White Contours | **checked on hardware** |
| R85 Ultra | 2968 | 3151:5030 | gen2 | Hall effect | imported, checked at connect | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R86 HE | 3909 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | Ink Shade, Ice Ninja, Moonlight | driven, not yet checked |
| R86 HE | 3973 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | Ink Shade, Ice Ninja, Moonlight | driven, not yet checked |
| R86 PRO | 3910 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R86 PRO HE | 2793 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R86 PRO HE | 2982 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | — | driven, not yet checked |
| R86 Ultra | 3477 | 3151:504c | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R96 PRO | 3788 | 3151:504c | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R96 Ultra | 3774 | 3151:504c | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R98 GT | 3748 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| R98 HE | 3743 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | Ink Shade, Ice Ninja, Black, Moonlight | driven, not yet checked |
| R98 HE | 3903 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | Ink Shade, Ice Ninja, Black, Moonlight | driven, not yet checked |
| R98 PRO | 3754 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | — | driven, not yet checked |
| R98 PRO HE | 4068 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | — | driven, not yet checked |
| R98 Ultra | 3737 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X60 HE | 2929 | 3151:5029 | gen2 | Hall effect | imported, checked at connect | no | — | driven, not yet checked |
| X65 | 2942 | 3151:5029 | gen2 | Hall effect | imported, checked at connect | no | White, Black, Starry Black, White Contours, Black Contours | driven, not yet checked |
| X65 (UK) | 3379 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | no | White, Black, Starry Black, White Contours, Black Contours | driven, not yet checked |
| X65 HE | 1025 | 3151:4010 | yc500 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | White, Black, Starry Black, White Contours, Black Contours | driven, not yet checked |
| X65 HE | 2268 | 3151:502d | gen2 | Hall effect | imported, checked at connect | no | White, Black, Starry Black, White Contours, Black Contours | driven, not yet checked |
| X65 PRO HE | 2308 | 3151:502f | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | White, Red, Yellow | driven, not yet checked |
| X65 PRO HE | 2938 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | White, Red, Yellow | driven, not yet checked |
| X65 Ultra | 4328 | 3151:502f | gen2 | Hall effect | imported, checked at connect | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X68 HE | 2270 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Black, White, Crystal White, Black Gradient, Black Contours, White Contours, Pink Contours | driven, not yet checked |
| X68 HE | 2472 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Black, White, Crystal White, Black Gradient, Black Contours, White Contours, Pink Contours | driven, not yet checked |
| X68 HE | 2902 | 3151:502d | gen2 | Hall effect | none: whole-board settings | no | Black, White, Crystal White, Black Gradient, Black Contours, White Contours, Pink Contours | driven, not yet checked |
| X68 HE BR | 3957 | 3151:5029 | gen2 | Hall effect | none: whole-board settings | no | — | driven, not yet checked |
| X68 HE V2 | 4298 | 39ab:9016 | gen2 | Hall effect | none: whole-board settings | no | Black, White, Crystal White, Black Gradient, Black Contours, White Contours, Pink Contours | driven, not yet checked |
| X68 MAX | 2755 | 3151:502d | gen2 | Hall effect | imported, checked at connect | no | Star White, White Contours, Black Contours | driven, not yet checked |
| X68 MAX | 3796 | 39ab:9016 | gen2 | Hall effect | none: whole-board settings | no | Star White, White Contours, Black Contours | driven, not yet checked |
| X68 PRO HE | 2370 | 3151:502f | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | Gradient Black, Black, White, Red | driven, not yet checked |
| X68 PRO HE | 2901 | 3151:502f | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | Gradient Black, Black, White, Red | driven, not yet checked |
| X68 Ultra | 2650 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X68 Ultra | 2833 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X82 HE | 3086 | 3151:5030 | gen2 | Hall effect | imported, checked at connect | no | — | driven, not yet checked |
| X82 HE | 4327 | 3151:502d | gen2 | Hall effect | imported, checked at connect | no | — | driven, not yet checked |
| X82 PRO HE | 2356 | 3151:502f | gen2 | Hall effect | imported, checked at connect | 2.4 GHz, Bluetooth | Comic, Black Contours, White Contours | driven, not yet checked |
| X82 PRO HE | 2935 | 3151:5030 | gen2 | Hall effect | imported, checked at connect | 2.4 GHz, Bluetooth | Comic, Black Contours, White Contours | driven, not yet checked |
| X820 PRO | 3221 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X820 SE | 3865 | 3151:5002 | gen2 | mechanical | none: whole-board settings | no | — | driven, not yet checked |
| X820 Ultra | 2804 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Dark Warrior, Star White, Star Black, Black Gradient, White Contours | driven, not yet checked |
| X820 Ultra | 3461 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Dark Warrior, Star White, Star Black, Black Gradient, White Contours | driven, not yet checked |
| X820 Ultra | 3922 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Dark Warrior, Star White, Star Black, Black Gradient, White Contours | driven, not yet checked |
| X83 PRO | 3870 | 3151:5056 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X83 PRO | 3886 | 39ab:9016 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X83 PRO | 3908 | 39ab:9007 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X83 PRO | 3991 | 39ab:9008 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X83 Ultra | 3920 | 3151:504c | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X85 | 4039 | 3151:502d | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Gradient Black, White Purple, BlackBerry, Gradient Purple | driven, not yet checked |
| X85 MAX | 2864 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X85 PRO | 1724 | 3151:4015 | yc500 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Starry Black, Cheese, Lavender, Moonlight, White Contours | driven, not yet checked |
| X85 PRO | 2952 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Starry Black, Cheese, Lavender, Moonlight, White Contours | driven, not yet checked |
| X85 PRO | 3451 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Starry Black, Cheese, Lavender, Moonlight, White Contours | driven, not yet checked |
| X85 PRO | 3504 | 3151:5002 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Starry Black, Cheese, Lavender, Moonlight, White Contours | driven, not yet checked |
| X85 PRO | 4084 | 39ab:9007 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Starry Black, Cheese, Lavender, Moonlight, White Contours | driven, not yet checked |
| X85 Ultra | 2769 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X86 | 1967 | 3151:4015 | yc500 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Milk White, Starry White, Starry Black | driven, not yet checked |
| X86 | 2408 | 3151:5025 | gen2 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Milk White, Starry White, Starry Black | driven, not yet checked |
| X87 Ultra | 2660 | 3151:502d | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X87 Ultra | 2852 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X87 Ultra | 3438 | 3151:504c | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Forged Carbon, Iced Orange, Shadow Jade | driven, not yet checked |
| X96 HE | 2792 | 3151:5030 | gen2 | Hall effect | none: whole-board settings | 2.4 GHz, Bluetooth | — | driven, not yet checked |
| X98 HE | 2964 | 3151:5030 | gen2 | Hall effect | imported, checked at connect | no | — | driven, not yet checked |
| X98 PRO | 1996 | 3151:4015 | yc500 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Cheese White, Star Black, Pink, Gradient Black | driven, not yet checked |
| X98 PRO | 2934 | 3151:5002 | gen2 | mechanical | imported, checked at connect | 2.4 GHz, Bluetooth | Cheese White, Star Black, Pink, Gradient Black | driven, not yet checked |
| X98 PRO | 4109 | 3151:5056 | gen2 | mechanical | none: whole-board settings | 2.4 GHz, Bluetooth | Cheese White, Star Black, Pink, Gradient Black | driven, not yet checked |

### Mice

| Model | Platform | USB | Identified by | Sensor | DPI | Colours (photos) | Shark Deck |
|---|---|---|---|---|---|---|---|
| V8 | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid 5 | PAW3950 | 50–42000 | Black, White | **checked on hardware** |
| X11 ULTRA | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid 11 | PAW3950 | 50–42000 | Black, Purple, Red | driven, not yet checked |
| F1 AIR | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid 20 | PAW3955 | 50–60000 | White & Black, White, Black | driven, not yet checked |
| X8 ULTIMATE / X8 ULTRA | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 1, 2, 3, 4, 5, 10, 11, 12, 18) | PAW3950 | 50–42000 | Black, White, Berry Red | driven by its sensor class, not yet checked |
| V5 | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 1, 2, 3, 4, 5, 10, 11, 12, 18) | PAW3950 | 50–42000 | Black, White | driven by its sensor class, not yet checked |
| R11 ULTRA | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 1, 2, 3, 4, 5, 10, 11, 12, 18) | PAW3950 | 50–42000 | Forged Black, Weave Black | driven by its sensor class, not yet checked |
| RS3 ULTRA | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 13, 14, 15, 16, 17, 21, 23) | PAW3955 | 50–52000 | Black, Silver, Red | driven by its sensor class, not yet checked |
| RS6 ULTRA | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 13, 14, 15, 16, 17, 21, 23) | PAW3955 | 50–52000 | Silver, Black | driven by its sensor class, not yet checked |
| V2 AIR | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 19, 20, 22) | PAW3955 | 50–60000 | White & Black, White, Black | driven by its sensor class, not yet checked |
| MEGA B2 | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 19, 20, 22) | PAW3955 | 50–60000 | White & Black, White, Black, Knight-Errant | driven by its sensor class, not yet checked |
| R5 TURBO | Compx Hub | receiver 3554:f517, fb44, fb35; cable f515, f516, fb43 | cid 124, mid not yet known (one of 19, 20, 22) | PAW3955 | 50–60000 | Dune, Black, White | driven by its sensor class, not yet checked |
| R2 | GearHub-V5 | cable 3151:4026, receiver 402d | device id 1893, 3009 | PAW3950 | 50–42000 | Grey, Black, White, Retro White, Purple & Blue | driven, not yet checked |
| R3 | GearHub-V5 | cable 3151:4026, receiver 402d | device id 1643, 3485 | PAW3395 | 50–26000 | White, Black, Grey, Purple Blue | driven, not yet checked |
| R3 | GearHub-V5 | cable 3151:4026, receiver 402d | device id 3309, 3310 | PAW3950 | 50–42000 | White, Black, Grey, Purple Blue | driven, not yet checked |
| X3 PRO | GearHub-V5 | cable 3151:4026, receiver 402d | device id 1660 | PAW3395 | 50–26000 | White, Black, Red | driven, not yet checked |
| R2 (newer MCU) | GearHub | 3151:5043 | device id 3016 | — | — | Grey, Black, White, Retro White, Purple & Blue | named only |
| R5 ULTRA | JXC | cable 373e:0046, receiver 0047 | its PID | PAW3950 | 100–42000 | White, Black, Red, Green | driven, not yet checked |
| R6 | JXC | cable 373e:0021, receiver 0022 | its PID | PAW3950 | 100–42000 | Black, White | driven, not yet checked |
| R8 | JXC | cable 373e:003a, receiver 003b | its PID | PAW3950 | 100–42000 | — | driven, not yet checked |

<!-- /generated:lineup -->

Beken mice (shown, not driven — see [`mouse-beken.md`](../protocol/mouse-beken.md)
for why): X11 (1D57:FA55), X8 PRO (2126 cable, FA65 8K receiver), X1 (2111),
X8 PLUS (2124), and the R1, X6 and X3 on their shared cable PID FA61. Through
the generic receiver FA60, which several brands use, they are not claimed at
all. X11 SE, X11 PRO V2, X3 MAX, X3 PRO (first revision), X8 SE, G3, G3 PRO,
V3, V3 PRO and V6 have no PID of their own that we know.

## Not configurable by Shark Deck

| Device | Why |
|---|---|
| X2, X2 PRO, X5 mice | no configuration software exists (PAW3212, fixed DPI steps) |
| G6, A2 mice | "no driver" per the store; buttons not programmable |
| X75, AKS068, AKS068 PRO | QMK / VIA boards: use [usevia.app](https://usevia.app) |
| AK820, AK820 PRO, AK832 | AJAZZ Sonix boards, another command set |
| X87, X66, X98, M71, M36 HE | in no registry we could find; protocol unknown |
| K87, K68, K6, M87 | discontinued; no software |
| ATTACK SHARK × AJ159P | AJAZZ collaboration mouse; firmware unknown |
| MEGA B2's magnetic switches, haptics; screens and knobs; X11 PRO V2's dock | protocols not known: the rest of those devices is driven where its platform is |

## Gaps worth knowing

- The R85HE's slot map is the only hand-verified one. Imported maps are
  checked against the board's own keymap when it connects; below 90 %
  agreement the board falls back to whole-board settings.
- The K85 (model id 1466) is the one magnetic yc500 board: its magnetic pages
  use different units, so it has no actuation menu yet.
- Over a 2.4 GHz receiver, a factory reset and the live key-travel test need
  the cable.
- Beken mice: see above.
