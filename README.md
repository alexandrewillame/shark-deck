<p align="center"><img src="docs/media/banner.jpg" alt="Shark Deck" width="100%"></p>

<p align="center">
  <a href="https://github.com/alexandrewillame/shark-deck/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/alexandrewillame/shark-deck?label=download"></a>
  <a href="https://github.com/alexandrewillame/shark-deck/actions/workflows/build.yml"><img alt="Build" src="https://github.com/alexandrewillame/shark-deck/actions/workflows/build.yml/badge.svg"></a>
  <img alt="Windows, macOS and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0a0c10">
  <a href="https://alexandrewillame.github.io/shark-deck/"><img alt="Also runs in the browser, over WebHID" src="https://img.shields.io/badge/browser-WebHID-0bb6a8"></a>
  <img alt="Works offline, no telemetry" src="https://img.shields.io/badge/network-none%2C%20no%20telemetry-6d5cff">
  <a href="LICENSE"><img alt="License: GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue"></a>
</p>

# Shark Deck

Open-source configurator for Attack Shark keyboards and mice — an auditable,
offline replacement for the vendor's _Mouse Hub_ and _Driver v4_.

**[Open it in your browser](https://alexandrewillame.github.io/shark-deck/)** ·
[Download for Windows, macOS and Linux](https://github.com/alexandrewillame/shark-deck/releases/latest) ·
[Report a problem](https://github.com/alexandrewillame/shark-deck/issues)

## Use it in your browser

**[alexandrewillame.github.io/shark-deck](https://alexandrewillame.github.io/shark-deck/)**
is the same configurator with nothing to install. Open it in Chrome, Edge or
Opera on a computer, click **Connect a device** and pick your mouse or keyboard
in the browser's list. It can be installed as an app, and then works offline.

The browser edition configures the device — DPI, buttons, lighting, actuation,
macros, onboard profiles, backups (downloadable as files). What needs software
on the computer stays in the desktop app: per-game auto-switching, the tray
icon, start at login. Firefox and Safari cannot reach USB devices; on Linux the
browser needs the udev rule once, and the page shows the commands. Details in
the [platform support matrix](docs/platform-support.md#browser-edition-webhid).

## Walkthrough

**Mouse:** DPI, polling rate, sensor settings, angle mode, buttons, macros, lighting.

<p align="center"><img src="docs/media/walkthrough/tour-1-mouse.webp" alt="Shark Deck walkthrough: mouse" width="800"></p>

**Keyboard:** Hall-effect actuation with live key travel, rapid trigger, macros, RGB lighting.

<p align="center"><img src="docs/media/walkthrough/tour-2-keyboard.webp" alt="Shark Deck walkthrough: keyboard" width="800"></p>

**Per-game auto-switching:** start a game and the mouse and keyboard both move to its profile; close it and they move back.

<p align="center"><img src="docs/media/walkthrough/tour-3-auto-switch.webp" alt="Shark Deck walkthrough: per-game auto-switching" width="800"></p>

| DPI & polling rate | Sensor & angle mode | Button remapping |
|---|---|---|
| ![](docs/media/screens/02-mouse-dpi-polling-sensor.png) | ![](docs/media/screens/13-mouse-sensor-angle-mode.png) | ![](docs/media/screens/03-mouse-button-remap.png) |
| **Live key travel & rapid trigger** | **Lighting effects** | **Per-key RGB** |
| ![](docs/media/screens/14-keyboard-key-travel.png) | ![](docs/media/screens/05-keyboard-lighting-effects.png) | ![](docs/media/screens/06-keyboard-per-key-rgb.png) |
| **Macro editor** | **Per-game auto-switching** | **Light theme** |
| ![](docs/media/screens/08-macro-editor.png) | ![](docs/media/screens/09-auto-profile-switching.png) | ![](docs/media/screens/11-light-theme.png) |

**Themes & languages:** animated backgrounds, colour palettes, eleven languages.

<p align="center"><img src="docs/media/walkthrough/tour-4-themes.webp" alt="Shark Deck walkthrough: themes and languages" width="800"></p>

## Where things are

| Path | What it is |
|---|---|
| **`app/`** | The application: all source **and** the build environment. You develop and build here. |
| **`dist/`** | Build output only. Produced by `npm run dist`; safe to delete and regenerate. Windows/macOS/Linux each produce their own. |
| `dist/app/` | **Just want to run it? This is the launcher.** Unpacked build, no install — `SharkDeck.exe` (Windows), `SharkDeck.app` (macOS), `sharkdeck` (Linux). |
| `dist/installer/` | `SharkDeck-Setup-*.exe` (Windows NSIS), `SharkDeck-*.dmg` (macOS), `sharkdeck_*.deb` / `sharkdeck-*.rpm` (Linux). |
| `dist/portable/` | `SharkDeck-*-portable.exe` (Windows), `SharkDeck-*.zip` (macOS), `SharkDeck-*.AppImage` (Linux) — one self-contained file, no install. |
| `docs/` | Protocol notes, reverse-engineering captures, the brief & roadmap, the [platform support matrix](docs/platform-support.md). |
| `app/assets/` | App icons (`logo.*`), device art, and `brand/` (wordmark) — all shipped in the asar. |
| `legacy/` | The superseded Python V8 profile switcher, kept for reference. |

## Run the app

Nothing built yet, or you just want to launch it:

```bash
cd app
npm install
npm run dev        # dev build with hot reload
npm run dev:web    # or the browser edition, on http://127.0.0.1:5174 (Chrome/Edge)
```

Then run the launcher in `dist/app/` after a build (below) — `SharkDeck.exe`
(Windows), `SharkDeck.app` (macOS), `sharkdeck` (Linux).

## Build the distributables

Each OS builds its own installers — there's no cross-compiling a macOS or
Linux build from Windows or vice versa.

```bash
cd app
npm run dist          # this OS's installer + portable -> ../dist/{installer,portable,app}
npm run dist:mac      # macOS only, when not already on macOS's own default target
npm run dist:linux    # Linux only, when not already on Linux's own default target
npm run pack          # unpacked only, fastest -> ../dist/app
```

Requires Node 24 (22.22 or later works). Windows/macOS/Linux — see
[`docs/platform-support.md`](docs/platform-support.md) for the full support
matrix, what's still unverified off Windows, and the per-OS unsigned-build
story (Windows SmartScreen, macOS Gatekeeper, Linux's udev rule for device
access).

On Windows the build needs no admin rights and no Developer Mode:
electron-builder 26 stamps the exe icon with `resedit` (pure JS) rather than
unpacking the `winCodeSign` vendor archive, whose macOS symlinks used to
require the symlink privilege. The old workaround is kept, unwired, as
`npm run prep:wincodesign` — see [`app/README.md`](app/README.md).

## Develop further

- Architecture, conventions and the capability model: [`CLAUDE.md`](CLAUDE.md)
  and [`app/README.md`](app/README.md).
- What's planned and what's unverified: [`docs/roadmap.md`](docs/roadmap.md) —
  note this is a dated, append-only session changelog rather than a reference
  document. For orientation start with [`CLAUDE.md`](CLAUDE.md) and the generated
  file index at [`docs/MAP.md`](docs/MAP.md).
- Wire protocol and its provenance tags: [`docs/protocol/README.md`](docs/protocol/README.md).
- Per-OS support matrix, the udev rule, and unsigned-build workarounds:
  [`docs/platform-support.md`](docs/platform-support.md).

## License

Copyright © 2026 Alexandre Willame. Shark Deck is free software under the
[GNU General Public License, version 3 or later](LICENSE): you may use, study,
share and change it; versions you distribute must stay under the same license,
with their source, and keep this copyright notice. It comes with no warranty.

If you build on Shark Deck, please credit Alexandre Willame as its original
author.
