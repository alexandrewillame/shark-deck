#!/bin/sh
# Shark Deck device report and recording, for Linux and macOS.
#
#   sh sharkdeck-device-report.sh                     every device of a family Shark Deck knows
#   sh sharkdeck-device-report.sh --device 1D57:FA65  one device, by its USB ids (any family)
#   ... --record / --no-record                        Linux: record without asking / never offer it
#   ... --steps deep,macro,specific                   record only the steps whose ids start with
#                                                     these words ('specific': one thing you choose)
#   sh sharkdeck-device-report.sh --preview-steps mouse   walk the recording steps; nothing is recorded
#
# Part of Shark Deck (GPL-3.0-or-later): https://github.com/alexandrewillame/shark-deck
#
# The report: the device's USB ids, names and HID layout (its report
# descriptors), read from what the system already knows - Linux: /sys; macOS:
# ioreg. Nothing is sent to the device. No serial number, user or computer
# name goes in it.
#
# The recording (Linux): the official software, which runs on Windows only,
# runs in a Windows virtual machine the device is passed through to, or with
# Wine, while the kernel's USB monitor (usbmon, read as root) records what goes
# over the cable - one setting at a time, the steps of SharkDeck-device-report.bat.
# Only the device's own traffic is kept, what is typed on it is blanked as it
# is recorded, and nothing is sent anywhere. Nothing is ever sent to a device.

set -u
TOOL_VERSION=2
ISSUE_URL='https://github.com/alexandrewillame/shark-deck/issues/new?template=new-device.yml'
REPORT_MARKER='----- For the Shark Deck maintainer: keep everything below exactly as it is -----'
# USB vendor ids of the families Shark Deck knows (main/devices/registry.ts knownVendorIds).
KNOWN_VIDS='3151 39AB 3554 373E 1D57'
# For the tests only (app/test/contract/device-report-sh.test.ts): another /sys, a
# canned ioreg, the system name, the model typed and where the report goes; a
# file read in place of /dev/usbmon0 (no root needed), and the owner's answers.
SYS="${SHARKDECK_SYS:-/sys}"
IOREG="${SHARKDECK_IOREG:-ioreg -r -c IOHIDDevice -l -w0}"
OS="${SHARKDECK_OS:-$(uname -s)}"
USBMON_FILE="${SHARKDECK_USBMON:-}"
ANSWERS="${SHARKDECK_TTY:-/dev/tty}"

WANT=''
RECORD=''
STEPS=''
PREVIEW=''
while [ $# -gt 0 ]; do
  case "$1" in
    --device) shift; WANT=$(printf '%s' "${1:-}" | tr 'a-f' 'A-F') ;;
    --record) RECORD=yes ;;
    --no-record) RECORD=no ;;
    --steps)
      shift; STEPS="${1:-}"
      case "$STEPS" in
        '' | *[!a-z,]* | ,* | *, | *,,*) printf '%s\n' '--steps takes words, like deep,macro,specific' >&2; exit 2 ;;
      esac
      ;;
    --preview-steps)
      case "${2:-}" in mouse | keyboard) PREVIEW=$2; shift ;; *) PREVIEW=mouse ;; esac
      ;;
    -h | --help) sed -n '2,9p' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/sd-report.XXXXXX") || exit 1
FLAG="$WORK/recording"
CAP_PID=''
cleanup() {
  rm -f "$FLAG"
  if [ -n "$CAP_PID" ]; then wait "$CAP_PID" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'exit 129' HUP
FOUND="$WORK/found"
: > "$FOUND"

# The owner's answers: the terminal, or nothing at all (then every question
# gets "no answer", and nothing is recorded).
if (: < "$ANSWERS") 2>/dev/null; then exec 3< "$ANSWERS"; else exec 3< /dev/null; fi
ask() { # prompt -> REPLY; false when there is no one to answer
  printf '%s' "$1"
  REPLY=''
  IFS= read -r REPLY <&3
}

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); CYAN=$(printf '\033[36m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m'); OFF=$(printf '\033[0m')
else
  BOLD=''; DIM=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; OFF=''
fi

say() { printf '%s\n' "$*"; }
# A paragraph, wrapped and indented.
para() { printf '%s\n' "$1" | fold -s -w 76 | sed 's/^/  /'; }
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
jstr0() { if [ -z "$1" ]; then printf '""'; else jstr "$1"; fi; }
hexdump_file() { od -An -v -tx1 "$1" 2>/dev/null | tr -d ' \n'; }
bytes_of() { od -An -v -tu1 "$1" 2>/dev/null | tr -s ' \n' '  '; }
if date -u +%3N 2>/dev/null | grep -q '^[0-9][0-9][0-9]$'; then
  now_iso() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
else
  now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
fi

