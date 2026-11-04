---
name: add-ipc-method
description: How to add a method to SharkDeck's renderer-to-main IPC surface - the three files that must change together, and the two mistakes that typecheck cleanly. Use when adding anything the renderer needs to ask the main process for, or any new read or write of device state.
---

# Adding an IPC method

Three files, always in one change. There is no codegen: the preload bridge is a
literal hand-written transcription of the `Api` interface.

| # | File | Change |
|---|---|---|
| 1 | `app/src/shared/ipc.ts` | Declare it on `interface Api`. |
| 2 | `app/src/preload/index.ts` | `yourMethod: (a, b) => invoke('yourMethod', a, b),` |
| 3 | `app/src/main/handlers.ts` | Add the implementation to `deviceHandlers` — the table **both hosts** share (the desktop and the browser edition). Anything that needs only the device layer or app data goes here. |

**A method only one host can do** (it needs Electron or the OS — a window, a
native dialog, the process list) goes in that host's table instead of #3, and
then **both** host tables need an entry — a fourth file:

| Host | Table |
|---|---|
| desktop | `desktopHandlers` in `app/src/main/ipc.ts` |
| browser | `browserHandlers` in `app/src/web/host/handlers.ts` — answer with the empty shape the renderer already handles, and gate the UI on `hostFeatures` (`app/src/renderer/state/host.ts`) |

Both host tables are declared `satisfies { [K in HostMethods]: Handler }`, so
`tsc` fails if either misses a host method or redefines a shared one.

The renderer then calls it as `sd.yourMethod(...)` - `sd` comes from
`app/src/renderer/state/bridge.ts` (or is re-exported by `tabs/common.tsx`).

## Return-type conventions

| Shape | Means |
|---|---|
| `Promise<X \| null>` | A read. `null` = **the device did not answer**. `[]` / `{}` = genuinely empty. `useDeviceData` raises the "couldn't read" banner on `null`, so do not use it for "empty". |
| `Promise<WriteResult>` | A write. **This return type is what marks the method as mutating**, and the contract test derives the backup-guard requirement from it. |
| `Promise<{ ok: boolean; error?: string }>` | An action that is not a device write (e.g. `deleteBackup`, `startTravelStream`). |

## A write must go through `guardedWrite`

```ts
setYourThing: (id: string, v: any) => guardedWrite(id, () => driverOrThrow(id).setYourThing(v)),
```

`guardedWrite` calls `deviceManager.ensureBackup(id)` and **refuses the write**
if no backup could be taken - so a device that can be written but not fully read
never gets mutated with nothing to restore from. It also calls the host's
`onDeviceWrite` hook (the desktop's `switcher.noteDeviceWrite()`) and
`deviceManager.noteWriteStart(id)`, which is how auto-switch knows something
changed and how the live poll avoids reading mid-write.

This is CLAUDE.md invariant #1. `npm run test:contract` enforces it: any `Api`
method returning `Promise<WriteResult>` whose handler does not call
`guardedWrite(` fails, unless it is one of three documented exemptions
(`startPairing`, `restoreBackup`, `applyProfile`).

## The two mistakes that typecheck cleanly

**1. Forgetting the preload line.** `const api: Api` means `tsc` *does* catch a
missing method - but only because of that annotation. Forgetting it entirely is
a runtime `undefined is not a function`.

**2. A wrong invoke string.** This one `tsc` cannot see:

```ts
readSensor: (id) => invoke('readPower', id),   // compiles fine, silently wrong
```

Both signatures are `(id: string) => Promise<...>`, so they are mutually
assignable. There are ~90 hand-written `invoke('name', ...)` lines and nothing
but the contract test checks that each matches its own key - it calls every
method and asserts which channel it asks for.

**Also:** the shared table is typed `{ [K in keyof Api]?: ... }` — every key
optional — so on its own it cannot prove completeness. The host tables'
`satisfies` does, and the contract test asserts `Api` <-> shared + host parity
for each host, in both directions. A new **write** must be in the shared table:
the test fails a mutating method found only in a host table.

**Browser edition:** add any new `Promise<WriteResult>` method to
`DEVICE_WRITES` in `app/src/web/host/bridge.ts` (the page warns before closing
mid-write); `test/contract/browser-api.test.ts` fails until you do.

## Push events instead of a call

For main -> renderer, add a channel to `interface Events` in the same file and
emit it from the main process. The renderer subscribes with
`sd.on('your:event', cb)`, which returns an unsubscriber. One shared
`ipcRenderer.on` fans out to all subscribers - do not add another listener on
`IPC.event`.

## Verify

```bash
cd app && npm run test:contract && npm run typecheck
```

About seven seconds, and it checks the whole round trip: parity in both
directions, per-method channel identity, and the backup guard.
