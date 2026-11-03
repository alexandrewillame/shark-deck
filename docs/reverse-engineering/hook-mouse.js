/*
 * Frida agent — records the HID traffic the ATTACK SHARK MOUSE HUB exchanges
 * with the V8 (3554:F517), REPLIES INCLUDED.
 *
 * This is the successor to hook.js. hook.js dumped every ReadFile buffer in its
 * onLeave, which for the Hub's OVERLAPPED (asynchronous) reads runs *before* the
 * driver has filled the buffer — so the 2026-08-13 capture recorded 443 writes
 * and zero block-read replies. Changes here:
 *
 *   1. Overlapped-aware reads. A ReadFile / DeviceIoControl that returns FALSE
 *      with ERROR_IO_PENDING is stashed by its OVERLAPPED* and dumped when
 *      GetOverlappedResult / GetOverlappedResultEx reports it complete. Also
 *      hooks ReadFileEx (APC completion) and HidD_GetInputReport.
 *   2. Whole vendor DLL surface. Instead of a hand-maintained 24-name list,
 *      every HIDUsb.dll export matching /^CS_Usb(Server|Finder)_/ is hooked and
 *      its pointer args hexdumped on enter and leave — this is what maps each
 *      Hub UI control to the frame it produces.
 *   3. Monotonic `seq` on every record, so a reply pairs to its request by
 *      sequence rather than wall-clock guesswork.
 *
 * Output records (consumed by capture-mouse.py -> session-v8.jsonl):
 *   { type, seq, t?, path?, len, hex, phase?, name?, args?, ret?, err? }
 *   type ∈ open | write | read | ioctl_in_<code> | ioctl_out_<code> |
 *          overlapped_read | readex | getinput | dll | ready
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

var MATCH = 'vid_3554';        // only report traffic to this device
var ERROR_IO_PENDING = 997;
var handles = {};              // handle string -> device path
var pending = {};              // OVERLAPPED* string -> { handle, buf, reqLen, tag }
var seq = 0;

function key(ptr) { return ptr.toString(); }
function nextSeq() { return ++seq; }

// --- handle -> path -------------------------------------------------------

var ntQueryObjectPtr = exportByName('ntdll.dll', 'NtQueryObject');
var ntQueryObject = ntQueryObjectPtr &&
  new NativeFunction(ntQueryObjectPtr, 'int', ['pointer', 'int', 'pointer', 'ulong', 'pointer']);

function queryObjectName(handle) {
  if (!ntQueryObject) return null;
  try {
    var size = 2048;
    var buf = Memory.alloc(size);
    var retLen = Memory.alloc(8);
    if (ntQueryObject(handle, 1, buf, size, retLen) !== 0) return null; // ObjectNameInformation
    var len = buf.readU16();
    if (len === 0) return null;
    return buf.add(Process.pointerSize).readPointer().readUtf16String(len / 2);
  } catch (e) { return null; }
}

function pathFor(handle, resolve) {
  var k = key(handle);
  if (!(k in handles) && resolve) handles[k] = queryObjectName(handle);
  var found = handles[k];
  return (found === null || found === undefined) ? undefined : found;
}

/** true if this handle is (or might be) our target device. */
function isTarget(handle, resolve) {
  var path = pathFor(handle, resolve);
  if (path === undefined) return true;              // opened before attach — keep it, tag unknown
  return path.toLowerCase().indexOf(MATCH) !== -1;
}

function toHex(buf, len) {
  var bytes = new Uint8Array(buf.readByteArray(len));
  var out = [];
  for (var i = 0; i < bytes.length; i++) out.push(('0' + bytes[i].toString(16)).slice(-2));
  return out.join(' ');
}

function dump(tag, handle, buf, len, resolve) {
  if (len <= 0 || len > 512) return;
  if (!isTarget(handle, resolve)) return;
  var path = pathFor(handle, resolve);
  send({
    type: tag,
    seq: nextSeq(),
    path: path === undefined ? ('<unknown handle ' + handle + '>') : path,
    len: len,
    hex: toHex(buf, len),
  });
}

var createFileW = exportByName('kernel32.dll', 'CreateFileW');
if (createFileW) {
  Interceptor.attach(createFileW, {
    onEnter: function (args) { try { this.path = args[0].readUtf16String(); } catch (e) { this.path = null; } },
    onLeave: function (retval) {
      if (this.path && retval.toInt32() !== -1) {
        handles[key(retval)] = this.path;
        if (this.path.toLowerCase().indexOf(MATCH) !== -1) {
          send({ type: 'open', seq: nextSeq(), path: this.path, handle: retval.toString() });
        }
      }
    },
  });
}

// --- feature reports ----------------------------------------------------