# ---- The recording's steps ------------------------------------------------------
# The Windows tool's own tables, row for row (SharkDeck-device-report.bat:
# $StepTable, $WhereTable, $CustomStepTable; device-report-sh.test.ts pins them
# equal). A step: id | mouse, keyboard or both | group | the value to set | the
# series it belongs to | flags | what to do. Flags: window, auto15 (moves on by
# itself after 15 s), repeat (one recording per choice in a list), attach,
# detect (a newly plugged receiver joins the recording), undo (puts back what
# the group's earlier steps changed), nochange.
step_table() {
  cat <<'STEPS'
start.open|both|Start|||window|Open the official software for your device and wait until it shows the device. Change nothing yet. Click once on its window, then click Done here.
start.idle|both|Start|||auto15|Leave everything alone for 15 seconds: no clicks, no changes. This shows what the software does on its own.
start.info|both|Start||||If the software shows the device's firmware version or other information somewhere, open that page. Never start a firmware update.
start.tour|both|Start||||Open every page or tab of the software once, without changing anything. Then go back to the main page.
dpi.s1.400|mouse|DPI|400|dpi.s1||Set DPI stage 1 to 400.
dpi.s1.800|mouse|DPI|800|dpi.s1||Set DPI stage 1 to 800.
dpi.s1.1600|mouse|DPI|1600|dpi.s1||Set DPI stage 1 to 1600.
dpi.s1.3200|mouse|DPI|3200|dpi.s1||Set DPI stage 1 to 3200.
dpi.s1.100|mouse|DPI|100|dpi.s1|ask|Set DPI stage 1 to 100, or to the lowest value it allows. Type the value it shows now.
dpi.s1.1000|mouse|DPI|1000|dpi.s1||Set DPI stage 1 to 1000.
dpi.s1.6400|mouse|DPI|6400|dpi.s1||Set DPI stage 1 to 6400.
dpi.s1.12000|mouse|DPI|12000|dpi.s1||Set DPI stage 1 to 12000.
dpi.s1.max|mouse|DPI|max|dpi.s1|ask|Set DPI stage 1 to the highest value it allows. Type the value it shows now.
dpi.s1.back|mouse|DPI||dpi.s1|undo ask|Set DPI stage 1 back to what you use (800 if unsure). Type the value it shows now.
dpi.s2.1200|mouse|DPI|1200|dpi.s2||Set DPI stage 2 to 1200 (only stage 2).
dpi.s2.2400|mouse|DPI|2400|dpi.s2||Set DPI stage 2 to 2400.
dpi.s2.back|mouse|DPI|||undo|Set DPI stage 2 back to what you use.
dpi.count.2|mouse|DPI|2|dpi.count||If you can choose how many DPI stages there are: set it to 2.
dpi.count.4|mouse|DPI|4|dpi.count||Set the number of DPI stages to 4.
dpi.count.back|mouse|DPI|||undo|Set the number of DPI stages back to what you use.
dpi.active.2|mouse|DPI|2|dpi.active||In the software, make stage 2 the active (current) DPI stage.
dpi.active.1|mouse|DPI|1|dpi.active|undo|Make stage 1 the active stage again.
dpi.button|mouse|DPI|||nochange|Press the DPI button on the mouse once, then press it again until stage 1 is back.
dpi.red|mouse|DPI|#FF0000|dpi.color||If DPI stages have colours: set stage 1's colour to pure red (#FF0000: red 255, green 0, blue 0).
dpi.green|mouse|DPI|#00FF00|dpi.color||Set stage 1's colour to pure green (#00FF00).
dpi.blue|mouse|DPI|#0000FF|dpi.color||Set stage 1's colour to pure blue (#0000FF).
dpi.color.back|mouse|DPI|||undo|Set stage 1's colour back to what you use.
dpi.xy|mouse|DPI|800x1600|||If X and Y can be set apart: set stage 1 to X 800 and Y 1600.
dpi.xy.off|mouse|DPI|||undo|Turn separate X and Y off again.
poll.125|both|Polling rate|125|poll||Set the polling rate (report rate) to 125 Hz.
poll.250|both|Polling rate|250|poll||Set the polling rate to 250 Hz.
poll.500|both|Polling rate|500|poll||Set the polling rate to 500 Hz.
poll.1000|both|Polling rate|1000|poll||Set the polling rate to 1000 Hz.
poll.2000|both|Polling rate|2000|poll||Set the polling rate to 2000 Hz, if offered.
poll.4000|both|Polling rate|4000|poll||Set the polling rate to 4000 Hz, if offered.
poll.8000|both|Polling rate|8000|poll||Set the polling rate to 8000 Hz, if offered.
poll.back|both|Polling rate||poll|undo ask|Set the polling rate back to what you use (1000 Hz if unsure). Type the value it shows now.
lod.low|mouse|Sensor|low|lod|ask|Set the lift-off distance (LOD) to its lowest setting (often 1 mm). Type the value it shows now.
lod.high|mouse|Sensor|high|lod|ask|Set the lift-off distance to its highest setting (often 2 mm). Type the value it shows now.
lod.back|mouse|Sensor|||undo|Set the lift-off distance back to what you use.
angle.on|mouse|Sensor|on|angle||Turn angle snapping (straight-line correction) on.
angle.off|mouse|Sensor|off|angle|undo|Turn angle snapping off (back on afterwards, if you use it).
ripple.on|mouse|Sensor|on|ripple||Turn ripple control on.
ripple.off|mouse|Sensor|off|ripple|undo|Turn ripple control off (back on afterwards, if you use it).
motion.on|mouse|Sensor|on|motion||Turn motion sync on.
motion.off|mouse|Sensor|off|motion|undo|Turn motion sync off (back on afterwards, if you use it).
mode.each|mouse|Sensor||sensor.mode|repeat|If the mouse has sensor or performance modes (Office, Gaming, Competitive...): choose the first one, type its name in the note, click Next one. Then the next mode, and so on.
mode.back|mouse|Sensor|||undo|Choose the mode you use again.
debounce.min|both|Response|min|debounce|ask|Set the debounce time (button or key response, often in ms) to its lowest value. Type the value it shows now.
debounce.max|both|Response|max|debounce|ask|Set the debounce time to its highest value. Type the value it shows now.
debounce.8|both|Response|8|debounce|ask|Set the debounce time to 8 ms, or the closest value. Type the value it shows now.
debounce.4|both|Response|4|debounce|ask|Set the debounce time to 4 ms, or the closest value. Type the value it shows now.
debounce.back|both|Response|||undo|Set the debounce time back to what you use.
sleep.min|both|Power|min|sleep|ask|Set the sleep (power saving) time to its shortest. Type the value it shows now.
sleep.max|both|Power|max|sleep|ask|Set the sleep time to its longest. Type the value it shows now.
sleep.10|both|Power|10|sleep|ask|Set the sleep time to 10 minutes, or the closest. Type the value it shows now.
sleep.back|both|Power|||undo|Set the sleep time back to what you use.
deep.min|both|Power|min|deep|ask|If there is a second, deeper sleep time: set it to its shortest. Type the value it shows now.
deep.max|both|Power|max|deep|ask|Set the deep sleep time to its longest. Type the value it shows now.
deep.back|both|Power|||undo|Set the deep sleep time back to what you use.
btn.b4.middle|mouse|Buttons|Middle click|btn.b4||Set button 4, the side button nearer the FRONT of the mouse ("Forward"), to Middle click.
btn.b4.right|mouse|Buttons|Right click|btn.b4||Set button 4 (front side button) to Right click.
btn.b4.key-a|mouse|Buttons|key A|btn.b4||Set button 4 (front side button) to the keyboard key A.
btn.b4.ctrl-c|mouse|Buttons|Ctrl+C|btn.b4||Set button 4 (front side button) to the shortcut Ctrl + C.
btn.b4.vol-up|mouse|Buttons|Volume up|btn.b4||Set button 4 (front side button) to Volume up.
btn.b4.vol-down|mouse|Buttons|Volume down|btn.b4||Set button 4 (front side button) to Volume down.
btn.b4.play|mouse|Buttons|Play/Pause|btn.b4||Set button 4 (front side button) to Play / Pause.
btn.b4.next|mouse|Buttons|Next track|btn.b4||Set button 4 (front side button) to Next track.
btn.b4.dpi-up|mouse|Buttons|DPI up|btn.b4||Set button 4 (front side button) to DPI up (or DPI cycle).
btn.b4.dpi-down|mouse|Buttons|DPI down|btn.b4||Set button 4 (front side button) to DPI down, if offered.
btn.b4.scroll-up|mouse|Buttons|Scroll up|btn.b4||Set button 4 (front side button) to Scroll up, if offered.
btn.b4.fire|mouse|Buttons|Fire|btn.b4|ask|Set button 4 (front side button) to fire key (rapid fire), if offered. Type its settings as the software shows them (clicks, speed).
btn.b4.off|mouse|Buttons|Disabled|btn.b4||Set button 4 (front side button) to Disabled (off).
btn.b4.default|mouse|Buttons|Forward|btn.b4|undo|Set button 4 (front side button) back to its default (Forward).
btn.b5.key-b|mouse|Buttons|key B|||Set button 5, the side button nearer the REAR of the mouse ("Back"), to the keyboard key B.
btn.b5.default|mouse|Buttons|Back||undo|Set button 5 (rear side button) to its default again (Back).
btn.mid.key-c|mouse|Buttons|key C|||Set the middle button (wheel click) to the keyboard key C.
btn.mid.default|mouse|Buttons|Middle click||undo|Set the middle button back to Middle click.
btn.reset|mouse|Buttons||||Optional, only if you do not mind losing your own button settings: restore all buttons to their defaults at once.
media.prev|mouse|Media keys|Previous Track|media.b4||Set button 4 (front side button) to the media key Previous track.
media.stop|mouse|Media keys|Stop Playback|media.b4||Set button 4 (front side button) to Stop (stops the music or video), if offered.
media.mute|mouse|Media keys|Mute|media.b4||Set button 4 (front side button) to Mute.
media.player|mouse|Media keys|Media player|media.b4||Set button 4 (front side button) to open the media player, if offered.
media.email|mouse|Media keys|Email|media.b4||Set button 4 (front side button) to open e-mail (Mail), if offered.
media.calc|mouse|Media keys|Calculator|media.b4||Set button 4 (front side button) to open the calculator, if offered.
media.computer|mouse|Media keys|My Computer|media.b4||Set button 4 (front side button) to open My Computer (This PC), if offered.
media.home|mouse|Media keys|Homepage|media.b4||Set button 4 (front side button) to the browser's Home page, if offered.
media.search|mouse|Media keys|Search|media.b4||Set button 4 (front side button) to Search, if offered.
media.back|mouse|Media keys|Previous page|media.b4||Set button 4 (front side button) to the browser's Back (previous page), if offered.
media.forward|mouse|Media keys|Next page|media.b4||Set button 4 (front side button) to the browser's Forward (next page), if offered.
media.halt|mouse|Media keys|Stop page|media.b4||Set button 4 (front side button) to the browser's Stop (stops loading the page), if offered.
media.refresh|mouse|Media keys|Refresh page|media.b4||Set button 4 (front side button) to the browser's Refresh, if offered.
media.favorites|mouse|Media keys|Favorites|media.b4||Set button 4 (front side button) to Favorites (bookmarks), if offered.
media.default|mouse|Media keys|Forward|media.b4|undo|Set button 4 (front side button) back to its default (Forward).
key.a-b|keyboard|Keys|A types B|||Remap the key A so that it types B (main layer).
key.a-b.undo|keyboard|Keys|A types A||undo|Put A back: make it type A again.
key.caps-ctrl|keyboard|Keys|Caps Lock is Left Ctrl|||Remap Caps Lock to Left Ctrl.
key.caps-ctrl.undo|keyboard|Keys|Caps Lock is Caps Lock||undo|Put Caps Lock back to Caps Lock.
key.f1-volup|keyboard|Keys|F1 is Volume up|||Remap F1 to Volume up.
key.f1-volup.undo|keyboard|Keys|F1 is F1||undo|Put F1 back to F1.
key.esc-mute|keyboard|Keys|Esc is Mute|||Remap Esc to Mute.
key.esc-mute.undo|keyboard|Keys|Esc is Esc||undo|Put Esc back to Esc.
key.fn|keyboard|Keys|Fn + key is Play/Pause|||If there is an Fn layer: give Play / Pause to Fn + a key the software lets you change (some, like Fn + A, are fixed): Fn + P, say. Type the key in the note.
key.fn.undo|keyboard|Keys|||undo|Put that Fn + key back as it was.
key.reset|keyboard|Keys||||Optional, only if you do not mind losing your own key settings: restore all keys to their defaults at once.
winlock.on|keyboard|Keys|on|winlock||Turn the Windows-key lock (game mode) on.
winlock.off|keyboard|Keys|off|winlock|undo|Turn the Windows-key lock off.
rollover.6|keyboard|Keys|6KRO|rollover||If offered: switch to 6-key rollover (6KRO).
rollover.n|keyboard|Keys|NKRO|rollover|undo|Switch back to N-key rollover (NKRO).
macro.make|both|Macros||||Create a macro named T1 that presses and releases A, then presses and releases B (record "ab", or add the four events by hand). Save it.
macro.delay|both|Macros|100|||If delays can be edited: change the delay between A and B to 100 ms, and save.
macro.assign.mouse|mouse|Macros||||Assign the macro T1 to button 4.
macro.assign.keyboard|keyboard|Macros||||Assign the macro T1 to the key F12.
macro.repeat|both|Macros|3|||If offered: make the macro repeat 3 times.
macro.clear|both|Macros|||undo|Set that button or key back to its default, then delete the macro.
light.each|both|Lighting||light.effect|repeat|Choose the first lighting effect in the list and wait 2 seconds. Type its name in the note, click Next one. Then the next effect, and so on.
light.red|both|Lighting|#FF0000|light.color||Choose a single-colour (static) effect, and set its colour to pure red (#FF0000).
light.green|both|Lighting|#00FF00|light.color||Set the colour to pure green (#00FF00).
light.blue|both|Lighting|#0000FF|light.color||Set the colour to pure blue (#0000FF).
light.white|both|Lighting|#FFFFFF|light.color||Set the colour to white (#FFFFFF).
light.dim|both|Lighting|min|light.bright||Set the brightness to its lowest (not off).
light.bright|both|Lighting|max|light.bright||Set the brightness to its highest.
light.half|both|Lighting|50%|light.bright||Set the brightness to the middle.
light.slow|both|Lighting|min|light.speed||Choose a moving effect, then set its speed to the slowest.
light.fast|both|Lighting|max|light.speed||Set the speed to the fastest.
light.dir|both|Lighting||||If the effect has a direction: change it once.
light.off|both|Lighting|off|light.power||Turn the lighting off.
light.on|both|Lighting|on|light.power||Turn the lighting on again.
light.back|both|Lighting|||undo|Put your own lighting back (effect, colour, brightness), as near as you remember it.
perkey.esc|keyboard|Per-key lighting|#FF0000|||If single keys can have their own colour: make Esc red and leave the rest.
perkey.space|keyboard|Per-key lighting|#0000FF|||Make the space bar blue as well.
perkey.clear|keyboard|Per-key lighting|||undo|Clear these custom colours.
side.each|both|Second light||side.effect|repeat|If there is a second light (side strip, logo, receiver): choose its first effect, type its name in the note, click Next one. Then its next effect, and so on.
side.red|both|Second light|#FF0000|side.color||Set the second light to pure red (#FF0000).
side.blue|both|Second light|#0000FF|side.color||Set the second light to pure blue (#0000FF).
side.back|both|Second light|||undo|Put the second light back as you had it.
act.2.0|keyboard|Actuation|2.0|act.all||If keys have an adjustable actuation point: set all keys to 2.0 mm.
act.3.5|keyboard|Actuation|3.5|act.all||Set all keys to 3.5 mm.
act.0.5|keyboard|Actuation|0.5|act.all||Set all keys to 0.5 mm. That is very light: until the next step, a key just touched may type.
act.back|keyboard|Actuation||act.all|undo ask|Set all keys back to what you use (2.0 mm if unsure). Type the value it shows now.
act.esc|keyboard|Actuation|1.0|||Set only Esc to 1.0 mm.
act.esc.undo|keyboard|Actuation|||undo|Set Esc back to the same as the other keys.
rt.on|keyboard|Actuation|on|rt||Turn rapid trigger on for all keys.
rt.0.1|keyboard|Actuation|0.1|rt.sens||Set the rapid trigger sensitivity to 0.1 mm.
rt.0.5|keyboard|Actuation|0.5|rt.sens||Set the rapid trigger sensitivity to 0.5 mm.
rt.off|keyboard|Actuation|off|rt|undo|Turn rapid trigger off (back on afterwards, if you use it).
dz.top|keyboard|Actuation|0.2|||If offered: set the top dead zone to 0.2 mm.
dz.top.undo|keyboard|Actuation|||undo|Set the top dead zone back as it was.
dz.bottom|keyboard|Actuation|0.2|||If offered: set the bottom dead zone to 0.2 mm.
dz.bottom.undo|keyboard|Actuation|||undo|Set the bottom dead zone back as it was.
travel|keyboard|Actuation|||nochange|If the software shows key travel live: open that view, press A slowly to the bottom, and release it.
dks.a|keyboard|Key modes||||Give the key A a dynamic keystroke (DKS) with any actions, and save.
dks.a.undo|keyboard|Key modes|||undo|Take the dynamic keystroke off A again.
mt.a|keyboard|Key modes||||Give the key A a mod-tap (tap: A, hold: Left Ctrl), and save.
mt.a.undo|keyboard|Key modes|||undo|Take the mod-tap off A again.
tgl.a|keyboard|Key modes||||Give the key A a toggle mode, and save.
tgl.a.undo|keyboard|Key modes|||undo|Take the toggle off A again.
snap.ad|keyboard|Key modes||||Turn on Snap Tap (SOCD) for A and D.
snap.ad.undo|keyboard|Key modes|||undo|Turn Snap Tap off for A and D again.
calibrate|keyboard|Key modes|||nochange|Optional: run the key calibration, following its instructions.
profile.2|both|Profiles|2|profile||Switch to onboard profile 2.
profile.1|both|Profiles|1|profile|undo|Switch back to profile 1 (or the one you use).
profile.export|both|Profiles|||attach|If the software can export your settings to a file: export one into the folder that just opened.
conn.other|both|Other connection|||detect|Now connect it the other way it can be connected. On its USB receiver now? Plug in its cable (and set its switch to wired, if it has one). On its cable now? Plug in its receiver and switch it to 2.4 GHz. Wait until the software shows it. Only one way? Click Not in my software.
conn.idle|both|Other connection|||auto15|Leave everything alone for 15 seconds.
conn.dpi.1600|mouse|Other connection|1600|conn.dpi||Set DPI stage 1 to 1600.
conn.dpi.back|mouse|Other connection||conn.dpi|undo ask|Set DPI stage 1 back to what you use. Type the value it shows now.
conn.poll.500|both|Other connection|500|conn.poll||Set the polling rate to 500 Hz.
conn.poll.back|both|Other connection||conn.poll|undo ask|Set the polling rate back to what you use. Type the value it shows now.
conn.green|both|Other connection|#00FF00|||Set the lighting to static pure green (#00FF00).
conn.light.back|both|Other connection|||undo|Put your own lighting back.
conn.pair|both|Other connection|||nochange|If the software has a pairing button for the receiver: click it and follow its instructions until the device works again.
other.each|both|Anything else||other|repeat|Any setting not asked about yet: change it once, type its name and the new value in the note, click Next one. When none are left, click Finished this list.
end.reset|both|Finish||||Restore the factory settings in the software (Reset, Reset Profile or Restore defaults): it tells Shark Deck the factory values. Your own settings come back from the file you exported, or set them again afterwards. Rather not? Click Not in my software.
end.close|both|Finish||||Close the official software.
STEPS
}

