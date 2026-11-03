#!/bin/bash
# Post-install for the .deb and .rpm — electron-builder.yml's
# `deb.afterInstall` / `rpm.afterInstall`.
#
# A script given there REPLACES electron-builder's own
# templates/linux/after-install.tpl instead of being added to it (its
# FpmTarget only falls back to the template when no script is set). That
# template is what lets the app start at all on Ubuntu 24.04 and later: it
# installs the AppArmor profile Chromium's sandbox needs there, sets
# chrome-sandbox's mode, links /usr/bin/<executable> and refreshes the
# desktop database. Without it the .deb installed fine and then aborted at
# launch with "The SUID sandbox helper binary was found, but is not
# configured correctly".
#
# So the first part below is that template, verbatim. Its dollar-brace names
# (executable, sanitizedProductName) are electron-builder macros, substituted
# in this file exactly as in the template. For the same reason nothing else
# here — the Shark Deck part, or a comment — may write a name in dollar-braces:
# electron-builder reads every one as a macro and fails the build on one it
# doesn't know. Plain $VAR is fine.

# --- electron-builder's after-install.tpl ------------------------------------

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
# (`[`, where the template has bash's `[[`: rpm runs this with /bin/sh whatever
# the first line says, and where that is dash `[[` fails and the sandbox
# helper was made setuid for nothing.)
if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# --- Shark Deck: the udev rule -------------------------------------------------
# Lets a non-root desktop user open Attack Shark / Compx HID devices (see
# assets/linux/60-sharkdeck.rules and hid/transport.ts's ensureOpen()). Never
# fails the install: without the rule the device just stays offline, and the
# app says why (hint.offlinePermission).

RULE_SRC='/opt/${sanitizedProductName}/resources/udev/60-sharkdeck.rules'
RULE_DEST='/lib/udev/rules.d/60-sharkdeck.rules'

if [ -f "$RULE_SRC" ]; then
  install -m 0644 "$RULE_SRC" "$RULE_DEST" 2>/dev/null || cp "$RULE_SRC" "$RULE_DEST" 2>/dev/null || true
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules 2>/dev/null || true
    # Only the HID nodes — a bare trigger replays a change event for every
    # device on the machine.
    udevadm trigger --subsystem-match=hidraw --action=change 2>/dev/null || true
  fi
else
  echo "sharkdeck: the bundled udev rule is missing ($RULE_SRC) — skipping; see docs/platform-support.md to install it by hand." >&2
fi

exit 0
