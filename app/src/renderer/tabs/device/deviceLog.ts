import type { LiveDevice } from '@shared/types/live';
import type { FrameLogEntry } from '@shared/types/diagnostics';

/**
 * One device's log as a text file an owner attaches to a report: what the
 * device is and where it stands now, then every frame Shark Deck sent it and
 * every one it answered or announced, oldest first, with what went wrong
 * around them (a refused change, a read that answered nothing, announcements
 * that could not be opened). The vendor software's recordings show what the
 * device takes; this shows what happens when Shark Deck talks to it.
 */
export function deviceLogText(
  device: LiveDevice,
  frames: readonly FrameLogEntry[],
  app: { version: string; host: string },
  now: Date,
): string {
  const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  const fw = device.firmware;
  const battery =
    device.battery === null
      ? device.charging
        ? 'charging'
        : 'unknown'
      : `${device.battery}%${device.charging ? ', charging' : ''}`;
  const own = frames.filter((f) => f.deviceId === device.id);
  const time = (ts: number) => new Date(ts).toISOString().slice(11, 23);
  const line = (f: FrameLogEntry) => {
    const mark = !f.hex ? '·' : f.dir === 'tx' ? '→' : '←';
    return `${time(f.ts)} ${mark} ${[f.hex, f.note].filter(Boolean).join('  ')}`;
  };
  return [
    'Shark Deck device log',
    `Shark Deck ${app.version} (${app.host}), saved ${now.toISOString()}`,
    `Device: ${device.displayName} — ${device.model}, ${hex4(device.vid)}:${hex4(device.pid)}, ${device.connection}`,
    `Firmware: ${fw?.device ?? '—'}${fw?.receiver ? `, receiver ${fw.receiver}` : ''}`,
    `Now: ${device.online ? 'online' : 'offline'}; battery ${battery}; DPI stage ${
      device.activeDpiStage === null ? '—' : device.activeDpiStage + 1
    }; polling ${device.pollRate ?? '—'} Hz`,
    '',
    `${own.length} lines, oldest first, times UTC. → sent to the device, ← from it, · a note.`,
    ...own.map(line),
    '',
  ].join('\n');
}

/** `SharkDeck-log-<model>-<yyyymmdd-hhmm>.txt`, in UTC. */
export function deviceLogName(device: LiveDevice, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `SharkDeck-log-${device.model}-${stamp}.txt`;
}
