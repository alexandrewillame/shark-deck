#!/bin/sh
# Shark Deck device report, for Linux and macOS.
#
#   sh sharkdeck-device-report.sh                    every device of a family Shark Deck knows
#   sh sharkdeck-device-report.sh --device 1D57:FA65 one device, by its USB ids (any family)
#
# Part of Shark Deck (GPL-3.0-or-later): https://github.com/alexandrewillame/shark-deck
#
# Writes a report of the device's USB ids, names and HID layout (its report
# descriptors) to the Desktop, for a "New device" issue. It reads what the
# system already knows - Linux: /sys; macOS: ioreg - and sends nothing to the
# device. No serial number, user or computer name goes in it.
#
# A recording of the official software (what Shark Deck's driver is written
# from) needs Windows: tools/SharkDeck-device-report.bat there.

set -u
TOOL_VERSION=2
ISSUE_URL='https://github.com/alexandrewillame/shark-deck/issues/new?template=new-device.yml'
# USB vendor ids of the families Shark Deck knows (main/devices/registry.ts knownVendorIds).
KNOWN_VIDS='3151 39AB 3554 373E 1D57'
# For the tests only (app/test/contract/device-report-sh.test.ts): another /sys, a
# canned ioreg, the system name, the model typed and where the report goes.
SYS="${SHARKDECK_SYS:-/sys}"
IOREG="${SHARKDECK_IOREG:-ioreg -r -c IOHIDDevice -l -w0}"
OS="${SHARKDECK_OS:-$(uname -s)}"

WANT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --device) shift; WANT=$(printf '%s' "${1:-}" | tr 'a-f' 'A-F') ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
upper4() { printf '%04X' "0x$1"; }
known() {
  for v in $KNOWN_VIDS; do [ "$v" = "$1" ] && return 0; done
  return 1
}
wanted() { # vid pid
  if [ -n "$WANT" ]; then [ "$1:$2" = "$WANT" ]; else known "$1"; fi
}
# A JSON string: quotes and backslashes escaped, control characters dropped.
jstr() {
  if [ -z "$1" ]; then printf 'null'; return; fi
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}
hexdump_file() { od -An -tx1 -v "$1" 2>/dev/null | tr -d ' \n'; }

# Collected as lines: vid|pid|release|product|maker|serial(0/1)|interface|transport|descriptor-hex
FOUND=$(mktemp "${TMPDIR:-/tmp}/sd-report.XXXXXX") || exit 1
trap 'rm -f "$FOUND"' EXIT

