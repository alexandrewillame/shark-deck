# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

SharkDeck — an open-source, offline configurator for Attack Shark keyboards and
mice, replacing the vendor's _Mouse Hub_ / _Driver v4_ (which shipped malware).
Electron + React + TypeScript, `node-hid` for USB HID. Cross-platform, with
`app/src/main/platform/` as the seam for the three OS implementations. Windows
is the most hardware-verified — see
[`docs/platform-support.md`](docs/platform-support.md).

It also ships as a **browser edition** (`app/src/web/`, GitHub Pages, WebHID):
the same renderer and the same device layer, with the Electron main process and
preload replaced by an in-page host. See [Browser edition](#browser-edition).

**`cd app` before running anything.** `app/` holds all source and the build.

---

## Working rules

**Verify with one command, not by re-reading files.**

```bash
cd app && npm run --silent check
```

contract → unit → typecheck → ui, cheapest first. ~20s, **3 lines on green**.
It does not format — run `npm run format` too (CI checks formatting). Use
`git diff` to review what you changed. Details and the narrower per-tier
commands: the `verify-change` skill.

**Do not read these.** They are large enough to end a session, and the project
permission rules deny most of them:

| Path | Why |
|---|---|
| `app/scripts/_raw/` | 48k lines of extracted vendor data, incl. a 2.6 MB single-line `qmk-bundle.js`. Tracked only because three tests read it as a fixture. |
| `app/out/`, `app/release/`, `dist/` | Build output. `dist/app/LICENSES.chromium.html` alone is 14.8 MB. |
| `docs/reverse-engineering/*.jsonl` / `.json` / `.bin` | ~22.5k lines of raw Frida captures. The prose that interprets them (`FINDINGS*.md`, `CAPTURE-*.md`) is the useful part. |
| `docs/roadmap.md` | **A dated session changelog, not reference material.** 857 lines of "2026-09-08 pass" entries. |
| `Notes.txt` | Off-limits by request. |

These are excluded from search by the root `.ignore` file, so a grep returns
real source. `.gitignore` covers build output.

**Never run these — they block forever:** the five root `.bat` wrappers (all end
in `pause`), `scripts/smoke-hid.mjs --watch`, `scripts/watch-region-a.mjs`,
`npm run test:watch`. Use `npm run dev`, not `dev.bat`. `npm run dev:web` and
`npm run preview:web` are servers: start them in the background.

`scripts/verify-mouse.mjs` **writes to the device** unless given `--read`.

---

## Where things are

[`docs/MAP.md`](docs/MAP.md) is a generated index of every source file ≥200
lines with its exports — read that instead of opening files to see what is in
them. Regenerate with `npm run map`.

### Task → recipe

Each of these is a skill that loads on demand with the full file-by-file
checklist. They exist because these tasks touch far more files than they look
like they should.

| Task | Skill | Files |
|---|---|---|
| Add a device feature / setting / config tab | `add-capability-tab` | **12–17** |
| Support a new mouse or keyboard model | `add-device-model` | 4 required + 3 conditional |
| Anything the renderer asks the main process for | `add-ipc-method` | 3, always together (4 for a host-only method) |
| Any user-facing string | `add-i18n-string` | 1 command (`npm run i18n:add`) |
| Validate a change / decide if it needs hardware | `verify-change` | — |

### Landmarks

Hubs you cannot avoid. Seek to the symbol rather than reading the file; line
numbers drift, symbol names do not.

| Where | What |
|---|---|
| `app/src/shared/types/` | 11 domain modules, none over 200 lines. `capability` (the `Capability` union) · `device` (`DeviceDescriptor`, `DeviceSpec`) · `live` (`LiveDevice`, `DeviceUi`, `WriteResult`) · `mouse-settings` · `keyboard-settings` · `lighting` · `keys` · `macros` · `profiles` (holds the tree's only runtime export, `resolveLink`) · `app-settings` · `diagnostics`. Import from the module, not a barrel — the import line is the pointer. |
| `app/src/shared/ipc.ts` | `interface Api` (`:41`) — the whole renderer↔main surface, and the source of truth for two guardrails. |
| `app/src/main/handlers.ts` | `createDeviceHandlers()` — `guardedWrite()` and every device / library / backup handler, **shared by both hosts**. Also `createDispatcher()` (own-property routing, paged-read dedupe) and `wireDeviceEvents()`. |
| `app/src/main/ipc.ts` | The desktop host: `desktopHandlers` (auto-switch, app profiles, window chrome, platform glue) and the Electron dispatch. The browser's counterpart is `browserHandlers` in `app/src/web/host/handlers.ts`. |
| `app/src/renderer/state/host.ts` | `hostFeatures` — what the running host can do (window chrome, auto-switch, the WebHID device picker…). Gate host-specific UI on it, as device UI is gated on capabilities. |
| `app/src/renderer/tabs/index.tsx` | `configTabs()` (`:43`) — **the real tab registry.** |
| `app/src/renderer/tabs/common.tsx` | `useDeviceData` (`:97`), `prefetchDeviceReads()` (`:208`), `useWrite` (`:294`), `useAutoWrite` (`:365`). Miss the prefetch and every tab open does a cold HID read. |
| `app/src/main/devices/deviceUi.ts` | `deviceUi()` — per-model bounds the renderer needs. A "must also register here" hub: a capability needing a range, an option list or a slot limit adds a field here AND to `DeviceUi` in `shared/types/live.ts`. 73 lines, split out of `manager.ts`. |
| `app/src/renderer/components/icons.tsx` | `IconName` (`:8`) + `PATHS` (`:58`). |
| `app/src/renderer/components/deviceArtAssets.ts` | `DEVICE_ART` (`:31`), `DEVICE_ART_DETAIL` (`:51`). Static imports only — the renderer CSP forbids fetching. |
| `app/src/renderer/state/bridge.ts` | `sd` — `window.sharkdeck`, reached lazily so renderer modules stay importable in tests. |

### Repository layout

| Path | Role |
|---|---|
| `app/src/main/` | Electron main — the only process that touches HID on the desktop. `hid/` (transport, checksums, frames), `devices/` (capability model, registry, `catalog/` per model, `drivers/`, manager, `virtual.ts` for simulated devices), `profiles/` (store, game scan, auto-switcher), `platform/` (per-OS glue), `macros/`, `handlers.ts` (shared) + `ipc.ts` (desktop), `store.ts` (host-neutral) + `store-fs.ts` (desktop backend), `crash.ts`. Everything `src/web/main.ts` reaches from here must stay Node-free. |
| `app/src/web/` | The browser edition: `main.ts` (boot), `host/` (storage over IndexedDB, `browserHandlers`, the `window.sharkdeck` bridge), `hid/node-hid-webhid.ts` (node-hid over WebHID), `sw.ts` + `pwa.ts` (offline app), `public/` (manifest, icons). |
| `app/src/renderer/` | Sandboxed React UI, no Node. `components/`, `screens/`, `state/` (zustand slices + `bridge.ts`), `tabs/` (+ `tabs/mouse/`, `tabs/device/`, `tabs/keyboard/`, `tabs/lighting/` per-feature sections), `background/` (the app background: a WebGL layer, one GLSL shader per effect — see `docs/design/background.md`), `styles/` (28 area files, ordered by the `styles.css` manifest). |
| `app/src/shared/` | `types/` (11 domain modules), the IPC contract, key layouts, `i18n/`, `mouse-options.ts`. Imported by all three processes via `@shared/*`. |
| `app/src/preload/` | contextBridge surfaces: `index` (`window.sharkdeck`), `crash`, `overlay`. |
| `app/test/` | `reporter.ts` (quiet reporter), `contract/` (invariant guardrails), `lib/`, `setup.ui.ts`. |
| `app/build/` | `csp.ts` — the production CSP hardening, extracted so a test can run it. |
| `app/assets/` | Ships in the asar. `logo.ico`/`logo.png`, `devices/<model>.webp`, `linux/60-sharkdeck.rules`. |
| `app/scripts/` | Build helpers, protocol extraction, hardware probes, `gen-map.mjs`, `i18n.mjs`. |
| `docs/protocol/` | Wire protocol, with provenance tags. |
| `docs/design/` | Settled design decisions, moved out of the source so they are not in the read path of anyone editing the component. Renderer layout, auto-switch, app background. |
| `docs/MAP.md` | Generated file index. |
| `docs/platform-support.md` | Per-OS support matrix: verified vs. unproven. |
| `legacy/` | Superseded Python V8 switcher. Reference only, excluded from search. |

---

## Architecture hinges

- **One capability enum is the pivot.** A descriptor in
  `devices/catalog/<model>.ts` declares a `Capability[]`; the UI renders the
  intersection. What gates it is **`hasAny()` from `shared/capabilities.ts` plus
  `configTabs()`** — _not_ `CAPABILITY_META`, which is a `Record<Capability, …>`
  and therefore the exhaustive runtime enumeration the guardrails iterate. Both
  matter; only one draws the UI.
- **Drivers are keyed by `descriptor.driver`** in `devices/drivers/index.ts`
  (`compx-mouse-8k`, `compx-keyboard`, `compx-he-keyboard`). `manager.ts` owns
  the enumerate/attach/poll loop and emits `devices:changed`;
  `wireDeviceEvents()` in `handlers.ts` hands those to each host, which fans
  them out (`ipc.ts` to every live window, the browser bridge in-page).
- **One renderer, two hosts.** The renderer only knows `window.sharkdeck`. On
  the desktop that is the preload over IPC; in the browser edition it is
  `web/host/bridge.ts` over the same shared handlers, with `node-hid` aliased
  to a WebHID implementation and storage on IndexedDB. Host-specific behaviour
  goes in the host's own table and the renderer gates on `hostFeatures`.
- **HID matching is by usage page + usage**, never by interface path — the
  path's instance suffix changes with USB port. See `hid/transport.ts`.
- **IPC is one `invoke` channel plus one `event` channel**, both typed by
  `shared/ipc.ts`. The renderer only ever sees `window.sharkdeck`.

---

## Invariants — do not break

Each now has a test. Trust the guardrail instead of re-reading the wiring:
`npm run test:contract` is ~1 second and checks all of it.

| Invariant | Enforced by |
|---|---|
| **Backup before the first write to any device.** Every mutating handler goes through `guardedWrite()`, which calls `deviceManager.ensureBackup()` and refuses the write if it fails. It lives in the shared table, so both hosts get it. | `test/contract/ipc-guarded-write.test.ts`. "Mutating" = an `Api` method returning `Promise<WriteResult>`, read off the AST. Every one must be in the shared table, guarded; no host table may redefine a shared method; each host's tables must cover the whole `Api`. Three documented exemptions: `startPairing`, `restoreBackup`, `applyProfile`. |
| **The preload bridge mirrors `Api` exactly.** Hand-written, no codegen. | `test/contract/preload-mirrors-api.test.ts` — parity both ways, **plus** calling every method to confirm it asks for its own channel (`tsc` cannot see a wrong invoke string). The browser bridge is built from its tables, whose completeness `satisfies` and the guarded-write test prove. |
| **No network.** Strict CSP, `will-navigate` block, `setWindowOpenHandler` deny. Model names and art are bundled, never fetched. The browser edition ships `connect-src 'none'`; its service worker (`src/web/sw.ts`) is the one file allowed a request — same origin, GET, its own files. | `test/contract/no-network-csp.test.ts` — including proof that the production CSP hardening actually fires (for both pages), and the service worker's guards, pinned verbatim. |
| **The browser edition reaches no Node or Electron code.** | `test/contract/browser-node-free.test.ts` walks every import from `src/web/main.ts` (with the Vite aliases) and fails on Node built-ins, Electron, `process.*`, `Buffer`, `require`. `vite.web.config.ts` also fails the build on them. |
| **The WebHID shim covers what `transport.ts` uses.** | `test/contract/webhid-shim.test.ts` — every `HID.x` / `dev.x()` in transport.ts must be in the shim's `IMPLEMENTED`. |
| **Renderer stays sandboxed** (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). | `test/contract/window-security.test.ts` — AST boolean literals, so a commented-out flag reads as absent rather than passing. |
| **Every capability has a simulated-device seed.** No read may return `null` where a descriptor exposes it, and writes must return `verified: 'match'`. | `src/main/devices/virtual.test.ts` — all 39 capabilities must be read-seeded or carry a documented `NO_READ` reason. |
| **Every protocol command carries a provenance tag** — `verified-capture` / `ported-from-vendor` / `inferred`. Only V8 profile switching is `verified-capture`; treat the rest as unconfirmed and keep the read-back diff. | `test/contract/protocol-provenance.test.ts` — coarse by design (there is no reliable way to enumerate "every command"), but it pins five things: the docs tag table and the `Provenance` type cannot drift apart; every descriptor carries a tag and developer mode preserves it; every module on the protocol allowlist records its confidence level in a comment; every labelled `provenance:` note names a canonical tag; and every file in a protocol directory must be classified, so the allowlist cannot rot by omission. |

---

## Commands (from `app/`)

```bash
npm run --silent check    # contract + unit + typecheck + ui. 3 lines on green
npm test                  # all tiers, one line
npm run test:contract     # ~1s: the invariants above
npm run test:unit         # ~3s: drivers, codecs, stores
npm run test:ui           # ~3s: jsdom + React hooks
npm run test:changed      # only what the git diff reaches
npm run test:verbose      # default reporter, when you need a test's console output
npm run typecheck         # tsc --noEmit
npm run format            # prettier --write .
npm run dev               # dev build, hot reload
npm run dev:web           # browser edition dev server, http://127.0.0.1:5174 (background it)
npm run build:web         # browser edition -> out/web/
npm run preview:web       # serve out/web/ on http://127.0.0.1:4174 (background it)
npm run map               # regenerate docs/MAP.md
npm run i18n:add -- 'a.key' 'English text'   # writes all 11 locales
npm run i18n:todo         # untranslated placeholders
npm run dist              # this OS's installer + portable + unpacked -> ../dist/
```

There is no cross-compiling; `npm run dist` targets whichever OS it runs on.
`dist:mac` / `dist:linux` just make that explicit (used by the CI matrix).

If `npm install` warns about un-approved install scripts:
`npm approve-scripts electron node-hid esbuild && npm rebuild electron esbuild node-hid`.

---

## Developer mode (no hardware)

Settings → Developer → **Simulated devices** (the row only exists in unpackaged
builds) fills the home grid with one fake device per supported shape — every
`CATALOG` model plus one of each synthetic family from `registry.ts`. This is
the substitute for the rendering tests the repo does not have: any renderer
change should be walked here.

`devices/virtual.ts` holds the roster and `VirtualDriver`, which answers every
read with plausible state seeded from the descriptor's `spec` and remembers
writes for the session.

Every simulated descriptor carries `simulated: true`, which each path that
writes to a **per-model** store checks first (`ensureBackup`,
`seedSoftwareProfilesIfNeeded`, `backupNow`, `captureSoftwareProfile`) — those
stores are keyed by model and shared with real hardware, so a fake V8 must never
write into the real V8's profiles or backups. `devices/manager-devmode.test.ts`
asserts no store write happens at all.

---

## Verifying HID changes

`npm test` covers checksums and codecs against captured frames; it does not
prove a frame reaches a device. For anything that builds or sends one, run
`node scripts/smoke-hid.mjs` with the real device connected (read-only, ~8–10
lines per device), and for a mutating change confirm the read-back diff in the
app's developer frame log before and after.

Two documented quirks in `hid/transport.ts` (`isEcho()`, the command-byte filter
in `request()`) are Windows HID-driver behaviours carried over from the original
Windows-only implementation — whether Linux hidraw or macOS IOHIDManager
echo/broadcast the same way is unconfirmed. If a report is rejected or misread
**only** on macOS/Linux, look there before assuming the wire protocol is wrong.

---

## Browser edition

`npm run build:web` → `out/web/`, published to
`https://alexandrewillame.github.io/shark-deck/` by `.github/workflows/pages.yml`
**when a GitHub Release is published** (not on every push). Chromium desktop
only (WebHID).

- **What differs is the host, not the app.** `vite.web.config.ts` aliases
  `node-hid` to `src/web/hid/node-hid-webhid.ts`, so `transport.ts`, the drivers
  and the manager run unchanged. `src/web/main.ts` installs IndexedDB storage
  (`installStorage`), configures the manager (`serialless: 'model'` — WebHID has
  no serial numbers, so the V8's dongle and cable merge by model), builds
  `window.sharkdeck` and only then imports the renderer.
- **Out of this edition:** auto-switch, app profiles, tray, start-at-login,
  overlay, window chrome, ambient (screen/music) lighting, simulated devices.
  `browserHandlers` answers those methods with empty shapes; the renderer hides
  them via `hostFeatures`.
- **Nothing else repaints the page.** `src/web/index.html` carries
  `color-scheme: only light` (turns off the browsers' forced dark) and
  `darkreader-lock` (Dark Reader stands down); `src/web/index.test.ts` pins
  both.
- **A device must be picked** in the browser's own dialog
  (`requestDeviceAccess()`, from a click). Devices with no USB serial (the
  R85HE) are forgotten by the browser on unplug.
- **Testing it:** the built-in browser pane can render the UI (`npm run
  preview:web`) but has neither the WebHID chooser nor working service workers.
  Real devices need Chrome on `http://127.0.0.1` with the desktop Shark Deck
  (tray) quit first — both polling one device interleave frames. The service
  worker's lifecycle can be driven from `node_modules/electron/dist/electron.exe`
  with a hidden window in an **in-memory** partition.
