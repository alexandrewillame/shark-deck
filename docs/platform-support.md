# Platform support

SharkDeck runs on Windows, macOS and Linux. This page is the honest account
of what that means in practice: what's implemented, what's been confirmed
against real hardware, and what is code-complete but unverified because it
was built on a Windows machine with no Mac or Linux box to test against.

## Support matrix

| Area | Windows | macOS | Linux |
|---|---|---|---|
| HID device access | ✅ hardware-verified | ⚠️ implemented, unverified (opened non-exclusively) | ✅ R85HE hardware-verified (WSL2 + usbipd); V8 untested. Needs the udev rule |
| Installer | NSIS `.exe` | `.dmg` (arm64 and x64) | `.deb` / `.rpm` |
| Portable build | portable `.exe` | `.zip` (relocatable `.app`) | `.AppImage` |
| Code signing | unsigned | ad-hoc signed (no Developer ID) | unsigned (not applicable on Linux) |
| Start at login | Startup-folder shortcut | login item, starts hidden | XDG autostart `.desktop` entry |
| System mouse settings link | Control Panel applet | System Settings pane | best-effort (GNOME/KDE/XFCE), toast if none found |
| Tray icon | ✅ | ✅ (menu bar) | ✅ GNOME (AppIndicator) and KDE Plasma 6, nested sessions; with no tray host closing quits |
| App menu | none | translated native menu | none |
| Profile-switch card | ✅ | ✅ (stays above full-screen apps) | ✅ under X11/XWayland; a desktop notification on native Wayland |
| Native window chrome | fully custom | native traffic lights | fully custom |
| Auto-switch: process detection | `tasklist` / PowerShell | `ps` | `/proc` (Proton/Wine games by their `.exe` name) |
| Auto-switch: Steam library scan | ✅ | ✅ | ✅ (incl. Flatpak and Snap Steam) |
| Auto-switch: Epic library scan | ✅ | n/a — no Epic launcher | n/a — no Epic launcher |
| Music lighting effect (system audio) | ✅ | n/a — no system-audio loopback | n/a — no system-audio loopback |
| CI (format, typecheck, all test tiers) | ✅ | ✅ | ✅ |

## Why Windows is ahead

This project's entire hardware-verification history — the protocol capture
sessions in `docs/reverse-engineering/`, every `verified-capture` /
`ported-from-vendor` provenance tag in `docs/protocol/`, every manual test —
happened on Windows, the OS the keyboard and mouse were first plugged into
(the R85HE has since been run on Linux too — see "Exercised on Linux"
below). The mac/Linux platform code
(`src/main/platform/mac.ts`, `linux.ts`) and packaging were written and
typechecked without a Mac or Linux machine to run them on. CI now runs the
contract, unit and UI tests on all three operating systems
(`.github/workflows/ci.yml`), and a release build only starts once they pass —
but no CI runner has an Attack Shark device plugged in.

That matters most for the HID layer. `hid/transport.ts` encodes two behaviours
that are documented as **Windows HID-driver specifics**, not universal USB/HID
facts:

- **`isEcho()`** — in feature-report mode, Windows hands back the report a
  command just *sent* when the firmware hasn't populated a reply buffer yet.
  Rejecting that echo is what fixed a bogus `v0.00` firmware readout on
  Windows. Whether macOS's IOHIDManager or Linux's hidraw ever produce the
  same echo is unknown.
- **The command-byte filter in `request()`** — exists because Windows
  delivers every input report to *every* open handle, so the vendor Hub
  app's own status poll (if it's also running) has to be filtered out by
  reply command byte. hidraw and IOHIDManager may not broadcast the same way.

Matching by USB HID usage page + usage (`findVendorCollection()`) rather than
by device path or collection index is deliberately the *portable* choice —
hidapi (bundled, version 0.15.0) populates `usagePage`/`usage` identically on
all three backends, verified by reading the hidapi source for each platform.
That part should hold. The echo/broadcast quirks above are the parts that
genuinely need a real device on real hardware to confirm one way or the
other — until then, every write still goes through the existing
backup-before-write and read-back-and-diff machinery (`CLAUDE.md`'s
invariants), so a wrong assumption fails safe rather than silently.

