---
name: verify-change
description: How to validate a change in SharkDeck cheaply - which command to run for which kind of edit, what needs real hardware, and which scripts never exit. Use before reporting work done, when tests or typecheck fail, or when deciding whether a change needs hardware.
---

# Verifying a change

## The one command

```bash
cd app && npm run --silent check
```

format -> contract -> unit -> typecheck -> ui, cheapest first. **About 20
seconds, 3 lines of output on green.** Use `--silent` so npm does not prepend
two lines per step.

Do not verify by re-reading the files you edited. `git diff` shows what you
changed; `check` shows whether it works.

## Narrower runs while iterating

| Command | When | Cost |
|---|---|---|
| `npm run test:contract` | Touched IPC, the preload bridge, a descriptor, `virtual.ts`, a `.html`, or a `BrowserWindow` | ~1s |
| `npm run test:unit` | Touched a driver, `shared/`, or main-process logic | ~3s |
| `npm run test:ui` | Touched a renderer hook or a `.tsx` | ~3s |
| `npm run typecheck` | Any TypeScript edit | ~6s |
| `npm run test:changed` | Broad edit, unsure what it affects - runs only what the diff reaches | varies |
| `npm test` | Everything, one line | ~5s |

`test:changed` resolves dependents through the module graph, so editing
`shared/mouse-wire.ts` pulls in every driver test that imports it. It cannot
see the contract tier's dependencies though - those tests read files with `fs`,
not `import` - so `check` always runs the full 1-second contract tier instead.

## On failure

The reporter prints only failures: file, test path, message, diff, first
in-project stack frame. That is usually enough. If you need a test's own
`console.log` or the per-file listing:

```bash
cd app && npm run test:verbose
```

`npm run test:bail` stops at the first failure, for when a suite goes broadly
red and the output is repetitive.

## What `check` cannot tell you

**Nothing renders a component.** Hook order, `useEffect` cleanup, `key`
identity and portal mounting all typecheck and unit-test fine while visibly
broken. For any renderer change:

```bash
cd app && npm run dev
```

Settings -> Developer -> **Simulated devices** (the row only exists in
unpackaged builds) fills the home grid with one fake device per supported
shape. Walk the affected tab on both a simulated mouse and a simulated
keyboard, and check the DevTools console for new warnings.

**CSS has no type system.** The rules live in `app/src/renderer/styles/`,
imported in order by `styles.css`. The rigorous check is that the built
stylesheet filename is a content hash:

```bash
cd app && npm run build && ls out/renderer/assets/*.css
```

An unchanged filename proves the bundled CSS is byte-identical - which is what
makes a mechanical restructure safe to verify without eyeballing the app.

Two things to know when the hash *does* move:

- **Comments count.** Vite does not minify the CSS, so every comment ships.
  Adding one changes the hash without changing a single rule. To tell the two
  apart, strip comments and whitespace from the before/after files and compare
  those - identical stripped output means no rule, selector or declaration
  changed.
- **`url()` is not rebased, and Vite does not warn.** Moving a rule into a
  file one directory deeper leaves a relative asset path pointing at nothing;
  Vite emits the unresolvable string instead of erroring. The only `url()` in
  the stylesheet is the topbar wordmark in `styles/layout.css`, and it is a
  CSS mask - so a broken path makes the glyph silently vanish with a clean
  build. Check the built CSS actually contains a hashed asset name:

```bash
cd app && grep -o "url([^)]*)" out/renderer/assets/index-*.css
```

## What needs real hardware

`npm test` covers checksums and codecs against captured frames. It does not
prove a frame reaches a device. For anything that builds or sends a frame:

```bash
cd app && node scripts/smoke-hid.mjs
```

Read-only, ~8-10 lines per connected device. `--probe <vid>:<pid>` for a model
it does not know.

For a mutating change, confirm the read-back diff in the app's developer frame
log before and after.

```bash
cd app && node scripts/verify-mouse.mjs --read
```

Decode-only pass over the V8's config block. **Without `--read` this script
writes to the device** - it snapshots, writes a test value, reads back, and
restores, per field. Only run the mutating form deliberately, with the V8 awake
and both the vendor Mouse Hub and SharkDeck closed (they hold the collection).

## Never run these - they block forever

| Command | Why |
|---|---|
| `scripts/smoke-hid.mjs --watch` | Re-enumerates every second, no exit |
| `scripts/watch-region-a.mjs` | 400 ms poll loop, no exit. Its purpose is to sit beside the vendor Hub while you change one setting, to find which offset moved |
| `build.bat`, `run.bat`, `dev.bat`, `build&run.bat`, `build&dev.bat` | All end in `pause` and wait on a keypress |
| `npm run test:watch` | Watch mode |

Use `npm run dev` rather than the `.bat` wrappers.

## Platform caveat

Two quirks in `app/src/main/hid/transport.ts` - `isEcho()` and the command-byte
filter in `request()` - are Windows HID-driver behaviours carried over from the
original Windows-only implementation. Whether Linux hidraw or macOS
IOHIDManager echo the same way is unconfirmed. If a report is rejected or
misread **only** on macOS or Linux, look there before concluding the wire
protocol is wrong. See `docs/platform-support.md`.
