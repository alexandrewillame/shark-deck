#!/bin/bash
# Post-remove for the .deb and .rpm — electron-builder.yml's
# `deb.afterRemove` / `rpm.afterRemove`.
#
# Like after-install.sh, a script given there REPLACES electron-builder's own
# templates/linux/after-remove.tpl, so that template's body is carried below
# verbatim (its dollar-brace names are electron-builder macros — see
# after-install.sh for why nothing else here may use that form), followed by
# the removal of the Shark Deck udev rule.

# Only on a real removal. rpm runs this as %postun on an UPGRADE too — after
# the new version's %post has already put everything back — with $1 = 1, and
# dpkg calls it with "upgrade", "failed-upgrade" and the like. Removing the
# /usr/bin link, the AppArmor profile and the udev rule then left the freshly
# upgraded app without them: after a `dnf upgrade` the device went offline
# with a permission error until the rule was reinstalled by hand.
case "$1" in
  0|remove|purge) ;;
  *) exit 0 ;;
esac

# --- electron-builder's after-remove.tpl -------------------------------------

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# --- Shark Deck: the udev rule -------------------------------------------------

RULE_DEST='/lib/udev/rules.d/60-sharkdeck.rules'
if [ -f "$RULE_DEST" ]; then
  rm -f "$RULE_DEST" 2>/dev/null || true
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules 2>/dev/null || true
  fi
fi

# --- Shark Deck: the install directory ------------------------------------------
# The .rpm owns its files but not their directories, so `rpm -e` left an empty
# tree in /opt. Only empty directories go — never a file. (dpkg has already
# removed the tree by now; this then finds nothing.)
if [ -d '/opt/${sanitizedProductName}' ]; then
  find '/opt/${sanitizedProductName}' -depth -type d -empty -delete 2>/dev/null || true
fi

exit 0
