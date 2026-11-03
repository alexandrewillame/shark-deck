"""Read-only probe of the V8's vendor HID collections.

Sends no writes. Attempts HidD_GetFeature across candidate report IDs on every
vendor-defined collection that advertises feature support, so the device's own
report structure can be inspected without risking a write to its flash.
"""

import sys
import os

# winhid.py lives with the legacy Python switcher, not next to this file.
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_REPO, "legacy", "attack-shark-profile-switcher"))

from winhid import HidDevice, HidError, enumerate_hid  # noqa: E402

# Default target is the V8 mouse; pass "kb" to probe the R85HE keyboard instead.
if len(sys.argv) > 1 and sys.argv[1].lower() in ("kb", "keyboard", "r85he"):
    VID, PID = 0x3151, 0x5029
else:
    VID, PID = 0x3554, 0xF517


def main() -> None:
    devices = enumerate_hid(VID, PID)
    if not devices:
        print("No VID_3554/PID_F517 interface found - is the dongle plugged in?")
        return

    for info in devices:
        if info.feature_len == 0:
            continue
        print(f"\n=== {info.describe()}")
        print(f"    {info.path}")
        try:
            dev = HidDevice(info)
        except HidError as exc:
            print(f"    cannot open: {exc}")
            continue
        with dev:
            for report_id in range(0, 9):
                try:
                    data = dev.get_feature(report_id)
                except HidError as exc:
                    print(f"    id 0x{report_id:02X}: {exc}")
                    continue
                print(f"    id 0x{report_id:02X}: {data.hex(' ')}")


if __name__ == "__main__":
    main()