where_table() {
  cat <<'WHERE'
Polling rate|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings (Keyboard Polling Rate). Elsewhere: Settings or Performance, as "polling rate" or "report rate".
Polling rate|mouse|Usually the main page, or Settings / Performance, as "polling rate" or "report rate".
Response|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings, if it has it. Elsewhere: Settings or Performance, as "debounce" or "response time".
Response|mouse|Usually Settings or Performance, as "debounce" or "response time".
Power|keyboard|Attack Shark Driver v4: Keyboard Settings > Other Settings, if it has it (a wired keyboard may have no sleep time). Elsewhere: Settings, as "sleep time" or "power saving".
Power|mouse|Usually Settings, as "sleep time" or "power saving".
DPI|mouse|Usually the main page: the DPI stages and their values.
Sensor|mouse|Usually Settings, Performance or Sensor: lift-off distance (LOD), angle snapping, ripple control, motion sync.
Buttons|mouse|Usually the main page or a Buttons / Key settings tab: click the button on the picture of the mouse, then choose what it does.
Media keys|mouse|Where buttons are set: click button 4 (the front side button) on the picture of the mouse, then look under Multimedia (or Media).
Keys|keyboard|Attack Shark Driver v4: Keyboard Settings > Custom Keys: click the key on the picture, then choose (media keys: Functions); Reset Key puts one back. Fn + key: Fn Layer Settings. Elsewhere: Keys, Keymap or Remap.
Macros|keyboard|Attack Shark Driver v4: Macro Editing makes it; Keyboard Settings > Custom Keys > Macro Settings gives it to a key. Elsewhere: a Macro tab.
Macros|mouse|Usually a Macro tab; a macro is then given to a button where buttons are set.
Lighting|keyboard|Attack Shark Driver v4: Light Settings. Elsewhere: Lighting, Light or RGB.
Lighting|mouse|Usually Lighting, Light or RGB.
Per-key lighting|keyboard|Attack Shark Driver v4: Light Settings, its custom (user) effect. Elsewhere: Lighting > Custom or Per-key.
Second light|both|Usually in Lighting: a side light, a logo light, or the receiver's light.
Actuation|keyboard|Attack Shark Driver v4: Keyboard Settings > Magnetic Switch Settings. Elsewhere: Performance, Magnetic switch or Trigger.
Key modes|keyboard|Attack Shark Driver v4: Keyboard Settings > Advanced Key Settings (DKS, MT, Toggle, SnapKey); calibration: the Travel Calibration button. Elsewhere: Advanced keys or Performance.
Profiles|keyboard|Attack Shark Driver v4: the Profile 1 list on the Keyboard Settings page (the Profile menu on the left is your account). Elsewhere: Profile 1, 2, 3... at the top or the side.
Profiles|mouse|Usually at the top or the side: Profile 1, 2, 3... or Config 1, 2, 3...
Other connection|both|Usually where the software shows the connection: cable, 2.4 GHz receiver, Bluetooth. A switch under the device often chooses it.
Finish|keyboard|Attack Shark Driver v4: Restore Factory Settings, bottom right of the Keyboard Settings page.
WHERE
}

