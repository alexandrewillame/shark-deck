import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT } from '../lib/ast';
import { buildFrame, toHex } from '../../src/main/hid/frame';
import {
  COMPX_8K_DONGLE_VID,
  knownVendorIds,
  provisionalHub,
  provisionalRoyuan,
  ROYUAN_RECEIVERS,
  ROYUAN_VIDS,
} from '../../src/main/devices/registry';
import { KB_CMD } from '../../src/main/devices/drivers/compx-keyboard';
import { V8_CMD } from '../../src/shared/mouse-wire';
import { JXC_VID } from '../../src/main/devices/catalog/jxc-mice';
import { BEKEN_VID } from '../../src/main/devices/catalog/beken-mice';
import { REPORT_MARKER } from '../../src/main/devices/deviceReport';
import { expectedOf } from '../../src/main/devices/capture/fields';

/**
 * tools/SharkDeck-device-report.bat runs on strangers' computers, against
 * devices Shark Deck does not support yet. It must ask nothing the app itself
 * would not ask: the same families, the same interfaces, byte for byte the
 * same identify frames — and nothing at all of a family it does not know, or
 * of a Beken mouse. Its recording mode sends nothing at all (USBPcap only
 * listens) and keeps only the device plugged in for it; its one download is
 * USBPcap's installer, run only when its hash is the one pinned here, and
 * kept only when Windows loads its driver. It is PowerShell and C#, which no
 * test here can run, so all of that is pinned by reading it.
 */
const BAT = resolve(APP_ROOT, '../tools/SharkDeck-device-report.bat');
const text = readFileSync(BAT, 'utf8');

/** The value of `$Name = …` on its own line. */
function assigned(name: string): string {
  const m = new RegExp(`^\\$${name} = (.+?)\\r?$`, 'm').exec(text);
  if (!m) throw new Error(`$${name} is not assigned on a line of its own`);
  return m[1]!;
}
const hexList = (name: string) =>
  [...assigned(name).matchAll(/0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1]!, 16)).sort();
const hexNum = (name: string) => parseInt(assigned(name), 16) || Number(assigned(name));
const literal = (name: string) => /^'([0-9a-f]+)'$/.exec(assigned(name))![1]!;
const bytes = (hex: string) => hex.match(/../g)!.map((b) => parseInt(b, 16));
const plainHex = (frame: Uint8Array) => toHex(frame).replace(/ /g, '');
const literalUrl = (name: string) => /^'([^']+)'$/.exec(assigned(name))![1]!;
/** The body of one PowerShell function of the tool. */
function fn(name: string): string {
  const from = text.indexOf(`function ${name}`);
  expect(from, `no function ${name}`).toBeGreaterThan(-1);
  const next = text.indexOf('\nfunction ', from + 1);
  return text.slice(from, next < 0 ? undefined : next);
}

/** The C# compiled into the tool, and the part of it that runs while recording. */
const csharp = /-TypeDefinition @'\r\n([\s\S]*?)\r\n'@/.exec(text)![1]!;
const RECORDING_MARK = '// ---- Recording: below this line nothing writes to a device.';
const recordingCs = csharp.slice(csharp.indexOf(RECORDING_MARK));

/** The recording's steps, as the table in the tool lists them. */
const steps = /\$StepTable = @'\r\n([\s\S]*?)\r\n'@/
  .exec(text)![1]!
  .split('\r\n')
  .map((line) => {
    const [id, kind, group, value, series, flags, what] = line.split('|');
    return {
      id: id!,
      kind: kind!,
      group: group!,
      value: value!,
      series: series!,
      flags: flags!,
      text: what!,
    };
  });

