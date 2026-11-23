/**
 * What the app makes of a device report from tools/SharkDeck-device-report.bat,
 * and where adding the device would go (src/main/devices/deviceReport.ts).
 * Given a recording (the .zip from Windows, the .tar.gz from Linux, or the
 * folder either unpacks to), it also writes the dossier a driver is built from
 * (src/main/devices/capture/dossier.ts), next to the recording, as dossier.md.
 *
 *   npm run device-report -- path/to/SharkDeck-device-report-1D57-FA55-….txt
 *   npm run device-report -- path/to/SharkDeck-recording-1D57-FA55-….zip
 *   npm run device-report -- path/to/SharkDeck-recording-1D57-FA55-….tar.gz
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseDeviceReport, triageReport } from '../src/main/devices/deviceReport';
import { dossier, stepMessages } from '../src/main/devices/capture/dossier';
import { sharkDeckChecks } from '../src/main/devices/capture/checks';
import { readZip } from '../src/main/devices/capture/zip';

const arg = process.argv[2];
if (!arg) {
  console.error(
    'usage: npm run device-report -- <report .txt | recording .zip, .tar.gz or folder>',
  );
  process.exit(1);
}
const path = resolve(arg);

/** Every file under a folder, as forward-slash paths relative to it. */
function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? filesUnder(root, full) : [relative(root, full).replace(/\\/g, '/')];
  });
}

let folder: string | null = null;
if (path.toLowerCase().endsWith('.zip')) {
  // Unpacked next to it, once: the pictures are for looking at.
  folder = path.slice(0, -4);
  if (!existsSync(folder)) {
    for (const e of readZip(new Uint8Array(readFileSync(path)))) {
      const to = resolve(folder, e.name);
      if (!to.startsWith(resolve(folder)))
        throw new Error(`refusing a zip entry outside the folder: ${e.name}`);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, e.data);
    }
  }
} else if (/\.(tar\.gz|tgz)$/i.test(path)) {
  // A Linux recording holds its folder: unpacked beside it, once, by the
  // system's tar (Windows has one too), run from that folder so no drive
  // letter reaches it (GNU tar reads "C:" as a remote host).
  folder = path.replace(/\.(tar\.gz|tgz)$/i, '');
  if (!existsSync(folder)) {
    const at = { cwd: dirname(path), encoding: 'utf8' as const };
    const name = basename(folder);
    for (const entry of execFileSync('tar', ['-tzf', basename(path)], at).split(/\r?\n/)) {
      if (
        (entry && !(entry === `${name}/` || entry.startsWith(`${name}/`))) ||
        /(^|\/)\.\.(\/|$)/.test(entry)
      )
        throw new Error(`refusing a .tar.gz entry outside the folder: ${entry}`);
    }
    execFileSync('tar', ['-xzf', basename(path)], at);
  }
} else if (statSync(path).isDirectory()) folder = path;

const reportFile = folder ? join(folder, 'report.txt') : path;
const report = parseDeviceReport(readFileSync(reportFile, 'utf8'));
for (const line of triageReport(report)) console.log(line);

if (folder && report.recording) {
  const pcap = join(folder, 'capture.pcap');
  if (!existsSync(pcap)) {
    console.log(`\nThe recording has no capture.pcap in ${folder}.`);
    process.exit(1);
  }
  const out = join(folder, 'dossier.md');
  const input = {
    model: report.model,
    recording: report.recording,
    pcap: new Uint8Array(readFileSync(pcap)),
    files: new Set(filesUnder(folder)),
    devices: report.devices,
  };
  // What Shark Deck's own driver makes of it (capture/checks.ts), after the frames.
  const checks = await sharkDeckChecks({ ...stepMessages(input), devices: report.devices });
  writeFileSync(out, `${dossier(input)}\n${checks.join('\n')}\n`);
  console.log(`\nDossier: ${out}\nPictures: ${join(folder, 'screens')}`);
}