['HidD_SetFeature', 'HidD_GetFeature'].forEach(function (name) {
  var fn = exportByName('hid.dll', name);
  if (!fn) return;
  Interceptor.attach(fn, {
    onEnter: function (args) {
      this.handle = args[0]; this.buf = args[1]; this.len = args[2].toInt32();
      if (name === 'HidD_SetFeature') dump('setfeature', this.handle, this.buf, this.len, true);
    },
    onLeave: function () {
      if (name === 'HidD_GetFeature') dump('getfeature', this.handle, this.buf, this.len, true);
    },
  });
});

var hidGetInput = exportByName('hid.dll', 'HidD_GetInputReport');
if (hidGetInput) {
  Interceptor.attach(hidGetInput, {
    onEnter: function (args) { this.handle = args[0]; this.buf = args[1]; this.len = args[2].toInt32(); },
    onLeave: function (retval) {
      if (retval.toInt32() !== 0) dump('getinput', this.handle, this.buf, this.len, true);
    },
  });
}

// --- output reports / synchronous + overlapped reads --------------------

var writeFile = exportByName('kernel32.dll', 'WriteFile');
if (writeFile) {
  Interceptor.attach(writeFile, {
    onEnter: function (args) { dump('write', args[0], args[1], args[2].toInt32()); },
  });
}

/*
 * ReadFile(hFile, lpBuffer, nToRead, lpNumberOfBytesRead, lpOverlapped)
 *  - synchronous handle: returns TRUE, buffer filled now  -> dump in onLeave
 *  - overlapped + completes inline: TRUE, dump in onLeave
 *  - overlapped + pending: FALSE, GetLastError()==ERROR_IO_PENDING
 *      -> stash by lpOverlapped, dump when GetOverlappedResult(Ex) says done
 */
var readFile = exportByName('kernel32.dll', 'ReadFile');
if (readFile) {
  Interceptor.attach(readFile, {
    onEnter: function (args) {
      this.handle = args[0];
      this.buf = args[1];
      this.reqLen = args[2].toInt32();
      this.pBytesRead = args[3];
      this.pOverlapped = args[4];
    },
    onLeave: function (retval) {
      var ok = retval.toInt32() !== 0;
      if (ok) {
        var n = this.reqLen;
        try { if (!this.pBytesRead.isNull()) n = this.pBytesRead.readU32(); } catch (e) {}
        dump('read', this.handle, this.buf, n);
        return;
      }
      var err = this._lastError !== undefined ? this._lastError : -1;
      // Frida exposes the post-call errno via this.lastError on Windows builds
      try { err = this.lastError; } catch (e) {}
      if (!this.pOverlapped.isNull()) {
        pending[key(this.pOverlapped)] = {
          overlappedPtr: this.pOverlapped,
          handle: this.handle, buf: this.buf, reqLen: this.reqLen,
          pBytesRead: this.pBytesRead, tag: 'overlapped_read',
        };
      }
    },
  });
}

var readFileEx = exportByName('kernel32.dll', 'ReadFileEx');
if (readFileEx) {
  Interceptor.attach(readFileEx, {
    onEnter: function (args) {
      this.handle = args[0]; this.buf = args[1]; this.reqLen = args[2].toInt32();
      this.pOverlapped = args[3];
    },
    onLeave: function () {
      if (!this.pOverlapped.isNull()) {
        pending[key(this.pOverlapped)] = {
          overlappedPtr: this.pOverlapped,
          handle: this.handle, buf: this.buf, reqLen: this.reqLen, pBytesRead: NULL, tag: 'readex',
        };
      }
    },
  });
}

var STATUS_PENDING = 0x103;

/*
 * OVERLAPPED layout: Internal (status, pointer-sized), InternalHigh (bytes
 * transferred, pointer-sized), then Offset/Pointer + hEvent. While the IO is in
 * flight Internal == STATUS_PENDING; on completion it becomes the final NTSTATUS
 * and InternalHigh holds the byte count. This lets us detect completion without
 * needing the app to call GetOverlappedResult.
 */
function overlappedDone(pOverlapped) {
  try {
    var internal = pOverlapped.readPointer().toInt32() >>> 0;
    return internal !== STATUS_PENDING;
  } catch (e) { return false; }
}

function completeOverlapped(pOverlapped, pBytesTransferred) {
  var rec = pending[key(pOverlapped)];
  if (!rec) return;
  delete pending[key(pOverlapped)];
  var n = rec.reqLen;
  try {
    if (pBytesTransferred && !pBytesTransferred.isNull()) n = pBytesTransferred.readU32();
    else if (rec.pBytesRead && !rec.pBytesRead.isNull()) n = rec.pBytesRead.readU32();
    else {
      // OVERLAPPED.InternalHigh holds the byte count on completion.
      n = pOverlapped.add(Process.pointerSize).readPointer().toInt32() || rec.reqLen;
    }
  } catch (e) {}
  if (!n || n <= 0) n = rec.reqLen;
  dump(rec.tag, rec.handle, rec.buf, n, true);
}

