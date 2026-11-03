"""Diagnostic: find out HOW Driver v4 / iot_driver actually talks to the R85HE.

The step-driven capture (capture-kb.py) recorded zero protocol frames — only
handle-enumeration opens — so the real HID I/O is going out a path the capture
hook missed or filtered. This script hooks EVERYTHING with no MATCH filter and
resolves every handle by kernel object name, so whatever iot_driver does shows
up raw.

Run it, then change ONE setting in Driver v4 (e.g. polling rate 125 -> 8000).
Ctrl+C when you've seen some lines. It also writes diag-kb.jsonl.

    python diag-kb.py                 # attach to iot_driver
    python diag-kb.py --process ATK   # or another owner
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

try:
    import frida
    import psutil
except ImportError:
    sys.exit("need: python -m pip install frida psutil")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "diag-kb.jsonl")
OWNER_NAMES = ("iot_driver_v215.exe", "iot_driver.exe", "iot_driver_v217.exe")

AGENT = r"""
'use strict';
var nq = null, p = Module.findExportByName('ntdll.dll', 'NtQueryObject');
if (p) nq = new NativeFunction(p, 'int', ['pointer','int','pointer','ulong','pointer']);
var names = {};
function name(h) {
  var k = h.toString();
  if (k in names) return names[k];
  var r = null;
  if (nq) { try {
    var b = Memory.alloc(2048), rl = Memory.alloc(8);
    if (nq(h, 1, b, 2048, rl) === 0) { var l = b.readU16(); if (l) r = b.add(Process.pointerSize).readPointer().readUtf16String(l/2); }
  } catch (e) {} }
  names[k] = r; return r;
}
function hex(buf, len) {
  if (len <= 0 || len > 512) return null;
  var a = new Uint8Array(buf.readByteArray(len)), s = [];
  for (var i = 0; i < a.length; i++) s.push(('0'+a[i].toString(16)).slice(-2));
  return s.join(' ');
}
function rep(tag, h, buf, len) {
  var n = name(h);
  send({ tag: tag, handle: h.toString(), path: n, hex: hex(buf, len), len: len });
}

['WriteFile','ReadFile'].forEach(function (fn) {
  var f = Module.findExportByName('kernel32.dll', fn);
  if (!f) return;
  Interceptor.attach(f, {
    onEnter: function (a) { this.h = a[0]; this.b = a[1]; this.l = a[2].toInt32(); if (fn === 'WriteFile') rep('WriteFile', this.h, this.b, this.l); },
    onLeave: function () { if (fn === 'ReadFile') rep('ReadFile', this.h, this.b, this.l); },
  });
});

var dio = Module.findExportByName('kernel32.dll', 'DeviceIoControl');
if (dio) Interceptor.attach(dio, {
  onEnter: function (a) {
    var code = a[1].toInt32() >>> 0;
    this.code = code; this.h = a[0]; this.in = a[2]; this.inl = a[3].toInt32();
    this.out = a[4]; this.outl = a[5].toInt32();
    rep('ioctl_in_' + code.toString(16), this.h, this.in, this.inl);
  },
  onLeave: function () { if (this.code === undefined) return; rep('ioctl_out_' + this.code.toString(16), this.h, this.out, this.outl); },
});

['HidD_SetFeature','HidD_GetFeature','HidD_GetInputReport','HidD_SetOutputReport'].forEach(function (nm) {
  var f = Module.findExportByName('hid.dll', nm);
  if (!f) { send({ tag: 'note', path: nm + ' not found in hid.dll' }); return; }
  Interceptor.attach(f, {
    onEnter: function (a) { this.nm = nm; this.h = a[0]; this.b = a[1]; this.l = a[2].toInt32();
      if (nm.indexOf('Set') !== -1) rep(nm, this.h, this.b, this.l); },
    onLeave: function () { if (this.nm.indexOf('Get') !== -1) rep(this.nm, this.h, this.b, this.l); },
  });
});

['hid_write','hid_send_feature_report','hid_get_feature_report','hid_read','hid_read_timeout'].forEach(function (nm) {
  var f = Module.findExportByName(null, nm);
  if (!f) return;
  Interceptor.attach(f, {
    onEnter: function (a) { this.nm = nm; this.b = a[1]; this.l = a[2].toInt32();
      if (nm === 'hid_write' || nm === 'hid_send_feature_report') send({ tag: nm, hex: hex(this.b, this.l), len: this.l }); },
    onLeave: function (rv) { if (this.nm.indexOf('read') === -1 && this.nm !== 'hid_get_feature_report') return;
      var n = rv.toInt32(); if (n > 0 && n <= 512) send({ tag: this.nm, hex: hex(this.b, n), len: n }); },
  });
});

send({ tag: 'ready' });
"""


def find_pid(nf):
    for pr in psutil.process_iter(["pid", "name"]):
        nm = pr.info["name"] or ""
        if (nf and nf.lower() in nm.lower()) or (not nf and nm in OWNER_NAMES):
            print(f"[*] attaching to {nm} (pid {pr.info['pid']})")
            return pr.info["pid"]
    sys.exit("no iot_driver process — open the Driver v4 window first, or pass --process")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--process")
    a = ap.parse_args()
    recs = []

    def on_msg(m, _d):
        if m.get("type") == "error":
            print("[!]", m.get("description"))
            return
        p = m.get("payload") or {}
        if p.get("tag") == "ready":
            print("[*] hooks in. NOW change one setting in Driver v4 (e.g. poll rate). Ctrl+C when done.\n")
            return
        if p.get("tag") == "note":
            print("[note]", p.get("path"))
            return
        p["t"] = time.time()
        recs.append(p)
        path = p.get("path") or ""
        # highlight anything that touches the keyboard
        kb = "vid_3151" in path.lower() or "3151" in path
        mark = " <<< R85HE" if kb else ""
        print(f"  [{p.get('tag'):>22}] path={path or '?'} len={p.get('len')}{mark}")
        if p.get("hex"):
            print(f"       {p['hex']}")

    sess = frida.attach(find_pid(a.process))
    s = sess.create_script(AGENT)
    s.on("message", on_msg)
    s.load()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            sess.detach()
        except Exception:
            pass
        with open(OUT, "w", encoding="utf-8") as fh:
            for r in recs:
                fh.write(json.dumps(r) + "\n")
        kb = [r for r in recs if "3151" in (r.get("path") or "")]
        print(f"\n[*] {len(recs)} records ({len(kb)} touching the R85HE) -> {OUT}")
        seen = sorted({r["tag"] for r in recs})
        print("[*] API surfaces seen:", ", ".join(seen))


if __name__ == "__main__":
    main()