**If you have Attack Shark hardware and a Mac or Linux machine**, the most
useful thing you can do is: install the app, run
`node scripts/smoke-hid.mjs` from `app/` with the device connected, and
[open an issue](https://github.com/alexandrewillame/shark-deck/issues) with
the output — especially anything that looks like a
timeout, an echoed reply, or a checksum mismatch that doesn't reproduce on
Windows. The checklist at the end of this page lists the rest.

## Linux

### The udev rule

node-hid's Linux backend (hidraw) opens `/dev/hidraw*` directly, which by
default only root can read/write. `assets/linux/60-sharkdeck.rules` grants
access to Attack Shark (`3554`) and Compx (`3151`) devices — the two vendor
IDs `main/devices/registry.ts`'s `knownVendorIds()` enumerates — to whoever's
logged in at the console:

```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151", TAG+="uaccess"
```

`TAG+="uaccess"` (systemd-logind's per-seat ACL mechanism) is used instead of
a blanket `MODE="0666"` deliberately — it grants access to the active local
session rather than to every user on a shared machine. `ATTRS{idVendor}`
(plural — matches an ancestor device, not just the hidraw node itself) is
required because the hidraw device node carries no vendor-id attribute of its
own; only its USB parent does.

**The .deb and .rpm packages install this automatically.** Their
`afterInstall` script (`scripts/linux/after-install.sh`, run as root) is
electron-builder's own post-install — the `/usr/bin/sharkdeck` link, the
sandbox helper's permissions, the AppArmor profile Ubuntu 24.04 needs —
followed by copying the rule into `/lib/udev/rules.d/` and re-triggering only
the hidraw nodes. `after-remove.sh` deletes the rule on uninstall only: an
rpm upgrade runs the old package's removal script *after* the new one's
install, and without that guard every upgrade deleted the rule it had just
installed. A test (`app/src/main/hid/linux-install-scripts.test.ts`) keeps
both scripts LF-only, free of `${…}` text electron-builder would try to
expand, and in step with the template steps they replace.

**The AppImage has no install step to hook**, so it ships the rule and a
manual installer alongside itself instead:

```bash
./SharkDeck-*.AppImage --appimage-extract
sudo sh squashfs-root/resources/udev/install-udev-rules.sh
```

That script installs the rule to `/etc/udev/rules.d/` — the one rules
directory still writable on image-based systems where `/usr` is read-only
(SteamOS, Bazzite, Fedora Silverblue/Kinoite) — and, where AppArmor restricts
unprivileged user namespaces (Ubuntu 24.04+), an AppArmor profile that lets
the AppImage keep Chromium's sandbox (see below).

Without the rule, opening the device fails with a permission error that
SharkDeck surfaces as an in-app hint (`hint.offlinePermission`) on the
device's card, and — where the failure happens early enough — a scan
diagnostic on the Welcome screen (`ScanUnmatchedReason: 'permission-denied'`).
It does *not* look like "nothing plugged in": the device still enumerates and
resolves to a descriptor (reading the report descriptor needs no privilege on
Linux — only opening the node for read/write does), it just stays offline
until the rule is installed and the device is reconnected.

A test (`app/src/main/hid/udev-rules.test.ts`) asserts the rule file's VIDs
match `knownVendorIds()` in both directions, so adding a device to the
catalog with a new vendor ID fails `npm test` instead of silently shipping a
Linux build that can't see the new device.

### Running the AppImage

- **Make it executable** after a download: `chmod +x SharkDeck-*.AppImage`.
- **It needs FUSE 2** (electron-builder's default AppImage runtime). Most
  desktops have it; where they don't: `sudo apt install libfuse2t64` (Ubuntu
  24.04), `sudo apt install libfuse2` (Ubuntu 22.04 / Debian), `fuse-libs`
  (Fedora), `fuse2` (Arch). Or skip FUSE entirely with
  `./SharkDeck-*.AppImage --appimage-extract-and-run`.
- **It needs libusb 1.0.** node-hid's Linux binding links `libusb-1.0.so.0`
  (its hidraw build too), and without it no device is ever found — the
  Welcome screen then says so and names the package. Desktops usually have
  it; a minimal install does not: `sudo apt install libusb-1.0-0` (Ubuntu /
  Debian), `libusb1` (Fedora), `libusb` (Arch). The `.deb` and `.rpm`
  declare it, so their installers pull it in.
- **The sandbox on Ubuntu 24.04+.** The AppImage's launcher checks whether it
  can create a user namespace and, where AppArmor forbids it, starts the app
  with `--no-sandbox` — it runs, without Chromium's sandbox. The AppArmor
  profile `install-udev-rules.sh` installs puts the sandbox back.

### Wayland

The `.deb`/`.rpm` menu entry, the autostart entry and the AppImage's embedded
entry all start the app with `--ozone-platform=x11`, so in a Wayland session
it runs under XWayland. A native Wayland client cannot place its own window,
stay above a full-screen game or let clicks pass through, and the
profile-switch card needs all three. Started some other way — an AppImage
double-clicked in a file manager — the app runs natively on Wayland and
shows a desktop notification in place of the card (`overlayWindow.ts`,
`nativeWayland()`).

### Tray icon

`Tray` needs a StatusNotifier host: KDE has one built in, GNOME only with the
AppIndicator extension (Ubuntu enables it by default; on Fedora and other
stock GNOME desktops it has to be installed).
Electron gives no error without one — it just draws nothing — so
`platform/linux.ts`'s `trayAvailable()` asks D-Bus for
`org.kde.StatusNotifierWatcher` first. With no host there is no tray icon,
"Close to tray" is switched off, and closing the window quits the app instead
of hiding it somewhere unreachable.

The tray was exercised in Ubuntu's GNOME Shell 50 (AppIndicator extension)
and in KDE Plasma 6.6 — KDE's own `kded6` watcher and Plasma's system tray —
each run nested under WSLg: the icon shows in the top bar / panel, the menu
reads Open Shark Deck · Auto-switch · Quit Shark Deck, closing the window
leaves the app in the tray, and the menu's Open and Quit work. GNOME's
extension lists items as `<bus>@<path>`, KDE as `<bus>/<path>`, and Electron
hands GNOME an icon file and KDE raw pixels; both rendered.

The `sharkdeck` icon the menu entry names comes from `app/build/icons` (16–512
px). Built from the 1254 px `logo.png` alone, it was installed as
`hicolor/1254x1254`, a size no icon theme lists, and menus and docks showed
a generic icon instead.

### Proton and Wine games

A Windows game under Proton shows up in `/proc` as the Wine preloader
(`/proc/<pid>/exe` → `wine64-preloader`), not as the game. The process scan
reads the game's own name from its command line (`Z:\…\cs2.exe` → `cs2.exe`)
and leaves Wine's own service processes out of the running-apps list, so an
Auto-switch trigger can name a Proton game exactly as it would on Windows.
`linuxProc.test.ts` covers the naming.

## macOS

### Unsigned and ad-hoc signed

There's no Apple Developer ID behind this build, so:

- **No real code signing, no notarization.** `electron-builder.yml` sets
  `mac.identity: null`.
- **Ad-hoc signed anyway** (`scripts/adhoc-sign-mac.mjs`, an `afterPack`
  hook running `codesign --sign -`) — without *any* signature, an Apple
  Silicon Mac refuses to launch the app at all ("is damaged and can't be
  opened"), which is a harder failure than the ordinary unsigned-app warning.
- **Gatekeeper still blocks the first launch.** On macOS 15 (Sequoia) and
  later: try to open the app once, dismiss the warning, then open System
  Settings → Privacy & Security and click **Open Anyway**. On earlier
  versions: right-click the app → Open, and confirm. Either way, clearing the
  quarantine attribute also works:

  ```bash
  xattr -dr com.apple.quarantine /Applications/SharkDeck.app
  ```

If a Developer ID certificate becomes available later: delete
`mac.identity: null` and the `afterPack` hook from `electron-builder.yml`,
set `identity` to the certificate name, and add a `notarize` block — see
[electron-builder's macOS signing docs](https://www.electron.build/code-signing-mac).

### HID

**No special entitlement or permission.** Both catalog devices (`v8.ts`,
`r85he.ts`) use vendor-defined HID usage pages (`0xFF02`, `0xFFFF`), not the
standard keyboard/mouse usage pages macOS gates behind Input Monitoring
consent. If a future device descriptor ever targets a standard HID usage
page, that would change.

**Opened non-exclusively.** hidapi's macOS backend seizes a device by default,
which would lock out the vendor's own app — and anything else holding the
device locks SharkDeck out. `hid/transport.ts` passes `nonExclusive: true`,
and a refusal to open is reported as a permission problem with a Mac-specific
hint (quit other keyboard or mouse software, then reconnect).

### App behaviour

- **The Dock and the menu bar.** Clicking the Dock icon brings the window
  back after it was closed to the menu bar. The app menu (About, Hide, Quit,
  Edit, Window) follows the app's language. The profile-switch card is a
  non-activating panel that shows above full-screen apps without taking focus
  or hiding the Dock icon.
- **Start at login** starts the app hidden. macOS passes a login item no
  arguments, so `index.ts` recognises a login launch through
  `app.getLoginItemSettings().wasOpenedAtLogin` instead of `--hidden`.
- **Shortcuts use ⌘**, and the tooltips that name keys say ⌘ and ⌥. Ctrl+Tab
  still cycles tabs (⌘Tab is the system's app switcher), and ⌘W on Home is
  left to the menu's Close Window.
- **Macro recording.** macOS sends no key-up for a key released while ⌘ is
  held, and one event per Caps Lock press; the recorder closes both off so a
  recorded macro never leaves a key stuck down.
- **Screen Colour lighting** asks for the Screen Recording permission the
  first time. The Music effect needs system-audio capture, which macOS does
  not offer without a virtual audio device.

## Windows

Unchanged from before this cross-platform work — still the most-tested path.
Builds are unsigned; Windows SmartScreen shows a "more info → run anyway"
prompt on first launch. See the root [`README.md`](../README.md) and
[`app/README.md`](../app/README.md) for build instructions.

## Auto-switch parity notes

- **Process name matching stays case-insensitive everywhere** (both the
  scanner and the stored trigger are lowercased), even though Linux
  filenames are case-sensitive by nature — this was already true of the
  Windows-only code and is preserved rather than "fixed", since a stricter
  Linux-only case-sensitive path would just make triggers harder to type
  correctly for no real benefit.
- **`DEFAULT_GAME_PROCESSES`** (the seeded, disabled "Gaming" profile's
  triggers) keeps literal `.exe` names like `cs2.exe` on every OS: the games
  in that list are Steam titles that overwhelmingly run under Proton on
  Linux, which reports the Windows binary's own name (see "Proton and Wine
  games" above). Linux adds `cs2` as well — Counter-Strike 2 has a native
  Linux build.
- **Manually adding a trigger** uses `PlatformInfo.processSuffix` (`.exe` on
  Windows, empty elsewhere) for the dialog's suffix and placeholder text, but
  a Linux/macOS user is free to type `.exe` anyway for a Proton/Wine game —
  the suffix is a convenience default, not an enforced format.
- **macOS process/game names**: the running-process scan
  (`platform/mac.ts`) reports the Mach-O binary name inside
  `Game.app/Contents/MacOS/`, which often differs from the `.app` bundle's
  own name. Browsing for an app therefore reads the bundle's
  `CFBundleExecutable` from its `Info.plist` (`bundleExecutableName()`), so a
  trigger added that way matches the process that actually runs.

## Exercised on Linux (Ubuntu 26.04 under WSL2, 2026-11-03)

- The CI gate (`npm run check`) and the release build (`npm run dist:linux`,
  all three packages) on Linux.
- `.deb`: install, upgrade 0.1.0 → 0.1.1 (apt pulled in libusb), removal and
  purge. `.rpm`: install, upgrade — the udev rule survives, which is the old
  `%postun` bug — and erase. `udevadm verify` on the rule in both locations.
- AppImage: the FUSE error without libfuse2, `--appimage-extract-and-run`, the
  normal FUSE run, `install-udev-rules.sh`, and a native-Wayland start.
- The packaged app under WSLg, driven over DevTools: closing quits when there
  is no tray host; the autostart entry (passes `desktop-file-validate`, points
  at the AppImage file when run from one); Proton/Wine process naming against
  faked `/proc` entries; the mouse-settings fallback; HID enumeration with and
  without libusb.

**With a real R85HE** (passed to WSL with usbipd-win, same day):

- Through the udev rule alone the hidraw nodes stayed root-only — WSL has no
  seat for `uaccess` to grant — and the app showed the device offline with the
  permission hint, as a Linux user without the rule would see it.
- With access granted as a desktop session would get it,
  `npm run verify:he` (the real `CompxHeKeyboard` read path) printed the same
  firmware, options and per-key actuation as on Windows, line for line, and
  its no-op write sent the identical frame and verified `match`. Neither
  Windows quirk in `hid/transport.ts` (`isEcho()`, the command-byte filter)
  rejected anything on hidraw.
- In the installed app: the device online, its reads, a backup taken before
  the first write, a no-op options write and a brightness change and restore,
  both verified `match` by read-back.

**AppArmor at run time** (WSL kernel booted with `apparmor=1`, Ubuntu's 178
profiles loaded):

- With AppArmor active, the `.deb`'s post-install installs and loads
  electron-builder's `sharkdeck` profile, and every Shark Deck process runs
  under it (`sharkdeck (unconfined)`).
- The AppImage's installer skips its profile where the kernel has no
  `apparmor_restrict_unprivileged_userns` (nothing to lift there). Loaded by
  hand, the profile attaches to both the `.AppImage` file and the app inside
  its `/tmp/.mount_SharkD…` mount; a program started under it whose path
  matches no profile keeps it, and can still create a user namespace — the
  inheritance the profile relies on.
- What WSL cannot show: the restriction itself. Its sysctl is an Ubuntu
  kernel patch, absent from WSL's kernel, so "no sandbox without the profile,
  sandbox with it" still needs a real Ubuntu 24.04+ machine.

Not covered there: the V8 mouse, and the Ubuntu kernel's user-namespace
restriction itself (see above).

## What's genuinely unverified (read before reporting "it doesn't work")

- Any real HID read/write against Attack Shark hardware on macOS, and the V8
  mouse on Linux — see "Why Windows is ahead" above.
- The Linux udev rule's `uaccess` grant actually taking effect across the
  common desktop environments (GNOME, KDE, XFCE) and login managers.
- Chromium's sandbox under Ubuntu 24.04+'s user-namespace restriction: the
  profiles load and attach (see above), but the restriction itself only
  exists in Ubuntu's kernel.
- macOS Gatekeeper's exact behaviour with an ad-hoc-signed (not
  Developer-ID-signed) app across recent macOS versions.
- The Linux tray in a full login session rather than a nested one — e.g. a
  tray host that only appears after Shark Deck has started at login: the
  check is made once, at startup.
- The profile-switch card on XWayland, and the notification that replaces it
  on native Wayland.
- Screen Colour lighting in a Wayland session: under XWayland, screen capture
  may only see X11 windows.
- `PlatformInfo.canOpenMouseSettings` on Linux is optimistic (`true`) rather
  than probed — `openMouseSettings()` tries a short list of known DE
  commands (`gnome-control-center`, `systemsettings[5|6]`,
  `xfce4-mouse-settings`) and shows a toast if none of them exists, rather
  than the button disappearing ahead of time.
- The macOS and Linux release builds in `.github/workflows/build.yml` have not
  yet run against a real tag.

### First-run checklist on a Mac or a Linux machine

1. Install the build (`.dmg`, or `.deb` / `.rpm`, or the AppImage plus
   `install-udev-rules.sh`) and launch it from the menu or Launchpad.
2. Plug the keyboard and the mouse in: each card should come online, not show
   the permission hint. Run `node scripts/smoke-hid.mjs` from `app/` and keep
   the output.
3. Change one setting per device, then confirm the read-back in Settings →
   Developer → frame log shows no diff.
4. Close the window: it should go to the tray / menu bar (or quit, on a Linux
   desktop with no tray host). Reopen it from the tray, the Dock or the menu.
5. Turn on Start at login, log out and back in: the app should start hidden.
6. Auto-switch: add a running game, switch to it, and check that the
   profile-switch card appears over it (a notification on native Wayland).
7. Record a short macro that uses a modifier, and play it back on the device.
