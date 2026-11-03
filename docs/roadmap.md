# SharkDeck — brief & roadmap

This is the original product brief for SharkDeck plus the running list of open
work. It was previously the loose `Notes.txt` at the repo root.

## Why this project exists

The user owns an Attack Shark gaming keyboard (R5HE, magnetic 8 KHz) and Attack
Shark gaming mice (V8, wireless 8 KHz). The vendor's configuration software
("Mouse Hub" and "Driver v4") shipped malware in a recent update and is no
longer trusted. SharkDeck is an open-source, auditable replacement that
configures the same hardware over USB-HID with a gamer aesthetic, built on a
modular architecture so new devices and features can be added later.

Reference hardware and vendor software on the dev machine:

| | Device | Vendor app |
|---|---|---|
| Keyboard | Attack Shark R5HE (magnetic 8 KHz) | Attack Shark Driver v4 — `C:\Users\alexa\AppData\Local\Programs\Attack Shark Driver v4\Attack Shark Driver v4.exe` |
| Mouse | Attack Shark V8 (wireless 8 KHz) | Attack Shark Mouse Hub — `C:\Program Files (x86)\ATTACK  SHARK MOUSE HUB\...\ATTACK  SHARK MOUSE HUB.exe` |

The Python profile switcher that seeded the auto-switch feature now lives in
[`legacy/attack-shark-profile-switcher/`](../legacy/attack-shark-profile-switcher/);
its V8 reverse-engineering capture session is in
[`reverse-engineering/`](reverse-engineering/).

## Target feature set

### Core app
- Welcome screen prompting the user to connect an Attack Shark USB peripheral or receiver.
- Every detected device shown as a card: device image, model name, battery, online/offline state, contextual tooltip (offline → turn on / recharge / re-pair, etc.).
- Clicking a card opens that device's configuration menu.
- Per-device tabs driven by capability — every device has a profile/preset page; only some have an LED-animation page, a screen page, etc.
- Automatic profile switching: when a configured game process is running, every device switches to a chosen profile.

### Mouse — parity with the vendor software
DPI, poll rate, sensor settings (LOD, ripple control, angle snapping, motion
sync, performance/"select" mode), button remap, macros, sleep timer, LED
indication (receiver LED, DPI LED, body LED), 20 KHz scanning frame rate, long-
distance mode, angle mode, firmware info & update, pair tool, restore defaults,
start-at-boot, shortcut to Windows Mouse Properties, UI language.

### Mouse — beyond the vendor software
Auto profile switching (seeded from the legacy Python V8 switcher); other
good-gaming-mouse-software conveniences as identified.

### Keyboard — parity with the vendor software
Per-key magnetic switch settings (needs a reverse-engineering session on Driver
v4), Fn / key-function remap, screen settings (for keyboards with a screen),
poll rate, per-key and side LED settings, macros, shared-LED community portal.

### Keyboard — beyond the vendor software
Profiles, auto profile switching, other conveniences as identified.

## Open work

### 2026-09-08 pass — wireless firmware, DPI read-back cross-talk, angle mode

Three user-reported mouse bugs, worked with a real V8 on the 2.4 GHz dongle.