custom_table() {
  cat <<'CUSTOM'
start.open|both|Start|||window|Open the official software for your device and wait until it shows the device. Click once on its window, then click Done here.
custom.each|both|Your recording|||repeat,describe|Do one thing in the official software: the setting Shark Deck should learn, or the one that does not work in it. Write in the note what you did (and what you expected), click Next one, then do the next thing. When you are done, click Finished this list.
end.close|both|Finish||||Close the official software.
CUSTOM
}

# The steps for a mouse or a keyboard: all of them, or those asked for by name
# (--steps deep,macro,specific) as the Windows tool picks them: opening the
# software, every step whose id starts with one of the words, the "something
# specific" step for 'specific', then closing the software.
steps_for() { # kind words
  { step_table; printf '%s\n' '--custom--'; custom_table; } | awk -F'|' -v kind="$1" -v words="$2" '
    BEGIN { n = split(words, w, ","); for (i = 1; i <= n; i++) W[w[i]] = 1 }
    /^--custom--$/ { custom = 1; next }
    $2 != "both" && $2 != kind { next }
    custom { if ($1 == "custom.each") C = $0; next }
    $1 == "end.close" { last = $0; next }
    { first = $1; sub(/\..*/, "", first); if (n == 0 || $1 == "start.open" || (first in W)) print }
    END { if (("specific" in W) && C != "") print C; if (last != "") print last }'
}

where_for() { # kind group
  where_table | awk -F'|' -v k="$1" -v g="$2" '$1 == g && ($2 == "both" || $2 == k) { w = $3 } END { printf "%s", w }'
}

# The table's words are the Windows window's; here they are typed.
for_terminal() {
  printf '%s' "$1" | sed \
    -e 's/ Click once on its window, then click Done here\./ Then press Enter here./' \
    -e 's/click Done here/press Enter here/g' \
    -e 's/Click Not in my software/Type n (not in my software)/g' \
    -e 's/click Next one/press Enter/g' \
    -e 's/click Finished this list/type f (finished this list)/g' \
    -e 's/into the folder that just opened/into the folder named below/g'
}

load_step() { # file line
  IFS='|' read -r S_ID S_KIND S_GROUP S_VALUE S_SERIES S_FLAGS S_TEXT <<EOF
$(sed -n "${2}p" "$1")
EOF
}
has_flag() {
  case " $(printf '%s' "$S_FLAGS" | tr ',' ' ') " in *" $1 "*) return 0 ;; esac
  return 1
}
# Whether a step changes something that may need putting back (the Windows tool's Changes()).
step_changes() {
  case "$S_GROUP" in Start | Finish | 'Anything else') return 1 ;; esac
  for f in auto15 nochange window attach detect; do has_flag "$f" && return 1; done
  return 0
}

# What the filter has counted so far: messages to the device, from it, kept.
counts() {
  c=''
  [ -r "$WORK/status" ] && c=$(cat "$WORK/status" 2>/dev/null)
  [ -n "$c" ] || { sleep 1; [ -r "$WORK/status" ] && c=$(cat "$WORK/status" 2>/dev/null); }
  printf '%s\n' "${c:-0 0 0}"
}
sent_count() { counts | cut -d' ' -f1; }
kept_count() { counts | cut -d' ' -f3; }

record_step() { # status [note]
  r_note=${2:-}
  printf '{"id":%s,"group":%s,"text":%s,"value":%s,"series":%s,"status":"%s","attempt":%d,"note":%s,"start":"%s","end":"%s","shots":[]}\n' \
    "$(jstr0 "$S_ID")" "$(jstr0 "$S_GROUP")" "$(jstr0 "$S_TEXT")" "$(jstr0 "$S_VALUE")" "$(jstr0 "$S_SERIES")" \
    "$1" "$ATTEMPT" "$(jstr0 "$r_note")" "$STEP_START" "$(now_iso)" >> "$WORK/results"
  r_changes=0
  step_changes && r_changes=1
  printf '%s|%s|%s|%s|%s|%s|%s\n' "$S_ID" "$1" "$S_GROUP" "$S_VALUE" "$S_FLAGS" "$r_changes" "$r_note" | tr -d '\r' >> "$WORK/log"
}

# What the steps done changed and no later step of their group put back.
still_changed() {
  [ -r "$WORK/log" ] || return 0
  awk -F'|' '$2 == "done" && $6 == 1 {
      f = " " $5 " "; gsub(/,/, " ", f)
      if (f ~ / undo /) { delete P[$3]; next }
      if (!($3 in G)) { G[$3] = 1; O[++n] = $3 }
      P[$3] = ($4 != "" ? $4 : "changed")
    }
    END { for (i = 1; i <= n; i++) if (O[i] in P) printf "%s: %s\n", O[i], P[O[i]] }' "$WORK/log"
}

countdown() {
  n=$1
  while [ "$n" -gt 0 ]; do printf '\r  %2d s ' "$n"; sleep 1; n=$((n - 1)); done
  printf '\r        \r'
}

show_step() {
  say ''
  say "  ${CYAN}${BOLD}$(printf '%s' "$S_GROUP" | tr 'a-z' 'A-Z')${OFF}${DIM}  -  step $W_I of $W_TOTAL${OFF}"
  t=$(for_terminal "$S_TEXT")
  has_flag ask && t=$(printf '%s' "$t" | sed 's/ Type the value it shows now\.$//')
  para "${BOLD}${t}${OFF}"
  w=$(where_for "$W_KIND" "$S_GROUP")
  [ -n "$w" ] && para "${DIM}Where to find it: $w${OFF}"
  if [ "$REPEAT" = 1 ]; then
    para "After each choice, type its name (and the value you set, if any), then Enter. After the last one, or if there is none: f."
  elif [ "$PUTBACK" = 1 ]; then
    para "Doing this step again. If the first try worked, just press Enter. If not, first put it back the way it was before this step and type r (I put it back); then do the step again and press Enter."
  elif [ "$TRIES" -gt 0 ]; then
    para "Doing this step again (try $((TRIES + 1))). The first try is kept: if it worked, just press Enter."
  elif has_flag ask; then
    para "Do only this in the official software, then type the value it shows and press Enter. Not there? n."
  elif has_flag auto15 && [ "$W_MODE" = record ]; then
    :
  else
    para "Do only this in the official software, wait a second, then press Enter. Not there? n."
  fi
  if has_flag attach && [ "$W_MODE" = record ]; then
    mkdir -p "$REC/attach"
    para "The folder: $REC/attach (from a virtual machine, copy the file out through a shared folder, or type n)."
  fi
  say "  ${DIM}n: not in my software   s: skip this group   b: redo the previous step   q: finish and save${OFF}"
}

prompt_for() {
  if has_flag describe; then printf '  What you did, and what you expected (f: finished) > '
  elif [ "$REPEAT" = 1 ]; then printf '  Its name, and the value you set if any (f: finished) > '
  elif has_flag ask; then printf '  The value it shows now > '
  elif [ "$PUTBACK" = 1 ]; then printf '  Enter: done   r: I put it back > '
  else printf '  Enter: done (or type a note first) > '
  fi
}

