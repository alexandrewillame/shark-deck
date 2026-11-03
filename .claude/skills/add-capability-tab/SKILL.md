---
name: add-capability-tab
description: Checklist for adding a new device capability to SharkDeck, with or without its own config tab - the exact files to touch, in order, and the wiring points that typecheck fine while doing nothing. Use whenever adding a device feature, a new setting the UI can read or write, a new capability string, or a new config tab.
---

# Adding a capability (and optionally a tab)

Adding a capability touches **12-17 files across 4 directories**. Nothing
enforces that you found them all except the contract tier, so run
`npm run test:contract` when you think you are done - it checks most of the
wiring points below and names the ones you missed.

Do not trust the older claim in `app/README.md` that this is "one tab plus one
capability string". It is not.

## 1. Declare the capability

| File | Change |
|---|---|
| `app/src/shared/types/capability.ts` | Add `\| 'yourCap'` to the `Capability` union. |
| `app/src/shared/capabilities.ts` | Add a `CAPABILITY_META` entry. **Required** - it is typed `Record<Capability, ...>`, so `tsc` fails without it. |

`CAPABILITY_META` does *not* drive the UI (a stale comment used to say it did).
What gates the UI is `hasAny(caps, [...])` plus `configTabs()`. `CAPABILITY_META`
is the exhaustive runtime enumeration the guardrails iterate.

If the capability carries data, add its settings interface to the matching
module under `app/src/shared/types/` -- `mouse-settings`, `keyboard-settings`,
`lighting`, and so on. There is no barrel, so import from the module directly.

## 2. The IPC round trip - all three files, one change

| File | Change |
|---|---|
| `app/src/shared/ipc.ts` | Add `readYourCap()` / `setYourCap()` to `interface Api`. A write must return `Promise<WriteResult>`. |
| `app/src/preload/index.ts` | Add one `yourCap: (id) => invoke('readYourCap', id)` line per method. **Hand-mirrored, no codegen.** |
| `app/src/main/ipc.ts` | Add the handler to the `handlers` object. |

Three traps here, all covered by `npm run test:contract`:

- **A write handler must go through `guardedWrite(id, () => ...)`.** That is what
  takes a backup before the first write to a device (CLAUDE.md invariant #1).
  The contract test derives "mutating" from the `Promise<WriteResult>` return
  type, so a new write method is in scope the moment you declare it.
- **The invoke string must match the method name.** `tsc` cannot catch
  `readSensor: (id) => invoke('readPower', id)` because both are
  `(id: string) => Promise<...>`. The contract test calls every method and
  checks which channel it asks for.
- **`handlers` is typed with every key optional**, so `tsc` does not catch a
  missing handler. The contract test asserts `Api` <-> `handlers` parity both
  ways.

## 3. The driver side

| File | Change |
|---|---|
| `app/src/main/devices/drivers/base.ts` | Add a default method returning `this.notSupported('YourCap')`. Without it, `driverOrThrow(id).readYourCap()` does not exist on other drivers. |
| `app/src/main/devices/drivers/compx-mouse-8k.ts` or `compx-keyboard.ts` or `compx-he-keyboard.ts` | The real `override`, with wire offsets. Use `writeVerified` so the write is read back. |
| `app/src/main/devices/catalog/<model>.ts` | Add `'yourCap'` to that model's `capabilities[]`, plus any `spec` fields. |

Tag any new protocol command with its provenance - `verified-capture`,
`ported-from-vendor`, or `inferred`. See `docs/protocol/README.md`.

## 4. Simulated devices (not optional)

| File | Change |
|---|---|
| `app/src/main/devices/virtual.ts` | Add a field to `VirtualState`, a value in `seed()`, and `override` the read and write. |
| `app/src/main/devices/virtual.test.ts` | Add the read to `READS_BY_CAPABILITY`, **or** a documented reason to `NO_READ`. |

Two rules the tests enforce, because breaking either makes every simulated
card look broken:

- **No read may return `null`** when a descriptor's capabilities expose it -
  `useDeviceData` raises the "couldn't read this device" banner on exactly that.
- **Writes must return `verified: 'match'`** - `useWrite` toasts on anything else.

`virtualDescriptors()` spreads `CATALOG`, so a capability added to a catalog
descriptor is automatically on a simulated device. The read seed is the part you
have to write.

## 5. The UI

| File | Change |
|---|---|
| `app/src/renderer/tabs/<Name>Tab.tsx` | New tab component, if it deserves a tab. Keep it thin - compose sections. |
| `app/src/renderer/tabs/index.tsx` | Push a `TabDef` inside `configTabs()`. **This is the real tab registry.** Gate it on `caps.includes('yourCap')` or `hasAny(caps, [...])`. |
| `app/src/renderer/components/icons.tsx` | A new glyph: add to the `IconName` union and a path to `PATHS`. `TabDef.icon` is typed `IconName`, so this is mandatory. `tsc` catches a missing `PATHS` entry. |
| `app/src/renderer/tabs/common.tsx` | Add a line to `prefetchDeviceReads()`. **Easy to miss:** without it every open of that tab does a cold HID round trip and shows a spinner, for a value that was sitting there unchanged. |
| `app/src/shared/i18n/en.ts` + the 10 locales | `cfg.tab.yourcap` and `cfg.tab.yourcap.desc`. **Use `npm run i18n:add`** - never hand-edit locale files. See the `add-i18n-string` skill. |

If the renderer needs per-model bounds (ranges, option lists), also:

| File | Change |
|---|---|
| `app/src/main/devices/deviceUi.ts` | Add the field in `deviceUi()`. 73 lines, split out of manager.ts. |
| `app/src/shared/types/live.ts` | Add it to `DeviceUi`. |

## 6. Optional: auto-switch participation

Only if the setting should be captured and re-applied by a profile:
`app/src/main/profiles/payload.ts` and `app/src/main/profiles/switcher.ts`.

## 7. Verify

```bash
cd app && npm run --silent check
```

Then, because no test renders your tab, walk it in the real app:

```bash
cd app && npm run dev
```

Settings -> Developer -> **Simulated devices**, open the device your capability
belongs to, and confirm the tab appears, reads a value, and writes without a
warning toast. The Developer row only exists in unpackaged builds.
