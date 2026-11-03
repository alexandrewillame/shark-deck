/*
 * Frida agent: records the HID traffic the Attack Shark Hub sends to the mouse.
 *
 * Hooks CreateFileW to build a handle -> device-path map, then reports every
 * feature/output report written through HidD_SetFeature, WriteFile or
 * DeviceIoControl, filtered to the target device. Also logs the integer
 * arguments of the vendor DLL's profile entry point, which gives a fallback
 * path if raw replay turns out to need extra setup.
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

var MATCH = 'vid_3554';          // only report traffic to this device
var handles = {};                // handle (as string) -> device path

function key(ptr) {
    return ptr.toString();
}

/*
 * The Hub opens its HID handles at startup, so when we attach to an already
 * running instance the CreateFileW hook never sees them. NtQueryObject recovers
 * the kernel object name (\Device\HID#VID_3554...) for any such handle, which
 * keeps us from having to restart the app to identify a collection.
 */
var ntQueryObject = null;
var ntQueryObjectPtr = exportByName('ntdll.dll', 'NtQueryObject');
if (ntQueryObjectPtr !== null) {
    ntQueryObject = new NativeFunction(
        ntQueryObjectPtr, 'int', ['pointer', 'int', 'pointer', 'ulong', 'pointer']);
}

function queryObjectName(handle) {
    if (ntQueryObject === null) return null;
    try {
        var size = 2048;
        var buf = Memory.alloc(size);
        var retLen = Memory.alloc(8);
        if (ntQueryObject(handle, 1, buf, size, retLen) !== 0) return null;  // ObjectNameInformation
        var len = buf.readU16();
        if (len === 0) return null;
        return buf.add(Process.pointerSize).readPointer().readUtf16String(len / 2);
    } catch (e) {
        return null;
    }
}

/*
 * `resolve` is only set for the HidD_ and DeviceIoControl hooks, whose handles are
 * always device handles. NtQueryObject(ObjectNameInformation) can block on
 * synchronous named-pipe handles, and a Qt app has plenty of those, so generic
 * ReadFile/WriteFile handles are never queried - use --spawn to name those.
 */
function pathFor(handle, resolve) {
    var k = key(handle);
    if (!(k in handles) && resolve) {
        handles[k] = queryObjectName(handle);   // cached, including null misses
    }
    var found = handles[k];
    return (found === null || found === undefined) ? undefined : found;
}

function dump(tag, handle, buf, len, resolve) {
    var path = pathFor(handle, resolve);
    if (path === undefined) {
        // Handle opened before we attached. Report it anyway, unidentified,
        // rather than silently dropping a possibly relevant packet.
        path = '<unknown handle ' + handle + '>';
    } else if (path.toLowerCase().indexOf(MATCH) === -1) {
        return;
    }
    if (len <= 0 || len > 512) return;
    var bytes = new Uint8Array(buf.readByteArray(len));
    var hex = [];
    for (var i = 0; i < bytes.length; i++) {
        hex.push(('0' + bytes[i].toString(16)).slice(-2));
    }
    send({ type: tag, path: path, len: len, hex: hex.join(' ') });
}

// --- handle -> path ---------------------------------------------------------

var createFileW = exportByName('kernel32.dll', 'CreateFileW');
if (createFileW !== null) {
    Interceptor.attach(createFileW, {
        onEnter: function (args) {
            try {
                this.path = args[0].readUtf16String();
            } catch (e) {
                this.path = null;
            }
        },
        onLeave: function (retval) {
            if (this.path && retval.toInt32() !== -1) {
                handles[key(retval)] = this.path;
                if (this.path.toLowerCase().indexOf(MATCH) !== -1) {
                    send({ type: 'open', path: this.path, handle: retval.toString() });
                }
            }
        }
    });
}

// --- feature reports --------------------------------------------------------

['HidD_SetFeature', 'HidD_GetFeature'].forEach(function (name) {
    var fn = exportByName('hid.dll', name);
    if (fn === null) return;
    Interceptor.attach(fn, {
        onEnter: function (args) {
            this.handle = args[0];
            this.buf = args[1];
            this.len = args[2].toInt32();
            if (name === 'HidD_SetFeature') {
                dump('setfeature', this.handle, this.buf, this.len, true);
            }
        },
        onLeave: function () {
            if (name === 'HidD_GetFeature') {
                dump('getfeature', this.handle, this.buf, this.len, true);
            }
        }
    });
});