# A newly plugged receiver or cable of the recorded device's vendor is recorded
# too (the filter keeps it by its vendor id): say so.
after_detect() {
  for u in "$SYS"/bus/usb/devices/*; do
    [ -r "$u/idVendor" ] && [ -r "$u/devnum" ] || continue
    v=$(tr -d ' \n' < "$u/idVendor" | tr 'a-f' 'A-F'); p=$(tr -d ' \n' < "$u/idProduct" | tr 'a-f' 'A-F')
    b=$(tr -d ' \n' < "$u/busnum"); n=$(tr -d ' \n' < "$u/devnum")
    grep -q "^$v:\\*\$" "$WORK/want" 2>/dev/null || continue
    grep -q "^[a-z]* $b $n " "$WORK/inject" && continue
    say "  ${GREEN}$v:$p is recorded too.${OFF}"
  done
}

skip_group() {
  g=$S_GROUP
  while [ "$W_I" -le "$W_TOTAL" ]; do
    load_step "$W_FILE" "$W_I"
    [ "$S_GROUP" = "$g" ] || break
    record_step skipped
    W_I=$((W_I + 1))
  done
}

confirm_finish() {
  still=$(still_changed)
  if [ -n "$still" ]; then
    say "  ${YELLOW}Still changed on your device (put it back in the official software afterwards):${OFF}"
    printf '%s\n' "$still" | sed 's/^/    - /'
  fi
  ask '  Finish and save now? [y/N] ' || return 0
  case "$REPLY" in [yYoO]*) return 0 ;; esac
  return 1
}

# The steps, one at a time, as the Windows tool's step window has them: done
# (Enter, with a note), not in my software (n), skip this group (s), redo the
# previous step (b), finish and save (q). In a recording, a change that never
# reached the device is asked about once (LIVE: the filter's counts are fresh).
walk() { # steps file, kind, record | preview
  W_FILE=$1; W_KIND=$2; W_MODE=$3
  W_TOTAL=$(wc -l < "$W_FILE" | tr -d ' ')
  W_I=1; W_REDO=0; FINISHED_ALL=false
  : > "$WORK/log"; : > "$WORK/results"
  while [ "$W_I" -le "$W_TOTAL" ]; do
    load_step "$W_FILE" "$W_I"
    TRIES=$(awk -F'|' -v id="$S_ID" '$1 == id && $2 == "done"' "$WORK/log" | wc -l | tr -d ' ')
    ATTEMPT=$TRIES
    STEP_START=$(now_iso); STEP_T=$(date +%s); STEP_SENT=0
    [ "$W_MODE" = record ] && STEP_SENT=$(sent_count)
    REPEAT=0; has_flag repeat && REPEAT=1
    PUTBACK=0
    [ "$W_REDO" = 1 ] && [ "$TRIES" -gt 0 ] && [ "$REPEAT" = 0 ] && step_changes && PUTBACK=1
    W_REDO=0
    show_step
    if has_flag auto15 && [ "$W_MODE" = record ]; then
      countdown 15
      record_step done
      W_I=$((W_I + 1))
      continue
    fi
    W_NEXT=1
    while :; do
      if ! ask "$(prompt_for)"; then say ''; return 0; fi
      a=$(printf '%s' "$REPLY" | tr -d '\r')
      cmd=$(printf '%s' "$a" | sed 's/^ *//; s/ *$//' | tr 'A-Z' 'a-z')
      case "$cmd" in
        q)
          if confirm_finish; then return 0; fi
          continue
          ;;
        b)
          if [ "$W_I" -le 1 ]; then say '  This is the first step.'; continue; fi
          [ $(($(date +%s) - STEP_T)) -ge 2 ] && record_step left
          W_I=$((W_I - 1)); W_REDO=1; W_NEXT=0
          break
          ;;
        s) skip_group; W_NEXT=0; break ;;
        r)
          if [ "$PUTBACK" = 1 ]; then
            # What putting it back sent is kept apart from the step done again.
            record_step reverted
            PUTBACK=0; STEP_START=$(now_iso); STEP_T=$(date +%s)
            [ "$W_MODE" = record ] && STEP_SENT=$(sent_count)
            say '  Now do the step again, then press Enter.'
            continue
          fi
          ;;
        n | f)
          if ! { [ "$REPEAT" = 1 ] && [ "$ATTEMPT" -gt 0 ]; }; then record_step not-offered; fi
          break
          ;;
      esac
      if has_flag ask && [ -z "$cmd" ] && [ "$W_MODE" = record ]; then
        say '  Type the value it shows now (or n if it is not in your software).'
        continue
      fi
      if [ "$LIVE" = 1 ] && [ "$PUTBACK" = 0 ] && step_changes && [ "$(sent_count)" = "$STEP_SENT" ]; then
        ask "  ${YELLOW}Nothing reached the $DEVICE_NAME in this step yet.${OFF} Some software sends a change only on Apply or Save. Done anyway? [y/N] " || return 0
        case "$REPLY" in [yYoO]*) ;; *) continue ;; esac
      fi
      record_step done "$a"
      if [ "$LIVE" = 1 ]; then
        got=$(($(sent_count) - STEP_SENT))
        [ "$got" -gt 0 ] && say "  ${GREEN}The $DEVICE_NAME received it ($got messages).${OFF}"
      fi
      if [ "$W_MODE" = record ] && has_flag detect; then after_detect; fi
      if [ "$REPEAT" = 1 ]; then
        ATTEMPT=$((ATTEMPT + 1)); STEP_START=$(now_iso); STEP_T=$(date +%s)
        [ "$W_MODE" = record ] && STEP_SENT=$(sent_count)
        say "  ${DIM}$ATTEMPT recorded. The next one, or f when the list is done.${OFF}"
        continue
      fi
      break
    done
    if [ "$W_NEXT" = 1 ]; then W_I=$((W_I + 1)); fi
  done
  FINISHED_ALL=true
}

