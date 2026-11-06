#!/bin/sh
# One-time setup for the AppImage build — the .deb/.rpm packages do the same
# on install (see after-install.sh). Run once, from the extracted AppImage:
#
#   ./SharkDeck-*.AppImage --appimage-extract
#   sudo sh squashfs-root/resources/udev/install-udev-rules.sh
#
# 1. The udev rule that lets Shark Deck open Attack Shark / Compx HID devices
#    without sudo (assets/linux/60-sharkdeck.rules; hid/transport.ts's
#    ensureOpen()). It goes to /etc/udev/rules.d, the administrator's own
#    rules — and the one rules directory still writable where /usr is
#    read-only (SteamOS, Bazzite, Fedora Silverblue/Kinoite, openSUSE Aeon),
#    which is where AppImage users often are. /lib/udev/rules.d failed there.
# 2. Where the kernel restricts unprivileged user namespaces through AppArmor
#    (Ubuntu 24.04 and later), an AppArmor profile that allows them for the
#    AppImage. Without one the AppImage's launcher (AppRun) finds no user
#    namespace and starts the app with --no-sandbox: it runs, but without
#    Chromium's sandbox. The .deb installs electron-builder's equivalent
#    profile; an AppImage has no install step to do it.
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: sudo sh install-udev-rules.sh" >&2
  exit 1
fi

# --- 1. the udev rule -----------------------------------------------------------

RULE_DEST="/etc/udev/rules.d/60-sharkdeck.rules"
mkdir -p /etc/udev/rules.d
# extraResources ships the canonical rule file alongside this script inside
# the AppImage — prefer that copy over the embedded fallback below so the
# two can never drift apart silently.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/60-sharkdeck.rules" ]; then
  cp "$SCRIPT_DIR/60-sharkdeck.rules" "$RULE_DEST"
else
  cat > "$RULE_DEST" <<'EOF'
# SharkDeck — see app/assets/linux/60-sharkdeck.rules for the commented source.
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="39ab", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="373e", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1d57", TAG+="uaccess"
EOF
fi
chmod 0644 "$RULE_DEST"

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules
  # Only the HID nodes — a bare trigger replays a change event for every
  # device on the machine.
  udevadm trigger --subsystem-match=hidraw --action=change
fi
echo "Installed $RULE_DEST — unplug and reconnect your Attack Shark device."

# --- 2. the AppArmor profile (Ubuntu 24.04+) -------------------------------------
# Attached both to the AppImage file wherever it is kept and to the app inside
# its runtime mount (/tmp/.mount_<first 6 letters of the file name><random>),
# which is the process whose sandbox needs the user namespace. Checked with a
# dry run first, as electron-builder's own post-install does; anything this
# AppArmor can't take is skipped, never half-installed.

if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] \
  && [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
  PROFILE="/etc/apparmor.d/sharkdeck-appimage"
  TMP="$(mktemp)"
  cat > "$TMP" <<'EOF'
# Shark Deck AppImage — lets Chromium's sandbox create the user namespace
# Ubuntu 24.04+ otherwise denies. Installed by install-udev-rules.sh.
abi <abi/4.0>,
include <tunables/global>

profile sharkdeck-appimage /{**/SharkDeck*.AppImage,tmp/.mount_SharkD*/sharkdeck} flags=(unconfined) {
  userns,

  include if exists <local/sharkdeck-appimage>
}
EOF
  if apparmor_parser --skip-kernel-load --debug "$TMP" >/dev/null 2>&1; then
    install -m 0644 "$TMP" "$PROFILE"
    apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE" || true
    echo "Installed $PROFILE — the AppImage can now start its sandbox."
  else
    echo "This AppArmor cannot load the Shark Deck profile; the AppImage will still run, without Chromium's sandbox." >&2
  fi
  rm -f "$TMP"
fi
