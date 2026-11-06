import type { ChecksumScheme, DeviceDescriptor } from '@shared/types/device';
import type { KeyZoneBindings, MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { KeyBinding } from '@shared/types/keys';
import type {
  DpiLedSettings,
  LightingSettings,
  PerKeyColor,
  PerKeyLightingOpts,
  ReceiverLedSettings,
  ReceiverLedValues,
  SideLightingSettings,
} from '@shared/types/lighting';
import type { FirmwareInfo, LiveState, TravelStreamResult, WriteResult } from '@shared/types/live';
import type { Macro } from '@shared/types/macros';
import type {
  ButtonMapping,
  DpiStage,
  PairingStatus,
  PowerSettings,
  SensorSettings,
} from '@shared/types/mouse-settings';
import { HidChannel } from '../../hid/transport';
import { buildFrame, toHex } from '../../hid/frame';
import type { IdentityKey } from '../identity-key';
import type { Capability } from '@shared/types/capability';

/** Sleep. Lives here rather than in a driver so `writeVerified`'s settle can
 *  use it without importing a concrete driver (which would be circular). */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * raw uint16 firmware -> "v{maj}.{min}".
 *
 * The vendor reads the value's *hex digits* as a decimal number: `0x0110` is
 * shown as v1.10, not v1.16. Both driver families need it — the keyboard's
 * `GET_USB_VERSION` reply and the mouse's `bcdDevice` are the same scheme, and
 * the capture's `CS_UsbFinder_GetVersion` returning `0x303` for a v3.03 mouse
 * is what confirms it.
 */
export function fmtVersion(raw: number): string {
  const digits = raw.toString(16); // 0x0110 -> "110"
  const dec = parseInt(digits, 10);
  if (!Number.isFinite(dec)) return `v${raw}`;
  const maj = Math.floor(dec / 100);
  const min = dec % 100;
  return `v${maj}.${String(min).padStart(2, '0')}`;
}

/**
 * One live per-key travel sample.
 *
 * `complete: false` means the driver read something but rejected it (a
 * sanity gate tripped), so `keys` is empty for a reason that is NOT "the
 * board is at rest". Consumers must not treat an incomplete sample as
 * evidence that a key was released — that is the whole point of the flag.
 */
export interface TravelSample {
  raw: Uint8Array;
  keys: { slot: number; mm: number }[];
  complete: boolean;
}

/**
 * How a per-key magnetic write treats the key bindings around it.
 *
 * `keepZoneBindings`: leave every key's SET_KEYMATRIX zones alone, even for a
 * key leaving mod-tap. For a write to an onboard profile the board is not
 * showing — the comparator's per-key copy, a profile copy. The key matrix is
 * written at one fixed layer whichever profile is active, so putting a key's
 * own binding back for ANOTHER profile's sake would undo a mod-tap key on the
 * profile in use.
 */
export interface MagneticWriteOpts {
  keepZoneBindings?: boolean;
}

/**
 * What a backup must hold before the first write to a device (CLAUDE.md
 * invariant #1, manager.ts `ensureBackup`).
 *
 * - `full`: every setting the device has reads back. Writes are refused until
 *   a backup holds every `required` block.
 * - `partial`: the device cannot report some settings (`unreadable`). The
 *   rest is backed up (`required`, when readable), and the first write waits
 *   for the user's one-time OK per model + firmware (`acknowledgeNoBackup`),
 *   because a Restore cannot bring those settings back.
 */
export interface BackupPolicy {
  kind: 'full' | 'partial';
  /** block names (`backup()` keys) a backup must hold */
  required: string[];
  /** the settings a `partial` device cannot report back */
  unreadable?: Capability[];
}

/**
 * Blocks a backup carries that hold no device setting: they never make a
 * backup count as taken (the V8's always carried `schema` and `firmware`, so
 * it used to "succeed" with nothing read at all).
 */
export const BACKUP_META_BLOCKS: ReadonlySet<string> = new Set([
  'schema',
  'firmware',
  'identity',
  'unreadable',
]);

export interface DriverContext {
  descriptor: DeviceDescriptor;
  channel: HidChannel;
  onWarning: (message: string) => void;
  /** Optional persisted key/value scratchpad for state the device cannot be
   *  asked for (e.g. the V8's receiver LEDs — command 0x2C has no confirmed
   *  GET). Keyed by the driver's own choice of key; scoped to this model by
   *  the manager (see main/devices/deviceState.ts). */
  state?: { get(key: string): Promise<unknown>; set(key: string, v: unknown): Promise<void> };
}

/**
 * Abstract device driver. Subclasses implement the wire protocol for one
 * family. Anything not overridden throws `NotSupported`, which the IPC layer
 * turns into a disabled control rather than an error.
 */
export abstract class Driver {
  protected readonly d: DeviceDescriptor;
  protected readonly ch: HidChannel;
  protected readonly warn: (m: string) => void;
  protected readonly state?: DriverContext['state'];

  constructor(ctx: DriverContext) {
    this.d = ctx.descriptor;
    this.ch = ctx.channel;
    this.warn = ctx.onWarning;
    this.state = ctx.state;
  }

  get descriptor(): DeviceDescriptor {
    return this.d;
  }

  // -- lifecycle -----------------------------------------------------------
  // Neither is currently called anywhere — the manager opens a channel
  // lazily (its first write/read) and closes it directly via `channel.close()`
  // — kept only as part of the Driver contract in case a future caller needs
  // an explicit connect/disconnect.
  async connect(): Promise<void> {
    await this.ch.open();
  }

  async disconnect(): Promise<void> {
    await this.ch.close();
  }

  // -- helpers -----------------------------------------------------------
  /**
   * Build a report for this device. `checksum` overrides the descriptor default
   * for the odd commands that use a different scheme — e.g. the Compx keyboard
   * signs `SET_LEDPARAM` / `SET_SLEDPARAM` with Bit8 while every other frame,
   * including their GETs, stays Bit7.
   */
  protected frame(command: number, args: number[] = [], checksum?: ChecksumScheme): Uint8Array {
    return buildFrame({
      reportId: this.d.reportLength === 17 ? 0x08 : 0x00,
      command,
      args,
      reportLength: this.d.reportLength,
      checksum: checksum ?? this.d.checksum,
    });
  }

  /**
   * Slice the useful payload out of a GET reply, for `writeVerified`'s
   * `compare`. The default drops the report id + command echo and the trailing
   * checksum byte, which is right for the mouse family.
   *
   * A driver whose replies don't all start at a fixed offset must override
   * this: the Compx keyboard's firmware sometimes leaves the echoed query
   * checksum in byte 2 and sometimes doesn't, so its readers resolve the start
   * per reply (`feaPayloadStart`). `compare` reading a fixed offset while the
   * matching reader reads a computed one is a read-back that reports
   * "mismatch" on a write that landed perfectly.
   */
  protected payloadOf(reply: Uint8Array, _getCommand: number): Uint8Array {
    return reply.subarray(2, reply.length - 1);
  }

  /**
   * Write a command and, when a matching GET exists, read it back and diff.
   * `compare` receives the reply payload (see `payloadOf`) and returns true
   * when it reflects the value just written.
   */
  protected async writeVerified(
    setCommand: number,
    args: number[],
    opts: {
      getCommand?: number;
      compare?: (payload: Uint8Array) => boolean;
      /** checksum scheme for the SET frame (GET stays on the descriptor default) */
      checksum?: ChecksumScheme;
      /**
       * Pause between the SET and its read-back, and again before the single
       * retry. 0 (the default) keeps the mouse family's existing behaviour.
       *
       * The Compx keyboard needs this: it applies a feature write
       * asynchronously, so an immediate GET can still answer with the
       * *pre-write* value — a mismatch on a write that worked. Its own paged
       * readers already pace for exactly this reason ("reading too eagerly
       * returns the previous chunk's buffer still sitting in the endpoint",
       * compx-keyboard.ts), and the effect is worst right after a burst, which
       * is precisely where per-key lighting calls it.
       */
      settleMs?: number;
      /**
       * Don't push a `write:warning` toast on an unconfirmed/mismatched
       * read-back — the returned `WriteResult` still carries it. For writes
       * issued *on behalf of* a user action rather than as the action itself,
       * where the caller folds this result into its own and the user should
       * see one labelled outcome, not a bare "command 0x7" from a command they
       * never asked for by name.
       */
      quiet?: boolean;
    } = {},
  ): Promise<WriteResult> {
    const tx = this.frame(setCommand, args, opts.checksum);
    const frames = [toHex(tx)];
    // The write and its read-back run as one atomic transaction — otherwise a
    // scan-loop poll (or another write) could land its own frame on the wire
    // between the SET and the GET, and this read-back would consume the
    // wrong reply. See HidChannel.transaction's doc comment.
    return this.ch.transaction(async (io) => {
      try {
        await io.write(tx);
      } catch (e) {
        return { ok: false, verified: 'unverified', error: String(e), frames };
      }

      if (opts.getCommand === undefined) {
        return { ok: true, verified: 'unverified', frames };
      }

      const getCommand = opts.getCommand;
      const settle = opts.settleMs ?? 0;
      // One retry behind a settle before calling it a mismatch: on a device
      // that applies the write asynchronously, the first read can legitimately
      // still hold the old value. Retrying costs one frame on the rare
      // near-miss and removes a whole class of false "mismatch" warnings; a
      // write that genuinely didn't land still reports mismatch, just a beat
      // later.
      let reply: Uint8Array | null = null;
      let match = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (settle) await delay(settle);
        reply = await io.request(this.frame(getCommand), getCommand);
        if (!reply) break;
        match = opts.compare ? opts.compare(this.payloadOf(reply, getCommand)) : true;
        if (match) break;
      }

      if (!reply) {
        if (!opts.quiet)
          this.warn(
            `No read-back for command 0x${setCommand.toString(16)} — value sent but unconfirmed.`,
          );
        return { ok: true, verified: 'unverified', frames };
      }
      frames.push(toHex(reply));
      if (!match) {
        if (!opts.quiet) this.warn(`Read-back mismatch for command 0x${setCommand.toString(16)}.`);
        return { ok: true, verified: 'mismatch', frames };
      }
      return { ok: true, verified: 'match', frames };
    });
  }

  protected notSupported(feature: string): WriteResult {
    return {
      ok: false,
      verified: 'unverified',
      error: `${feature} not supported by ${this.d.displayName}`,
    };
  }

  // -- reads (override as available) ------------------------------------
  /**
   * What the firmware says this device is (see identity-key.ts) — the one
   * command sent to a device before it is identified. null = no answer.
   */
  async identify(): Promise<IdentityKey | null> {
    return null;
  }

  /**
   * True when this device is reached through a 2.4 GHz receiver that carries
   * its packets (`DeviceDescriptor.relay`). What needs the cable — a factory
   * reset, the live travel stream — is refused then: the receiver drops a
   * bare-opcode packet if the device has dozed, so it may never arrive.
   */
  protected get relayed(): boolean {
    return !!this.d.relay;
  }

  /** The battery of a device behind a receiver, from the receiver's own status. */
  protected async relayBattery(kind: 'keyboard' | 'mouse'): Promise<number | null> {
    const s = await this.ch.relayStatus?.();
    if (!s) return null;
    const pct = kind === 'keyboard' ? s.keyboardBattery : s.mouseBattery;
    return pct > 0 && pct <= 100 ? pct : null;
  }
  async getFirmware(): Promise<FirmwareInfo | null> {
    return null;
  }
  async getActiveProfile(): Promise<number | null> {
    return null;
  }
  async getBattery(): Promise<{
    level: number | null;
    charging: boolean;
    raw?: number | null;
    millivolts?: number | null;
  }> {
    return { level: null, charging: false, raw: null, millivolts: null };
  }
  /**
   * Lightweight liveness probe used by the poll loop to decide `online`
   * without blocking battery/firmware polling on it. Defaults to a profile
   * read; a driver whose profile GET is unreliable (e.g. the V8 mouse's
   * best-effort `0x0E`) should override with a cheaper, more reliable probe.
   */
  async ping(): Promise<boolean> {
    return (await this.getActiveProfile()) !== null;
  }
  /** null = the device did not answer; [] = it answered with no stages. */
  async readDpiStages(): Promise<DpiStage[] | null> {
    return null;
  }
  /** 0-based index into readDpiStages()'s array; null = the device did not answer. */
  /**
   * A cheap re-read of the state an on-device button can change.
   *
   * The contract is the cost, not the content: an implementation MUST be
   * substantially cheaper than calling the individual `read*` methods, because
   * this is polled on a cadence while a device screen is open. A driver with
   * no cheap path returns null — the default — and is simply never live-polled,
   * which is what keeps every keyboard out of the poller with no extra gating.
   */
  async readLiveState(): Promise<LiveState | null> {
    return null;
  }

  async readActiveDpiStage(): Promise<number | null> {
    return null;
  }
  async readPollRate(): Promise<number | null> {
    return null;
  }
  async readSensor(): Promise<SensorSettings | null> {
    return null;
  }
  async readPower(): Promise<PowerSettings | null> {
    return null;
  }
  async readButtons(): Promise<Record<number, ButtonMapping> | null> {
    return null;
  }
  async readMagnetic(): Promise<MagneticKeySettings[]> {
    return [];
  }
  /** The per-zone bindings of mod-tap and DKS keys, by slot — see
   *  `KeyZoneBindings` (a mod-tap key's is `[hold, tap]`). Null on every
   *  driver that has no such thing. */
  async readKeyZoneBindings(): Promise<KeyZoneBindings | null> {
    return null;
  }
  /** Which magnetic switch is fitted per key — magnetism page 252. Null on
   *  every driver that has no such page. */
  async readSwitchTypes(): Promise<Record<number, number> | null> {
    return null;
  }
  async setSwitchTypes(_a: { slot: number; switchId: number }[]): Promise<WriteResult> {
    return { ok: false, verified: 'unverified', error: 'Switch replacement not supported' };
  }
  async readLighting(): Promise<LightingSettings[]> {
    return [];
  }
  async readSideLighting(): Promise<SideLightingSettings | null> {
    return null;
  }
  /** The per-key picture; null when the device did not answer. A driver
   *  with no per-key lighting has no picture at all — the empty one. */
  async readPerKeyLighting(): Promise<PerKeyColor[] | null> {
    return [];
  }
  async readReceiverLed(): Promise<ReceiverLedSettings | null> {
    return null;
  }
  async readDpiLed(): Promise<DpiLedSettings | null> {
    return null;
  }
  async readFnLayer(): Promise<Record<number, string>> {
    return {};
  }
  /** Every slot's current binding for one layer; null = the device didn't
   *  answer (never fabricate a table — see compx-keyboard.ts). */
  async readKeyBindings(_layer: 'base' | 'fn'): Promise<Record<number, KeyBinding> | null> {
    return null;
  }
  async readMacros(): Promise<Macro[]> {
    return [];
  }
  /** Debounce time in ms, or null if the device did not answer. */
  async readKeyboardOptions(): Promise<
    import('@shared/types/keyboard-settings').KeyboardOptions | null
  > {
    return null;
  }

  async setKeyboardOptions(
    _o: Partial<import('@shared/types/keyboard-settings').KeyboardOptions>,
  ): Promise<WriteResult> {
    return this.notSupported('Keyboard options');
  }

  async readDebounce(): Promise<number | null> {
    return null;
  }
  async readPerformance(): Promise<
    import('@shared/types/mouse-settings').PerformanceSettings | null
  > {
    return null;
  }
  async readDpiDynamic(): Promise<
    import('@shared/types/mouse-settings').DpiDynamicSettings | null
  > {
    return null;
  }

  // -- writes (override as available) ------------------------------------
  async setActiveProfile(_slot: number): Promise<WriteResult> {
    return this.notSupported('Profile switch');
  }
  async setDpiStages(_s: DpiStage[]): Promise<WriteResult> {
    return this.notSupported('DPI');
  }
  async setActiveDpiStage(_i: number): Promise<WriteResult> {
    return this.notSupported('DPI stage');
  }
  async setPollRate(_hz: number): Promise<WriteResult> {
    return this.notSupported('Polling rate');
  }
  async setSensor(_s: SensorSettings): Promise<WriteResult> {
    return this.notSupported('Sensor');
  }
  async setPower(_p: PowerSettings): Promise<WriteResult> {
    return this.notSupported('Power');
  }
  async setButton(_button: number, _action: string): Promise<WriteResult> {
    return this.notSupported('Buttons');
  }
  /** Rich button assignment (action + params + combo/multimedia/macro payload). */
  async setButtonMapping(
    _button: number,
    _mapping: import('@shared/types/mouse-settings').ButtonMapping,
  ): Promise<WriteResult> {
    return this.notSupported('Buttons');
  }
  async setMagneticKey(_k: MagneticKeySettings, _opts?: MagneticWriteOpts): Promise<WriteResult> {
    return this.notSupported('Magnetic switches');
  }
  /** Bulk per-key write for a multi-key selection. Default: sequential
   *  `setMagneticKey` calls; a family that can skip unchanged pages or pace
   *  frames (e.g. CompxHeKeyboard) should override for real batching. */
  async setMagneticKeys(
    keys: MagneticKeySettings[],
    _previous?: MagneticKeySettings[],
    opts?: MagneticWriteOpts,
  ): Promise<WriteResult> {
    const frames: string[] = [];
    for (const k of keys) {
      const r = await this.setMagneticKey(k, opts);
      frames.push(...(r.frames ?? []));
      if (!r.ok) return { ...r, frames };
    }
    return { ok: true, verified: 'unverified', frames };
  }
  async setMagneticGlobal(_mm: number): Promise<WriteResult> {
    return this.notSupported('Magnetic switches');
  }
  /** Write one key's per-zone bindings: a DKS key's actions 2-4 in zones 1-3,
   *  or a mod-tap key's hold in zone 0 with its tap in zone 1 — see
   *  `KeyZoneBindings`. */
  async setKeyZoneBindings(_slot: number, _zones: Array<string | null>): Promise<WriteResult> {
    return this.notSupported('Key zone bindings');
  }
  /** Recalibrate the Hall sensors — `scope: 'zero'` (rest point) or `'max'` (full travel). */
  async setMagneticCalibration(_scope: 'zero' | 'max'): Promise<WriteResult> {
    return this.notSupported('Magnetic calibration');
  }
  async setDebounce(_ms: number): Promise<WriteResult> {
    return this.notSupported('Debounce');
  }
  async setPerformance(
    _p: import('@shared/types/mouse-settings').PerformanceSettings,
  ): Promise<WriteResult> {
    return this.notSupported('Performance mode');
  }
  async setDpiDynamic(
    _d: import('@shared/types/mouse-settings').DpiDynamicSettings,
  ): Promise<WriteResult> {
    return this.notSupported('DPI dynamic sensitivity');
  }
  /**
   * @param opts.quiet suppress the read-back warning toast — for a write made
   *   on behalf of another action, which folds this result into its own.
   * @param opts.streaming skip the read-back entirely. For host-driven
   *   effects (see main/lighting/ambient.ts) that write several times a
   *   second: a verify per frame would double the traffic on an endpoint that
   *   wedges under exactly that, to confirm a value about to be replaced.
   */
  async setLighting(
    _l: LightingSettings,
    _opts: { quiet?: boolean; streaming?: boolean } = {},
  ): Promise<WriteResult> {
    return this.notSupported('Lighting');
  }
  async setSideLighting(_l: SideLightingSettings): Promise<WriteResult> {
    return this.notSupported('Side lighting');
  }
  async setPerKeyLighting(_keys: PerKeyColor[], _opts?: PerKeyLightingOpts): Promise<WriteResult> {
    return this.notSupported('Per-key lighting');
  }
  async setReceiverLed(_l: ReceiverLedValues): Promise<WriteResult> {
    return this.notSupported('Receiver LED');
  }
  async setDpiLed(_l: DpiLedSettings): Promise<WriteResult> {
    return this.notSupported('DPI LED');
  }
  async setKeyRemap(_layer: 'base' | 'fn', _index: number, _action: string): Promise<WriteResult> {
    return this.notSupported('Key remap');
  }
  async saveMacro(_m: Macro): Promise<WriteResult> {
    return this.notSupported('Macros');
  }
  async deleteMacro(_id: string): Promise<WriteResult> {
    return this.notSupported('Macros');
  }
  async restoreDefaults(): Promise<WriteResult> {
    return this.notSupported('Restore');
  }

  /** Put the receiver into pairing mode (wireless devices). */
  async startPairing(): Promise<WriteResult> {
    return this.notSupported('Pairing');
  }
  /** Poll pairing progress; `null` = the receiver did not answer. */
  async getPairingStatus(): Promise<PairingStatus | null> {
    return null;
  }

  /** Enable/disable the live per-key travel report stream (magnetic keyboards). */
  async startTravelStream(): Promise<TravelStreamResult> {
    return { ok: false, unsupported: true, error: 'Live travel not supported by this device' };
  }
  async stopTravelStream(): Promise<void> {
    /* no-op */
  }
  /**
   * One poll of the travel stream; null when nothing is pending. `keys` is
   * decoded and scaled server-side (not left to the renderer to guess at)
   * — slot-indexed, matching every other per-key wire operation.
   *
   * `complete` distinguishes "every key not listed is genuinely at rest" from
   * "this sample was discarded". A released key is expressed by ABSENCE from
   * `keys`, so a sample the driver threw away is otherwise indistinguishable
   * from the whole board coming up at once — which is what made a key that
   * was still held read as released.
   */
  async readTravel(): Promise<TravelSample | null> {
    return null;
  }

  /**
   * Read every readable block for a full backup snapshot. Subclasses list the
   * GET commands they support; the base drives the reads.
   */
  protected backupCommands(): number[] {
    return [];
  }

  /**
   * What a backup of this device has to hold before anything is written to it
   * (manager.ts `ensureBackup`). A driver that writes must override this —
   * test/contract/backup-policy.test.ts holds every one to it.
   */
  backupPolicy(): BackupPolicy {
    return { kind: 'full', required: [] };
  }

  /**
   * Delay between the GETs `backup()` issues, in ms.
   *
   * Some firmware wedges its config endpoint under bursty feature-report I/O.
   * That matters more here than anywhere else: `backup()` is what
   * `ensureBackup()` runs before the FIRST write to a device, so an unpaced
   * sweep turns the mandatory safety step into the thing that breaks the
   * device. 0 keeps the old behaviour for families that don't care.
   */
  protected backupPaceMs = 0;

  async backup(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let first = true;
    for (const cmd of this.backupCommands()) {
      if (!first && this.backupPaceMs) {
        await new Promise((r) => setTimeout(r, this.backupPaceMs));
      }
      first = false;
      const reply = await this.ch.request(this.frame(cmd), cmd);
      if (reply) out[`0x${cmd.toString(16)}`] = toHex(reply);
    }
    return out;
  }

  async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    // Default: replaying raw GET payloads as SET is family-specific and unsafe
    // to generalise. Subclasses that can do it override this.
    void blocks;
    return this.notSupported('Backup restore');
  }
}
