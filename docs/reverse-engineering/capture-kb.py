"""Frida host: records Driver v4 -> R85HE HID traffic, one labelled step at a time.

The V8 session (capture.py) was time-driven: record for N seconds, then guess
which packet went with which click by wall-clock. This one is STEP-DRIVEN — it
prints an instruction, waits for you to press Enter, and tags every packet that
arrives before the next Enter with that step's name. Correlation is then exact.

Usage
-----
    python capture-kb.py                 # attach to a running iot_driver
    python capture-kb.py --process ATK   # attach to a different owner instead
    python capture-kb.py --free          # no script; just log everything with timestamps

Prereqs: Driver v4 installed and its service (iot_driver_v215.exe) running —
open the Driver v4 window once and it spawns. `python -m pip install frida psutil`.

Output: session-r85he.jsonl next to this file (NOT session.jsonl — that is the
V8 capture and must not be overwritten). Each record gets a "step" field.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter

# Windows consoles default to cp1252 and choke on box-drawing / arrows.
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
OUT = os.path.join(HERE, "session-r85he.jsonl")

# iot_driver is the HID owner. Fall back names cover older/newer builds.
OWNER_NAMES = ("iot_driver_v215.exe", "iot_driver.exe", "iot_driver_v217.exe")

# The click script. Each tuple is (short-name, what-to-do-in-the-Driver-v4-UI).
# Keep CAPTURE-KEYBOARD.md and this list in sync.
#
# What Driver v4 actually exposes for the R85HE (from its device-table row —
# `other:{isSwitchReplaceable:true}` only, no `deBounce`/`sleep24`/`sleepBT`):
#   magnetic actuation (travel / RT / DKS / modes / dead zone / calibration),
#   key + Fn-layer remap (4 layers), per-key lighting, side lighting,
#   polling rate, macros, profile slots, firmware.
#   NO debounce control, NO sleep timer, NO battery — it's a wired board.
# Any step whose page you can't find: just press Enter to skip it.
STEPS = [
    ("01_enumerate", "Driver v4 is open and the R85HE card is shown. Just press Enter."),
    ("02_read_all_pages", "Click through every settings page/tab once, changing NOTHING. Enter when done."),
    ("04_poll_125", "Polling-rate control: set 125 Hz. Enter."),
    ("04_poll_250", "Polling rate: 250 Hz. Enter."),
    ("04_poll_500", "Polling rate: 500 Hz. Enter."),
    ("04_poll_1000", "Polling rate: 1000 Hz. Enter."),
    ("04_poll_2000", "Polling rate: 2000 Hz. Enter."),
    ("04_poll_4000", "Polling rate: 4000 Hz. Enter."),
    ("04_poll_8000", "Polling rate: 8000 Hz. Enter."),
    ("05_profile_1", "Profile / preset / layer slot 1. Enter."),
    ("05_profile_2", "Profile slot 2. Enter."),
    ("05_profile_3", "Profile slot 3. Enter."),
    ("05_profile_4", "Profile slot 4. Enter."),
    ("05_profile_reread", "Re-open the actuation page so it re-reads the now-active slot. Enter."),
    ("06_actuation_min", "Global / all-keys actuation: lowest value (~0.1 mm). Enter."),
    ("06_actuation_mid", "Global actuation: mid (~1.5 mm). Enter."),
    ("06_actuation_max", "Global actuation: highest (~3.4 mm). Enter."),
    ("07_key_esc", "Per-key actuation: select ESC only, set ~0.5 mm. Enter."),
    ("07_key_q", "Per-key actuation: select Q only, set ~2.0 mm. Enter."),
    ("07_key_right", "Per-key actuation: select RIGHT ARROW only, set ~2.99 mm. Enter."),
    ("08_rt_pair", "Rapid trigger: enable it on the SPACE + B pair (RT needs a pair). Enter."),
    ("08_rt_off", "Turn that rapid-trigger pair back OFF. Enter."),
    ("10_deadzone_top", "Top dead zone (a SEPARATE control from rapid trigger): ~0.4 mm on ESC. Enter."),
    ("10_deadzone_bottom", "Bottom dead zone on ESC: ~0.4 mm, then back to ~0.3 mm. Enter."),
    ("09_mode_dks", "DKS on A: fill the 4 action keys A/B/C/D; points A-press 0.7, B-press 3.2, C-release 3.2, D-release 0.7. Enter."),
    ("09_mode_mt", "Mod-tap on one key, hold-trigger 200 ms. Enter (skip if not offered)."),
    ("09_mode_tgl", "Toggle / long-press on key D -> key D. Enter (skip if not offered)."),
    ("10_calibrate", "Run the magnetic calibration / recalibrate button, if present. Otherwise Enter."),
    ("11_remap_key", "Key remap: remap a spare key (e.g. Right-Ctrl) to F12. Enter."),
    ("11_fn_layer", "Fn-layer remap: on the Fn layer, remap one key. Enter."),
    ("11_layer_2", "Switch to layer 2, remap one key. Enter (skip if no layer switch)."),
    ("11_layer_3", "Switch to layer 3, remap one key. Enter (skip if no layer switch)."),
    ("11_layer_4", "Switch to layer 4, remap one key. Enter (skip if no layer switch)."),
    ("12_macro_record", "Macros: record a 2-keystroke macro with a delay between them. Enter."),
    ("12_macro_assign", "Assign that macro to a key. Enter."),
    ("13_perkey_colour", "PER-KEY lighting (static colour is the ONLY per-key option): set 3-4 keys to different solid colours. Enter when done."),
    ("13_global_light", "GLOBAL / whole-board lighting: step a few effects, then brightness + speed + direction. Enter when done."),
    ("14_side_light_each", "Side / edge lighting: step through each of its effects. Enter when done."),
    ("17_restore_defaults", "Restore Defaults / factory reset, if present. Else Enter."),
    ("18_live_travel", "Open the live per-key travel / monitor view (if present), press a few keys, close it. Enter."),
    ("19_firmware_page", "Open the firmware-update page. DO NOT start an update. Enter."),
    ("99_done", "Capture complete. Press Enter to stop and write the file."),
]

packets: list[dict] = []
current_step = "00_preamble"

# Only these packet types are protocol traffic worth showing live. Everything
# else (handle opens, HID collection-info/descriptor IOCTLs iot_driver fires on
# its ~1 s enumeration poll) is still recorded to the .jsonl, just not printed.
INTERESTING = {"setfeature", "getfeature", "getinput"}
_noise = 0


def find_pid(name_filter: str | None) -> int:
    import psutil

    cands = []
    for proc in psutil.process_iter(["pid", "name"]):
        pname = proc.info["name"] or ""
        if name_filter:
            if name_filter.lower() in pname.lower():
                cands.append((pname, proc.info["pid"]))
        elif pname in OWNER_NAMES:
            cands.append((pname, proc.info["pid"]))
    if not cands:
        sys.exit(
            "No iot_driver process found. Open the Attack Shark Driver v4 window "
            "once so it starts its service, then re-run. (Or pass --process.)"
        )
    print(f"[*] attaching to {cands[0][0]} (pid {cands[0][1]})")
    return cands[0][1]


# Set from the agent's own messages, and checked before the first prompt: an
# agent that throws at load time installs no hooks, and the run would
# otherwise walk through every step and write an empty file. See the frida-17
# note in hook-kb.js.
_agent_error: "str | None" = None
_ready = False


def on_message(message: dict, _data) -> None:
    global _noise, _agent_error, _ready
    if message.get("type") == "error":
        _agent_error = str(message.get("description", message))
        print(f"\n[!] the agent raised: {_agent_error}")
        return
    payload = message.get("payload") or {}
    kind = payload.get("type")
    if kind == "ready":
        _ready = True
        print("[*] hooks installed\n")
        return
    payload["t"] = time.time()
    payload["step"] = current_step
    packets.append(payload)  # everything is recorded, regardless of printing

    if kind == "open":
        return
    if kind in INTERESTING and "hex" in payload:
        print(f"    \033[36m[{current_step}]\033[0m [{kind}] len={payload.get('len')}  {payload['hex']}")
    else:
        _noise += 1  # counted, shown in the step banner, not printed line-by-line


def summarise() -> None:
    print("\n" + "=" * 74)
    print("SUMMARY - distinct protocol frames per step / direction (noise excluded)")
    print("=" * 74)
    counts: Counter = Counter()
    for pkt in packets:
        if "hex" not in pkt or pkt["type"] not in INTERESTING:
            continue
        counts[(pkt.get("step", "?"), pkt["type"], pkt["hex"])] += 1
    if not counts:
        print("  (nothing - did Driver v4 have the R85HE card, and did you make changes?)")
    for (step, kind, hexs), n in counts.most_common():
        print(f"  {n:>3}x [{step:>18}] [{kind}] {hexs}")
    with open(OUT, "w", encoding="utf-8") as fh:
        for pkt in packets:
            fh.write(json.dumps(pkt) + "\n")
    print(f"\n[*] {len(packets)} records ({_noise} of them background noise) -> {OUT}")


def main() -> None:
    global current_step, _noise
    ap = argparse.ArgumentParser()
    ap.add_argument("--process", help="attach to a process whose name contains this instead of iot_driver")
    ap.add_argument("--free", action="store_true", help="no step script; log everything until Ctrl+C")
    args = ap.parse_args()

    with open(os.path.join(HERE, "hook-kb.js"), encoding="utf-8") as fh:
        source = fh.read()

    session = frida.attach(find_pid(args.process))
    script = session.create_script(source)
    script.on("message", on_message)
    script.load()

    deadline = time.time() + 5
    while not _ready and _agent_error is None and time.time() < deadline:
        time.sleep(0.05)
    if _agent_error is not None:
        sys.exit(
            "aborting: the agent did not install its hooks (see the error above), so"
            f" nothing would be captured. frida {frida.__version__} is installed."
        )
    if not _ready:
        sys.exit("aborting: the agent never reported ready, so nothing would be captured.")

    try:
        if args.free:
            current_step = "free"
            print("[*] free-run - Ctrl+C to stop and write the file")
            while True:
                time.sleep(1)
        else:
            print(f"\n[*] {len(STEPS)} steps. Do each action in the Driver v4 window, then press Enter here.")
            print("[*] Cyan lines are protocol frames; background HID enumeration noise is hidden (counted).\n")
            for i, (name, desc) in enumerate(STEPS, 1):
                current_step = name
                bar = "=" * 74
                skipped = f"   ({_noise} noise pkts hidden so far)" if _noise else ""
                prompt = (
                    f"\n\033[1m{bar}\n"
                    f" STEP {i}/{len(STEPS)}  --  {name}\n"
                    f"{bar}\033[0m\n"
                    f" {desc}\n"
                    f"\033[33m Do it in Driver v4, then press Enter here.\033[0m{skipped}\n > "
                )
                try:
                    input(prompt)
                except EOFError:
                    break
                # flush to disk after every step so a crash/kill never loses the run
                try:
                    with open(OUT, "w", encoding="utf-8") as fh:
                        for pkt in packets:
                            fh.write(json.dumps(pkt) + "\n")
                except Exception:
                    pass
    except KeyboardInterrupt:
        pass
    finally:
        try:
            session.detach()
        except Exception:
            pass
        summarise()


if __name__ == "__main__":
    main()
