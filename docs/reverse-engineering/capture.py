"""Frida host: records the Hub's HID traffic while you switch profiles.

Usage
-----
    python capture/capture.py                 # attach to the running Hub
    python capture/capture.py --spawn         # launch the Hub under Frida
    python capture/capture.py --seconds 120   # how long to record

While it runs, click Profile 1, 2, 3, 4 in the Attack Shark Hub, pausing about a
second between clicks. Every packet is printed live and appended to
capture/session.jsonl, then summarised by how many distinct payloads were seen.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter

try:
    import frida
except ImportError:
    sys.exit("frida is not installed. Run: python -m pip install frida")

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_EXE = (r"C:\Program Files (x86)\ATTACK  SHARK MOUSE HUB"
           r"\ATTACK  SHARK MOUSE HUB\ATTACK  SHARK MOUSE HUB.exe")
HUB_NAMES = ("ATTACK  SHARK MOUSE HUB.exe", "iot_driver_v215.exe", "ATK HUB.exe")

packets: list[dict] = []


def find_pid(name_filter: str | None) -> int:
    """Locate the vendor app's PID, preferring the Qt Hub."""
    import psutil

    candidates = []
    for proc in psutil.process_iter(["pid", "name"]):
        pname = proc.info["name"] or ""
        if name_filter:
            if name_filter.lower() in pname.lower():
                candidates.append((pname, proc.info["pid"]))
        elif pname in HUB_NAMES:
            candidates.append((pname, proc.info["pid"]))
    if not candidates:
        sys.exit("No vendor app running. Open the Attack Shark Hub first, "
                 "or pass --spawn.")
    # Prefer the Qt Hub, which is the app that manages the V8.
    candidates.sort(key=lambda c: HUB_NAMES.index(c[0]) if c[0] in HUB_NAMES else 99)
    print(f"[*] attaching to {candidates[0][0]} (pid {candidates[0][1]})")
    return candidates[0][1]


def on_message(message: dict, _data) -> None:
    if message.get("type") == "error":
        print(f"[!] {message.get('description', message)}")
        return
    payload = message.get("payload") or {}
    kind = payload.get("type")

    if kind == "ready":
        print("[*] hooks installed - now click Profile 1, 2, 3, 4 in the Hub")
        return
    if kind == "open":
        print(f"[open] {payload['path']}")
        return
    if kind == "dll":
        phase = payload.get("phase", "")
        if phase == "leave":
            extra = f" -> ret={payload.get('ret')} buf={payload.get('buf')}"
            print(f"[dll<] {payload['name']}{extra}")
        else:
            print(f"[dll>] {payload['name']}({', '.join(payload.get('args', []))})")
        packets.append({"t": time.time(), **payload})
        return

    payload["t"] = time.time()
    packets.append(payload)
    path = payload.get("path", "")
    col = ""
    low = path.lower()
    if "col" in low:
        col = "col" + low.split("col")[1][:2]
    print(f"[{kind:>10}] {col:<6} len={payload.get('len'):<4} {payload.get('hex')}")


def summarise() -> None:
    print("\n" + "=" * 72)
    print("SUMMARY - distinct payloads per direction/collection")
    print("=" * 72)
    counts: Counter = Counter()
    for pkt in packets:
        if "hex" not in pkt:
            continue
        low = pkt.get("path", "").lower()
        col = "col" + low.split("col")[1][:2] if "col" in low else "?"
        counts[(pkt["type"], col, pkt["hex"])] += 1
    for (kind, col, hexs), n in counts.most_common():
        print(f"  {n:>3}x [{kind:>10}] {col:<6} {hexs}")

    out = os.path.join(HERE, "session.jsonl")
    with open(out, "w", encoding="utf-8") as handle:
        for pkt in packets:
            handle.write(json.dumps(pkt) + "\n")
    print(f"\n[*] {len(packets)} records written to {out}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spawn", action="store_true",
                        help="launch the Hub under Frida instead of attaching")
    parser.add_argument("--seconds", type=int, default=90,
                        help="recording duration (default 90)")
    parser.add_argument("--process", help="substring of the process name to attach to")
    args = parser.parse_args()

    with open(os.path.join(HERE, "hook.js"), encoding="utf-8") as handle:
        source = handle.read()

    if args.spawn:
        print(f"[*] spawning {HUB_EXE}")
        pid = frida.spawn([HUB_EXE])
        session = frida.attach(pid)
    else:
        pid = find_pid(args.process)
        session = frida.attach(pid)

    script = session.create_script(source)
    script.on("message", on_message)
    script.load()

    if args.spawn:
        frida.resume(pid)

    print(f"[*] recording for {args.seconds}s ...")
    try:
        time.sleep(args.seconds)
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