- [x] **The mouse's firmware version reads over the air — it is command
      `0x12`.** The previous conclusion ("not obtainable wirelessly, plug in the
      cable") was wrong, and the reasoning behind it was too: the vendor's
      `CS_UsbFinder_GetVersion` call in the capture returns `0x303` through a
      **dongle** path, not a cable one, and wraps a `0x12` exchange sitting two
      lines away in the same capture. Reproduced on hardware through a dongle
      whose own `bcdDevice` is `0x300`, so the two are different numbers rather
      than one value read twice. `getFirmware` now reports the receiver from
      the descriptor and the mouse from `0x12`, and caches the first success so
      a later doze keeps showing it. `fw.unparsed` ("connect by USB cable")
      becomes `fw.asleep` ("wake the mouse") in all 11 locales.
- [x] **"Setting 0x2 did not read back as written" was reply cross-talk.**
      Every region-A offset is read with the same command byte and
      `HidChannel.request` matched on that alone, so any other `0x08` reply in
      the queue was accepted as the answer to whatever was last asked — from
      our own concurrent sweep, or from the vendor Hub polling the same mouse
      (Windows copies every input report to every open handle). Replies echo
      their offset and length; `request()` takes an `accept` predicate now and
      the V8 driver checks both, on every region-A read and every write
      read-back. `DPI_STAGE_COUNT` is where it showed because `setDpiStages`
      writes it first.
- [x] Two competing explanations for the same symptom were tested on hardware
      and **ruled out**, so they are recorded rather than left as folklore:
      write-settle timing (12/12 immediate read-backs matched) and a
      stage-count lower bound (`0x0002` accepts `1`, so a single-DPI setup is
      legal and the documented "2–6" range was too narrow). A settle-and-retry
      loop went into `writeSettingRaw` anyway — it costs nothing on the path
      that already works — but it is not what was failing.
- [x] **Mouse angle mode writes nothing instead of pretending.** `0xB3` was a
      gap-analysis guess; it accepts a write and reads it straight back, which
      is exactly why the old code reported success while the mouse's angle
      never moved. Every other unclaimed slot in that scalar run behaves the
      same, so no write/read-back sweep can pick the right one — the lesson
      `0x50` already taught. While the offset was unknown the driver sent
      nothing and said so, and `readSensor` reported 0° rather than echoing a
      byte a previous build parked there. **Superseded 2026-09-10** — the
      offset was found (`0xBD`) and that scaffolding is gone; see below.
- [x] `scripts/watch-region-a.mjs` — read-only config-block watcher that names
      the offset behind any unmapped vendor-Hub control by diffing live reads
      while the Hub writes. Releases the HID handle between polls so the Hub
      and SharkDeck keep working; `--wide` extends it to region B.
- [x] **Mouse angle mode works: the offset is `0x00BD`.** Found by hooking the
      vendor Hub's own writes while its slider was dragged
      (`capture-mouse.py --spawn --angle`, then `analyze-v8.py`) — one `0x07`
      write per drag, all to `0xBD`, nothing else in region A moving. The five
      captured frames also measured the encoding: signed byte, two's
      complement, −30..30, ordinary companion byte — exactly what
      `angleToWire` already assumed, so the codec needed no change. `0xB3` was
      the old guess; no read-back sweep could have distinguished it from
      `0xBD`, since all five candidates accept a write and hand it back.
      `V8_ANGLE_OFFSET_CONFIRMED` / `V8_ANGLE_CANDIDATES` deleted — the angle
      is a plain verified scalar in `worst()` now, and the UI control is live.
- [x] **The capture harness was silently dead on modern frida.** frida 17
      removed `Module.findExportByName`, so `hook-mouse.js` / `hook-kb.js` /
      `hook.js` threw at load, installed zero hooks, and produced an EMPTY
      session file through a run that looked like it worked. All three now
      resolve exports through an `exportByName` shim that works on either API
      generation, `capture-mouse.py` / `capture-kb.py` refuse to prompt for a
      step until the agent reports `ready`, and an empty capture prints a
      diagnosis instead of a bare record count.

### 2026-09-07 pass — mouse live monitoring + Lighting truthfulness (V8 on hand)

User-reported mouse bugs, worked with a real V8 attached — so the two
speculative offsets finally got the hardware pass `FINDINGS.md` "Still open" #9
had been waiting for. `scripts/verify-mouse.mjs`: 24/24.

- [x] **Receiver LED read is fixed, and the cause was a wrong command.** `0x2C`
      answers a zero-length probe with the generic ACK (declared length 0)
      *every* time, so the old read failed 100% of the time and the pane always
      showed "Couldn't read this from the device" on a cold start. **`0x2D` is
      the GET** — verified on hardware by writing a triple via `0x2C` and
      reading it back. `setReceiverLed` now verifies against it too; that write
      previously had no read-back at all and always claimed success.
- [x] Receiver LED: `ReceiverLedSettings.fromCache` becomes
      `source: 'device' | 'lastWrite' | 'cache' | 'unreadable'`, and the read
      never returns `null`. A device that answers but has no read command is
      not a read *failure*, and saying so was the actual bug in the message.
      The pane shows a disabled "Not reported" entry rather than displaying a
      value it did not read.
- [x] **One warning per action instead of three.** A speculative offset that
      does not read back used to emit a generic driver warning, an
      offset-specific driver warning, *and* poison `worst()` so the
      capture-verified fields beside it were reported as a mismatch. New
      `WriteResult.note` + `CompxMouse8K.writeSpeculative` keep the unproven
      byte out of the verdict; `useWrite` renders one honest sentence. Applies
      to the mouse angle offset `0xB3` as well.
- [x] DPI-indicator LED: the panel re-reads the device after each settled write
      (`useAutoWrite`'s new `onSettled`), so it shows what the hardware took
      rather than what was asked for. The `0x52` byte is now read and reported
      raw (`DpiLedSettings.flagRaw`, dev builds only) and deliberately **not**
      allowed to override the effect — it reads `00` alongside `0x4C = 02` in
      every factory profile, so "flag 0 means off" would misreport a new mouse.
- [x] DPI-indicator LED sliders finally pass `drag`, so a drag is one debounced
      write instead of a whole `setDpiLed` per pixel — and `onPointerUp={flush}`
      stops being dead code.
- [x] **Live monitoring of DPI stage and polling rate.** They can be changed
      with the mouse's own buttons, so the manager re-reads them while a device
      screen is the active tab (`setLiveWatch`), and nothing polls otherwise.
      One 17-byte request per tick, not the 22-frame region-A sweep: poll rate,
      stage count and active stage all live in the first ten bytes.
      `nextLiveValue` (pure, unit-tested) stops a poll that predates the user's
      own write from undoing it, and freezes entirely mid-drag.
- [x] Fixed a pre-existing race the poll would have made routine: a region-A
      sweep is 22 separate channel operations, so a write could land mid-sweep
      and the torn result was cached as fresh for 600 ms. A snapshot epoch now
      discards it. `writeSetting` also invalidates *after* the write, not only
      before.
- [x] `PollRateSection` no longer forces a full region-A sweep right after a
      write; the one-frame live poll confirms it instead. Net HID traffic down.
- [x] UI: every `Slider` value is now an `EditableNumber` — the dashed-underline
      click-to-type affordance the Actuation tab already had. They were always
      clickable; nothing on screen said so. Deletes a second, divergent inline
      editor, and each value gains a keyboard tab stop.
- [x] Docs: `0x2D` promoted to verified in `FINDINGS.md` and
      `docs/protocol/README.md`; `0x4E` recorded as 0..255 (the `0..100`
      comment was stale — hardware read back 135); the `0x50`/`0x52` sweep
      results written up.
- [x] **Device firmware is readable after all — it was never on the wire.**
      `0x02` carries no version at any selector or length (probed on hardware);
      the vendor reads `bcdDevice` off the USB descriptor via
      `CS_UsbFinder_GetVersion`. `HidChannel.descriptorRelease` +
      `fmtVersion` (moved to drivers/base.ts, shared with the keyboard) now
      show **Receiver firmware v3.00** instead of n/a. The mouse's own firmware
      is genuinely not obtainable over 2.4 GHz, so that row says so plainly
      instead of reading as a failure. Closes `FINDINGS.md` "Still open" #1.
- [x] DPI-indicator LED: brightness now shows only for Steady and speed only
      for Breathing — a breathing LED sets its own brightness as it pulses, so
      that slider controlled nothing visible.
- [x] **Panels no longer jump while a setting is applied.** `useDeviceData`
      gained `firstLoad`, and every spinner in the app renders on that rather
      than on `loading`. A re-read after a write used to swap a "Reading from
      device…" row in where the value was, moving every control below it — and
      the mouse Lighting pane re-reads after every write by design.
- [x] Receiver LED: "DPI level" is no longer offered — the receiver cannot show
      a DPI stage usefully. It stays in `RX_LED_WIRE` so a receiver already set
      to it still decodes; only the picker filters it.
- [x] Receiver LED: the poll-rate and battery colour legends are a colour key
      now, not a sentence naming colours. The thing being explained is a
      colour; naming it made the reader translate back while looking at the LED.
- [x] Clicking a slider's value selects it, so you can type straight over it.
      The overlay editor mounts after `editing` flips, so the old
      focus-on-`[editing]` effect ran against a null ref and never re-ran — a
      callback ref fixes it for every number field in the app.
- [x] Removed the "best-effort / pending confirmation" notes from the
      DPI-indicator LED pane. Protocol confidence is a note to whoever is
      building the driver, not to someone changing their LED.
- [x] **The wired V8 is a second endpoint, and it is now recognised.** With the
      USB-C cable in, the mouse enumerates as `3554:F515` (the dongle is
      `F517`) — product string "V8", same serial, same MI_01/0xFF02 vendor
      collection, and it answers the identical `0x08` frame family. It used to
      fall through to `genericCompxMouse` and show up as an unnamed "Attack
      Shark Mouse" claiming to be wireless. New `ATTACK_SHARK_V8_WIRED`
      catalog entry + a `DeviceDescriptor.wired` flag, since the VID is shared
      and nothing in the VID/PID pair says which endpoint is which.
- [x] **Device firmware now reads over USB: v3.03.** The wired endpoint's
      `bcdDevice` is the mouse's own firmware — and it is exactly the `0x303`
      the vendor capture's `GetVersion` returned, which means that session was
      recorded with the cable in. Over the dongle the same field is the
      receiver's (v3.00), so the Device row there now says "connect by USB
      cable" instead of "n/a".
- [x] The wired variant drops `receiverLed`, `pairing` and `longDistanceMode`:
      with no dongle attached there is no receiver to configure (`0x2D`
      correctly answers a bare ACK there). It keeps the same `model` string as
      the wireless entry so onboard profile names, the colour pick and backups
      follow the mouse rather than the cable.
- [x] **Tab switches no longer wait on HID.** A per-device read cache
      (`renderer/state/deviceCache.ts`) plus a background prefetch when a
      device's menu opens: every pane's data is read once while the user is
      still on the first tab, and served instantly afterwards. A cached value
      is still re-checked in the background, and a `null` from that check
      never replaces a value we already have — one dropped report must not
      turn a working pane into "Couldn't read this from the device". Explicit
      reloads (the Re-read button, the re-read after a write) always hit the
      device. The macro sweep is excluded: 16 chunked slots is too much to
      spend on a tab most sessions never open.
- [x] The travelling device photo no longer needs a scroll to catch up when
      switching Lighting sub-panes. The close-up shot is a *sibling* of the
      `<ArtAnchor>`, so swapping it moved the anchor without resizing it —
      invisible to both its ResizeObserver and its own capture-phase `load`
      listener. Announced explicitly now, and again once the new image decodes.
- [x] **One mouse, one card — even on two endpoints.** With the cable in, the
      V8 stops talking to its dongle, so the wireless card became a menu that
      showed nothing while a second card held the real settings. Entries are
      now keyed on **model + serial** rather than VID/PID, so both endpoints
      collapse into one device, and `adoptEndpoint` hands it to whichever is
      actually carrying traffic (cable wins). The id is stable across the
      switch, so an open tab keeps working instead of being orphaned. Devices
      with no serial (the R85HE) keep the old path-based key untouched.
- [x] **Refresh after a change is twice as quick**: `scanIntervalMs`
      2500 -> 1250, `LIVE_POLL_MS` 3000 -> 1500, `LIVE_WRITE_QUIET_MS`
      1500 -> 750. The live poll rides the scan pass, so its effective cadence
      is `max(scanInterval, LIVE_POLL_MS)` and the two had to move together —
      halving only the latter would have changed nothing. Cost is one extra
      ping + profile frame per device per tick; the expensive reads stay gated
      (battery 60 s, everything else behind the watch flag).
- [x] `scripts/smoke-hid.mjs` reports firmware from the USB descriptor like the
      app does, instead of decoding `0x02` into a bogus "v0.00", and knows
      about the USB-C endpoint.
- [ ] **Still needs eyes on the hardware, not just bytes:** `0x50` accepts
      *every* value 0..5 and `0x52` holds what is written, so neither is
      "rejected" — but nobody has yet watched whether the breathing LED's pace
      changes with `0x50`, or whether `0x52` gates the LED at all. Both stay
      `inferred` and out of the reported verdict until someone looks.
      `verify-mouse.mjs` prints `LOOK` prompts for exactly this.
- [ ] Receiver-LED **value** meanings (which indication each of 0..4 selects)
      still need the same kind of look — see `FINDINGS.md` "Still open" #4.
- [ ] Phase 2, not started: the Attack Shark **R6 / R8 / R5 Ultra / M5 Ultra**
      family (VID `0x373e`, a wholly different 64-byte feature-report protocol).
      Reference sources and a full work breakdown are in the plan for this pass.
      The four R6 photos are already in `app/assets/devices/`, still unwired.

### 2026-09-06 pass — Actuation key viewer, per-key lighting toasts, auto-switch scope

UI/UX batch from a user pass over the keyboard tabs, plus one behaviour change.

- [x] **Actuation key viewer: labels no longer collide.** Every marker label
      used to print at a fixed `x`/`y = mmToPx(mm) + 4` with no collision
      handling, so any two settings within ~0.19 mm rendered as one smudge —
      including the stock actuation 1.50 / release 1.30 pair (12 px apart) and,
      constantly, the live marker crossing the actuation point. Labels are now
      dodged apart to a 13 px minimum by `dodgeLabels` in `switchGeometry.ts`
      (two sweeps, so a cluster at either edge stays on the canvas), with a
      leader line back to the true row — the marker **lines** never move — and
      a `paint-order: stroke` halo so text stays legible over the bands.
      `switchGeometry.test.ts` covers the collision, ordering and edge cases.
- [x] **One name per term.** The bottom dead zone was `Bottom DZ` (slider),
      `btm dead zone` (SVG tick) and `Bottom dead zone` (tooltip) on one
      screen, and the *top* one's tick was just `dead zone`, unqualified. Now
      "Top dead zone" / "Bottom dead zone" everywhere; the SVG widened to 352
      and `.switch-stage-col` to 60 px so the full names fit unabbreviated.
- [x] **Three marker/line misalignments**, all reported as "the yellow-orange
      marker doesn't match the line that represents it":
      (a) the per-key gauge on each board key drew its fill from `bottom: 0`
      while its ticks are positioned from the top — mirrored against the very
      ticks it is read with, contradicting `KeyGauge`'s own documented
      contract; (b) Chromium insets a range thumb by half its width at each end,
      so every slider handle sat up to 7 px (~0.12 mm) off its own marker line,
      worst at the extremes and correct only at the midpoint — `sliderTrack()`
      now overshoots the input by one thumb and lifts it half a thumb so the
      thumb *centre* sweeps the true span; (c) the drawn keycap rested 12 px
      (0.2 mm) above the housing and travelled from there, so the moving key
      never lined up with the `Now` line reporting its position — its underside
      is now the travel datum at exactly `mmToPx(depth)`, and the live marker
      runs the full width of the housing (with a caret on the axis) so it
      visibly meets the cap it describes.
- [x] **Selecting a key arms the live view.** Live travel is now derived
      (`!liveFailed && !blurred && (liveManual || sel.size > 0)`) rather than
      stored: selecting a key is itself the request to see its position. The
      Live button stays as an override, `liveFailed` latches once for devices
      with no travel stream (so arming-on-select can't retry it per click), and
      window blur parks the stream instead of clearing a flag nothing reads.
- [x] **Global actuation moved off the top of the tab** into an "All keys"
      popover on the per-key toolbar (portaled like `LanguageMenu`), so the
      keyboard viewer — the point of the screen — starts at the top instead of
      below a full-width card.
- [x] **Device rail auto-collapses below 1100 px.** One `matchMedia` listener
      in App sets a transient `railAutoCollapsed` in the store, OR'd with the
      user's persisted `railCollapsed` — deliberately *not* written to settings,
      which would make one narrow window collapse the rail permanently.
- [x] **"Read-back mismatch for command 0x7" on every per-key paint.** `0x7` is
      `SET_LEDPARAM` (whole-board lighting), not the per-key command — the
      colours (`SET_USERPIC`, `0x0c`) were landing fine. The warning came from
      `ensureCustomEffect()`, and two defects made its verification fail:
      `writeVerified` read the value back with **no settle**, immediately after
      a 13-frame burst, on firmware that applies the write asynchronously (its
      own paged readers already pace for exactly this); and it sliced the reply
      at a **hardcoded offset 2** while every keyboard GET decoder resolves it
      per reply with `feaPayloadStart` (2 *or* 3), so whenever the echoed query
      checksum was present `compare` read `0xff - 0x87 = 0x78` instead of the
      effect index. `writeVerified` gained `settleMs`, one retry behind that
      settle, an overridable `payloadOf` (the keyboard overrides it), and
      `quiet` so a write issued *on behalf of* a user action folds into the
      caller's labelled result instead of toasting a bare hex command number.
- [x] **Tooltips across the per-key lighting pane** — 15 new `light.*.tip`
      keys in all 11 locales, on the zone buttons, the Global/Per-Key mode
      (via a new per-option `tip` on `Segmented`), the brush, swatches, Clear,
      Fill all, Read-from-keyboard, and every saved-layout action. Each says
      what the control does *to the device* (Load vs Apply to device were
      indistinguishable before). The board itself gets an info dot on its
      always-visible hint rather than a tooltip that would follow the cursor
      across the painting surface.
- [x] **Auto-switch now follows the visible screen.** It suspended whenever
      *any* device tab existed, so it stayed off essentially forever once a
      device had been opened once. It now keys off the **active** tab, resuming
      as soon as the user is on Home/Settings/Auto-Switch. Because that fires on
      ordinary navigation rather than once per tab close, the forced re-push on
      resume is debounced 750 ms and gated on a dirty flag set by
      `guardedWrite` — a menu the user only *looked at* leaves `applied` valid,
      so flicking tabs no longer fans HID writes out to every device. The
      paused pill now offers "Go to Home and resume" (device tabs stay open)
      and explains the rule; `switcher.test.ts` is new — there was no test for
      `switcher.ts` at all — and locks down that a user's own OFF is never
      overridden by navigation.
- [x] **`GET_LEDPARAM` field order — resolved from the vendor bundle.** The
      reply order is the same as the write order (*effect, speed, brightness,
      option, rgb*), so `readLighting` was already right and
      `FINDINGS-R85HE.md:163` is wrong. `getLightSetting` in
      `scripts/_raw/qmk-bundle.js` reads `LIGHT_MAXSPEED - e[2]` as the speed
      and `e[3]` as the brightness; the captured
      `00 87 0d 04 01 00 00 c8 c8` decodes coherently only that way (effect 13
      `LightUserPicture`, option 0 and rgb `(0,200,200)` — both of which are
      what the vendor itself writes for that effect). No hardware check needed
      after all. Written up in `docs/protocol/keyboard-compx.md`.
- [ ] **The whole batch above still needs the on-hardware pass** — in
      particular the 0x7 fix, which was diagnosed against the capture and the
      `kb-snapshot-2026-09-05…json` reply rather than observed live. Set the
      board to a non-Custom effect *first*, then paint a key, so the
      `ensureCustomEffect` write path is actually exercised instead of its
      already-Custom short-circuit.

### 2026-09-05 pass — keyboard HID bugs + Home/Actuation UI

Three reported keyboard bugs, all traced to the same root-cause family: the
paged `GET_*` commands answer with **no command echo and no checksum**, so they
must bypass `HidChannel.request()` and be paced.

- [x] **Per-key lighting read wedged the board.** `readUserPicWith` went
      through `request()`, whose command-byte filter rejected every chunk and
      then burned its whole 3x6 attempt budget on each of six chunks — ~126
      unpaced feature reports, which is the "endpoint lockup" in
      `FINDINGS-R85HE.md` (board stops accepting feature writes until
      replugged). Rewritten as a paced raw read like `readMagnetismPage`:
      `USERPIC_REPLY_OFFSET` 9 -> 1, `USERPIC_BYTES` 280 -> 384 (128 slots x 3,
      confirmed against qmk's `___cmdGetCustomLightLayout`), `settleMs` between
      chunks on both the read and the write.
- [x] **Writing a per-key colour did nothing.** Separate from the read bug, and
      found by going back to the raw capture: `session-r85he.jsonl` holds
      **seven** `SET_USERPIC` frames, not five, and byte 5 is that chunk's
      payload length (`0x38`, then `0x2a` on the last) while byte 6 is the
      last-chunk **commit** flag. The driver sent five chunks with a hardcoded
      `0x38` and a permanently-zero byte 6, so the board accepted every frame
      and never applied the map. Now 7 chunks / 378 bytes (126 slots x 3 RGB),
      with `compx-keyboard.test.ts` locking all seven headers and their
      checksums against the captured bytes.
- [x] **Live travel monitor showed nothing.** It polled an input-report stream
      whose layout was never captured; on the R85HE's feature-only MI_02
      collection that only returned stale endpoint bytes. Live travel is
      actually magnetism **page 254**, read with the ordinary paged frame —
      the only `GET_MULTI_MAGNETISM` frame in the whole capture is page `0xfe`,
      and qmk names 254 `liveTravel`. Poll is now one whole-page sample per
      tick at 150 ms instead of a 4-read burst every 50 ms.
- [x] **Keyboard never re-detected after a replug.** `HidChannel.close()` was
      reversible: it nulled the handle but nothing stopped a queued or later
      operation calling `ensureOpen()` and re-opening it. The prune sweep hit
      that exactly — `stopTravel()` queued a write, `close()` was
      fire-and-forget, then the entry was deleted, stranding an open handle
      that nothing could close and that blocks the next `open()` on the same
      Windows path. Added a `disposed` flag (a closed channel stays closed), a
      bounded `close()`, an awaited prune teardown that no longer notifies a
      device that has already gone, and a rebuild of any entry whose channel
      was disposed. `refreshEntry` now also releases the handle once a device
      stops answering, keeping the card visible.
- [x] UI: Home cards ~25% larger and fluid (`flex: 1 1 380px`, max 425px) with
      the grid cap and default window width raised so three still fit; hover
      now washes the whole card face instead of only outlining the border and
      the artwork's alpha silhouette; a `Loading` spinner component
      (`tabs/common.tsx`, with a deliberate `prefers-reduced-motion` exemption)
      replaces the bare "Reading from device…" text and fills the panes that
      previously rendered nothing — including the Actuation board, which used
      to show `DEFAULT_KEY` placeholders as if they were device state.
- [x] UI: the R85HE's `black` colour variant is renamed `green` — its photo was
      always the green board (`attack-shark-r85-he-green.webp`). `black-gradient`
      is genuinely black and unchanged. Stored colour picks are now validated
      against the descriptor's variants, so a renamed id falls back to the
      catalogue default instead of the generic silhouette.
- [x] UI: the Actuation switch diagram clipped its own tick labels — the `<svg>`
      viewport was 260px with text starting at x=194, ~10 monospace glyphs, so
      "bottom dead zone 3.70" rendered as "bottom dea". Widened to 344 and the
      longest label shortened to "btm dead zone".
- [ ] **All of the above still needs the on-hardware pass** — see the
      Verification section of the plan and `CAPTURE-KEYBOARD.md` step 13
      (per-key lighting) and step 18 (live travel).

### 2026-08-31 pass — bug/feature batch (no hardware available this session)

A large batch of user-reported bugs and UI/feature requests across mouse,
keyboard and shell, implemented against the capture docs with every
speculative wire offset provenance-tagged and read-back-verified rather than
assumed correct. **Everything below needs an on-hardware pass** — see
`docs/reverse-engineering/FINDINGS.md`'s "Still open" #9/#10 and
`FINDINGS-R85HE.md`'s "Still open" for the exact capture steps.

- [x] Mouse: DPI slider auto-zooms to the enabled stages instead of a fixed
      50–42000 linear track (full range still reachable by drag-to-edge or
      typing an exact value); fixed a `--dpi-thumb`-inset bug in the
      drag-to-DPI math that made a trait's hit-area drift a few px from the
      cursor. Angle mode restored (`v8.ts` capability + a speculative
      `V8_BLOCK.ANGLE_DEGREES = 0xB3`, gap-analysed from the capture, never
      trusted without a read-back match). DPI-indicator LED gained a
      breathing-speed control (speculative `V8_BLOCK.DPI_LED_SPEED = 0x50`),
      gated so Off shows neither brightness nor speed and Steady shows only
      brightness. Buttons tab rebuilt as a table + numbered mouse-silhouette
      diagram (`components/MouseButtonDiagram.tsx`), which also surfaced and
      fixed a live regression: the left-click lock re-derived from a label
      string and silently stopped locking once `buttonMap` existed. Receiver
      LED now falls back to a persisted last-write cache
      (`main/devices/deviceState.ts`) instead of "unreadable" forever
      (command `0x2C` has no known GET); firmware read distinguishes "never
      answered" from "answered with an ACK, not a version" instead of
      showing "n/a" for both.
- [x] Keyboard: per-key lighting write path corrected to the captured
      `SET_USERPIC` frame shape (5×56-byte chunks, default `compx-fea`
      checksum, not the old wrong `'bit7'`/7×56 guess) and now read-back
      verified instead of hardcoded `unverified`; painting now also flips
      the board to the Custom effect. Base- and Fn-layer key bindings are
      now actually read from the device (`readKeyBindings`, was hardcoded
      empty) with hard-wired Fn shortcuts (`shared/keyboard-fn-defaults.ts`,
      decoded from the vendor's `defaultFnMatrix`) shown as locked. Main/side
      lighting brightness reads were off-by-one-and-wrong-scale (root cause
      of "brightness always ~0%" and the "default to 100%" ask). Side
      lighting reworked to the vendor's actual model: 6 real effects ×
      independent Shining/Custom-colour choice × brightness (all but Off) ×
      speed (all but Off/Always-On). Actuation tab: bottom dead zone
      surfaced (was read and discarded), multi-key selection with
      select-all, a whole-board per-key gauge overlay, and the live travel
      monitor's transport bug fixed (`readInputUnlocked` never opened the
      handle) plus a feature-report fallback — still marked experimental,
      since the stream's byte layout has never been captured. Keyboard
      board now scales to the full pane width instead of a fixed 34px/unit
      island. Per-key lighting gained an eyedropper tool and a saved-preset
      library (mirrors the existing macro library).
- [x] Shell: topbar buttons (Home, auto-switch, language, settings, window
      controls) now support click-and-hold-to-drag via a manual
      `windowStartDrag`/`windowEndDrag` IPC pair, since a native CSS drag
      region can't also receive `click`; restore-and-follow when maximized.
      Home-grid drag-reorder now inserts before/after like the tab strip
      (was "replace whichever card you drop on"), and drags the whole card
      instead of just the product photo (`<img draggable={false}>`).
      grey-brown pushed back toward light-brown (reversing an earlier
      over-correction toward grey); crimson shifted from a pink-reading hue
      toward orange, clear of the `red` palette. Removed the inline
      "confirmed"/"unconfirmed" chip from every panel (the bottom-right
      toast is now the only write-outcome UI). Auto-Switch's Modes and
      Games/Apps rows drop their pencil icon — the name itself is now the
      rename target.

- [~] **Validate against real hardware**: `CompxMouse8K.ping()` checks the
      `08 03` status reply's payload byte (`reply[6]`). The 2026-08-30 capture's
      `11_*` offline steps show `reply[6]` going `01 -> 00` when the mouse is
      powered off, so it *does* track the wireless link — but the dongle keeps
      answering `08 03` on its own, so "no reply" and "`reply[6] == 0`" should be
      treated the same. `devices/manager.ts` keeps the 2-consecutive-miss
      hysteresis. See `docs/reverse-engineering/FINDINGS.md` "Still open" #2.
- [x] `DeviceArt.tsx`'s inline SVG gradient ids are per-instance (`useId()`)
      instead of the literal `"g"`/`"gm"` they used to be — duplicate DOM ids
      across simultaneously-rendered cards could resolve `url(#g)` to the
      wrong node after React reordered them, one plausible way an outline
      could silently vanish. Also bumped `Icon`'s default stroke width
      1.3→1.5, since the small tab-strip glyphs at 14px were faint. Neither
      fix was confirmed against the exact reported instance (no screenshot
      to compare) — worth a visual double-check.
- [x] The language-menu dropdown is portaled to `document.body` at
      `position: fixed` (see `usePortalPosition.ts`), like `Tooltip` already
      was — `.topbar`'s `backdrop-filter` creates a CSS stacking context that
      trapped the list's `z-index` inside it, so device cards in `.content`
      could paint over it regardless of the z-index value. Its `max-height`
      is now a real overflow safety net instead of a routine scrollbar.
- [x] Added an app-wide `ErrorBoundary` (`components/ErrorBoundary.tsx`) —
      before this, any uncaught error anywhere, including inside a topbar
      widget, unmounted the *entire* React tree with nothing left to click,
      which is what a report of "the window goes black and has to be
      force-killed" looks like (reproduced deliberately during development
      by triggering a `WindowControls` effect throw). Each open tab's content
      is wrapped individually so one broken tab doesn't take the others down;
      `WindowControls` gets its own boundary with a minimal always-works
      fallback (`MinimalWindowControls`) so the frameless window's close
      button survives even if the fancy titlebar controls break.
- [~] Full V8 protocol capture **done** (2026-08-30, ~117-step Hub sweep with
      replies — `docs/reverse-engineering/session-v8.jsonl`, `FINDINGS.md`,
      `v8-analysis.txt`). Confirmed against real traffic: the write command is
      **`0x07`** (`08 07 00 <off16be> <len> <bytes+companion>`), **not `0x09`**;
      `0x09` with zero args is **restore-factory-defaults**; the full region-A
      block map (poll `0x00`, DPI stages, LOD `0x0A`, sensor toggles `0xAB`/`AF`/
      `B1`, sleep `0xAD`, debounce `0xA9`, buttons `0x68`–`0x74`, DPI-LED
      `0x4C`/`0x4E`); long-distance = command `0x16`; receiver LED = command
      `0x2C`; macros live in region C (`0x0480`+); pairing = `0x05`/`0x06`.
      **Driver rewrite DONE (2026-08-30):** `compx-mouse-8k.ts` now writes via
      `0x07` + companion byte and the verified region-A map; `0x09` is
      `restoreDefaults()`; `0x2C` receiver LED (one 3-byte frame), `0x16`
      long-range, `0x05`/`0x06` pairing and region-C macros are wired.
      `@shared/mouse-wire.ts` holds the capture-derived constants;
      `batteryPercentFromCurve` moved to `@shared/battery.ts`. New capabilities
      `sensorMode` / `mouseDebounce` with UI; `angleMode` dropped from the V8.
      typecheck + 95 tests + build green. **Still to do:** full Buttons UI
      (combo / multimedia / firepower / macro binding — driver
      `setButtonMapping` is ready), future-mouse panes, the on-hardware
      verification pass, and the DPI-register mini-capture. Still open on the
      wire: `0x02` firmware (pure echo on the V8), `0x2C` per-value meanings,
      `0x09` reset scope, `Profile-*.bin` decode.
- [x] Fixed the mouse config-block read/write offset (was little-endian,
      device wants big-endian) and the 10-byte-per-frame chunk limit — this was
      silently breaking mouse DPI, poll rate, sensor/LOD, sleep timer, buttons
      and both LED blocks while looking like it worked.
- [x] Fixed the mouse firmware query to match the vendor's captured frame
      shape; added `charging`/battery-curve decoding so the reported battery
      percentage comes from the same millivolt curve the vendor Hub uses,
      alongside the raw byte and voltage for comparison.
- [x] **R85HE checksum recovered** by probing the real device (no vendor app):
      `compx-fea` — `(0xFF - Σ) & 0xFF` at byte 2, args from byte 3, no trailing
      byte. `checksum.ts` / `frame.ts` / `checksum.test.ts` updated; the old
      `bit7`/`bit8` trailing reconstruction was never right. Also recovered:
      the real 79-key column-major matrix (`ANSI_79_SG9047`, replacing the
      wrong `ANSI_75` physical order that made per-key writes land on the wrong
      key), firmware `v5.11` and model id 3123 from `GET_USB_VERSION`, and that
      the R85HE is wired-only (no `GET_RF_VERSION`, so battery is N/A not
      missing). See `docs/reverse-engineering/FINDINGS-R85HE.md`.
- [x] Keyboard poll-rate read: `GET_REPORT` reply confirmed as `00 83 7c 01`,
      code at frame `[3]`. **Resolved** — it is a plain list index, not a
      bitmask: qmk.top's `setReportRate` maps `0..6` to 8000/4000/2000/1000/
      500/250/125, matching `IDX_TO_RATE` in `compx-keyboard.ts` exactly. A
      2.4 GHz dongle variant in the same bundle omits 250 Hz; noted in
      `scripts/_raw/qmk-magnetism.json` as `otherVariants`.
- [x] **qmk.top adopted as the keyboard protocol source** (`npm run extract:qmk`).
      54-command table, checksum arithmetic, magnetic parameter model, device
      records and key layouts, all from the vendor's own WebHID configurator.
      33/35 of the hand-built `KB_CMD` matched it on first comparison;
      `drivers/kb-commands.test.ts` locks the agreement. Caveat: its device
      table carries no Attack Shark models, so layouts still come from Driver
      v4's table.
- [x] **Magnetic read path fixed.** Paged `GET_MULTI_MAGNETISM` replies carry
      no command byte and no checksum (64 raw data bytes from frame[1]), so
      `ch.request()` rejected every one and `readMagnetic()` silently served
      hardcoded defaults. Also 128 slots/page with `chunks / 2` bytes per key,
      not 56-byte chunks. Verified on hardware: 79 keys at 2.0/1.0/0.1 mm.
- [x] **Reply-checksum enforcement disabled** for `compx-fea`, with evidence in
      `docs/protocol/keyboard-compx.md`. It rejected `GET_USB_VERSION`, so
      `getFirmware()` returned null and the magnetic travel multiplier stayed
      at its fallback of 10 instead of 200 — every travel value off by 20x.
- [x] **Rapid trigger is mode-byte bit 7**, independent of snap/SOCD, and the
      mode is the low nibble. Pages 2/3 (RT press/release sensitivity) are now
      written, so the Actuation tab's RT sliders reach the device; bit 6 (full
      bottom-out) round-trips instead of being cleared on every key write.
- [x] **Descriptor resolution by firmware model id** (`resolveModelId`). VID/PID
      cannot tell these boards apart — an R86PROHE shares `0x3151:0x5029` with
      the R85HE and would inherit its 79-key layout, putting every slot-indexed
      per-key write on the wrong key. A model id we do not carry is now
      surfaced as a warning rather than silently trusted.
- [x] **`KBOPTION` exposed** — Fn OS, anti-mistouch, RT stabilisation and
      hardware swap-WASD, as a Keyboard options panel on the Device tab
      (capability `keyboardOptions`). All five switches share one register, so
      the driver merges partial changes over the last read. Read-back gives a
      real `verified: 'match'`; confirmed on hardware with a no-op write.
- [x] **Unsupported magnetic pages echo the query** (page 200 returns our own
      frame verbatim). The paged reader now detects that instead of decoding the
      echo as key data — it cannot lean on `request()`'s `isEcho`, since these
      reads bypass `request()` entirely.
- [x] Page 251 (top dead zone) is implemented after all: with proper pacing it
      reads all zeros, stably. The earlier "implausible" 60/198/2 was a stale
      endpoint buffer (60 = page 6's 0.3 mm bottom dead zone). Still untested
      against a non-zero value.
- [x] **SOCD (page 9) and mod-tap (page 5) verified on hardware.** Writing a
      snap-tap pair produced `p7[A]=7 p7[D]=7, p9[A]=21 p9[D]=9`; mod-tap 200 ms
      produced mode 3 and page-5 value 20. Both restored to the pre-test
      snapshot afterwards. Also found: page 9's unpaired sentinel is **0xFF**,
      not 0, so leaving snap mode now writes 0xFF rather than pointing the key
      at slot 0.
- [x] **Magnetic write semantics corrected.** Byte 4 is the vendor's *commit*
      flag (set on the last write of a batch), not a per-page constant, and the
      value is `chunks / 2` bytes wide — writing 2 bytes to a 1-byte page spilled
      a 0 into the next slot. `setMagneticKey` now builds the whole batch and
      commits once, at the end.
- [x] **DKS zone-action data model** — `app/src/shared/dks.ts`, the four 2-bit
      trigger-point fields ported from qmk.top's `ws`/`Lu`, with an exhaustive
      256-value round-trip test.
- [x] **Multi-frame `SET_KEYMATRIX`** implemented (`setDksBindings`): one frame
      per DKS zone, zone index in frame byte 7, commit on the last.
- [ ] **DKS zone WRITE is a no-op on R85HE fw v5.11** and is the one thing here
      still unproven. The page is **10** on this generation (qmk.top's page 8
      returns no data at all — see docs/protocol/keyboard-compx.md), reads and
      decodes correctly, but neither page accepts the single-key write frame.
      The vendor writes the four `SET_KEYMATRIX` bindings before the flags, so
      the firmware likely refuses flags for a key with no bindings. Next step is
      a Frida capture of the vendor configuring a DKS key
      (`CAPTURE-KEYBOARD.md`), not more blind probing.
- [x] **Key-matrix read was completely broken; fixed and verified 78/78.** Three
      separate faults: the 4th GET arg is the Fn profile (driver sent 3, so the
      base layer read as 128 zeroed slots), the reply offset is 1 not 9 (9 also
      broke the 4-byte stride), and the replies carry no command byte so
      `ch.request()` rejected every chunk. See docs/protocol/keyboard-compx.md.
- [x] **`setKeyRemap` fixed** — layer 0 (not 3, which targets a profile the read
      never sees) and the HID code at quad byte 2 (not 1). Verified both ways on
      hardware: remapping slot 9 changed that slot only, and writing the original
      quad restored it exactly.
- [ ] `writeVerified` reports `verified: 'match'` for key-matrix writes even when
      its read-back is stale — it once returned the pre-write value twice running.
      It should use the fixed raw paged read instead of `request()`.
- [ ] `setDksBindings` (the keymatrix half) is still untested on hardware.
- [x] **`backup()` paced** (`backupPaceMs`, 120 ms on keyboards). It fires its
      GETs with internal retries and wedged a real R85HE mid-sweep — and since
      `ensureBackup()` runs it before the FIRST write to any device, the
      mandatory safety step was itself the hazard.
- [x] **Unsupported pages / wrong-shaped GETs.** An unimplemented page echoes the
      query verbatim (page 200 does). Separately, a GET with the wrong argument
      COUNT hangs the MCU outright: `GET_FN` takes three args, and a fourth
      wedged the board instantly after 70 paced transactions had succeeded.
      New `npm run snapshot:kb` captures a full restorable snapshot, persisting
      after every section.
- [ ] **R86HE**: not yet modelled. No R86HE hardware has been probed; the
      vendor table lists R86PROHE as ids 2793 (`0x5030`, screen) and 2982
      (`0x5029`), both `Common89_SG8967`, a layout the repo does not have.
      Run `npm run identify:kb` with the board attached to pin the id, then add
      the layout + a catalog entry with its `modelId`.
- [x] Keyboard battery: **not applicable** on the R85HE — it is wired-only.
      `getBattery` staying unimplemented on the keyboard drivers is correct for
      this board; a future wireless HE keyboard would need the command found.
- [ ] Finish the R85HE `SET_*` frame layouts and `GET_KEYMATRIX`/`GET_FN` args
      by running `docs/reverse-engineering/CAPTURE-KEYBOARD.md` (step-driven
      Frida capture of Driver v4 -> the guided click script). New:
      `npm run extract:kb` (static tables), `npm run dump:kb` (pre-image),
      `capture-kb.py` / `hook-kb.js`.
- [x] Read onboard state from the device on attach rather than showing
      hard-coded profile values.
- [x] Firmware version no longer caches the first failed read forever (bounded
      retry); mouse now queries a receiver ("slave") version too.
- [x] Auto-Switch "+ Add rule" works (was a dead `window.prompt` call).
- [x] User-friendly visual macro editor with live recording (no hex input).
- [x] Macros rebuilt: the tab is now a library rail plus a single-macro editor
      (`renderer/components/macro/`, replacing the one 455-line
      `MacroEditor.tsx`), with an explicit selection, a dirty state with
      Save/Revert, and a confirm before discarding edits or deleting.
      Recording is the primary control at the top of the editor rather than the
      fourth button in a wrapping row, and is a real take: it *arms* first and
      starts its clock on the first keypress (the old one started it on the
      Record click, baking the time you spent reaching for the keyboard in as a
      leading delay), ignores clicks on its own buttons (previously recorded as
      steps), stops on Esc, offers As-typed / Even / None timing and
      Replace / Append, and only commits on Keep. `codeToHid` moved to
      `shared/keys.ts` as `hidUsageForBrowserCode` (+ tests) and grew the
      numpad, punctuation and system keys it used to drop *silently*; anything
      still unmappable is now counted and reported. The step list shows a
      press/release pair as one "tap" row with its hold time, makes every field
      editable in place (only delays were before), and carries a capacity meter
      against the real slot size — `DeviceUi.macroLimits`, derived per driver
      in `devices/manager.ts` from `KB_MACRO_MAX_STEPS` / `V8_MACRO_MAX_STEPS`
      — since both codecs silently truncate past it.
      Fixed alongside: `encodeMacro` (compx-keyboard.ts) wrote a `move` step as
      a phantom `KEY_DOWN 0x00` instead of dropping it as the V8 codec does, so
      the recorder no longer captures pointer motion at all (neither device can
      store it); `saveLibraryMacro` upserts in place instead of moving an edited
      macro to the end of the library; and `labelForCode` now normalises a usage
      spelling, so a macro read back off a device (zero-padded `"04"`) shows as
      `A` rather than `0x04`.
- [x] Profiles are now a link model, not a settings snapshot: a general
      profile (`AppProfile.links`, `src/shared/types.ts`) points each device
      model at one of its own per-device slots — an onboard hardware slot
      (`profiles` capability, e.g. the V8's four real memory banks) or a
      software-held slot (`softwareProfiles` capability, e.g. the R85HE,
      whose `SET_PROFILE` only flips a flag with no known storage behind it —
      SharkDeck now keeps that slot's settings itself in
      `config/device-profiles.json` and replays them on select). What a slot
      *contains* is configured on the device's own Profile tab, never in
      Auto-Switch. Seeded on first run with "Desktop" and "Gaming" profiles
      and a disabled rule mapping common game executables to Gaming with
      Desktop as fallback. Renaming a profile (pencil icon), deleting one
      (now un-dangles any rule that pointed at it instead of leaving it
      silently enabled-but-broken), and a per-rule fallback tooltip are new;
      the previous per-device *setting-snapshot* profile model and its
      "capture everything from connected devices" flow are gone.

### UI
- [x] Centre the list of connected devices.
- [x] Settings: theme colour-palette option — ships "Shark cyan" plus "Amber"
      (renamed from "Ember" and recoloured — it read as a dark red-orange
      despite the name; now an actual bright yellow-orange), matching
      `app/assets/logo.ico`. Every palette-relevant rule now keys off
      `--accent-rgb`/`--violet-rgb` instead of a handful of hard-coded cyan
      literals, so switching palettes no longer leaves cyan bleeding through
      (card hover sheen, toggle fill, active tab rail, background glow).
- [x] Settings: "Dark", "Light", "Follow system" mode option.
- [x] Use `app/assets/logo.ico` as the application and tray icon (and the
      installer/uninstaller icon — `app/build/` is gone).
- [x] Frameless window with an integrated custom titlebar + window buttons.
- [x] Multi-tab shell: Settings, Auto-Switch and every device open in their own
      pinned/closable tab (home is pinned); switching is instant and preserves
      each device tab's active sub-tab and scroll position, since tabs stay
      mounted rather than being torn down and rebuilt.
- [x] Tooltip is rendered in a `document.body` portal at `position: fixed`
      with both axes clamped to the viewport, instead of being absolutely
      positioned inside its anchor — it no longer clips against a card's
      `overflow: hidden` or the window edge.
- [x] Removed the verified/ported/inferred provenance badge from device cards
      and the tab rail; removed the duplicate "Edit profile" / "Lighting" /
      "Auto-Switch" shortcut buttons on the device overview (all three
      duplicated the tab rail or topbar one click away).
- [x] Tooltips on every status pill/dot on the device card and overview
      (online/offline, connection, battery, profile slot, firmware,
      backed-up).
- [x] A device that goes offline while its config screen is open now shows a
      banner and disables every control in the active tab (via a wrapping
      `<fieldset disabled>`) until it reconnects.
- [x] Icon set (`src/renderer/components/icons.tsx`) used in the topbar, tab
      strip, and device tab rail — gear for Settings, globe for the language
      picker (moved from a Settings dropdown to a topbar icon menu), bolt for
      Auto-Switch, sliders/bulb/chip for Profile/Lighting/Device.
- [x] Full en/fr localisation with a `t()` layer (`src/shared/i18n/`); skeleton
      catalogues for ar/ja/ko/ru/tr/zh-CN/zh-TW.
- [x] Gamer-shaped mouse icon; compact tray menu (Exit first).
- [ ] Fill in the ar/ja/ko/ru/tr/zh translations beyond the hardware vocabulary
      — several new strings from this pass (profiles, status tooltips, the
      offline banner) currently fall back to English in those seven locales.
- [ ] The device-entry animation approximates "art flies from its grid card
      into the hero slot" with a plain fade/rise on the whole tab instead of a
      true FLIP (measure-old-rect → animate-delta) of the artwork element —
      a full FLIP would need a small shared measurement hook wired through
      DeviceGrid and DeviceOverview.
- [x] The browser-style tab strip lives in the same row as the topbar instead
      of a separate row below it, and Home no longer appears in it (the brand
      button and the new back-arrow "return to home" button, shown whenever
      you're away from Home, cover that). Tabs can be dragged to reorder
      (in-memory, not persisted). `Ctrl+W` closes the active tab, `Ctrl+Tab`/
      `Ctrl+Shift+Tab` cycle the open (non-Home) tabs, `Ctrl+T` opens Home —
      all skipped while the macro recorder is actively capturing raw
      keystrokes (`state/shortcuts.ts`).
- [x] Redrew the `mouse` glyph in `icons.tsx` (rounded body, L/R split,
      scroll-wheel capsule, two thumb buttons) instead of a plain pill+stem.
- [x] The device-config tab rail is collapsible to icons-only
      (`settings.railCollapsed`), with a smooth grid-column transition. Fixed
      alongside it: the Basic/Advanced toggle used to be pushed below the
      fold on a device with enough capability tabs to make the rail taller
      than the viewport (a CSS-grid stretch issue, not a `.tabrail` overflow
      one) — the rail is now `position: sticky` with its own internal-only
      scroll region for the tab list, the toggle pinned in a separate footer.
      Every rail button (and Panel section headers where the label is jargon,
      e.g. the magnetic-switch modes) now carries a tooltip explaining it —
      the only label left once the rail is collapsed.
- [x] Button remap, key/Fn-layer remap, per-key magnetic actuation, and
      macros are each promoted from sections stacked inside Profile/Device
      into their own top-level tabs (`tabs/ButtonsTab.tsx` / `KeysTab.tsx` /
      `ActuationTab.tsx` / `MacrosTab.tsx`), gated by capability like every
      other tab. Mouse macros already worked before this move (the V8
      declares `macros` and `MacroEditor` already handled mouse-button
      steps) — it just wasn't its own discoverable tab.
- [x] Three new colour palettes (violet, crimson, emerald) alongside
      shark-cyan/amber, each with a dark and light variant; the palette
      swatch list now carries a `labelKey` instead of a two-way ternary.
- [x] Added a full Spanish translation (`shared/i18n/es.ts`, a sibling to
      `fr.ts`, not a `locales/` skeleton).
- [x] Removed the USB/2.4 GHz/Bluetooth connection-type pill from the device
      card and overview.
- [x] The Auto-Switch topbar control now has its own on/off `Toggle` next to
      the icon that navigates to its screen — no separate settings-menu
      control, and it stays in sync with the Auto-Switch screen's own toggle
      for free since both read the same live `switcher.running` state.
- [x] Low-battery warning threshold has a "disabled" option (sentinel `0`) —
      also wired the setting into `devices/manager.ts`'s `hint()`, which
      previously hardcoded 10% regardless of what the setting said.
- [x] Per-device cosmetic colour/edition picker (`ColorPicker.tsx`): a small
      swatch button on the card/overview art opens a popover of the photos
      declared in that model's `colorVariants` (`DeviceColorVariant[]`) —
      2 for the V8 (black/white), 4 for the R85HE (green, black·gradient
      keycaps, white, white·contour keycaps). Purely cosmetic, persisted per model in
      `config/device-colors.json`, never sent to the device.
- [x] Onboard profile slots (the V8's real hardware memory banks) can now be
      renamed, same as software-held slots already could — persisted in
      `config/onboard-profile-names.json` since the hardware itself has no
      name field for a slot. The custom name now shows everywhere a slot is
      referenced (`OnboardProfilesSection`, the device card's active-profile
      pill, the overview stat, Auto-Switch's profile-links editor) via one
      shared `slotLabel()` helper so they can't drift apart. Auto-Switch's
      software-slot option labels are not yet wired to `SoftwareProfile`'s
      own name (a pre-existing, separate gap — that name lives behind an
      extra fetch this editor doesn't currently make).
- [ ] A reference catalogue of Attack Shark models beyond the V8/R85HE
      already supported — see
      [`devices/attack-shark-lineup.md`](devices/attack-shark-lineup.md).
      Deliberately left as a template with unconfirmed stub rows rather than
      guessed specs; needs real hardware or a vendor spec sheet to fill in.
      `DeviceSpec.buttonMap` (button x/y positions, for a future graphical
      picker) is now a real field but not populated for the V8 either — the
      button index→physical-button order itself is unconfirmed (see
      `protocol/README.md`), so mapping coordinates on top of that would
      compound the uncertainty.
- [ ] Profile-switch popup (bottom-left, always-on-top, shows over a
      fullscreen game) is implemented (`main/overlayWindow.ts`,
      `SwitcherState.lastSwitch`) but only smoke-tested via the `Switcher`
      class's own logic, not against a real game-launch transition end to
      end — worth an actual "launch cs2.exe with a rule pointed at it"
      pass. Gated by the existing (previously dead) `overlayEnabled` setting.

### Platform
- [x] Linux support — `src/main/platform/linux.ts`, packaged as AppImage/deb/rpm
      with the udev rule (`assets/linux/60-sharkdeck.rules`) deb/rpm install
      automatically and AppImage installs via a bundled script. Process/game
      scanning is native (`/proc`, Steam library paths); Epic has no Linux
      launcher so that source is simply empty there.
- [x] macOS support — `src/main/platform/mac.ts`, packaged as dmg/zip, ad-hoc
      signed (no Apple Developer ID — see `scripts/adhoc-sign-mac.mjs` and
      `docs/platform-support.md`). Native traffic lights via
      `titleBarStyle: 'hidden'`; process/game scanning via `ps` + Steam's
      macOS library path.
- [ ] **Hardware-verify Linux/macOS.** Everything above is code-complete and
      typechecks, but this was built and tested on Windows with real Attack
      Shark hardware; the HID path on Linux (hidraw) and macOS
      (IOHIDManager) has not been confirmed against a real device — see
      `docs/platform-support.md`'s "unverified" list, and the two
      Windows-driver-specific quirks called out in `hid/transport.ts`
      (`isEcho()`, the command-byte filter in `request()`). Needs someone
      with the hardware on each OS to run `node scripts/smoke-hid.mjs` and
      confirm a read-back diff on an actual write.
- [ ] Linux tray: `Tray` needs an AppIndicator host, absent on bare GNOME
      without an extension — `main/index.ts`'s tray init already degrades
      non-fatally and forces `minimizeToTray` off when it fails, but this
      hasn't been confirmed on a real GNOME session.
