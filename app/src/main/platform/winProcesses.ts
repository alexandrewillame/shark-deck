import koffi from 'koffi';

/**
 * Every running process's image name (`cs2.exe`), from Windows itself: a
 * Toolhelp snapshot (CreateToolhelp32Snapshot, Process32FirstW/NextW, all
 * documented kernel32 calls) made through koffi, in a few milliseconds.
 *
 * This is auto-switch's question every couple of seconds, tray or not. It was
 * `tasklist`, which cost about half a second of CPU each time on a desktop
 * with ~330 processes — tasklist works out every process's memory and session,
 * then the app read its output from a pipe line by line, cmd.exe and a console
 * host spawned around it — so Shark Deck showed 3–5 % CPU every two seconds
 * during a game. Measured on that PC: ~7 ms here.
 *
 * Imported on first use only (platform/win.ts), so nothing native loads on
 * macOS or Linux, nor before auto-switch polls. The entry is one buffer read in
 * place: marshalling it into an object per process cost a third more.
 */

const TH32CS_SNAPPROCESS = 0x2;

// PROCESSENTRY32W's layout, for its size and the name's offset on this
// architecture (568 and 44 on x64 and arm64, 556 and 36 on ia32); never
// marshalled itself. Unnamed: a named koffi type cannot be declared twice in
// one process, as a second load of this module would.
const ENTRY = koffi.struct({
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16', 260),
});
const SIZE = koffi.sizeof(ENTRY);
const NAME = koffi.offsetof(ENTRY, 'szExeFile');

const kernel32 = koffi.load('kernel32.dll');
const snapshot = kernel32.func(
  'intptr __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)',
);
const first = kernel32.func('bool __stdcall Process32FirstW(intptr hSnapshot, void *lppe)');
const next = kernel32.func('bool __stdcall Process32NextW(intptr hSnapshot, void *lppe)');
const closeHandle = kernel32.func('bool __stdcall CloseHandle(intptr hObject)');

const entry = Buffer.alloc(SIZE);

/** szExeFile: UTF-16, NUL-terminated within its 260 characters. */
function nameOf(b: Buffer): string {
  let end = NAME;
  while (end + 1 < SIZE && (b[end]! | b[end + 1]!) !== 0) end += 2;
  return b.toString('utf16le', NAME, end);
}

/**
 * The running processes' image names, lower-cased and de-duplicated, as
 * `tasklist` gave them. Throws when Windows gives no snapshot, rather than
 * answering "nothing is running" (see platform/win.ts).
 */
export function processNames(): Set<string> {
  const snap = Number(snapshot(TH32CS_SNAPPROCESS, 0));
  if (snap === -1 || snap === 0) throw new Error('CreateToolhelp32Snapshot gave no snapshot');
  const names = new Set<string>();
  try {
    entry.fill(0);
    entry.writeUInt32LE(SIZE, 0);
    if (first(snap, entry)) {
      do names.add(nameOf(entry).toLowerCase());
      while (next(snap, entry));
    }
  } finally {
    closeHandle(snap);
  }
  if (!names.size) throw new Error('the process snapshot was empty');
  return names;
}