# ---- The filter --------------------------------------------------------------------
# Its input: /dev/usbmon0, every USB bus, as `od -An -v -tu1` prints its bytes:
# event after event, each a 48-byte header then the data it says it carries
# (usbmon's binary interface, read(2)). Its output: the events kept, as pcap
# records (link type 189, what app/src/main/devices/capture/usbpcap.ts reads),
# one a line, written as octal escapes the script turns back into bytes.
#
# Kept: the recorded devices (`target` lines of the inject file, and a device
# plugged in meanwhile whose ids, or vendor id, the want file lists), with
# their serial number blanked, what is typed on a keyboard collection blanked
# (a sample of 32 kept), and mouse movement cut to a sample of 200: the Windows
# tool's SdPcap rules. Every other device is dropped as soon as it is seen; its
# address is known from /sys (`known` lines), or from its own descriptor when
# it is plugged in meanwhile. Nothing is written but the kept records and the
# counts.
filter_awk() {
  cat <<'AWK'
function le(at, n,   v, i) { v = 0; for (i = n - 1; i >= 0; i--) v = v * 256 + B[at + i]; return v }
function put32(at, v) {
  B[at] = v % 256; B[at + 1] = int(v / 256) % 256
  B[at + 2] = int(v / 65536) % 256; B[at + 3] = int(v / 16777216) % 256
}
function status_out() { printf "%d %d %d\n", SENT, RECV, KEPT > status; close(status) }
function rec(   len, s, i) {
  len = 48 + le(36, 4)
  s = O[B[16]] O[B[17]] O[B[18]] O[B[19]] O[B[24]] O[B[25]] O[B[26]] O[B[27]]
  s = s O[len % 256] O[int(len / 256) % 256] O[int(len / 65536) % 256] O[int(len / 16777216) % 256]
  s = s O[len % 256] O[int(len / 256) % 256] O[int(len / 65536) % 256] O[int(len / 16777216) % 256]
  for (i = 0; i < len; i++) s = s O[B[i]]
  return s
}
function emit() { print rec() > out; KEPT++; if (KEPT % 200 == 1) status_out() }
function pend(key) {
  if (PENDN[key] + 0 < 512) PEND[key, PENDN[key]++] = rec()
  else DROPPED++
}
function forget(key,   k, p) {
  delete NAME[key]; delete TARGET[key]; delete SERIAL[key]; delete WHERE[key]
  for (k in EPIF) { split(k, p, SUBSEP); if (p[1] == key) delete EPIF[k] }
  for (k in BOOT) { split(k, p, SUBSEP); if (p[1] == key) delete BOOT[k] }
}
# A device descriptor came back: the address is that device's.
function named(key, bus, dev, cap,   name, first, i, n) {
  name = sprintf("%04X:%04X", B[56] + 256 * B[57], B[58] + 256 * B[59])
  if ((key in NAME) && NAME[key] != name) forget(key)
  first = !(key in NAME)
  NAME[key] = name
  SERIAL[key] = cap >= 17 ? B[64] : 0
  if (first) TARGET[key] = (key in WANTKEY) || (name in WANT) || ((substr(name, 1, 4) ":*") in WANT)
  if (TARGET[key]) WHERE[key] = name " (bus " bus ", address " dev ")"
  if (first) {
    n = PENDN[key] + 0
    for (i = 0; i < n; i++) {
      if (TARGET[key]) { print PEND[key, i] > out; KEPT++ } else DROPPED++
      delete PEND[key, i]
    }
    delete PENDN[key]
  }
}
# A configuration descriptor: which interface each endpoint is, and boot protocols.
function config(key, cap,   i, bl, t, iface) {
  iface = -1
  for (i = 0; i + 1 < cap;) {
    bl = B[48 + i]; t = B[49 + i]
    if (bl < 2 || i + bl > cap) break
    if (t == 4 && bl >= 9) { iface = B[50 + i]; if (B[53 + i] == 3 && B[54 + i] == 1) BOOT[key, iface] = B[55 + i] }
    else if (t == 5 && bl >= 7 && iface >= 0) EPIF[key, B[50 + i]] = iface
    i += bl
  }
}
# A HID report descriptor: its keyboard and mouse collections, with their input report ids.
function hid(name, iface, cap,   i, p, size, type, tag, v, j, page, usage, depth, c, CU, CI, rid, k, kind, r) {
  if ((name SUBSEP iface) in HIDDONE) return
  HIDDONE[name, iface] = 1
  page = 0; usage = -1; depth = 0; c = 0; rid = 0
  for (i = 0; i < cap;) {
    p = B[48 + i]
    if (p == 254) { i += 3 + B[49 + i]; continue }
    size = p % 4; if (size == 3) size = 4
    type = int(p / 4) % 4; tag = int(p / 16)
    v = 0; for (j = size - 1; j >= 0; j--) v = v * 256 + B[49 + i + j]
    if (type == 1 && tag == 0) page = v
    else if (type == 1 && tag == 8) rid = v
    else if (type == 2 && tag == 0 && depth == 0 && usage < 0) usage = size == 4 ? v : page * 65536 + v
    else if (type == 0 && tag == 10) { if (depth == 0) { c++; CU[c] = usage < 0 ? page * 65536 : usage; CI[c] = "" }; depth++ }
    else if (type == 0 && tag == 12) { if (depth > 0) depth-- }
    else if (type == 0 && tag == 8 && depth > 0 && c > 0 && rid != 0 && index(" " CI[c] " ", " " rid " ") == 0) CI[c] = CI[c] (CI[c] == "" ? "" : " ") rid
    if (type == 0) usage = -1
    i += 1 + size
  }
  for (k = 1; k <= c; k++) {
    kind = CU[k] == 65542 ? "keyboard" : CU[k] == 65538 ? "mouse" : ""
    if (kind == "") continue
    r = ++RULES; RKIND[r] = kind; RNAME[r] = name; RIF[r] = iface; RIDS[r] = CI[k]
  }
}
function addRule(name, iface, kind,   r) { r = ++RULES; RKIND[r] = kind; RNAME[r] = name; RIF[r] = iface; RIDS[r] = ""; return r }
# The rule for an input report: its interface's, for its report id; else, on a
# device that types, any endpoint no descriptor placed; else the boot protocol.
function ruleFor(key, iface, first,   name, r, any, kb, p) {
  name = NAME[key]; any = 0; kb = 0
  for (r = 1; r <= RULES; r++) {
    if (RNAME[r] != name) continue
    if (RKIND[r] == "keyboard") kb = 1
    if (RIF[r] != iface) continue
    any = 1
    if (RIDS[r] == "" || index(" " RIDS[r] " ", " " first " ") > 0) return r
  }
  if (any) return ""
  if (iface < 0 && kb) return addRule(name, iface, "keyboard")
  p = ((key SUBSEP iface) in BOOT) ? BOOT[key, iface] : 0
  if (iface >= 0 && (p == 1 || p == 2)) return addRule(name, iface, p == 1 ? "keyboard" : "mouse")
  return ""
}
function event(   type, xfer, ep, dev, bus, key, id, cap, s, t, idx, iface, r, sig, n, i) {
  type = B[8]; xfer = B[9]; ep = B[10]; dev = B[11]; bus = B[12] + 256 * B[13]
  cap = le(36, 4)
  key = bus "/" dev
  id = B[0] "," B[1] "," B[2] "," B[3] "," B[4] "," B[5] "," B[6] "," B[7]
  # Isochronous traffic and error events: never kept.
  if (xfer == 0 || (type != 83 && type != 67)) { DROPPED++; return }
  if (xfer == 2 && type == 83 && B[14] == 0) {
    SETUP[id] = B[40] " " B[41] " " B[42] " " B[43] " " B[44] " " B[45] " " B[46] " " B[47]
    if (!INJECTING && (key in NAME) && TARGET[key] && (B[40] == 33 || B[40] == 161)) { SENT++; status_out() }
  } else if (xfer == 2 && type == 67 && (id in SETUP)) {
    split(SETUP[id], s, " ")
    delete SETUP[id]
    if (s[1] == 128 && s[2] == 6 && cap > 0) {
      t = s[4] + 0; idx = s[3] + 0
      if (t == 1 && cap >= 12) named(key, bus, dev, cap)
      else if (t == 2 && cap >= 9 && (key in NAME)) config(key, cap)
      else if (t == 3 && idx != 0 && (key in SERIAL) && idx == SERIAL[key] && cap > 2) {
        for (i = 2; i < cap; i++) B[48 + i] = i % 2 == 0 ? 48 : 0
        SERIALS++
      }
    } else if (s[1] == 129 && s[2] == 6 && s[4] == 34 && cap > 0 && (key in NAME)) hid(NAME[key], s[5] + 0, cap)
  }
  if (!(key in NAME)) { pend(key); return }
  if (!TARGET[key]) { DROPPED++; return }
  if (xfer == 1 && ep >= 128) {
    iface = ((key SUBSEP ep) in EPIF) ? EPIF[key, ep] : -1
    r = ruleFor(key, iface, cap > 0 ? B[48] : -1)
    if (r != "") {
      # A read waiting for input carries nothing.
      if (type == 83) { DROPPED++; return }
      sig = key "/" ep "/" ((RIDS[r] != "" && cap > 0) ? B[48] : -1)
      n = SEEN[sig]++
      if (RKIND[r] == "keyboard") {
        KEYS++
        if (n >= 32) { DROPPED++; return }
        for (i = (RIDS[r] != "" ? 1 : 0); i < cap; i++) B[48 + i] = 0
      } else if (n >= 200) { MOUSE++; return }
    } else if (type == 67 && cap > 0 && !INJECTING) { RECV++; if (RECV % 50 == 1) status_out() }
  } else if (xfer == 1 && type == 83 && cap > 0 && !INJECTING) { SENT++; status_out() }
  emit()
}
# One made-up request and its answer, as if read now: a descriptor as Linux holds it.
function synth(bus, dev, setup, data, len,   s, i) {
  split(setup, s, " ")
  SYN++
  head(bus, dev, 83, -115)
  for (i = 0; i < 8; i++) B[40 + i] = s[i + 1] + 0
  B[14] = 0; B[15] = 60
  put32(32, s[7] + 256 * s[8]); put32(36, 0)
  event()
  head(bus, dev, 67, 0)
  B[14] = 45; B[15] = 0
  put32(32, len); put32(36, len)
  for (i = 0; i < len; i++) B[48 + i] = data[i]
  event()
}
function head(bus, dev, type, st,   i) {
  for (i = 0; i < 48; i++) B[i] = 0
  B[0] = SYN % 256; B[1] = int(SYN / 256) % 256; B[2] = 83; B[3] = 68
  B[8] = type; B[9] = 2; B[10] = 128; B[11] = dev + 0
  B[12] = (bus + 0) % 256; B[13] = int((bus + 0) / 256)
  put32(16, t0 + 0); put32(24, SYN)
  put32(28, st < 0 ? st + 4294967296 : st)
}
function injectLine(line,   w, n, key, i, d, total, off) {
  n = split(line, w, " ")
  key = w[2] "/" w[3]
  if (w[1] == "known") { NAME[key] = w[4]; TARGET[key] = 0 }
  else if (w[1] == "target") { WANTKEY[key] = 1 }
  else if (w[1] == "desc" && n >= 3 + 18) {
    for (i = 0; i < 18; i++) d[i] = w[4 + i] + 0
    synth(w[2], w[3], "128 6 0 1 0 0 18 0", d, 18)
    off = 4 + 18
    if (n >= off + 3) {
      total = (w[off + 2] + 0) + 256 * (w[off + 3] + 0)
      if (total > n - off + 1) total = n - off + 1
      split("", d)
      for (i = 0; i < total; i++) d[i] = w[off + i] + 0
      synth(w[2], w[3], "128 6 0 2 0 0 " (total % 256) " " int(total / 256), d, total)
    }
  } else if (w[1] == "report" && n > 4) {
    total = n - 4
    for (i = 0; i < total; i++) d[i] = w[5 + i] + 0
    synth(w[2], w[3], "129 6 0 34 " (w[4] + 0) " 0 " (total % 256) " " int(total / 256), d, total)
  }
}
BEGIN {
  for (i = 0; i < 256; i++) O[i] = sprintf("\\%03o", i)
  while ((getline line < want) > 0) WANT[line] = 1
  close(want)
  INJECTING = 1
  while ((getline line < inject) > 0) injectLine(line)
  close(inject)
  INJECTING = 0
  nb = 0; need = -1
  status_out()
}
{
  for (f = 1; f <= NF; f++) {
    B[nb++] = $f + 0
    if (nb == 48) need = 48 + le(36, 4)
    if (nb == need) { event(); nb = 0; need = -1 }
  }
}
END {
  for (k in PENDN) { UNIDENT += PENDN[k]; DROPPED += PENDN[k] }
  printf "messages %d\nother %d\nkeys %d\nmouse %d\nserials %d\nunidentified %d\n", KEPT, DROPPED, KEYS, MOUSE, SERIALS, UNIDENT > summary
  for (k in WHERE) printf "seen %s\n", WHERE[k] > summary
  close(summary)
  close(out)
  status_out()
}
AWK
}

