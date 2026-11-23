# Beken mice (VID 0x1D57)

X11, X11 SE, X11 PRO V2, R1, X6, X3, X3 MAX, X3 PRO (first revision), X1,
X8 SE, X8 PLUS, X8 PRO, G3, G3 PRO, V3, V3 PRO, V6.

**Shark Deck drives two of them: the X8 PRO through its 8K receiver
(`1D57:FA65`) and on its cable (`2126`), and the X11 on its cable (`FA55`) and
through its receiver (`FA60`)**,
`app/src/main/devices/drivers/beken-8k-mouse.ts`. The others it shows and never
talks to (`app/src/main/devices/catalog/beken-mice.ts`): a
card with the model's name where its PID is its own, "Not supported yet",
nothing read or written. This page records what is known, so a driver can be
written once someone can check it on a mouse.

## The X8 PRO's 8K receiver (FA65)

From an owner's USB recording of the vendor's "Attack Shark Software" 1.0.0.2,
made with the device report tool (78 steps, November 2026,
[issue #1](https://github.com/alexandrewillame/shark-deck/issues/1)). Every
frame Shark Deck sends reproduces a recorded one byte for byte
(`beken-8k-mouse.test.ts`), but none has reached an X8 PRO from Shark Deck yet:
`ported-from-vendor`, and 🟠 in the lineup until its owner has tried it.

**Transport.** Output report 4 on the vendor collection `FF01:0002`
(interface 2), 64 bytes; the receiver answers on input report 4. The mouse
says things unasked on `FF00:0001`, input report 3, which Shark Deck reads
beside the settings collection (`DeviceDescriptor.events`): `03 08 40 <state>
<percent>` (the battery, every 2 s; state 3 on the cable, charging; `08` is the
X8 PRO's model byte) and `03 08 10 <stage>` (the DPI button). The stage it
announces is the one Shark Deck sends with the next DPI-block change, so a
change no longer moves the mouse back to the stage Shark Deck last sent.

**Frame.** `04 <len> 00 <cmd> <inner> 01 <body…> <sum>`:

- `<len>`: the bytes from the report id to the end of the checksum;
- byte 2: `00` (the macro upload continues in a second report with `01`);
- `<inner>`: the bytes from `<cmd>` to the end of the body;
- `<sum>`: the 16-bit big-endian sum of every byte before it.

A data block ends its body with the 16-bit sum of its own data bytes.

**Answers.** `04 06 c0 01 00 cb` when the receiver has the frame, then
`04 06 c1 <s> 00 <sum>`: `01` when the mouse took it (10–700 ms in the
recording), `00` after about 2 s without an answer from the mouse.

**Nothing is read.** The vendor software never asks the mouse for anything: it
keeps the settings itself and always writes whole blocks. So does Shark Deck,
keeping each block as it last went out (per model). Until a block has been
sent once, the menus show starting values, and the first change sends the
whole block as shown; the confirmation before the first write says so.

| Command | Block | Content |
|---|---|---|
| `0x04` | DPI and sensor | 47 data bytes: flags A (bit 4 lift-off 2 mm, else 1 mm; bit 0 ripple control), flags B (bit 4 angle snapping; bit 0 motion sync), stage mask (`3f` = six stages), one "doubled" bit per stage, `00`, 8 low bytes, 8 high bytes, active stage (1-based), 8 RGB colours, `02`; then their sum and 4 zeros. A stage is `(raw + 1) × 50`, or `× 100` with its doubled bit: 40000 is raw 399 doubled. |
| `0x05` | power | 8 data bytes: `00 03 a8 00 ff 00` (meaning unknown, sent back unchanged), sleep in half-minutes, key response in 2 ms units; then their sum and 2 zeros. |
| `0x06` | polling | `<code> <FF − code> 00 00 00 00`: 125 Hz `14`, 250 `24`, 500 `34`, 1000 `44`, 2000 `54`, 4000 `64`, 8000 `74`. |
| `0x08` | buttons | 18 slots `[action, modifiers, usage]`, then their sum. Slots 0–2 left, right, middle; 3 the DPI button; 4 the rear side button (Backward by default); 5 the front one (Forward); 6 `3c` (unknown); 16–17 the wheel. |
| `0x09` | macros | Two reports: `04 40 00 09 6f 11 <data 56>` and `04 39 01 <data 50> <sum16 of the data>`, each closed by the sum of its own bytes. The data, 106 bytes: four zeros, the repeat count, the event count, then two bytes an event — the delay after it in ms (7 bits), its top bit set on a release, then the key's usage. `11` is the macro's slot: the vendor software gave its first macro `11` and its button `12 00 11`. The receiver answers the first report `c0` only, the second `c0` then `c1`. |
| `0x0C` | ? | `0c 0a 01 fe 01 fe 00 00 00 00`, sent before every whole-profile write. Never sent by Shark Deck. |

Button actions recorded: `01` off, `02` left, `03` right, `04` middle, `05`
backward, `06` forward, `08` fire (clicks while held, nothing to set), `09`
scroll up, `0e` / `0f` DPI + / −, `10 00 03` easy aim, `11` a key (modifier
bits, then its usage: Ctrl + C is `11 01 06`), `12` a macro, `17` next track,
`18` play / pause, `1a` mute, `1b` / `1c` volume + / −, `1d` calculator, `1e`
email, `20` / `21` browser forward / back, `22` browser stop, `23` My Computer,
`24` refresh, `25` browser home. The vendor software's Favorites is the key
Ctrl + Shift + O (`11 03 12`), and its whole shortcut list is keys with
modifiers (Alt + F4 is `11 04 3d`, Win + Shift + S `11 0a 16`). Inferred from
the defaults and the run of codes: `0a` scroll down, `0d` DPI loop, `16`
previous, `19` stop. Not seen: media player, search.

Profiles live in the vendor software: switching one rewrites every block
(`0x0C`, `0x04`, `0x05`, `0x06`, `0x08`, a second apart). Its macro editor
shows each event with its own delay ("A Pushed 100, A Release 10, B Pushed
100, B Release 1" is `64 04 8a 04 64 05 81 05`); a mouse button in a macro,
and a delay above 127 ms, are in neither recording, so Shark Deck refuses
them. Neither recording has the vendor's "Reset Profile".

## The X8 PRO on its cable (2126)

From the owner's second recording (79 steps, 2026-11-19), over the cable. The
mouse takes the very blocks the receiver carries, as **feature reports** on its
`000B:0000` collection (interface 2): `<id> <len> 01 <data> <sum16 of data,
big-endian>`, the length counting the zeros the receiver's frames pad with —
DPI `04 38` (47 data bytes), power `05 0f` (8), buttons `08 3b` (54); polling is
`06 09 01 <code> <0xFF − code> 00 00 00 00`. Byte for byte in
`beken-8k-mouse.test.ts`; `Beken8kCableMouse` in `drivers/beken-8k-mouse.ts`.

**It answers reads.** `a0 <id> <len> 00 01` (feature report 0xA0) asks for a
block; a GET of report 0xA0 answers `a0 01` once it is ready; a GET of the
block's report returns it. The vendor software reads polling, DPI and power so
when it starts (never the buttons). So on the cable every change starts from
the mouse's own block, its active stage included.

**Polling holds two rates.** The byte's high half is the receiver's rate
(`1`–`7` = 125–8000 Hz), the low half the cable's (`1`–`4` = 125–1000 Hz):
through the receiver the software changes the high half only, on the cable the
low half only.

**What both recordings show.**
- The DPI block's byte 21 (frame byte 24 on the cable) is the active stage,
  1-based. The DPI button changes it on the mouse, and the mouse announces it
  (`03 08 10 <stage>` on input report 3, through the receiver and on the
  cable). Shark Deck sends the stage it last heard, so a change does not move
  the mouse to another stage.
- The eight colours, in the vendor software's order: red, green, blue, yellow,
  cyan, magenta, orange, white. The vendor software never changes them, and
  the mouse keeps them so (the cable's read). The mouse starts its light over
  at the first entry whenever a DPI block lands, on the stage the block makes
  current: sent stage 1, every change came back red; sent stage 2, stage 2 lit
  red and stage 1 magenta (the X8 PRO's owner, 2026-11-19 and 11-23). Shark
  Deck turns the first entries so the light starts on the current stage's own
  colour (`bekenStageColours`), and each stage keeps its colour. `inferred`.
- Button slots: 0 Left, 1 Right, 2 Middle, 3 the DPI button (underneath),
  4 Backward (button 5, the side button nearer the rear, factory `05`),
  5 Forward (button 4, nearer the front, factory `06`). The report tool used to
  name the rear button "button 4 (Back)" and the front one "button 5
  (Forward)", the reverse of the vendor software's numbers; it now names them by
  where they are, and the first driver, which followed the tool's names, had
  4 and 5 swapped.
- Power: sleep in half-minutes (1–60: 30 s – 30 min), key response in ms ÷ 2
  (2–25: 4–50 ms), deep sleep in minutes in the high halves of bytes 1 and 2,
  as on the X11: the vendor's pages showed 11 min as `b8` and 4 min as `48`
  in byte 2 (below the 10 min its owner gave as the slider's end).
- Macros: the receiver's data as feature report 9, two reports of 64 bytes,
  `09 40 11 00 <data 60>` and `09 40 11 01 <data 46> <sum16>`, 200 ms apart;
  the mouse answers `03 08 50 00 09` on its announcement collection
  (`000A:0000` on the cable).

## The X11 (cable FA55, receiver FA60)

From an owner's recording of the same vendor software, 1.0.0.2 (95 steps,
2026-11-19, [issue #2](https://github.com/alexandrewillame/shark-deck/issues/2)),
on the cable. `BekenX11Mouse` in `drivers/beken-8k-mouse.ts`: every frame it
sends reproduces a recorded one byte for byte (`beken-8k-mouse.test.ts`); none
has reached an X11 from Shark Deck yet.

**The X8 PRO's cable protocol.** The same feature reports on `000B:0000`
(interface 2), the same blocks, checksums and button codes. The cable's reports
are shorter — DPI 52 bytes, power 13, polling 9, buttons 59 — while the length
bytes still count the padding (`04 38`, `05 0f`).

**One read holds every block.** The vendor software asks with
`a0 0a 80 00 01` (feature report 0xA0; the mouse turned its first request down
each time, and took the same one 200 ms later), gets `a0 01` from report 0xA0
300 ms on, then reads report 10, 128 bytes: `0a 80 01`, the polling code and its
complement, the DPI block (47 bytes and a zero), the power block, the button
block — each followed by its sum, **low byte first** — then zeros. Each block
is the one the software's next change sent, that change aside. Button slots the
mouse holds as `00 00 00` the software sends as `01 00 00` (off). It also reads
report 11 (`0b 08 01 10`, meaning unknown). Shark Deck reads report 10 the same
way, when a tab opens and after each change.

**What differs from the X8 PRO.**
- DPI: a stage is its low byte × 42.5, floored when sent — 50 → `01`, 400 →
  `09`, 800 → `12`, 1600 → `25`, 3200 → `4b`, 6400 → `96`. A high byte `01`
  doubles the step (12000 → `8d`, high `01`); the stage's bit in both bytes 3
  and 4 doubles it again (22000 → `81`, high `01`, both bits). 50 to 22000.
- The switches: byte 0 bit 0 is angle snapping, byte 1 bit 0 ripple control.
  No lift-off or motion sync.
- Polling: one code, 1000 ÷ the rate (`08` 125 Hz, `04`, `02`, `01` 1000 Hz).
- Button slots: 0 Left, 1 Right, 2 Middle, **6 Forward (button 4, the front
  side button, factory `06`), 7 Backward (button 5, the rear one, factory
  `05`)**, 16–17 the wheel, 5 the DPI button. The vendor software lists five
  buttons and draws "4 Adelante" (Forward) on the front one and "5 Atrás" on
  the rear one (its pages, in the recording); it does not let you remap the
  DPI button, and neither does Shark Deck. The owner's steps mixed the two
  side buttons up (the report tool still named them the wrong way round
  then); the factory actions, the vendor's reset, its read and its pages
  agree.
- The power block holds the light too: the high half of byte 0 is the
  effect (0 off, 1 static, 2 breathing, 3 neon, 4 colour breathing, 5 static
  colour, 6 mixed breathing — the vendor software's names, through its
  owner's Spanish), the low half of byte 1 the speed (1 the fastest to 5 the
  slowest), that of byte 2 the brightness (1 to 8), bytes 3–5 the colour.
  Static takes a brightness and a colour, breathing a speed and a colour,
  static colour a brightness, neon a speed (the software's pages). Deep
  sleep, 1–60 min, is the high half of byte 1 then that of byte 2 (`01 38`:
  3 min). Then sleep in half-minutes and key response in ms ÷ 2, as on the
  X8 PRO. Since the block holds all of that, Shark Deck sends it only as the
  mouse has just reported it.
- The active stage is the DPI block's byte 21, 1-based; the factory has
  stage 2.

**Input report 3** carries `03 55 …` (`55` is the X11's model byte):
`40 <state> <percent>` every 2 s (the battery; state 3 on the cable), `10
<stage>` when the DPI button moves, `50 00 <report>` after each block written.
Shark Deck reads the battery and the stage there, sending nothing.

**Macros** are the X8 PRO's (above): the same vendor software, the same
report sizes. Its owner built one in the software's macro manager but did not
put it on a button, so nothing was sent: the X11's are inferred from the
X8 PRO's recordings.

**Through its receiver (FA60).** The receiver ("2.4G Wireless Device" by
LXDDZ) is one other brands' mice use too, and it does not say what is behind
it. The mouse does, unasked: byte 1 of its notifications on input report 3 is
its model (`55`), and they come on a collection of their own (`000A:0000`).
So Shark Deck opens that one first and sends nothing; only on `55` does it
open the settings collection (`000B:0000`) and drive the mouse — another
model's byte gives a named card, an unknown one an "Unrecognised" card, and
nothing is written to either. Through the receiver the vendor software read
report 10 and sent the cable's very blocks, padded to the receiver's report
sizes (56, 15, 9, 59 bytes). Once, a mouse just woken answered a change with
`03 55 00 00 01` then `03 55 01 00 00`, and the software sent the change
again 500 ms later until `03 55 50 00 05` came; Shark Deck sends it again
while the mouse reads back otherwise.

Not driven yet: the vendor's reset (`0c 0a 01 fe 01 fe` on report 12, then
every block), and a mouse button in a macro (its owner's macro had one, but
it was never sent).

## The others: why there is no driver yet

- **Reads need a permission mailbox.** Every read goes through feature report
  `0xA0` (`A0 <id> <len> 00 <param> 00 00 00`, wait 250 ms, GET `A0` byte 1
  = 1 means granted, then GET `<id>` at its declared length). One grant allows
  one read; refusals come in bursts with a cooldown. The community's
  hardware-verified reads were all on Linux; the X8 PRO's and the X11's
  recordings show the vendor software reading this way on Windows. Chromium cannot
  reach the configuration collection at all (it carries only constant items),
  so the browser edition never could.
- **Dangerous neighbours.** Report `0x10` enters the bootloader — the mouse
  re-enumerates as A745:0033 and stays there across replugs. Writing `0x0B`
  unpaired a receiver. `0x0C` changes the profile count. `0x07` and
  `0x22`–`0x2E` are unknown.
- **Pacing.** Over the cable every other write stalls (EPIPE) and has to be
  resent; through a receiver, writes closer than about a second apart froze
  the link until a replug.
- **Per-model differences.** The X11 encodes DPI in steps of 42.5 with two
  doubling bits (above; a community tool uses a 220-entry table for it); the
  X6 and X8 PRO linearly, each differently. The X8 PRO's 8K
  receiver speaks its own protocol (above). Bytes 3 and 4 of the DPI report
  carry angle snap / ripple on one model and lift-off / motion sync on
  another. Button slots rotate between write and read on the X8 PRO.
- **Identification is shaky.** The receiver FA60 is generic (Delux and others
  use it); the model comes from byte 1 of the input report-3 frames, and a
  real X6 sends `0x10`, which is the R1's byte.

## What is known about the others

| Report | Content | Readable |
|---|---|---|
| `0x04` | DPI stages, enable mask, active stage, colours (52 bytes cable / 56 receiver), BE sum checksum | yes (mailbox) |
| `0x05` | light mode / speed / brightness / RGB, sleep (half-minutes), debounce (ms / 2) | yes |
| `0x06` | poll rate: `06 09 01 code FF−code`, 08=125 … 01=1000 (X8 PRO differs) | yes |
| `0x08` | 18 button slots `[action, mods, usage]` | yes, slot order caveats |
| `0x09` | macros (the X8 PRO's two pages, above) | no |
| `0x0B` | firmware version (X8 PRO) | read by the vendor software on the X8 PRO and the X11 (`0b 08 01 10`); writing it unpairs |
| `0x10` | **bootloader — never** | — |
| `0xA0` | read-permission mailbox | — |
| input 3 | `03 model event p1 p2`: battery (`40`), DPI stage (`10`), write ACK (`50`), profile (`80`) | pushed |

PIDs: X11 FA55 (cable) / FA60 (receiver); X8 PRO 2126 / FA65 (8K receiver);
X1 2111; X8 PLUS 2124; R1, X6, X3 FA61 on their cables. Receiver model bytes
(byte 1 of report 3): X11 55, X11 SE 07, X11 PRO A9, R1 10, X6 85 (a real one
sent 10), X3 4D, X3 MAX 4E, X3 PRO 4F or 01, X1 B1, X8 SE 02, X8 PLUS 06,
X8 PRO 08, G3 04, G3 PRO 0E, V3 EA, V3 PRO E5, V6 24.

## Sources

The X8 PRO (receiver and cable): an owner's recordings of the vendor software
(issue #1). The X11 on its cable: another owner's recording (issue #2). The rest, provenance as the community tools report it; nothing
there is ours.

- HarukaYamamoto0/attack-shark-x11-driver (MIT) — captures and protocol docs.
- HolyJoey/attack-shark-x11 (MIT) — cable and receiver checked on hardware.
- KaiSta/attackSharkOnLinux (no licence file: facts only) — mailbox timing.
- Zelozzzz/dorsal `xseries.py` (MIT) — the DPI table, 310 vendor packets.
- OpenMouse mouse-protocol (AGPL-3.0: facts only) — issues #161, #171, #253;
  the X8 PRO test document attached to #171.
- clevim/OpenSharkX11, devmarciordg/attackshark-x11-linux,
  akawazak/attack-shark-x11-community-driver, blak0p/attack-shark-linux,
  cyberps96/attack-shark-ctl (MIT); xb-bx/attack-shark-r1-driver (no licence
  file: facts only).
