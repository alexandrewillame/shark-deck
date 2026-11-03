"""Focused step-driven capture — the exact settings the driver rewrite needs
pinned down (the points verify-mouse.mjs flags), against the vendor Mouse Hub.

Same harness as capture-mouse.py (hook-mouse.js, overlapped-read aware,
continuous flush, hard-exit past Frida's Windows detach hang). Shorter step
list: one clean write per setting so `analyze-v8.py` gives an unambiguous
offset -> value mapping.

    python capture-mouse-verify.py --spawn

Output: session-v8-verify.jsonl next to this file. After: run
`python analyze-v8.py session-v8-verify.jsonl`.

Prereqs: V8 mouse AWAKE (keep nudging it), receiver plugged in, SharkDeck
closed (`node app/scripts/kill-running-app.mjs`).
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
OUT = os.path.join(HERE, "session-v8-verify.jsonl")
HUB_EXE = (r"C:\Program Files (x86)\ATTACK  SHARK MOUSE HUB"
           r"\ATTACK  SHARK MOUSE HUB\ATTACK  SHARK MOUSE HUB.exe")
HUB_NAMES = ("ATTACK  SHARK MOUSE HUB.exe",)

# (step-name, what to do). One deliberate write per step; pause ~1 s then Enter.
STEPS = [
    ("00_open", "Hub open, V8 selected, on the Sensor tab. Change nothing. Enter."),

    # --- polling rate: every value, so the bitmask is nailed ----------
    ("poll_125", "Polling Rate = 125 Hz. Enter."),
    ("poll_250", "Polling Rate = 250 Hz. Enter."),
    ("poll_500", "Polling Rate = 500 Hz. Enter."),
    ("poll_1000", "Polling Rate = 1000 Hz. Enter."),
    ("poll_2000", "Polling Rate = 2000 Hz. Enter."),
    ("poll_4000", "Polling Rate = 4000 Hz. Enter."),
    ("poll_8000", "Polling Rate = 8000 Hz. Enter."),
    ("poll_back", "Polling Rate back to 1000 Hz. Enter."),

    # --- LOD ----------------------------------------------------------
    ("lod_07", "LOD = 0.7 mm. Enter."),
    ("lod_1", "LOD = 1 mm. Enter."),
    ("lod_2", "LOD = 2 mm. Enter."),

    # --- sensor mode + toggles, one at a time -----------------------
    ("mode_lp", "Select mode = LP. Enter."),
    ("mode_hp", "Select mode = HP. Enter."),
    ("mode_lp2", "Select mode back to LP. Enter."),
    ("motion_on", "Motion Sync ON. Enter."),
    ("motion_off", "Motion Sync OFF. Enter."),
    ("anglesnap_on", "Angle snapping ON. Enter."),
    ("anglesnap_off", "Angle snapping OFF. Enter."),
    ("ripple_on", "Ripple Control ON. Enter."),
    ("ripple_off", "Ripple Control OFF. Enter."),

    # --- advanced ---------------------------------------------------
    ("scan20k_on", "Advanced tab. 20K FPS Scanning ON. Enter."),
    ("scan20k_off", "20K FPS Scanning OFF. Enter."),
    ("longrange_on", "Long distance mode ON. Enter."),
    ("longrange_off", "Long distance mode OFF. Enter."),
    ("sleep_min", "Mouse Sleep Time = the SHORTEST option. Enter."),
    ("sleep_mid", "Mouse Sleep Time = a MIDDLE option. Enter."),
    ("sleep_max", "Mouse Sleep Time = the LONGEST option. Enter."),

    # --- key response time (debounce) -----------------------------
    ("debounce_min", "Keys tab. Key Response Time = the LOWEST value. Enter."),
    ("debounce_mid", "Key Response Time = a MIDDLE value. Enter."),
    ("debounce_max", "Key Response Time = the HIGHEST value. Enter."),
    ("debounce_default", "Key Response Time back to default. Enter."),

    # --- DPI: exact round values so reg = f(dpi) is unambiguous ----
    ("dpi_count_2", "Sensor tab. Set the number of DPI stages to 2. Enter."),
    ("dpi_count_4", "Set the number of DPI stages to 4. Enter."),
    ("dpi_active_1", "Set the ACTIVE DPI stage to 1. Enter."),
    ("dpi_active_2", "Set the ACTIVE DPI stage to 2. Enter."),
    ("dpi_active_3", "Set the ACTIVE DPI stage to 3. Enter."),
    ("dpi_s1_400", "DPI stage 1 = exactly 400. Enter."),
    ("dpi_s1_800", "DPI stage 1 = exactly 800. Enter."),
    ("dpi_s1_1600", "DPI stage 1 = exactly 1600. Enter."),
    ("dpi_s1_3200", "DPI stage 1 = exactly 3200. Enter."),
    ("dpi_s1_6400", "DPI stage 1 = exactly 6400. Enter."),
    ("dpi_s1_12800", "DPI stage 1 = exactly 12800. Enter."),
    ("dpi_s1_20000", "DPI stage 1 = exactly 20000. Enter."),
    ("dpi_s1_26000", "DPI stage 1 = exactly 26000 (max). Enter."),
    ("dpi_s1_1000", "DPI stage 1 back to 1000. Enter."),
    ("dpi_s2_2000", "DPI stage 2 = exactly 2000. Enter."),
    ("dpi_s1_color_r", "DPI stage 1 colour = pure RED. Enter."),
    ("dpi_s1_color_g", "DPI stage 1 colour = pure GREEN. Enter."),
    ("dpi_s2_color_b", "DPI stage 2 colour = pure BLUE. Enter."),

    # --- DPI-indicator LED --------------------------------------
    ("dpiled_off", "Light tab. DPI effect = Off. Enter."),
    ("dpiled_steady", "DPI effect = Steady. Enter."),
    ("dpiled_breath", "DPI effect = Breathing. Enter."),
    ("dpiled_bright_lo", "DPI effect brightness = LOW. Enter."),
    ("dpiled_bright_hi", "DPI effect brightness = MAX. Enter."),

    # --- receiver LEDs, one indication per LED -----------------
    ("rx_led1_off", "Receiver LED 1 = Always Off. Enter."),
    ("rx_led1_batt", "Receiver LED 1 = Mouse Battery Level. Enter."),
    ("rx_led1_quality", "Receiver LED 1 = Connection Quality. Enter."),
    ("rx_led1_poll", "Receiver LED 1 = Polling Rate. Enter."),
    ("rx_led1_dpi", "Receiver LED 1 = DPI Level (if offered). Enter."),
    ("rx_led2_batt", "Receiver LED 2 = Mouse Battery Level (if offered). Enter."),
    ("rx_led3_quality", "Receiver LED 3 = Connection Quality (if offered). Enter."),

    # --- buttons: each of the 6, to a simple action ------------
    ("btn1_default", "Keys tab. Button 1 (Left) — leave as Left Click. Enter."),
    ("btn2_right", "Button 2 = Right Click. Enter."),
    ("btn3_dpiloop", "Button 3 = DPI Switch / DPI loop. Enter."),
    ("btn4_pollswitch", "Button 4 = Polling rate switch. Enter."),
    ("btn5_forward", "Button 5 = Forward. Enter."),
    ("btn6_dpilock", "Button 6 = DPI Lock. Enter."),
    ("btn6_disable", "Button 6 = Disable. Enter."),
    ("btn6_restore", "Button 6 back to its default action. Enter."),

    ("99_done", "Done. Enter to write the file and exit."),
]

packets: list[dict] = []
current_step = "00_preamble"
INTERESTING = {"write", "read", "overlapped_read", "readex", "getinput", "setfeature", "getfeature", "dll"}
_noise = 0


def find_pid(name_filter):
    import psutil

    for proc in psutil.process_iter(["pid", "name"]):
        pn = proc.info["name"] or ""
        if (name_filter and name_filter.lower() in pn.lower()) or (not name_filter and pn in HUB_NAMES):
            print(f"[*] attaching to {pn} (pid {proc.info['pid']})")
            return proc.info["pid"]
    sys.exit("ATTACK SHARK MOUSE HUB is not running. Open it, or pass --spawn.")


def flush():
    try:
        with open(OUT, "w", encoding="utf-8") as fh:
            for pkt in packets:
                fh.write(json.dumps(pkt) + "\n")
    except Exception:
        pass


def on_message(message, _data):
    global _noise
    if message.get("type") == "error":
        print(f"[!] {message.get('description', message)}")
        return
    p = message.get("payload") or {}
    k = p.get("type")
    if k == "ready":
        print(f"[*] hooks installed — {p.get('dllHooks', 0)} HIDUsb.dll exports\n")
        return
    p["t"] = time.time()
    p["step"] = current_step
    packets.append(p)
    if k == "dll" and p.get("phase") == "enter":
        print(f"  \033[35m[{current_step}]\033[0m {p['name']}")
    elif k in INTERESTING and "hex" in p:
        col = "\033[32m" if k == "write" else "\033[36m"
        print(f"  {col}[{current_step}]\033[0m [{k:>14}] {p['hex']}")
    else:
        _noise += 1
    if len(packets) % 20 == 0:
        flush()


def summarise():
    print("\n" + "=" * 74)
    c: Counter = Counter()
    for pkt in packets:
        if "hex" in pkt and pkt["type"] in INTERESTING:
            c[(pkt.get("step", "?"), pkt["type"], pkt["hex"])] += 1
    for (step, kind, h), n in c.most_common():
        print(f"  {n:>3}x [{step:>18}] [{kind:>14}] {h}")
    flush()
    print(f"\n[*] {len(packets)} records ({_noise} noise) -> {OUT}")


def _safe_detach(session):
    try:
        session.detach()
    except Exception:
        pass


def main():
    global current_step
    ap = argparse.ArgumentParser()
    ap.add_argument("--spawn", action="store_true")
    ap.add_argument("--process")
    args = ap.parse_args()

    with open(os.path.join(HERE, "hook-mouse.js"), encoding="utf-8") as fh:
        source = fh.read()

    if args.spawn:
        print(f"[*] spawning {HUB_EXE}")
        pid = frida.spawn([HUB_EXE])
        session = frida.attach(pid)
    else:
        session = frida.attach(find_pid(args.process))

    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    if args.spawn:
        frida.resume(pid)

    try:
        print(f"\n[*] {len(STEPS)} steps. Do each in the Hub, pause ~1 s, then press Enter.")
        print("[*] Keep the mouse moving so it does not fall asleep.\n")
        for i, (name, desc) in enumerate(STEPS, 1):
            current_step = name
            try:
                input(f"\n\033[1m{'='*74}\n STEP {i}/{len(STEPS)}  {name}\n{'='*74}\033[0m\n {desc}\n > ")
            except EOFError:
                break
            flush()
    except KeyboardInterrupt:
        print("\n[*] interrupted — writing the file")
    finally:
        summarise()
        import threading

        t = threading.Thread(target=lambda: _safe_detach(session), daemon=True)
        t.start()
        t.join(3)
        os._exit(0)


if __name__ == "__main__":
    main()