// Poll in-flight overlapped reads; dump each the moment its OVERLAPPED says the
// IO finished. This is the belt-and-braces that does not depend on the Hub
// calling GetOverlappedResult / draining an IOCP.
setInterval(function () {
  for (var k in pending) {
    if (!pending.hasOwnProperty(k)) continue;
    var rec = pending[k];
    if (overlappedDone(rec.overlappedPtr)) completeOverlapped(rec.overlappedPtr, NULL);
  }
}, 60);

['GetOverlappedResult', 'GetOverlappedResultEx'].forEach(function (name) {
  var fn = exportByName('kernel32.dll', name);
  if (!fn) return;
  Interceptor.attach(fn, {
    onEnter: function (args) { this.pOverlapped = args[1]; this.pBytes = args[2]; },
    onLeave: function (retval) {
      if (retval.toInt32() !== 0) completeOverlapped(this.pOverlapped, this.pBytes);
    },
  });
});

// Fallback: some stacks pump completions through GetQueuedCompletionStatus.
var gqcs = exportByName('kernel32.dll', 'GetQueuedCompletionStatus');
if (gqcs) {
  Interceptor.attach(gqcs, {
    onEnter: function (args) { this.pBytes = args[1]; this.pOverlapped = args[3]; },
    onLeave: function (retval) {
      if (retval.toInt32() !== 0) {
        try { completeOverlapped(this.pOverlapped.readPointer(), this.pBytes); } catch (e) {}
      }
    },
  });
}

// --- DeviceIoControl (HID type 0x000b) ---------------------------------

var deviceIoControl = exportByName('kernel32.dll', 'DeviceIoControl');
if (deviceIoControl) {
  Interceptor.attach(deviceIoControl, {
    onEnter: function (args) {
      var code = args[1].toInt32() >>> 0;
      if (((code >>> 16) & 0xffff) !== 0x000b) return;
      this.code = code;
      this.handle = args[0];
      this.inBuf = args[2]; this.inLen = args[3].toInt32();
      this.out = args[4]; this.outLen = args[5].toInt32();
      this.pBytesRet = args[6];
      this.pOverlapped = args[7];
      if (this.inLen > 0) dump('ioctl_in_' + code.toString(16), this.handle, this.inBuf, this.inLen, true);
    },
    onLeave: function (retval) {
      if (this.code === undefined) return;
      if (retval.toInt32() !== 0) {
        var n = this.outLen;
        try { if (!this.pBytesRet.isNull()) n = this.pBytesRet.readU32(); } catch (e) {}
        dump('ioctl_out_' + this.code.toString(16), this.handle, this.out, n, true);
      } else if (this.pOverlapped && !this.pOverlapped.isNull()) {
        pending[key(this.pOverlapped)] = {
          overlappedPtr: this.pOverlapped,
          handle: this.handle, buf: this.out, reqLen: this.outLen,
          pBytesRead: this.pBytesRet, tag: 'ioctl_out_' + this.code.toString(16),
        };
      }
    },
  });
}

// --- vendor DLL surface (auto-enumerated) -----------------------------

function hexArgBuf(ptr, n) {
  try {
    var b = new Uint8Array(ptr.readByteArray(n));
    var out = [];
    for (var i = 0; i < b.length; i++) out.push(('0' + b[i].toString(16)).slice(-2));
    return out.join(' ');
  } catch (e) { return null; }
}

var hidusb = null;
try { hidusb = Process.getModuleByName('HIDUsb.dll'); }
catch (e) { try { hidusb = Module.load('HIDUsb.dll'); } catch (e2) {} }

var dllCount = 0;
if (hidusb) {
  hidusb.enumerateExports().forEach(function (exp) {
    if (exp.type !== 'function') return;
    if (!/^CS_Usb(Server|Finder)_/.test(exp.name)) return;
    dllCount++;
    var name = exp.name;
    Interceptor.attach(exp.address, {
      onEnter: function (args) {
        this.name = name;
        this.a = [args[0], args[1], args[2], args[3], args[4], args[5]];
        send({
          type: 'dll', seq: nextSeq(), name: name, phase: 'enter',
          args: this.a.map(function (p) { return p.toString(); }),
          argbufs: this.a.map(function (p) { return hexArgBuf(p, 32); }),
        });
      },
      onLeave: function (retval) {
        send({
          type: 'dll', seq: nextSeq(), name: this.name, phase: 'leave',
          ret: retval.toString(),
          argbufs: this.a.map(function (p) { return hexArgBuf(p, 32); }),
        });
      },
    });
  });
}

send({ type: 'ready', seq: nextSeq(), dllHooks: dllCount });