// --- output reports ---------------------------------------------------------

var writeFile = exportByName('kernel32.dll', 'WriteFile');
if (writeFile !== null) {
    Interceptor.attach(writeFile, {
        onEnter: function (args) {
            dump('write', args[0], args[1], args[2].toInt32());
        }
    });
}

var readFile = exportByName('kernel32.dll', 'ReadFile');
if (readFile !== null) {
    Interceptor.attach(readFile, {
        onEnter: function (args) {
            this.handle = args[0];
            this.buf = args[1];
            this.len = args[2].toInt32();
        },
        onLeave: function () {
            dump('read', this.handle, this.buf, this.len);
        }
    });
}

// Catches anything that bypasses the wrappers above.
var deviceIoControl = exportByName('kernel32.dll', 'DeviceIoControl');
if (deviceIoControl !== null) {
    Interceptor.attach(deviceIoControl, {
        onEnter: function (args) {
            var code = args[1].toInt32() >>> 0;
            if (((code >>> 16) & 0xffff) !== 0x000b) return;   // HID device type
            this.code = code;
            dump('ioctl_in_' + code.toString(16), args[0], args[2], args[3].toInt32(), true);
            this.handle = args[0];
            this.out = args[4];
            this.outLen = args[5].toInt32();
        },
        onLeave: function () {
            if (this.code === undefined) return;
            dump('ioctl_out_' + this.code.toString(16), this.handle, this.out,
                 this.outLen, true);
        }
    });
}

// --- vendor DLL entry points ------------------------------------------------
//
// HIDUsb.dll exports a clean named C API for every setting SharkDeck cares
// about. Hooking the whole SET/GET surface here and reading back the buffers
// its calls produce (via the WriteFile / DeviceIoControl hooks above) turns the
// mouse block map from `inferred` into a capture — see CAPTURE-MOUSE.md.

var HIDUSB_FNS = [
    // config blocks
    'CS_UsbServer_ReadConfig', 'CS_UsbServer_SetCurrentConfig',
    'CS_UsbServer_ReadAllFlashData', 'CS_UsbServer_SetClearSetting',
    // DPI / poll rate
    'CS_UsbServer_ReadCurrentDPI', 'CS_UsbServer_ReadReportRate',
    // LEDs — the ones this pass is about
    'CS_UsbServer_ReadDPILed', 'CS_UsbServer_ReadLedBar',
    'CS_UsbFinder_GetDongleIndicatorLed', 'CS_UsbFinder_SetDongleIndicatorLed',
    'CS_UsbFinder_GetDongleRGBBarMode', 'CS_UsbFinder_SetDongleRGBBarMode',
    'CS_UsbFinder_Get4KDongleRGBValue', 'CS_UsbFinder_Set4KDongleRGB',
    // firmware — device vs receiver ("slave")
    'CS_UsbFinder_GetVersion', 'CS_UsbFinder_GetSlaveVersion',
    'CS_UsbServer_ReadVersion', 'CS_UsbServer_GetSlaveVersion',
    // long-range / battery / misc writes
    'CS_UsbFinder_SetLongRangeMode', 'CS_UsbFinder_GetLongRangeMode',
    'CS_UsbFinder_SetData', 'CS_UsbFinder_SetCommand',
    'CS_UsbFinder_WriteDeviceData', 'CS_UsbFinder_ReadWriteDeviceData',
];

HIDUSB_FNS.forEach(function (name) {
    var fn = exportByName('HIDUsb.dll', name);
    if (fn === null) return;
    Interceptor.attach(fn, {
        onEnter: function (args) {
            this.name = name;
            this.a = [args[0], args[1], args[2], args[3], args[4], args[5]];
            send({
                type: 'dll',
                name: name,
                phase: 'enter',
                args: this.a.map(function (p) { return p.toString(); })
            });
        },
        onLeave: function (retval) {
            // Try to surface a small return buffer (arg1 is usually the out ptr).
            var hex = null;
            try {
                var b = new Uint8Array(this.a[1].readByteArray(32));
                hex = [];
                for (var i = 0; i < b.length; i++) hex.push(('0' + b[i].toString(16)).slice(-2));
                hex = hex.join(' ');
            } catch (e) { /* not a readable buffer */ }
            send({ type: 'dll', name: this.name, phase: 'leave', ret: retval.toString(), buf: hex });
        }
    });
});

send({ type: 'ready' });
