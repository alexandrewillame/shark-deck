"""Frida host: records ATTACK SHARK MOUSE HUB -> V8 HID traffic, one labelled step
at a time.

The 2026-08-13 session (capture.py) was time-driven — record for N seconds, then
guess which packet went with which click by wall-clock, and it lost every device
reply to overlapped I/O. This one is STEP-DRIVEN like capture-kb.py: it prints an
instruction, waits for Enter, and tags every packet that arrives before the next
Enter with that step's name. It pairs with hook-mouse.js, which captures the
overlapped read completions the old hook.js missed.

Usage
-----
    python capture-mouse.py --spawn          # launch the Hub under Frida (best:
                                             #   the CreateFileW hook then sees
                                             #   every device handle)
    python capture-mouse.py                  # attach to an already-open Hub
    python capture-mouse.py --process HUB     # attach by name substring
    python capture-mouse.py --free            # no step script; log until Ctrl+C
    python capture-mouse.py --spawn --angle  # ANGLE_STEPS only: the six slider
                                             #   drags that locate Mouse Angle
                                             #   Mode's offset (see ANGLE_STEPS)

Prereqs: the V8 mouse AND its 8K receiver connected; ATTACK SHARK MOUSE HUB
installed; `python -m pip install frida psutil`. Close SharkDeck first
(`node app/scripts/kill-running-app.mjs`) — it holds the vendor collection.

Output: session-v8.jsonl next to this file (NOT session.jsonl — that is the
preserved first-generation V8 capture). Each record carries a "step" field and
the monotonic "seq" from the agent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import frida
except ImportError:
    sys.exit("frida is not installed. Run: python -m pip install frida psutil")

HERE = os.path.dirname(os.path.abspath(__file__))
# Default output. `--out` overrides it, which is how a targeted run (e.g.
# `--angle`) avoids clobbering the preserved full-session capture.
OUT = os.path.join(HERE, "session-v8.jsonl")

HUB_EXE = (r"C:\Program Files (x86)\ATTACK  SHARK MOUSE HUB"
           r"\ATTACK  SHARK MOUSE HUB\ATTACK  SHARK MOUSE HUB.exe")
HUB_NAMES = ("ATTACK  SHARK MOUSE HUB.exe",)

# Each tuple is (short-name, what-to-do-in-the-Hub). Keep CAPTURE-MOUSE.md in
# sync. Any step whose control you cannot find: just press Enter to skip it.
# Pause ~1 s after doing the action before pressing Enter, so the frame settles
# inside this step's window.
STEPS = [
    # -- 01 preamble: the read sweep, now WITH replies -------------------
    ("01_enumerate", "Hub is open and the V8 card is shown. Change nothing. Enter."),
    ("01_open_device", "Click the mouse card to enter its config. Enter."),
    ("01_read_all_tabs", "Click through EVERY tab (Preview, Keys, Sensor, Advanced, Light, Other/Settings) once, changing NOTHING. This captures the full block read-back. Enter when done."),

    # -- 02 Keys ------------------------------------------------------------
    ("02_key_left_default", "Keys tab. Select button 1 (Left) — leave it as Left Click (it must stay a click). Enter."),
    ("02_key2_button", "Button 2 (Right): set action = Button / Right Click. Enter."),
    ("02_key3_dpi_switch", "Button 3: action = DPI Switch (DPI loop). Enter."),
    ("02_key3_dpi_plus", "Button 3: DPI Switch -> DPI +. Enter."),
    ("02_key4_pollrate_switch", "Button 4: action = Polling rate switch. Enter."),
    ("02_key5_firepower", "Button 5: action = Firepower Button. Enter."),
    ("02_key5_fire_times", "Firepower: set Times = 3. Enter."),
    ("02_key5_fire_interval", "Firepower: set Interval = 50. Enter."),
    ("02_key6_config_switch", "Button 6: action = Configuration Switch. Enter."),
    ("02_key6_dpi_lock", "Button 6: action = DPI Lock. Enter."),
    ("02_key6_light_toggle", "Button 6: action = Turn on/off all decorative lights. Enter."),
    ("02_key6_strip_toggle", "Button 6: action = On/Off Light Strip. Enter."),
    ("02_key6_strip_cycle", "Button 6: action = Cyclic Switching of Light Strip Effect. Enter."),
    ("02_key6_combo", "Button 6: action = Combo key, set a 2-key combo. Enter."),
    ("02_key6_multimedia", "Button 6: action = Multimedia -> Volume+. Enter."),
    ("02_key6_scroll_lr", "Button 6: action = Scroll Left/Right -> Scroll Left. Enter."),
    ("02_key6_disable", "Button 6: action = Disable. Enter."),
    ("02_key6_restore", "Button 6: restore to its default action. Enter."),
    ("02_debounce_low", "Key Response Time (debounce): set the LOWEST value. Enter."),
    ("02_debounce_high", "Key Response Time: set a HIGH value. Enter."),
    ("02_debounce_default", "Key Response Time: back to default. Enter."),

    # -- 03 Sensor -------------------------------------------------------
    ("03_poll_125", "Sensor tab. Polling Rate = 125 Hz. Enter."),
    ("03_poll_250", "Polling Rate = 250 Hz. Enter."),
    ("03_poll_500", "Polling Rate = 500 Hz. Enter."),
    ("03_poll_1000", "Polling Rate = 1000 Hz. Enter."),
    ("03_poll_2000", "Polling Rate = 2000 Hz. Enter."),
    ("03_poll_4000", "Polling Rate = 4000 Hz. Enter."),
    ("03_poll_8000", "Polling Rate = 8000 Hz. Enter."),
    ("03_poll_1000_back", "Polling Rate back to 1000 Hz. Enter."),
    ("03_lod_07", "LOD = 0.7 mm. Enter."),
    ("03_lod_1", "LOD = 1 mm. Enter."),
    ("03_lod_2", "LOD = 2 mm. Enter."),
    ("03_sensor_mode_lp", "Select mode = LP. Enter."),
    ("03_sensor_mode_hp", "Select mode = HP. Enter."),
    ("03_sensor_mode_lp_back", "Select mode back to LP. Enter."),
    ("03_dpi_stage_count_2", "DPI Setting: set the number of DPI stages to 2. Enter."),
    ("03_dpi_stage_count_6", "DPI stages back to 6 (or the default). Enter."),
    ("03_dpi_stage1_value", "DPI stage 1: change its DPI value (e.g. 800 -> 1000). Enter."),
    ("03_dpi_stage2_value", "DPI stage 2: change its DPI value. Enter."),
    ("03_dpi_stage1_color", "DPI stage 1: change its colour to pure green. Enter."),
    ("03_dpi_stage2_color", "DPI stage 2: change its colour to pure blue. Enter."),
    ("03_dpi_active_stage_3", "Set the ACTIVE DPI stage to 3. Enter."),
    ("03_dpi_active_stage_1", "Active DPI stage back to 1. Enter."),
    ("03_motionsync_on", "Motion Sync = ON (leave everything else off). Enter."),
    ("03_motionsync_off", "Motion Sync = OFF. Enter."),
    ("03_anglesnap_on", "Angle snapping = ON. Enter."),
    ("03_anglesnap_off", "Angle snapping = OFF. Enter."),
    ("03_ripple_on", "Ripple Control = ON. Enter."),
    ("03_ripple_off", "Ripple Control = OFF. Enter."),
    ("03_performance_on", "Highest performance = ON. Enter."),
    ("03_performance_t1", "Highest performance timeout: pick a short value. Enter."),
    ("03_performance_t2", "Highest performance timeout: pick a long value. Enter."),
    ("03_performance_off", "Highest performance = OFF. Enter."),

    # -- 04 Advanced ---------------------------------------------------
    ("04_sleep_max_FIRST", "Advanced tab. Mouse Sleep Time = MAX. Do this early and leave it — it keeps the mouse awake for the rest of the run. Enter."),
    ("04_sleep_min", "Mouse Sleep Time = a short value (capture the low end). Enter."),
    ("04_sleep_max_again", "Mouse Sleep Time = MAX again. Enter."),
    # There is no Mouse Angle Mode *toggle* in the Hub — only a slider, which
    # is why the 2026-08-30 operator found nothing to click here and the
    # session ended up with no angle step at all. Drag it. For a run dedicated
    # to locating the offset use `--angle` (ANGLE_STEPS below) instead.
    ("04_angle_mode_p30", "Advanced tab: drag the Mouse Angle Mode SLIDER to +30. Enter."),
    ("04_angle_mode_m30", "Drag the Mouse Angle Mode slider to -30. Enter."),
    ("04_angle_mode_zero", "Drag the Mouse Angle Mode slider back to 0. Enter."),
    ("04_scan20k_on", "20K FPS Scanning Frame Rate = ON. Enter."),
    ("04_scan20k_off", "20K FPS Scanning Frame Rate = OFF. Enter."),
    ("04_longdist_on", "Long distance mode = ON. Enter."),
    ("04_longdist_off", "Long distance mode = OFF. Enter."),
    ("04_dpi_dyn_classic", "DPI Dynamic Sensitivity: mode = Classic. Enter."),
    ("04_dpi_dyn_natural", "DPI Dynamic Sensitivity: mode = Natural. Enter."),
    ("04_dpi_dyn_jump", "DPI Dynamic Sensitivity: mode = Jump. Enter."),
    ("04_dpi_dyn_custom", "DPI Dynamic Sensitivity: mode = Custom, drag one curve point. Enter."),
    ("04_dpi_dyn_off", "DPI Dynamic Sensitivity: back to default/off. Enter."),

    # -- 05 Light -----------------------------------------------------
    ("05_dpi_effect_off", "Light tab. DPI effect = Off. Enter."),
    ("05_dpi_effect_steady", "DPI effect = Steady. Enter."),
    ("05_dpi_effect_breathing", "DPI effect = Breathing. Enter."),
    ("05_dpi_effect_bright", "DPI effect: change Brightness. Enter."),
    ("05_light_mode_1", "Display light effects = Rainbow. Enter."),
    ("05_light_mode_2", "Light effects = Single Color Breath. Enter."),
    ("05_light_mode_3", "Light effects = Fixed Color. Enter."),
    ("05_light_mode_4", "Light effects = Neon. Enter."),
    ("05_light_mode_5", "Light effects = Rainbow Breath. Enter."),
    ("05_light_mode_6", "Light effects = Fixed Rainbow. Enter."),
    ("05_light_mode_0", "Light effects = Off. Enter."),
    ("05_light_bright", "Light: change Brightness. Enter."),
    ("05_light_speed", "Light: change Speed. Enter."),
    ("05_light_custom_color", "Light: set a custom colour (pure red). Enter."),
    ("05_light_move_off", "Turn off decorative lights when moving = ON. Enter."),
    ("05_light_move_off2", "Turn off decorative lights when moving = OFF. Enter."),
    ("05_lightoff_time_1", "Time until decorative lights turn off: pick a short value. Enter."),
    ("05_lightoff_time_2", "...pick a long value. Enter."),
    ("05_rx_led1_off", "Receiver LED indication (LED 1) = Always Off. Enter."),
    ("05_rx_led1_battery", "Receiver LED 1 = Mouse Battery Level. Enter."),
    ("05_rx_led1_link", "Receiver LED 1 = Connection Quality. Enter."),
    ("05_rx_led1_poll", "Receiver LED 1 = Polling Rate. Enter."),
    ("05_rx_led1_dpi", "Receiver LED 1 = DPI Level. Enter."),
    ("05_rx_led2", "Receiver LED 2 (if shown): step it through its options. Enter."),
    ("05_rx_led3", "Receiver LED 3 (if shown): step it through its options. Enter."),
    ("05_rx_decor_on", "Receiver Decorative Light = ON, pick an effect + colour. Enter."),
    ("05_rx_decor_off", "Receiver Decorative Light = OFF. Enter."),

    # -- 06 Macros --------------------------------------------------
    ("06_macro_new", "Macros: create a New Macro, name it. Enter."),
    ("06_macro_record", "Record: press A, wait, press B, stop. Save. Enter."),
    ("06_macro_cycle_mode", "Set the macro's cycle mode (e.g. 'until key released'). Enter."),
    ("06_macro_cycle_times", "Set Cycle Times = 3. Enter."),
    ("06_macro_insert_event", "Insert a command event (e.g. Left Click) into the macro. Save. Enter."),
    ("06_macro_assign", "Assign the macro to button 6. Enter."),
    ("06_macro_export", "Export this macro to a file. Enter."),
    ("06_macro_import", "Import that macro file back. Enter."),
    ("06_macro_delete", "Delete the macro. Enter."),

    # -- 07 Profiles ----------------------------------------------
    ("07_profile_1", "Profile / Configuration slot 1. Enter."),
    ("07_profile_2", "Profile slot 2. Enter."),
    ("07_profile_3", "Profile slot 3. Enter."),
    ("07_profile_4", "Profile slot 4. Enter."),
    ("07_profile_1_back", "Profile slot 1 again. Enter."),
    ("07_export_p1", "With Profile 1 active: Export configuration -> save as v8-config-export/profile-1.* . Enter."),
    ("07_export_p2", "Switch to Profile 2, Export -> v8-config-export/profile-2.* . Enter."),
    ("07_export_p3", "Profile 3, Export -> v8-config-export/profile-3.* . Enter."),
    ("07_export_p4", "Profile 4, Export -> v8-config-export/profile-4.* . Enter."),
    ("07_import_p1", "Switch to Profile 1, Import v8-config-export/profile-1.* back. Enter."),

    # -- 08 Settings -------------------------------------------
    ("08_device_info", "Settings / Device Information: open it. Records the firmware query for BOTH mouse and receiver. Enter."),
    ("08_language", "Change the Hub UI Language, then change it back. Enter."),
    ("08_autoboot_on", "Start automatically upon booting = ON. Enter."),
    ("08_autoboot_off", "Start automatically upon booting = OFF. Enter."),
    ("08_restore_defaults", "Restore Settings / Restore Defaults. Confirm. This resets the mouse — it is captured on purpose. Enter."),
    ("08_post_restore_read", "Let the Hub re-read everything after the restore. Change nothing. Enter."),

    # -- 09 Pair ------------------------------------------
    ("09_pair_tool_open", "Pair / Pair Tool: open it. Enter."),
    ("09_pair_start", "Click Start Pairing (you do NOT have to complete a real re-pair — the frame is what matters). Enter."),

    # -- 10 Wired -------------------------------------
    ("10_plug_cable", "Plug the V8 in with its USB-C cable (keep the receiver in too). Wait for the Hub to switch to wired mode. Enter."),
    ("10_sensor_mode_corded", "Sensor tab: Select mode = Corded (only offered on cable). Enter."),
    ("10_wired_read_all", "Click through the tabs again in wired mode, changing nothing. Enter."),
    ("10_firmware_page", "Firmware Update page: open it. DO NOT start an update. Enter."),
    ("10_unplug_cable", "Unplug the cable, back to wireless. Enter."),

    # -- 11 Offline (do this LAST) -------------------
    ("11_mouse_off", "Turn the mouse OFF (power switch) with the receiver still plugged in. Wait ~5 s. Enter."),
    ("11_offline_poll", "Leave it off. Let the Hub poll a few times / show it offline. Enter."),
    ("11_mouse_on", "Turn the mouse back ON. Wait for it to reconnect. Enter."),

    ("99_done", "Capture complete. Press Enter to stop and write the file."),
]

# `--angle`: the control the full session never exercised, because its step
# list looked for a toggle the Hub does not have. This is what located
# V8_BLOCK.ANGLE_DEGREES = 0xBD on 2026-09-10, and it stays as the worked
# example. Five distinct slider positions, because the offset alone is not
# enough — the five bytes written also settle the ENCODING, which no
# write/read-back sweep can: -30..30 two's complement, 0..60 biased and
# degrees-doubled all fit a signed byte identically.
#
# Read the result off `analyze-v8.py`'s SETTING-WRITE MAP: the offset that
# appears under these steps and nowhere else is the angle. If nothing shows up
# there, check its command map instead — the drag may not be a 0x07 region-A
# write at all, which is exactly the case scripts/watch-region-a.mjs would be
# blind to.
ANGLE_STEPS = [
    ("00_baseline", "Hub open, mouse card open, Advanced tab showing. Change NOTHING. Enter."),
    ("04_angle_0", "Drag the Mouse Angle Mode slider to 0 — drag it there even if it already reads 0, so a write is emitted. Enter."),
    ("04_angle_p15", "Drag the slider to +15. Enter."),
    ("04_angle_p30", "Drag the slider to +30 (maximum). Enter."),
    ("04_angle_m15", "Drag the slider to -15. Enter."),
    ("04_angle_m30", "Drag the slider to -30 (minimum). Enter."),
    ("04_angle_back_0", "Drag the slider back to 0, leaving the mouse as you found it. Enter."),
    ("99_done", "Done. Press Enter to stop and write the file."),
]

packets: list[dict] = []
current_step = "00_preamble"

# Types worth printing live; everything else still goes to the .jsonl.
INTERESTING = {
    "write", "read", "overlapped_read", "readex", "getinput",
    "setfeature", "getfeature", "dll",
}
_noise = 0
# Set from the agent's own messages. A frida API break (see hook-mouse.js's
# `exportByName`) used to leave BOTH of these untouched while the run walked
# through every step and wrote an empty file, so they are now checked before
# the first prompt rather than merely printed.
_agent_error: "str | None" = None
_ready = False


def _hub_running() -> bool:
    """Is a Hub instance already up?

    It single-instances: a second copy spawned here would notice the first,
    hand over and exit, leaving the hooks in a process that talks to nothing.
    """
    import psutil

    for proc in psutil.process_iter(["name"]):
        if (proc.info["name"] or "") in HUB_NAMES:
            return True
    return False


def find_pid(name_filter: str | None) -> int:
    import psutil

    cands = []
    for proc in psutil.process_iter(["pid", "name"]):
        pname = proc.info["name"] or ""
        if name_filter:
            if name_filter.lower() in pname.lower():
                cands.append((pname, proc.info["pid"]))
        elif pname in HUB_NAMES:
            cands.append((pname, proc.info["pid"]))
    if not cands:
        sys.exit("ATTACK SHARK MOUSE HUB is not running. Open it first, or pass --spawn.")
    print(f"[*] attaching to {cands[0][0]} (pid {cands[0][1]})")
    return cands[0][1]


def on_message(message: dict, _data) -> None:
    global _noise, _agent_error, _ready
    if message.get("type") == "error":
        _agent_error = str(message.get("description", message))
        print(f"\n\033[31m[!] the agent raised: {_agent_error}\033[0m")
        for line in (message.get("stack") or "").splitlines()[:6]:
            print(f"    {line}")
        return
    payload = message.get("payload") or {}
    kind = payload.get("type")
    if kind == "ready":
        _ready = True
        dll = payload.get("dllHooks", 0)
        print(f"[*] hooks installed - {dll} HIDUsb.dll exports hooked\n")
        if not dll:
            print("\033[33m[!] no HIDUsb.dll exports were hooked - the vendor DLL is not"
                  " loaded in this process. Writes are still captured, but no Hub"
                  " control will be named by the DLL call that produced it.\033[0m")
        return
    payload["t"] = time.time()
    payload["step"] = current_step
    packets.append(payload)

    if kind == "open":
        print(f"[open] {payload.get('path')}")
        return
    if kind == "dll":
        ph = payload.get("phase", "")
        if ph == "enter":
            print(f"  \033[35m[{current_step}]\033[0m [dll>] {payload['name']}")
        return
    if kind in INTERESTING and "hex" in payload:
        tag = kind if kind in ("write",) else f"{kind}"
        colour = "\033[32m" if kind == "write" else "\033[36m"
        print(f"  {colour}[{current_step}]\033[0m [{tag:>14}] len={payload.get('len'):<3} {payload['hex']}")
    else:
        _noise += 1

    # Flush to disk continuously so a Ctrl+C that wedges Frida's detach on
    # Windows can never lose the capture.
    if len(packets) % 20 == 0:
        flush()


def flush() -> None:
    try:
        with open(OUT, "w", encoding="utf-8") as fh:
            for pkt in packets:
                fh.write(json.dumps(pkt) + "\n")
    except Exception:
        pass


def summarise() -> None:
    print("\n" + "=" * 74)
    print("SUMMARY — distinct frames per step / type (noise excluded)")
    print("=" * 74)
    counts: Counter = Counter()
    for pkt in packets:
        if "hex" not in pkt or pkt["type"] not in INTERESTING:
            continue
        counts[(pkt.get("step", "?"), pkt["type"], pkt["hex"])] += 1
    for (step, kind, hexs), n in counts.most_common():
        print(f"  {n:>3}x [{step:>22}] [{kind:>14}] {hexs}")
    flush()
    print(f"\n[*] {len(packets)} records ({_noise} background noise) -> {OUT}")
    if not packets:
        print("")
        print("=" * 74)
        print("NOTHING WAS CAPTURED - the file is empty, so there is nothing to analyse.")
        print("=" * 74)
        print("The Hub polls the mouse ~1 Hz on its own, so even a run where you touched")
        print("no control should record traffic. An empty file means the hooks were not")
        print("in the process doing the talking. Check, in order:")
        print("  1. Was the Hub ALREADY running when you passed --spawn? It",
              "single-instances,")
        print("     so the copy spawned here hands over and exits. Close it, tray",
              "included.")
        print("  2. Is SharkDeck holding the device? node app/scripts/kill-running-app.mjs")
        print("  3. Did the mouse card actually appear in the Hub, with the receiver in?")
        print("  4. Is the Hub elevated but this shell not? Run both the same way.")


def main() -> None:
    global current_step, _noise
    ap = argparse.ArgumentParser()
    ap.add_argument("--spawn", action="store_true", help="launch the Hub under Frida")
    ap.add_argument("--process", help="attach to a process whose name contains this")
    ap.add_argument("--free", action="store_true", help="no step script; log until Ctrl+C")
    ap.add_argument("--seconds", type=int, default=0,
                    help="with --free: stop and write the file after N seconds (smoke test)")
    ap.add_argument("--angle", action="store_true",
                    help="run ANGLE_STEPS only — locate Mouse Angle Mode's offset")
    ap.add_argument("--out", help="write here instead of session-v8.jsonl")
    args = ap.parse_args()

    global OUT
    if args.out:
        OUT = args.out if os.path.isabs(args.out) else os.path.join(HERE, args.out)
    elif args.angle:
        # Never let a short targeted run overwrite the full-session capture.
        OUT = os.path.join(HERE, "session-v8-angle.jsonl")
    steps = ANGLE_STEPS if args.angle else STEPS

    with open(os.path.join(HERE, "hook-mouse.js"), encoding="utf-8") as fh:
        source = fh.read()

    if args.spawn:
        # A second Hub started here would hand off to the instance already
        # running and exit, leaving every hook in a process that talks to
        # nothing - another silent empty capture.
        if _hub_running():
            sys.exit(
                "ATTACK SHARK MOUSE HUB is already running. Close it (tray icon too)"
                " and re-run, or drop --spawn to attach to the running one."
            )
        print(f"[*] spawning {HUB_EXE}")
        pid = frida.spawn([HUB_EXE])
        session = frida.attach(pid)
    else:
        pid = find_pid(args.process)
        session = frida.attach(pid)

    try:
        script = session.create_script(source)
    except Exception as e:
        sys.exit(
            f"the agent failed to COMPILE: {e}\n"
            f"hook-mouse.js is a frida agent, and frida {frida.__version__} is installed -"
            " a frida whose JS API the agent does not match fails right here."
        )
    script.on("message", on_message)
    script.load()

    # An agent that threw at LOAD time installs no hooks at all, and every step
    # then records nothing while the run looks like it worked - which is exactly
    # how an empty session file was produced when frida 17 removed
    # Module.findExportByName. Never prompt for a step before the agent has said
    # it is ready.
    deadline = time.time() + 5
    while not _ready and _agent_error is None and time.time() < deadline:
        time.sleep(0.05)
    if _agent_error is not None:
        sys.exit(
            "aborting: the agent did not install its hooks (see the error above), so"
            f" nothing would be captured.\nfrida {frida.__version__} is installed."
            " The agent resolves exports through its own `exportByName` shim, so this"
            " is a NEW incompatibility - check it against this frida's JS API."
        )
    if not _ready:
        sys.exit("aborting: the agent never reported ready, so nothing would be captured.")
    if args.spawn:
        frida.resume(pid)

    try:
        if args.free:
            current_step = "free"
            if args.seconds:
                print(f"[*] free-run for {args.seconds}s, then write the file")
                time.sleep(args.seconds)
            else:
                print("[*] free-run — Ctrl+C to stop and write the file")
                while True:
                    time.sleep(1)
        else:
            print(f"\n[*] {len(steps)} steps. Do each action in the Hub, then press Enter here.")
            print("[*] Green = host->device write, cyan = device->host reply, magenta = vendor DLL call.")
            print("[*] Pause ~1 s after each action before pressing Enter.\n")
            for i, (name, desc) in enumerate(steps, 1):
                current_step = name
                bar = "=" * 74
                skipped = f"   ({_noise} noise pkts hidden)" if _noise else ""
                try:
                    input(
                        f"\n\033[1m{bar}\n STEP {i}/{len(steps)}  --  {name}\n{bar}\033[0m\n"
                        f" {desc}\n\033[33m Do it in the Hub, then press Enter.\033[0m{skipped}\n > "
                    )
                except EOFError:
                    break
                flush()
    except KeyboardInterrupt:
        print("\n[*] interrupted — writing the file")
    finally:
        # Write the file FIRST — Frida's session.detach() can wedge on Windows
        # when the target was --spawn'd, and we must not lose the capture to it.
        summarise()
        import threading

        t = threading.Thread(target=lambda: _safe_detach(session), daemon=True)
        t.start()
        t.join(3)
        # _exit skips atexit AND the stdout buffer, which is block-buffered when
        # stdout is a pipe or a redirect - the summary and every diagnostic above
        # would simply vanish for anyone capturing this run to a file.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)  # hard-exit past any stuck Frida/asyncio teardown


def _safe_detach(session) -> None:
    try:
        session.detach()
    except Exception:
        pass


if __name__ == "__main__":
    main()
