/**
 * Just enough of the zip format to open a recording from the device report
 * tool: the central directory, stored and deflated entries. Maintainer-side
 * only (node:zlib), never part of the app.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function readZip(file: Uint8Array): ZipEntry[] {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  // The end-of-central-directory record: at the end, before any comment.
  let eocd = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip: central directory');
    const method = v.getUint16(at + 10, true);
    const compressed = v.getUint32(at + 20, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const commentLength = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    // Windows PowerShell's Compress-Archive writes backslashes.
    const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/');
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`damaged zip: ${name}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = file.subarray(start, start + compressed);
    if (method === 0) entries.push({ name, data: raw });
    else if (method === 8) entries.push({ name, data: new Uint8Array(inflateRawSync(raw)) });
    else throw new Error(`${name}: zip compression method ${method} is not read here`);
  }
  return entries;
}