describe('the device report tool', () => {
  it('knows the families the app knows', () => {
    expect(hexList('KnownVendorIds')).toEqual([...knownVendorIds()].sort());
    expect(hexList('RoyuanVendorIds')).toEqual([...ROYUAN_VIDS].sort());
    expect(hexList('RoyuanRelayPids')).toEqual(Object.keys(ROYUAN_RECEIVERS).map(Number).sort());
    expect(hexNum('HubVendorId')).toBe(COMPX_8K_DONGLE_VID);
    expect(hexNum('JxcVendorId')).toBe(JXC_VID);
    expect(hexNum('BekenVendorId')).toBe(BEKEN_VID);
  });

  it('asks a ROYUAN device its model on the interface the app uses, with the frame the app sends', () => {
    const d = provisionalRoyuan(0x3151, 0x5029);
    expect(hexNum('RoyuanUsagePage')).toBe(d.usagePage);
    expect(hexNum('RoyuanUsage')).toBe(d.usage);
    expect(Number(assigned('RoyuanReportBytes'))).toBe(d.reportLength);
    const frame = buildFrame({
      reportId: 0x00,
      command: KB_CMD.GET_USB_VERSION,
      reportLength: d.reportLength,
      checksum: d.checksum,
    });
    expect(literal('RoyuanIdentifyHex')).toBe(plainHex(frame));
  });

  it('asks a Hub mouse its model the same way, nonce aside', () => {
    const d = provisionalHub(0xf517);
    expect(hexNum('HubUsagePage')).toBe(d.usagePage);
    expect(hexNum('HubUsage')).toBe(d.usage);
    expect(Number(assigned('HubReportBytes'))).toBe(d.reportLength);
    // The app draws a fresh nonce per ask (drivers/identify.ts); the tool's is
    // fixed. Everything else, the checksum over that nonce included, matches.
    const sent = bytes(literal('HubIdentifyHex'));
    const nonce = sent.slice(6, 10);
    const frame = buildFrame({
      reportId: 0x08,
      command: V8_CMD.IDENTIFY,
      args: [0x00, 0x00, 0x00, 0x08, ...nonce],
      reportLength: d.reportLength,
      checksum: d.checksum,
    });
    expect(literal('HubIdentifyHex')).toBe(plainHex(frame));
  });

  it('asks nothing of a Beken mouse, a JXC mouse or an unknown family', () => {
    // The two ways it can send: one call each, in the two families that ask.
    expect(text.match(/\[SdHid\]::AskFeature\(/g)).toHaveLength(1);
    expect(text.match(/\[SdHid\]::AskOutput\(/g)).toHaveLength(1);
    const from = text.indexOf('function AskModel');
    const askModel = text.slice(from, text.indexOf('\nfunction ', from));
    const branch = (label: string) => {
      const at = askModel.indexOf(`        ${label} {`);
      expect(at, `no ${label} branch in AskModel`).toBeGreaterThan(-1);
      return askModel.slice(at, askModel.indexOf('\n', at));
    };
    for (const quiet of ["'jxc'", "'beken'", 'default']) {
      expect(branch(quiet)).not.toMatch(/Ask(Feature|Output)/);
    }
    // And in C#, only those two methods write to a device.
    expect(text.match(/HidD_SetFeature\(h,/g)).toHaveLength(1);
    expect(text.match(/fs\.Write\(/g)).toHaveLength(1);
  });

  it('downloads one thing, USBPcap’s installer, and runs it only when its hash is the pinned one', () => {
    expect(text).not.toMatch(
      /Invoke-RestMethod|WebClient|DownloadString|DownloadFile|Net\.Http|Sockets|BitsTransfer|\bcurl\b|\bwget\b/i,
    );
    const downloads = text.split('\r\n').filter((l) => /Invoke-WebRequest/i.test(l));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/Invoke-WebRequest -Uri \$UsbPcapInstallerUrl -OutFile \$exe /);
    expect(literalUrl('UsbPcapInstallerUrl')).toBe(
      'https://github.com/desowin/usbpcap/releases/download/1.5.4.0/USBPcapSetup-1.5.4.0.exe',
    );
    // As Wireshark's own dependency index lists it
    // (https://dev-libs.wireshark.org/windows/packages/USBPcap/).
    expect(literalUrl('UsbPcapInstallerSha256')).toBe(
      '87A7EDF9BBBCF07B5F4373D9A192A6770D2FF3ADD7AA1E276E82E38582CCB622',
    );
    const install = fn('InstallUsbPcap');
    const hashed = install.indexOf('Get-FileHash -Algorithm SHA256 -LiteralPath $exe');
    const refused = install.indexOf('if ($hash -ne $UsbPcapInstallerSha256) {');
    const handed = install.indexOf('UsbPcapSetup $exe');
    expect(hashed).toBeGreaterThan(install.indexOf('Invoke-WebRequest'));
    expect(refused).toBeGreaterThan(hashed);
    expect(install.slice(refused, handed)).toContain("return 'failed'");
    expect(handed).toBeGreaterThan(refused);
    // Checked again with administrator rights, just before the one place it runs.
    const phase = fn('UsbPcapSetupPhase');
    const rehashed = phase.indexOf('Get-FileHash -Algorithm SHA256 -LiteralPath $job.installer');
    expect(rehashed).toBeGreaterThan(-1);
    expect(phase.indexOf('[SdJob]::RunNoRestart($job.installer')).toBeGreaterThan(rehashed);
    expect(text.match(/\[SdJob\]::RunNoRestart\(/g)).toHaveLength(1);
    expect(text).not.toMatch(/Start-Process -FilePath \$(exe|job\.installer)\b/);
    // Asked first, every time.
    expect(install.indexOf('Read-Host')).toBeGreaterThan(-1);
    expect(install.indexOf('Read-Host')).toBeLessThan(install.indexOf('Invoke-WebRequest'));
  });

  it('loads USBPcap’s driver before any restart, and takes out one Windows refuses', () => {
    // USBPcap filters every USB controller and hub: a driver Windows refuses
    // (Memory integrity can) would stop the keyboard and mouse from the next start.
    expect(fn('UsbPcapLoadCheck')).toContain('& $sc start USBPcap');
    const phase = fn('UsbPcapSetupPhase');
    const loaded = phase.indexOf('$load = UsbPcapLoadCheck');
    expect(loaded).toBeGreaterThan(phase.indexOf('[SdJob]::RunNoRestart($job.installer'));
    const removed = phase.indexOf('RemoveUsbPcap', loaded);
    expect(removed).toBeGreaterThan(loaded);
    // Only a USBPcap this tool installed.
    expect(phase.slice(loaded, removed)).toContain('-and $job.installer) {');
    // Taken out means out of the USB class's filters, whatever its uninstaller did.
    const remove = fn('RemoveUsbPcap');
    expect(remove).toContain(
      "OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Class\\{36FC9E60-C465-11CF-8056-444553540000}', $true)",
    );
    expect(remove).toContain("Where-Object { $_ -ne 'USBPcap' }");
    // Its installer's own "restart now?" cannot restart the computer before that
    // check: it runs in a job refused ExitWindowsEx, started suspended so that
    // it is in the job from its first instruction.
    expect(recordingCs).toContain('ui.Restrictions = 0x80; // JOB_OBJECT_UILIMIT_EXITWINDOWS');
    expect(recordingCs).toMatch(/CreateProcess\(path, [^;]*, 0x4, /);
    // Every road to a restart passes a driver Windows loaded.
    const install = fn('InstallUsbPcap');
    expect(install.indexOf("return 'installed'")).toBeGreaterThan(
      install.indexOf('if (-not $setup.loads) {'),
    );
    const calls = [...text.matchAll(/^ +RestartForUsbPcap\r$/gm)].map((m) => m.index!);
    expect(calls).toHaveLength(3);
    for (const at of calls) {
      const from = Math.max(text.lastIndexOf('\nfunction ', at), ...calls.filter((c) => c < at));
      expect(text.slice(from, at)).toMatch(/'installed'|\.loads/);
    }
  });

  it('reads USBPcapCMD through a redirected output: it is a Windows (GUI) program', () => {
    // PowerShell neither waits for a GUI program nor reads its output: the
    // recording window once saw no USB controller at all while USBPcap listened.
    const hubs = fn('UsbPcapHubs');
    expect(hubs).toContain('$psi.UseShellExecute = $false');
    expect(hubs).toContain('$psi.RedirectStandardOutput = $true');
    expect(text.match(/--extcap-interfaces/g)).toHaveLength(1);
    expect(text).not.toMatch(/& \$pcapCmd\b/);
  });

  it('closes Shark Deck, by the name the build gives it, before it could talk to the device', () => {
    const builder = readFileSync(resolve(APP_ROOT, 'electron-builder.yml'), 'utf8');
    const product = /^productName: (.+)$/m.exec(builder)![1]!.trim();
    expect(fn('CloseSharkDeck')).toContain(`Get-Process -Name '${product}'`);
    // Before the report's question, before the device is unplugged for a
    // recording, and before the step window.
    expect(text).toContain('if ($interactive) { CloseSharkDeck }');
    expect(fn('RecordingPhase').match(/^ +CloseSharkDeck\r$/gm)).toHaveLength(2);
  });

  it('links only to the project, and to where USBPcap is published', () => {
    const urls = [...text.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    const usbpcap = [literalUrl('UsbPcapUrl'), literalUrl('UsbPcapInstallerUrl')];
    expect(usbpcap[0]).toBe('https://github.com/desowin/usbpcap/releases');
    for (const u of urls.filter((u) => !usbpcap.includes(u)))
      expect(u).toMatch(/^https:\/\/github\.com\/alexandrewillame\/shark-deck/);
  });

  it('carries on after a restart through a sign-in task of the owner’s, and restarts only when told to', () => {
    expect(literalUrl('ResumeName')).toBe('SharkDeckDeviceReport');
    // A sign-in task, not Windows' run-once list: an installer can make Windows
    // run that list at any moment (it once did, during the restart countdown).
    expect(text).not.toMatch(/RunOnce/);
    const task = fn('RegisterResumeTask');
    expect(task).toContain('New-ScheduledTaskTrigger -AtLogOn -User $user');
    expect(task).toContain('-RunLevel Highest');
    expect(task).toContain('-AllowStartIfOnBatteries');
    expect(task).toContain('--resume-recording');
    expect(text.match(/Register-ScheduledTask /g)).toHaveLength(1);
    expect(fn('ClearResume')).toContain('UnregisterResumeTask');
    // Set before the installer runs, so that any restart carries on; gone again
    // when there is nothing to carry on.
    const phase = fn('UsbPcapSetupPhase');
    expect(phase.indexOf('RegisterResumeTask $job.user')).toBeGreaterThan(-1);
    expect(phase.indexOf('RegisterResumeTask $job.user')).toBeLessThan(
      phase.indexOf('[SdJob]::RunNoRestart('),
    );
    expect(phase).toContain('if (-not $out.loads) { UnregisterResumeTask }');
    expect(text).toMatch(
      /if \(\$flags\.Resume -and -not \(Test-Path -LiteralPath \(ResumeFile\)\)\) \{\r\n[^\r]*\r\n {4}UnregisterResumeTask/,
    );
    // A failed install leaves nothing behind to reopen.
    expect(fn('InstallUsbPcap').match(/ClearResume/g)!.length).toBeGreaterThanOrEqual(2);
    const restart = fn('RestartForUsbPcap');
    expect(text.match(/shutdown\.exe/g)).toHaveLength(1);
    expect(restart.indexOf('Read-Host')).toBeGreaterThan(-1);
    expect(restart.indexOf('Read-Host')).toBeLessThan(restart.indexOf('shutdown.exe'));
  });

  it('records without sending anything: no device write below the recording mark', () => {
    expect(csharp).toContain(RECORDING_MARK);
    expect(recordingCs).not.toMatch(
      /HidD_Set|WriteFile|DeviceIoControl|CreateFile\w*\(|AskFeature|AskOutput/,
    );
  });

  it('records the chosen device where it is and what is plugged in meanwhile, never a whole controller', () => {
    // USBPcapCMD, once per USB controller: devices plugged in from now on and,
    // on the device's own controller, the device itself by its address. Never -A
    // (the whole controller, the keyboard you type with included).
    const start = text.split('\r\n').filter((l) => l.includes('New-Object SdRecorder($pcapCmd'));
    expect(start).toHaveLength(1);
    const rec = fn('RecordingPhase');
    expect(rec).toMatch(/\$cmdArgs = @\('-d', \$hub, '-o', '-', '--capture-from-new-devices'/);
    expect(rec).toContain(
      "if ($hub -eq $atHub) { $cmdArgs += @('--devices', [string]$place.Address, '--inject-descriptors') }",
    );
    expect(text.match(/--devices|--inject-descriptors/g)).toHaveLength(2);
    expect(text).not.toMatch(/capture-from-all-devices|'-A'/);
    // The address is the hub driver's account of the device's port, its USB ids
    // checked, and it is used only on the controller USBPcap says that recorder
    // listens on; failing either, the device is unplugged and recorded as it comes back.
    expect(csharp).toContain('0x22040C'); // IOCTL_USB_GET_NODE_CONNECTION_INFORMATION
    expect(csharp).toContain(
      'BitConverter.ToUInt16(info, 12) != vid || BitConverter.ToUInt16(info, 14) != pid',
    );
    expect(csharp).toContain('0x22200C'); // IOCTL_USBPCAP_GET_HUB_SYMLINK
    expect(rec).toContain('$replug = -not $atHub');
    // And the recorders end with the tool, even when its window is closed.
    expect(text).toContain('[SdJob]::Adopt($r.Process)');
  });

  it('takes each capture from USBPcapCMD’s standard output, so it can count it while recording', () => {
    // USBPcapCMD opens a file it writes to with no sharing: the step window
    // could not read it, and its "received it" line never came on.
    const recorder = recordingCs.slice(recordingCs.indexOf('public class SdRecorder'));
    expect(recorder).toContain('psi.RedirectStandardOutput = true;');
    expect(recorder).toContain(
      'new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read)',
    );
    // Messages the software sends: class requests on the control pipe, and data
    // on interrupt OUT pipes (the V8 family's way); none is a device write of ours.
    // Counted one message at a time as it is written, typing left out (SdPcap.Live).
    expect(recordingCs).toContain('return s[0] == 0x21 || s[0] == 0xA1 ? 1 : 0;');
    expect(recordingCs).toContain('if ((ep & 0x80) == 0) return up ? 0 : 1;');
    expect(recorder).toMatch(
      /int kind = live\.See\(rec\);\s*if \(kind == 1\) Interlocked\.Increment\(ref sent\);/,
    );
    // All it sent is in the file before the file is read.
    expect(fn('RecordingPhase')).toMatch(/\$r\.Process\.Kill\(\)[\s\S]*?\$r\.Finish\(\)/);
  });

  it('picks a device of a family it knows from what is plugged in, and unplugs only the others', () => {
    // A keyboard can take a while to type normally again after it is plugged back in.
    expect(fn('KnownDevicesPresent')).toContain('$KnownVendorIds -contains $_.Vid');
    expect(fn('ChooseDevice')).toContain('Paths = @(WaitForDevice -Unplug); Model = $null');
    expect(text.match(/WaitForDevice -Unplug/g)).toHaveLength(1);
    expect(text).toContain('$chosen = ChooseDevice');
    // The name it gave when found, which the owner confirmed, is its model name.
    expect(text).toContain('$model = $chosen.Model');
  });

  it('pictures only a window the owner said is the official software', () => {
    // Picking only names a candidate; a yes in ConfirmCandidate is the one place
    // that sets what gets pictured.
    const pick = recordingCs.slice(
      recordingCs.indexOf('void Pick()'),
      recordingCs.indexOf('bool ConfirmCandidate()'),
    );
    expect(pick).not.toContain('softwarePid =');
    const confirm = recordingCs.slice(
      recordingCs.indexOf('bool ConfirmCandidate()'),
      recordingCs.indexOf('void Repick()'),
    );
    expect(recordingCs.match(/softwarePid = candidatePid/g)).toHaveLength(1);
    expect(confirm).toContain(
      'if (!AskIsSoftware(candidatePid, candidateName, candidateTitle)) { candidatePid = 0; return false; }',
    );
    expect(confirm.indexOf('AskIsSoftware(')).toBeLessThan(
      confirm.indexOf('softwarePid = candidatePid'),
    );
    // The question shows the window, from memory: that picture is never saved.
    const ask = recordingCs.slice(
      recordingCs.indexOf('bool AskIsSoftware('),
      recordingCs.indexOf('void Repick()'),
    );
    expect(ask).toContain('SdShot.Snapshot(pid)');
    expect(ask).not.toMatch(/\.Save\(|WriteAllBytes/);
    // Another window takes over only once it is confirmed: until then the
    // pictures go on as they were, and no stray window becomes a candidate.
    const repick = recordingCs.slice(
      recordingCs.indexOf('void Repick()'),
      recordingCs.indexOf('static string ImagePath('),
    );
    expect(repick).not.toContain('softwarePid = 0');
    expect(repick).toContain(
      'picking = softwarePid == 0 && index < steps.Length && Has(steps[index], "window");',
    );
  });

  it('says in the step window what is recorded and what is not, and where each setting is', () => {
    expect(recordingCs).toContain('public class SdRecorder');
    expect(recordingCs).toContain('"Only the " + DeviceName + "\'s USB messages');
    expect(recordingCs).toContain('is blanked as soon as it is recorded, so it is never saved.');
    // "Redo previous" keeps what the step being left saw, for the reader.
    expect(recordingCs).toContain('Record(steps[index], "left", stepStart)');
    // Every place named belongs to a group of the steps.
    const where = /\$WhereTable = @'\r\n([\s\S]*?)\r\n'@/
      .exec(text)![1]!
      .split('\r\n')
      .map((line) => line.split('|'));
    const groups = new Set(steps.map((s) => s.group));
    for (const [group, kind, said] of where) {
      expect(groups, group).toContain(group);
      expect(['both', 'mouse', 'keyboard'], group).toContain(kind);
      expect(said!.length, group).toBeGreaterThan(20);
    }
    // At the end, the whole recording folder opens, not just its pictures.
    const rec = fn('RecordingPhase');
    expect(rec).toContain('Start-Process explorer.exe "`"$recDir`""');
    expect(rec).not.toMatch(/explorer\.exe "`"\$\(Join-Path \$recDir 'screens'\)/);
  });

  it('offers the recording by default, with USBPcap installed when missing or half there', () => {
    const offer = fn('OfferRecording');
    expect(offer).toContain("Read-Host '  Record now? [Y/n]'");
    expect(offer).not.toContain('[y/N]');
    expect(offer).toContain("if (-not (FindUsbPcap) -or (UsbPcapDriver) -eq 'missing') {");
    // The report travels inside the recording, and is saved on its own only without one.
    const main = text.slice(text.indexOf('# ---- Main'));
    const carried = main.indexOf("if ($recording -eq 'started' -or $recording -eq 'restart') {");
    expect(carried).toBeGreaterThan(-1);
    expect(main.match(/SaveText \$file /g)).toHaveLength(1);
    expect(main.indexOf('SaveText $file ')).toBeGreaterThan(carried);
  });

  it('keeps what is typed and the serial number out of a recording', () => {
    expect(recordingCs).toMatch(/rule\.Kind == "keyboard"[\s\S]*rec\[i\] = 0/);
    expect(recordingCs).toContain('index == d.Serial');
    // Keyboard and mouse collections become privacy rules, from what Windows says they are.
    expect(text).toContain("[SdPcap]::AddRule($device, $mi, 'keyboard', $ids)");
    expect(text).toContain("[SdPcap]::AddRule($device, $mi, 'mouse', $ids)");
    // Blanked as it is recorded, never only when saved: the rules are set
    // before the first recorder starts, and each message is seen before it is written.
    const rec = fn('RecordingPhase');
    expect(rec.indexOf('SetPrivacyRules @(PresentPaths')).toBeGreaterThan(-1);
    expect(rec.indexOf('SetPrivacyRules @(PresentPaths')).toBeLessThan(
      rec.indexOf('New-Object SdRecorder('),
    );
    expect(recordingCs).toMatch(
      /int kind = live\.See\(rec\);[\s\S]*?Write\(rec, 0, rec\.Length\);/,
    );
  });

  it('has a step table the maintainer’s reader can line up', () => {
    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size, 'step ids repeat').toBe(ids.length);
    expect(steps[0]!.flags).toBe('window');
    expect(steps.filter((s) => s.flags === 'window')).toHaveLength(1);
    expect(steps.some((s) => s.flags === 'auto15' && s.id === 'start.idle')).toBe(true);
    for (const s of steps) {
      expect(['both', 'mouse', 'keyboard'], s.id).toContain(s.kind);
      for (const flag of s.flags.split(/[ ,]+/).filter(Boolean))
        expect(
          ['window', 'auto15', 'repeat', 'attach', 'detect', 'undo', 'nochange', 'ask'],
          s.id,
        ).toContain(flag);
      expect(s.text.length, s.id).toBeGreaterThan(10);
    }
    // A series lines up steps that set one setting to known values, all of one kind.
    const series = new Map<string, typeof steps>();
    for (const s of steps) if (s.series) series.set(s.series, [...(series.get(s.series) ?? []), s]);
    for (const [name, members] of series) {
      if (members.some((s) => s.flags === 'repeat')) continue;
      expect(members.length, `series ${name}`).toBeGreaterThanOrEqual(2);
      const kinds = new Set(
        members.map((s) => expectedOf(s.value, '').kind).filter((k) => k !== 'label'),
      );
      expect(kinds.size, `series ${name} mixes kinds of value`).toBeLessThanOrEqual(1);
    }
  });

  it('puts every remap and key mode back with the very next step, and says what is still changed', () => {
    // A remapped key or a key mode changes how the keyboard types: the step
    // right after it puts it back.
    const keyboard = steps.filter((s) => s.kind !== 'mouse');
    for (const [i, s] of keyboard.entries()) {
      const remap = s.group === 'Keys' && s.id.startsWith('key.') && s.id !== 'key.reset';
      const mode = s.group === 'Key modes' && s.flags !== 'nochange';
      if ((remap || mode) && !s.id.endsWith('.undo')) {
        expect(keyboard[i + 1]?.id, s.id).toBe(`${s.id}.undo`);
        expect(keyboard[i + 1]?.flags, s.id).toBe('undo');
      }
    }
    // Fn + A is a system key in Attack Shark Driver v4, which refuses to change it.
    expect(text).not.toMatch(/Fn \+ A to|key\.fn-a/);
    // What is still changed: on stopping early, and at the end.
    expect(recordingCs).toMatch(/bool Confirm\(\)[\s\S]*?StillChanged\(\)/);
    const rec = fn('RecordingPhase');
    expect(rec).toContain('$still = @($wizard.StillChanged())');
    // Packed before the owner is asked anything: closing the window keeps the .zip.
    expect(rec.indexOf('Pack $recDir $zip')).toBeGreaterThan(-1);
    expect(rec.indexOf('Pack $recDir $zip')).toBeLessThan(
      rec.indexOf("Read-Host '  (Nothing to delete"),
    );
  });

  it('redoes a change only once it is put back, and shows when a step reached the device', () => {
    expect(recordingCs).toContain('"I put it back"');
    expect(recordingCs).toContain('Record(s, "reverted", stepStart)');
    // Against what the software sends on its own while left alone.
    expect(recordingCs).toMatch(/idleRate = \(SentAll - stepSent\)/);
    expect(recordingCs).toContain('received it (');
  });

  it('writes the step states and fields the maintainer’s reader expects', () => {
    for (const state of ['"done"', '"not-offered"', '"skipped"'])
      expect(recordingCs).toContain(state);
    for (const field of [
      'id',
      'group',
      'text',
      'value',
      'series',
      'status',
      'attempt',
      'note',
      'start',
      'end',
      'shots',
    ])
      expect(text, `step field ${field}`).toMatch(new RegExp(`\\b${field} = (@\\()?\\$_\\.`));
    for (const field of [
      'version',
      'kind',
      'usbpcap',
      'started',
      'ended',
      'finishedAllSteps',
      'devices',
      'software',
      'kept',
      'steps',
    ])
      expect(text, `recording field ${field}`).toMatch(new RegExp(`^\\s+${field} = `, 'm'));
  });

  it('writes the marker the maintainer’s reader looks for (npm run device-report)', () => {
    expect(text).toContain(REPORT_MARKER);
  });

  it('is a cmd/PowerShell hybrid with Windows line endings', () => {
    // cmd.exe misreads labels and jumps in a file with bare LF endings.
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(text.startsWith('<# :')).toBe(true);
    expect(text).toMatch(/\r\n#>\r\n/);
  });
});