# ---- The recording (Linux) -----------------------------------------------------------
# What the filter starts from: every USB device plugged in now, by its address
# (`known`), and the recorded ones (`target`) with their descriptors as Linux
# holds them (device, configuration, HID report), written in first, since they
# were read when the device was plugged in.
make_inject() {
  : > "$WORK/inject"; : > "$WORK/want"
  TARGETS=''; PLACES=''
  for u in "$SYS"/bus/usb/devices/*; do
    [ -r "$u/idVendor" ] && [ -r "$u/busnum" ] && [ -r "$u/devnum" ] || continue
    v=$(tr -d ' \n' < "$u/idVendor" | tr 'a-f' 'A-F'); p=$(tr -d ' \n' < "$u/idProduct" | tr 'a-f' 'A-F')
    b=$(tr -d ' \n' < "$u/busnum"); n=$(tr -d ' \n' < "$u/devnum")
    if ! grep -q "^$v|$p|" "$FOUND"; then
      printf 'known %s %s %s:%s\n' "$b" "$n" "$v" "$p" >> "$WORK/inject"
      continue
    fi
    printf 'target %s %s %s:%s\n' "$b" "$n" "$v" "$p" >> "$WORK/inject"
    [ -r "$u/descriptors" ] && printf 'desc %s %s %s\n' "$b" "$n" "$(bytes_of "$u/descriptors")" >> "$WORK/inject"
    for i in "$u"/*:*; do
      [ -r "$i/bInterfaceNumber" ] || continue
      f=$(tr -d ' \n' < "$i/bInterfaceNumber")
      for h in "$i"/*:*:*.*; do
        [ -r "$h/report_descriptor" ] || continue
        printf 'report %s %s %s %s\n' "$b" "$n" "$((0x$f))" "$(bytes_of "$h/report_descriptor")" >> "$WORK/inject"
      done
    done
    case " $TARGETS " in *" $v:$p "*) ;; *) TARGETS="${TARGETS:+$TARGETS }$v:$p" ;; esac
    PLACES="${PLACES:+$PLACES, }bus $b, address $n"
    printf '%s:%s\n%s:*\n' "$v" "$p" "$v" >> "$WORK/want"
  done
}

# The USB monitor's bytes: /dev/usbmon0 read as root, until the flag file goes
# (or this script does). Nothing else runs as root.
usbmon_bytes() {
  if [ -n "$USBMON_FILE" ]; then cat "$USBMON_FILE"; return; fi
  $ROOT sh -c 'modprobe usbmon 2>/dev/null
[ -r /dev/usbmon0 ] || { echo no-usbmon >&2; exit 3; }
echo ready >&2
cat /dev/usbmon0 & c=$!
while [ -e "$1" ] && kill -0 "$2" 2>/dev/null; do sleep 1; done
kill "$c" 2>/dev/null
wait "$c" 2>/dev/null
exit 0' sh "$FLAG" "$$"
}

record() {
  say ''
  say "  ${CYAN}Shark Deck - recording${OFF}"
  say "  ${CYAN}======================${OFF}"
  para "The official software runs on Windows. Run it here in a Windows virtual machine (VirtualBox, GNOME Boxes, virt-manager, VMware) with the device passed through to it (the machine's USB menu), or with Wine. This tool records what goes over the USB cable on this computer, which is what reaches the device either way."
  descs=$(cut -d'|' -f9 "$FOUND")
  guess=''
  case "$descs" in *0902a101*) case "$descs" in *0906a101*) ;; *) guess=M ;; esac ;; *0906a101*) guess=K ;; esac
  KIND=''
  while [ -z "$KIND" ]; do
    ask "  Is it a mouse (M) or a keyboard (K)?${guess:+ [$guess]} " || return 1
    case "${REPLY:-$guess}" in [mMsS]*) KIND=mouse ;; [kKcCtT]*) KIND=keyboard ;; esac
  done
  words=''
  if [ -n "$STEPS" ]; then
    words=$STEPS
    # Named as the steps' own groups ("Media keys"), not by the words that picked them.
    asked=$(steps_for "$KIND" "$STEPS" | cut -d'|' -f3 | grep -v -x -e Start -e Finish | awk '!seen[$0]++' | paste -sd, - | sed 's/,/, /g')
    say "  Shark Deck asked for a short recording, of these settings only: $asked."
  elif [ "$RECORD" != yes ]; then
    say '  What to record:'
    say '    1  Everything, one setting at a time (about 30 minutes): for a device Shark Deck does not know yet.'
    say '    2  Something specific (a few minutes): a setting missing from Shark Deck, or one that does not work.'
    say "       ${DIM}You do it in the official software and write in a note what you did.${OFF}"
    ask '  1 or 2 [1] ' || return 1
    case "$REPLY" in *2*) words=specific ;; esac
  fi
  ask '  The official software, and how it runs here (its name and version; virtual machine or Wine): ' || return 1
  SOFTWARE=$(printf '%s' "$REPLY" | tr -d '\r')

  if [ -z "$USBMON_FILE" ]; then
    while pgrep -x sharkdeck >/dev/null 2>&1; do
      say "  ${YELLOW}Shark Deck is running: it would talk to the device too.${OFF} Quit it (its tray icon > Quit)."
      ask '  Press Enter once it is closed (or c to go on anyway) ' || return 1
      case "$REPLY" in [cC]*) break ;; esac
    done
  fi

  ROOT=''
  if [ -z "$USBMON_FILE" ] && [ "$(id -u)" != 0 ]; then
    say ''
    para "Recording USB traffic needs administrator rights: the tool reads the kernel's USB monitor (usbmon) as root, and nothing else."
    if command -v sudo >/dev/null 2>&1 && sudo -v; then ROOT='sudo -n'
    elif command -v pkexec >/dev/null 2>&1; then ROOT=pkexec; say '  A password window may open.'
    else
      say "  ${RED}Neither sudo nor pkexec is here: run this tool as root.${OFF}"
      return 1
    fi
  fi

  STAMP=$(date +%Y%m%d-%H%M)
  REC="$OUT_DIR/SharkDeck-recording-$fvid-$fpid-$STAMP"
  mkdir -p "$REC" || return 1
  steps_for "$KIND" "$words" > "$WORK/steps"
  filter_awk > "$WORK/filter.awk"
  : > "$FLAG"; : > "$WORK/capture.log"
  AWK=awk
  awk -W version 2>/dev/null | grep -qi mawk && AWK='awk -W interactive'
  STDBUF=''
  command -v stdbuf >/dev/null 2>&1 && STDBUF='stdbuf -oL'
  LIVE=0
  [ -n "$STDBUF" ] && [ -z "$USBMON_FILE" ] && LIVE=1
  STARTED=$(now_iso)
  (usbmon_bytes | $STDBUF od -An -v -tu1 | $AWK -v t0="$(date +%s)" -v inject="$WORK/inject" -v want="$WORK/want" \
    -v out="$WORK/kept" -v status="$WORK/status" -v summary="$WORK/kept.txt" -f "$WORK/filter.awk") 2>> "$WORK/capture.log" &
  CAP_PID=$!
  if [ -z "$USBMON_FILE" ]; then
    waited=0
    while ! grep -q '^ready' "$WORK/capture.log" 2>/dev/null; do
      if grep -q 'no-usbmon' "$WORK/capture.log" 2>/dev/null || ! kill -0 "$CAP_PID" 2>/dev/null || [ "$waited" -gt 120 ]; then
        rm -f "$FLAG"; wait "$CAP_PID" 2>/dev/null; CAP_PID=''
        if grep -q 'no-usbmon' "$WORK/capture.log" 2>/dev/null; then
          say "  ${RED}This system's kernel has no USB monitor (usbmon, CONFIG_USB_MON), so nothing can be recorded here.${OFF}"
        else
          say "  ${RED}The recording could not start: no administrator rights.${OFF}"
        fi
        rm -rf "$REC"
        return 1
      fi
      sleep 1; waited=$((waited + 1))
    done
  fi
  K0=$(kept_count)
  DEVICE_NAME=${MODEL:-device}
  say ''
  say "  ${GREEN}Recording.${OFF} Keep this window open until the end."
  para "${DIM}Recorded: what the official software and the $DEVICE_NAME send each other. Not recorded: other devices, what you type on it (blanked), its serial number.${OFF}"
  walk "$WORK/steps" "$KIND" record
  ENDED=$(now_iso)
  [ "$LIVE" = 1 ] && [ "$(kept_count)" = "$K0" ] &&
    say "  ${YELLOW}Nothing was recorded from the $DEVICE_NAME: was it passed to the virtual machine, and did the software show it?${OFF}"

  say ''
  say "  ${CYAN}Recording stopped. Keeping only your device's part of it...${OFF}"
  rm -f "$FLAG"
  wait "$CAP_PID" 2>/dev/null
  CAP_PID=''
  # pcap, link type 189 (LINKTYPE_USB_LINUX): usbmon's 48-byte headers.
  {
    printf '\324\303\262\241\002\000\004\000\000\000\000\000\000\000\000\000\000\000\004\000\275\000\000\000'
    while IFS= read -r l; do printf "$l"; done < "$WORK/kept"
  } > "$REC/capture.pcap"

  kv() { sed -n "s/^$1 //p" "$WORK/kept.txt" | head -n 1; }
  messages=$(kv messages); other=$(kv other); keys=$(kv keys); mouse=$(kv mouse); serials=$(kv serials); unident=$(kv unidentified)
  seen=$(sed -n 's/^seen //p' "$WORK/kept.txt")
  seen_json=$(printf '%s\n' "$seen" | sed '/^$/d' | while IFS= read -r s; do printf '%s,' "$(jstr "$s")"; done | sed 's/,$//')
  devices_json=$(for t in $TARGETS; do printf '"%s",' "$t"; done | sed 's/,$//')
  done_n=$(awk -F'|' '$2 == "done"' "$WORK/log" | wc -l | tr -d ' ')
  notoff_n=$(awk -F'|' '$2 == "not-offered"' "$WORK/log" | wc -l | tr -d ' ')
  skip_n=$(awk -F'|' '$2 == "skipped"' "$WORK/log" | wc -l | tr -d ' ')
  CAPTURE="usbmon (Linux $(uname -r))"
  REC_JSON=$(printf '"recording":{"version":1,"kind":"%s","usbpcap":null,"capture":%s,"started":"%s","ended":"%s","finishedAllSteps":%s,"inPlace":true,"devices":[%s],"software":{"process":%s},"kept":{"messages":%s,"otherDevices":%s,"keyPressesBlanked":%s,"mouseMovesLeftOut":%s,"serialNumbersBlanked":%s,"unidentified":%s,"seen":[%s]},"steps":[%s]}' \
    "$KIND" "$(jstr "$CAPTURE")" "$STARTED" "$ENDED" "$FINISHED_ALL" "$devices_json" "$(jstr "$SOFTWARE")" \
    "${messages:-0}" "${other:-0}" "${keys:-0}" "${mouse:-0}" "${serials:-0}" "${unident:-0}" "$seen_json" \
    "$(paste -sd, "$WORK/results")")
  {
    say ''
    say 'Recording'
    say '---------'
    say "A $KIND, recorded $STARTED to $ENDED with $CAPTURE."
    say "Recorded where it was plugged in ($PLACES), without unplugging it: the tool wrote in its device, configuration and report descriptors as Linux holds them."
    [ -n "$SOFTWARE" ] && say "Official software: $SOFTWARE."
    say "Kept ${messages:-0} USB messages from $(printf '%s\n' "$seen" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g'); key presses blanked: ${keys:-0}; mouse movements left out: ${mouse:-0}."
    say "Steps: $done_n done, $notoff_n not in the software, $skip_n skipped."
  } > "$WORK/recording.txt"
  write_report "$REC/report.txt" "$WORK/recording.txt" "$REC_JSON"
  [ -n "$seen" ] || say "  ${RED}The recording holds nothing from your device: it never named itself on USB.${OFF}"

  say ''
  say "  ${GREEN}Steps: $done_n done, $notoff_n not in the software, $skip_n skipped.${OFF}"
  still=$(still_changed)
  if [ -n "$still" ]; then
    say "  ${YELLOW}Still changed on your device: put these back in the official software.${OFF}"
    printf '%s\n' "$still" | sed 's/^/    - /'
  else
    say "  ${DIM}Everything the steps changed was put back.${OFF}"
  fi
  PACK="$REC.tar.gz"
  tar -czf "$PACK" -C "$OUT_DIR" "$(basename "$REC")" || return 1
  RECORDED=yes
  say ''
  say "  ${GREEN}Ready to send: $PACK${OFF}"
  para "capture.pcap in it is the USB traffic, report.txt describes the device."
  say ''
  say '  Next: open a "New device" request on GitHub and attach that file:'
  say "  $ISSUE_URL"
  if [ -z "${SHARKDECK_OUT:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$OUT_DIR" >/dev/null 2>&1 &
    if ask '  Press Enter to open that page in your browser, or close this window ' ; then
      xdg-open "$ISSUE_URL" >/dev/null 2>&1 &
    fi
  fi
  return 0
}

# ---- Preview ---------------------------------------------------------------------------
if [ -n "$PREVIEW" ]; then
  steps_for "$PREVIEW" "$STEPS" > "$WORK/steps"
  LIVE=0
  DEVICE_NAME=device
  say ''
  say "  ${CYAN}Shark Deck - the recording's steps${OFF} ${DIM}(a preview: nothing is recorded)${OFF}"
  walk "$WORK/steps" "$PREVIEW" preview
  say ''
  awk -F'|' '{ printf "  %-22s %-12s %s\n", $1, $2, $7 }' "$WORK/log"
  exit 0
fi

# ---- The report ------------------------------------------------------------------------
# Collected as lines: vid|pid|release|product|maker|serial(0/1)|interface|transport|descriptor-hex
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
    KEEP="$WORK/keep"
    : > "$KEEP"
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
MODEL="${SHARKDECK_MODEL:-}"
if [ -z "$MODEL" ]; then
  ask '  Which model is it (as on the box or the store page, e.g. X8 PRO)? ' || say ''
  MODEL=$(printf '%s' "$REPLY" | tr -d '\r')
else
  say "  Which model is it (as on the box or the store page, e.g. X8 PRO)? $MODEL"
fi
first=$(head -n 1 "$FOUND")
fvid=$(printf '%s' "$first" | cut -d'|' -f1); fpid=$(printf '%s' "$first" | cut -d'|' -f2)
OUT_DIR="${SHARKDECK_OUT:-}"
if [ -z "$OUT_DIR" ]; then
  OUT_DIR=$(xdg-user-dir DESKTOP 2>/dev/null) || OUT_DIR=''
  [ -n "$OUT_DIR" ] && [ "$OUT_DIR" != "$HOME" ] && [ -d "$OUT_DIR" ] || OUT_DIR="$HOME/Desktop"
fi
[ -d "$OUT_DIR" ] || OUT_DIR="$HOME"
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
  say 'A recording of the official software: this tool makes one on Linux, SharkDeck-device-report.bat on Windows.'
} > "$WORK/summary"
{
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
  printf ']'
} > "$WORK/head.json"

# The report file: its readable part (and the recording's), the marker, the JSON.
write_report() { # file, more readable lines ('' for none), the recording's JSON ('' for none)
  {
    cat "$WORK/summary"
    [ -n "$2" ] && cat "$2"
    say "$REPORT_MARKER"
    cat "$WORK/head.json"
    [ -n "$3" ] && printf ',%s' "$3"
    printf '}\n'
  } > "$1"
}

RECORDED=''
if [ "$PLATFORM" = linux ] && [ "$RECORD" != no ]; then
  make_inject
  if [ -z "$TARGETS" ]; then
    [ "$RECORD" = yes ] && say '  A recording needs the device on USB here (its cable or its receiver): Bluetooth is not recorded.'
  else
    go=yes
    if [ "$RECORD" != yes ]; then
      say ''
      para "Next, a recording: you change each setting once in the official software while this tool records what it sends the device. About 30 minutes, or a few for one setting. Only this device's traffic is kept, what you type on it is blanked as it is recorded, and nothing is sent anywhere."
      if ask '  Record now? [Y/n] '; then
        case "$REPLY" in [nN]*) go=no ;; esac
      else
        go=no
        say ''
      fi
    fi
    if [ "$go" = yes ]; then record || say "  ${DIM}No recording: the report alone is saved.${OFF}"; fi
  fi
elif [ "$RECORD" = yes ]; then
  say '  A recording needs Linux here, or Windows (SharkDeck-device-report.bat): the report alone is saved.'
fi

if [ -z "$RECORDED" ]; then
  write_report "$OUT" '' ''
  say ''
  say "  Saved: $OUT"
  say '  Attach it to a "New device" issue:'
  say "  $ISSUE_URL"
  if [ -n "${SHARKDECK_OUT:-}" ]; then :
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$ISSUE_URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$ISSUE_URL"; fi
fi
say ''
