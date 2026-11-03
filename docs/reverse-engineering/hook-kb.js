/*
 * Frida agent: records the HID feature traffic iot_driver_v215.exe exchanges
 * with the Attack Shark R85HE.
 *
 * Confirmed by diagnostic (2026-08-30): Driver v4's Electron renderer does NOT
 * do WebHID for this keyboard (`navigator.hid.getDevices()` is empty). The
 * config I/O runs in **iot_driver_v215.exe** via `HidD_SetFeature` and
 * `DeviceIoControl(IOCTL_HID_SET_FEATURE=0xb0191 / IOCTL_HID_GET_FEATURE=
 * 0xb0192 / IOCTL_HID_GET_INPUT_REPORT=0xb01a2)` on the MI_02 collection. That
 * handle resolves only to `\Device\NNNNN`, so we do NOT filter by device path —
 * we filter by frame shape: a feature report is `00 <cmd> …` (report id 0 then
 * a command byte in the FEA_CMD range). During an R85HE-only Driver v4 session
 * that is exactly the traffic we want.
 *
 * Frame (verified against these captures): `[00, cmd, p0..p5, checksum@8, …]`
 * for short commands — checksum at byte 8, `sum(bytes[1..64]) & 0xFF == 0xFF`.
 * Replies come back on the `0xb0192` / `HidD_GetFeature` OUT buffer, data from
 * byte 2.
 */

'use strict';

/*
 * Frida 17 removed the static module-lookup helpers — `Module.findExportByName`,
 * `Module.enumerateExports` and `Module.findBaseAddress` are all `undefined`
 * there, and lookups moved onto per-module objects. This agent used the static
 * form on its first top-level statement, so on a modern frida the whole script
 * threw at load time: zero hooks installed, zero records written, and a run
 * that walked through every step and produced an EMPTY session file.
 *
 * Resolve exports through this instead. It works on both API generations, and
 * loads the module if the process has not mapped it yet (hid.dll in particular
 * may not be loaded when the agent attaches).
 */
function exportByName(moduleName, exportName) {
  try {
    if (typeof Module.findExportByName === 'function') {
      return Module.findExportByName(moduleName, exportName); // frida <= 16
    }
    var m = Process.findModuleByName(moduleName);
    if (!m) { try { m = Module.load(moduleName); } catch (e) { m = null; } }
    return m ? m.findExportByName(exportName) : null;
  } catch (e) {
    return null;
  }
}

// command bytes we expect on the R85HE vendor channel (5e635fe2 generation);
// used only to tell a real feature frame from noise, not to gate capture hard.
var CMD_MIN = 1;
var CMD_MAX = 0xf0;

var nq = null;
var p = exportByName('ntdll.dll', 'NtQueryObject');
if (p !== null) nq = new NativeFunction(p, 'int', ['pointer', 'int', 'pointer', 'ulong', 'pointer']);
var names = {};
function pathOf(h) {
    var k = h.toString();
    if (k in names) return names[k];
    var r = null;
    if (nq !== null) {
        try {
            var b = Memory.alloc(2048),
                rl = Memory.alloc(8);
            if (nq(h, 1, b, 2048, rl) === 0) {
                var l = b.readU16();
                if (l) r = b.add(Process.pointerSize).readPointer().readUtf16String(l / 2);
            }
        } catch (e) {
            /* ignore */
        }
    }
    names[k] = r;
    return r;
}

function hexOf(buf, len) {
    if (len <= 0 || len > 512) return null;
    var a = new Uint8Array(buf.readByteArray(len));
    var s = [];
    for (var i = 0; i < a.length; i++) s.push(('0' + a[i].toString(16)).slice(-2));
    return { hex: s.join(' '), b0: a[0], b1: a[1], allZero: a.every(function (x) { return x === 0; }) };
}

// A feature frame: report id 0, byte 1 a plausible command, not all-zero.
function isFrame(h) {
    return h && !h.allZero && h.b0 === 0x00 && h.b1 >= CMD_MIN && h.b1 <= CMD_MAX;
}

var lastKey = '';
function emit(tag, h, buf, len) {
    var d = hexOf(buf, len);
    if (!isFrame(d)) return;
    var k = tag[0] + d.hex;
    if (k === lastKey) return; // collapse the exact-repeat connect-time GET spam
    lastKey = k;
    send({ type: tag, path: pathOf(h) || '?', len: len, hex: d.hex });
}

// --- HidD_SetFeature / HidD_GetFeature -----------------------------------
['HidD_SetFeature', 'HidD_GetFeature', 'HidD_GetInputReport'].forEach(function (name) {
    var fn = exportByName('hid.dll', name);
    if (fn === null) return;
    Interceptor.attach(fn, {
        onEnter: function (a) {
            this.name = name;
            this.h = a[0];
            this.b = a[1];
            this.l = a[2].toInt32();
            if (name === 'HidD_SetFeature') emit('setfeature', this.h, this.b, this.l);
        },
        onLeave: function () {
            if (this.name === 'HidD_GetFeature') emit('getfeature', this.h, this.b, this.l);
            else if (this.name === 'HidD_GetInputReport') emit('getinput', this.h, this.b, this.l);
        },
    });
});

// --- IOCTL_HID_SET_FEATURE / GET_FEATURE / GET_INPUT_REPORT ------------
// hidapi's HidD_SetFeature already issues 0xb0191, so the SET is usually a dup
// of the HidD_ hook above — `emit`'s repeat-collapse drops it. The GET reply is
// the OUT buffer of 0xb0192 (the IN buffer is an empty query).
var IOCTL = { b0191: 'setfeature', b0192: 'getfeature', b01a2: 'getinput' };
var dio = exportByName('kernel32.dll', 'DeviceIoControl');
if (dio !== null) {
    Interceptor.attach(dio, {
        onEnter: function (a) {
            var code = (a[1].toInt32() >>> 0).toString(16);
            this.tag = IOCTL[code];
            if (!this.tag) return;
            this.h = a[0];
            this.out = a[4];
            this.outLen = a[5].toInt32();
            if (this.tag === 'setfeature') emit('setfeature', this.h, a[2], a[3].toInt32());
        },
        onLeave: function () {
            if (!this.tag) return;
            if (this.tag !== 'setfeature') emit(this.tag, this.h, this.out, this.outLen);
        },
    });
}

// (hidapi named exports are not hooked — HidD_SetFeature / the 0xb019x IOCTLs
// already carry the same frames; hooking hidapi too just double-reports.)

send({ type: 'ready' });