case "$OS" in
  Linux)
    PLATFORM=linux
    for d in "$SYS"/bus/hid/devices/*; do
      [ -r "$d/uevent" ] || continue
      id=$(sed -n 's/^HID_ID=//p' "$d/uevent")
      bus=${id%%:*}; rest=${id#*:}
      vid=$(upper4 "${rest%%:*}"); pid=$(upper4 "${rest#*:}")
      wanted "$vid" "$pid" || continue
      desc=$(hexdump_file "$d/report_descriptor")
      real=$(readlink -f "$d")
      iface_dir=$(dirname "$real"); usb=$(dirname "$iface_dir")
      iface=null; release=''; product=''; maker=''; serial=0; transport=other
      case "$bus" in
        0003)
          transport=usb
          case "$(basename "$iface_dir")" in *:*.*) iface=${iface_dir##*.} ;; esac
          [ -r "$usb/bcdDevice" ] && release=$(tr -d '\n' < "$usb/bcdDevice")
          [ -r "$usb/product" ] && product=$(tr -d '\n' < "$usb/product")
          [ -r "$usb/manufacturer" ] && maker=$(tr -d '\n' < "$usb/manufacturer")
          [ -e "$usb/serial" ] && serial=1
          ;;
        0005) transport=bluetooth; product=$(sed -n 's/^HID_NAME=//p' "$d/uevent") ;;
      esac
      printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$vid" "$pid" "$release" "$product" "$maker" "$serial" "$iface" "$transport" "$desc" >> "$FOUND"
    done
    ;;
  Darwin)
    PLATFORM=macos
    # Each HID device ioreg lists, its own properties only (not its children's).
    $IOREG | awk -v found="$FOUND" '
      function flush() {
        if (vid != "") printf "%04X|%04X|%04X|%s|%s|%s|null|%s|%s\n", vid, pid, rel, prod, maker, serial, tr, desc >> found
        vid = ""; pid = 0; rel = 0; prod = ""; maker = ""; serial = 0; tr = "other"; desc = ""
      }
      function value(line) { sub(/^[^=]*= /, "", line); gsub(/^"|"$/, "", line); return line }
      /^\+-o / { flush(); own = 1; next }
      /^[ |]*\+-o / { own = 0; next }
      !own { next }
      /"VendorID" = / { vid = value($0) + 0 }
      /"ProductID" = / { pid = value($0) + 0 }
      /"VersionNumber" = / { rel = value($0) + 0 }
      /"Product" = / { prod = value($0) }
      /"Manufacturer" = / { maker = value($0) }
      /"SerialNumber" = / { serial = 1 }
      /"Transport" = / { tr = tolower(value($0)) }
      /"ReportDescriptor" = / { d = value($0); gsub(/[<> ]/, "", d); desc = tolower(d) }
      END { flush() }'
    # Keep the families Shark Deck knows (or the one asked for).
    KEEP=$(mktemp "${TMPDIR:-/tmp}/sd-keep.XXXXXX") || exit 1
    while IFS='|' read -r vid pid rest; do
      wanted "$vid" "$pid" && printf '%s|%s|%s\n' "$vid" "$pid" "$rest" >> "$KEEP"
    done < "$FOUND"
    mv "$KEEP" "$FOUND"
    ;;
  *) say "This report is for Linux and macOS. On Windows, run SharkDeck-device-report.bat."; exit 1 ;;
esac

say ''
say '  Shark Deck device report'
say '  ========================'
say ''
if [ ! -s "$FOUND" ]; then
  say '  No device of a family Shark Deck knows is plugged in.'
  say "  (USB vendor ids $KNOWN_VIDS.) Plug it in by its cable, or plug in its"
  say '  receiver, and run this again. A device of another family: run it with'
  say '  --device VID:PID (lsusb, or System Information on macOS, shows them).'
  exit 1
fi

say '  Found:'
cut -d'|' -f1,2,4 "$FOUND" | sort -u | while IFS='|' read -r vid pid product; do
  say "    $vid:$pid ${product:+\"$product\"}"
done
say ''
printf '  Which model is it (as on the box or the store page, e.g. X8 PRO)? '
MODEL="${SHARKDECK_MODEL:-}"
if [ -z "$MODEL" ]; then read -r MODEL < /dev/tty 2>/dev/null || MODEL=''; else say "$MODEL"; fi
first=$(head -n 1 "$FOUND")
fvid=$(printf '%s' "$first" | cut -d'|' -f1); fpid=$(printf '%s' "$first" | cut -d'|' -f2)
OUT_DIR="${SHARKDECK_OUT:-$HOME/Desktop}"; [ -d "$OUT_DIR" ] || OUT_DIR="$HOME"
OUT="$OUT_DIR/SharkDeck-device-report-$fvid-$fpid.txt"

{
  say 'Shark Deck device report'
  say '========================'
  say "Created $(date -u +%Y-%m-%dT%H:%M:%SZ) on $PLATFORM, tool version $TOOL_VERSION."
  say "Model, as typed: ${MODEL:-(not given)}"
  cut -d'|' -f1-6 "$FOUND" | sort -u | while IFS='|' read -r vid pid release product maker serial; do
    say "Device $vid:$pid \"$product\" by \"$maker\" - release $release - reports a serial number: $([ "$serial" = 1 ] && echo yes || echo no)"
    grep "^$vid|$pid|" "$FOUND" | while IFS='|' read -r _ _ _ _ _ _ iface transport desc; do
      say "  - interface $iface ($transport): report descriptor of $(( ${#desc} / 2 )) bytes"
    done
  done
  say 'A recording of the official software needs Windows: SharkDeck-device-report.bat.'
  say '----- For the Shark Deck maintainer: keep everything below exactly as it is -----'
  printf '{"tool":"SharkDeck-device-report","version":%s,"platform":"%s","model":%s,"devices":[' \
    "$TOOL_VERSION" "$PLATFORM" "$(jstr "$MODEL")"
  sep=''
  for key in $(cut -d'|' -f1,2 "$FOUND" | sort -u); do
    vid=${key%%|*}; pid=${key#*|}
    line=$(grep "^$vid|$pid|" "$FOUND" | head -n 1)
    release=$(printf '%s' "$line" | cut -d'|' -f3)
    product=$(printf '%s' "$line" | cut -d'|' -f4)
    maker=$(printf '%s' "$line" | cut -d'|' -f5)
    printf '%s{"vid":"%s","pid":"%s","release":%s,"product":%s,"manufacturer":%s,"interfaces":[' \
      "$sep" "$vid" "$pid" "$(jstr "$release")" "$(jstr "$product")" "$(jstr "$maker")"
    isep=''
    grep "^$vid|$pid|" "$FOUND" | while IFS='|' read -r _ _ _ _ _ _ iface transport desc; do
      printf '%s{"interface":%s,"transport":"%s","reportDescriptor":"%s"}' "$isep" "$iface" "$transport" "$desc"
      isep=','
    done
    printf '],"identify":null}'
    sep=','
  done
  printf ']}\n'
} > "$OUT"

say ''
say "  Saved: $OUT"
say '  Attach it to a "New device" issue:'
say "  $ISSUE_URL"
if [ -n "${SHARKDECK_OUT:-}" ]; then :
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$ISSUE_URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then open "$ISSUE_URL"; fi
say ''
