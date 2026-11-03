"""Turn session-v8.jsonl (from capture-mouse.py) into a candidate V8 protocol map.

For each capture step it prints, in wire order:
  * the vendor DLL calls (CS_UsbServer_* / CS_UsbFinder_*) that fired,
  * every host->device write frame, decoded (command, offset/len for 0x08/0x09),
  * every device->host reply frame paired to it by sequence.

Then it builds two cross-cut views:
  * COMMAND MAP   — each 0x08 command byte, the steps it appeared in, and the
                    distinct reply payloads seen.
  * SETTING MAP   — each 0x07 write: offset, bytes written, and which step /
                    which DLL call produced it → "this offset is <setting>".
  * REGION-A DIFF — the per-profile config block (0x0000..0x00d8) rebuilt from
                    the 0x08 read replies, one column per step that changed it,
                    so a one-setting-at-a-time step reveals exactly one byte.

    python analyze-v8.py [session-v8.jsonl]

Read-only; writes nothing. Pipe to a file if you want to keep the report.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict, OrderedDict

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PATH = sys.argv[1] if len(sys.argv) > 1 else "session-v8.jsonl"

WRITE_TYPES = {"write", "setfeature"}
READ_TYPES = {"read", "overlapped_read", "readex", "getinput", "getfeature", "ioctl_out_b01a8"}

CMD_NAME = {
    0x01: "HANDSHAKE", 0x02: "GET_VERSION", 0x03: "STATUS", 0x04: "BATTERY",
    0x05: "PAIR_ENTER", 0x06: "PAIR_STATUS",
    0x07: "WRITE_SETTING", 0x08: "READ_SETTING", 0x09: "RESTORE_DEFAULTS",
    0x0E: "GET_PROFILE", 0x0F: "SET_PROFILE",
    0x16: "LONG_RANGE", 0x2C: "RX_LED",
}

# The real write command is 0x07 (offset16-BE, len, then value+companion byte).
# 0x09 with zero args is factory-restore. See FINDINGS.md.
WRITE_SETTING_CMD = 0x07


def bytes_of(hexstr: str) -> list[int]:
    return [int(x, 16) for x in hexstr.split()]


def decode(frame: list[int]) -> str:
    if len(frame) < 2 or frame[0] != 0x08:
        return "(not an 0x08 frame)"
    cmd = frame[1]
    name = CMD_NAME.get(cmd, f"0x{cmd:02x}")
    if cmd in (0x07, 0x08, 0x09) and len(frame) >= 6:
        off = (frame[3] << 8) | frame[4]
        ln = frame[5]
        payload = " ".join(f"{b:02x}" for b in frame[6:6 + ln])
        return f"{name} off=0x{off:04x} len={ln}" + (f"  [{payload}]" if payload.strip("0 ") else "")
    if cmd == 0x0F and len(frame) >= 7:
        return f"{name} -> profile {frame[6] + 1}"
    body = " ".join(f"{b:02x}" for b in frame[2:6])
    return f"{name}  args=[{body}]"


def main() -> None:
    try:
        recs = [json.loads(l) for l in open(PATH, encoding="utf-8")]
    except FileNotFoundError:
        sys.exit(f"{PATH} not found — run capture-mouse.py first.")

    recs.sort(key=lambda r: r.get("seq", 0))

    # ---- per-step timeline ------------------------------------------------
    by_step: "OrderedDict[str, list]" = OrderedDict()
    for r in recs:
        by_step.setdefault(r.get("step", "?"), []).append(r)

    cmd_replies: dict[int, set] = defaultdict(set)
    cmd_steps: dict[int, set] = defaultdict(set)
    writes_09: list[tuple] = []          # (step, offset, payload_hex, dll_context)
    regionA_by_step: "OrderedDict[str, dict]" = OrderedDict()

    print("=" * 78)
    print(f"TIMELINE  ({PATH}, {len(recs)} records, {len(by_step)} steps)")
    print("=" * 78)

    for step, rs in by_step.items():
        dll_here = [r["name"] for r in rs if r.get("type") == "dll" and r.get("phase") == "enter"]
        frames = [(r, bytes_of(r["hex"])) for r in rs if "hex" in r and r["type"] in WRITE_TYPES | READ_TYPES]
        if not dll_here and not frames:
            continue
        print(f"\n--- {step} ---")
        for name in dict.fromkeys(dll_here):
            print(f"    DLL  {name}")
        last_dll = dll_here[-1] if dll_here else ""
        regionA: dict[int, int] = {}
        for r, fr in frames:
            if len(fr) < 2 or fr[0] != 0x08:
                continue
            arrow = "->" if r["type"] in WRITE_TYPES else "<-"
            print(f"    {arrow} {r['type']:>15} seq={r.get('seq'):<5} {decode(fr)}")
            cmd = fr[1]
            if r["type"] in READ_TYPES:
                cmd_replies[cmd].add(r["hex"])
            else:
                cmd_steps[cmd].add(step)
            if cmd == WRITE_SETTING_CMD and len(fr) >= 6:
                off = (fr[3] << 8) | fr[4]
                ln = fr[5]
                writes_09.append((step, off, " ".join(f"{b:02x}" for b in fr[6:6 + ln]), last_dll))
            if cmd == 0x08 and r["type"] in READ_TYPES and len(fr) >= 6:
                off = (fr[3] << 8) | fr[4]
                ln = fr[5]
                if off < 0x0100:
                    for i in range(ln):
                        if 6 + i < len(fr):
                            regionA[off + i] = fr[6 + i]
        if regionA:
            regionA_by_step[step] = regionA

    # ---- command map ----------------------------------------------------
    print("\n" + "=" * 78)
    print("COMMAND MAP — 0x08 command bytes seen, their steps and distinct replies")
    print("=" * 78)
    for cmd in sorted(set(cmd_replies) | set(cmd_steps)):
        name = CMD_NAME.get(cmd, f"0x{cmd:02x}")
        print(f"\n  {name} (0x{cmd:02x})")
        if cmd_steps.get(cmd):
            steps = sorted(cmd_steps[cmd])
            print(f"    written in ({len(steps)}): {', '.join(steps)}")
        for rep in sorted(cmd_replies.get(cmd, [])):
            print(f"    reply: {rep}")

    # ---- block-write map ----------------------------------------------
    print("\n" + "=" * 78)
    print("SETTING-WRITE MAP — every 0x07 write (offset <- bytes), by step / DLL call")
    print("=" * 78)
    if not writes_09:
        print("  (no 0x07 writes captured)")
    for step, off, payload, dll in writes_09:
        print(f"  0x{off:04x} <- [{payload}]   {step}   {dll}")

    # ---- region-A per-step diff -------------------------------------
    print("\n" + "=" * 78)
    print("REGION-A DIFF — config-block bytes that changed between consecutive steps")
    print("=" * 78)
    prev: dict[int, int] = {}
    prev_step = None
    for step, m in regionA_by_step.items():
        if prev:
            diffs = sorted((o, prev.get(o), v) for o, v in m.items() if prev.get(o) != v and o in prev)
            if diffs:
                print(f"\n  {prev_step}  ->  {step}")
                for o, a, b in diffs:
                    print(f"    0x{o:04x}: {a:02x} -> {b:02x}")
        prev = {**prev, **m}
        prev_step = step

    print("\n[done]")


if __name__ == "__main__":
    main()
