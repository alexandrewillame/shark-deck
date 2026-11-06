# SharkDeck

An open-source, auditable configurator for Attack Shark keyboards and mice —
a trustworthy replacement for the vendor's _Mouse Hub_ and _Driver v4_.

- **No network.** A strict CSP plus a `will-navigate` block; the app makes zero
  outbound connections. Model names and artwork are shipped locally instead of
  pulled from the vendor's cloud API.
- **Modular.** One capability enum is the hinge: a device declares what it has,
  a config tab declares what it needs, the UI renders the intersection. Adding a
  model really is close to one file in `src/main/devices/catalog/` (plus art and
  a catalog slot). Adding a _feature_ is not one tab and one capability string —
  it lands in 12–17 files across the type union, the IPC contract, the preload
  bridge, a driver, the simulated-device seeds and the UI. `npm run test:contract`
  checks the wiring; the `add-capability-tab` skill lists every file.
- **Safe by construction.** A full config backup is taken before the first write
  to any device, and every write is read back and diffed. Each protocol command
  is tagged `verified-capture` / `ported-from-vendor` / `inferred`.

## Status

Basics implemented:

- Welcome screen + live USB-HID detection (no manual refresh)
- Device cards: art, model, connection type, online state, battery, active
  profile, firmware, contextual offline tooltip
- Capability-driven config screen with tab rail
- Mouse tabs: Profiles, DPI, Polling Rate, Sensor, Buttons, Macros, Power,
  Pair, Firmware, Restore
- Keyboard tabs: Profiles, Magnetic (interactive key map), Key Remap, Lighting,
  Macros, Power, Screen, Firmware, Restore
- Automatic game-aware profile switching (Steam/Epic scan, rules, tray, pin),
  reimplemented natively from the Python tool now in
  `../legacy/attack-shark-profile-switcher/`
- **V8 profile switching is verified against real hardware traffic.** Other
  writes are wired end-to-end but their frames are still being confirmed — see
  `../docs/protocol/`.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` starts electron-vite (Vite dev server + hot reload) and opens the
app. Requires Node 24 (22.22 or later works). Runs on Windows, macOS, and Linux — see
[`../docs/platform-support.md`](../docs/platform-support.md) for the per-OS
support matrix and what's still unverified off Windows.

If `npm install` prints _"packages have install scripts not yet covered by
allowScripts"_, approve the three native/binary deps once:

```bash
npm approve-scripts electron node-hid esbuild && npm rebuild electron esbuild node-hid
```

## Build a standalone executable

`npm run dist` builds whatever this OS's electron-builder targets are — there's
no cross-compiling a macOS or Linux build from Windows or vice versa; each OS
builds its own.

```bash
# Windows
npm run dist            # -> ../dist/installer/SharkDeck-Setup-<ver>.exe   (NSIS installer)
                        #    ../dist/portable/SharkDeck-<ver>-portable.exe  (single file, no install)
                        #    ../dist/app/SharkDeck.exe                      (unpacked, runnable)
npm run dist:portable   # portable target only

# macOS
npm run dist:mac         # -> ../dist/installer/SharkDeck-<ver>-{x64,arm64}.dmg     (drag-to-Applications)
                        #    ../dist/portable/SharkDeck-<ver>-mac.zip, -arm64-mac.zip  (relocatable .app)
                        #    ../dist/app/mac{,-arm64}/SharkDeck.app             (unpacked, runnable)

# Linux
npm run dist:linux       # -> ../dist/installer/sharkdeck_<ver>_amd64.deb     (installs a udev rule too)
                        #    ../dist/installer/sharkdeck-<ver>.x86_64.rpm   (same)
                        #    ../dist/portable/SharkDeck-<ver>.AppImage      (single file, see below)
                        #    ../dist/app/sharkdeck                         (unpacked, runnable)

npm run pack             # unpacked only, fastest, for testing — this OS's target
```

electron-builder stages raw output in `app/release/`; `scripts/organize-dist.mjs`
then sorts it into `../dist/{installer,portable,app}/` and writes `../dist/README.md`.

All three builds are unsigned by a real certificate — see
[`../docs/platform-support.md`](../docs/platform-support.md) for what that means
on each OS (Windows SmartScreen, macOS Gatekeeper + the ad-hoc-signing story,
and Linux's udev rule for HID access).

**Windows: no admin rights / Developer Mode off?** Not a problem any more.
Older electron-builder shelled out to `rcedit` (from `winCodeSign-2.6.0.7z`) to
stamp the exe icon and version resources, and that archive contains macOS
symlinks 7-Zip can't extract unprivileged — so the build aborted without
Developer Mode or an elevated shell. electron-builder 26 stamps resources with
`resedit` (pure JS) and no longer depends on `7zip-bin`, so an unsigned build
never touches those vendor tools.

`scripts/prep-wincodesign.mjs` (which pre-extracted the archive minus its
`darwin/` folder) is therefore no longer run by `dist` / `pack` /
`dist:portable`. It is kept as a manual escape hatch should a future
electron-builder — or real code signing — need the vendor tools again:

```bash
npm run prep:wincodesign
```

**Linux: `dist:linux`'s `rpm` target** needs `rpmbuild` and `fakeroot` on
`PATH` (`sudo apt install rpm fakeroot` on Debian/Ubuntu) — see
`.github/workflows/build.yml` for the exact packages CI installs.

## Other scripts

```bash
npm run typecheck             # tsc --noEmit
npm test                      # checksum vectors from real V8 captures
npm run build                 # production bundle in out/ (no packaging)
npm run extract               # re-derive protocol data from the installed vendor apps
node scripts/smoke-hid.mjs    # read-only HID probe of connected Attack Shark devices
```

`node-hid` ships an ABI-stable N-API prebuild for every platform (Windows,
macOS x64/arm64, Linux x64/arm64/arm, plus musl), so no compiler is needed on
install anywhere. If `npm run rebuild` / `electron-builder install-app-deps`
ever leaves a locally-compiled `node_modules/node-hid/build/` behind, delete
it — `electron-builder.yml` deliberately excludes it from the packaged app
(see the comment there) because a build compiled on one OS would otherwise
ship on and crash every other OS.

## Layout

```
src/main/      Electron main — the only process that touches HID
  hid/         transport (node-hid), checksum schemes, frame builders
  devices/     capability model, registry, per-model catalog, drivers, manager
  profiles/    profile store, game scan, the auto-switcher
  platform/    per-OS glue (startup-on-login, system mouse settings, process/game scanning) — win.ts / mac.ts / linux.ts behind one Platform interface
  macros/      macro store
  ipc.ts       IPC handlers (guardedWrite, backup-before-write)
  crash.ts     top-level error trap + the debug error window
src/preload/   contextBridge surfaces: index (window.sharkdeck), crash, overlay
src/renderer/  React UI — sandboxed, no Node access. index.html + crash.html
src/shared/    types + IPC contract + capability model + key layouts + i18n
assets/        app icons (logo.*) + device art (devices/<model>.webp)
scripts/       build helpers, protocol extraction, HID smoke probe
../docs/protocol/   provenance-tagged protocol notes
```

## License

GPL-3.0-or-later.
