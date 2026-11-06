import type { DeviceDescriptor } from '@shared/types/device';
import type {
  KeyboardOptions,
  KeyZoneBindings,
  MagneticKeySettings,
} from '@shared/types/keyboard-settings';
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
  DpiDynamicSettings,
  DpiStage,
  PairingStatus,
  PerformanceSettings,
  PowerSettings,
  SensorSettings,
} from '@shared/types/mouse-settings';
import { KB_LIGHT_EFFECTS, KB_PERKEY_EFFECT_INDEX } from '@shared/lighting';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import { SWITCH_FACTORY_DEFAULT } from '@shared/keyboard-switches';
import { applicableDpiStages, clampActiveDpiStage } from '@shared/mouse-wire';
import { CATALOG } from './catalog';
import { KEYBOARDS } from './catalog/keyboards';
import { hubMouseRoster } from './catalog/hub-mice';
import { GEARHUB_MICE } from './catalog/gearhub-mice';
import { jxcMouseRoster } from './catalog/jxc-mice';
import { readOnly } from './identity';
import { Driver, type MagneticWriteOpts, type TravelSample } from './drivers/base';
import { decodeQuad, quadFor } from './drivers/compx-keyboard';
import { MT_HOLD_ZONE, MT_TAP_ZONE, isModTapEntry } from '@shared/key-zones';

/**
 * Developer mode's simulated devices.
 *
 * The home grid, the config rail and every tab are driven entirely by the
 * `LiveDevice`/`Capability` pair the main process reports, so with nothing
 * plugged in none of them are reachable. This module fabricates one device per
 * *supported shape* — not per PID — so the whole UI can be navigated with no
 * hardware attached (see docs/roadmap.md, which records several work batches
 * done with no device on the desk).
 *
 * Nothing here ever touches HID: `VirtualDriver` overrides every method that
 * would reach `this.ch`, and the manager hands it a channel it never opens.
 * Nothing here ever touches a per-model on-disk store either — every
 * descriptor is tagged `simulated: true`, which is the flag the write paths in
 * ipc.ts and manager.ts check before persisting anything.
 */

/** The endpoint the simulated read-only card claims (another brand's mouse on a Hub PID). */
const SIM_FOREIGN_VID = 0x3554;
const SIM_FOREIGN_PID = 0xf5f6;

/** How long a simulated pairing "takes" — long enough for the pane to show
 *  its in-progress state, short enough not to test the operator's patience. */
const VIRTUAL_PAIR_MS = 4_000;

/**
 * One descriptor per distinct device shape the app can render:
 *  - every hand-authored `CATALOG` model (so a new catalog file automatically
 *    gains a simulated card — there is no second list to maintain);
 *  - one keyboard per distinct shape in the generated catalogue (driver,
 *    capabilities, key layout, wireless, magnetic limits) — ~80 model ids
 *    collapse to the handful of menus they actually produce;
 *  - every Hub mouse name and sensor class (catalog/hub-mice.ts);
 *  - a read-only card, as another brand's device on the same chip shows.
 */
export function virtualDescriptors(): DeviceDescriptor[] {
  const seen = new Set(CATALOG.map((d) => d.model));
  const shapes = new Set<string>();
  const layoutIds = new Map<unknown, number>();
  const shapeOf = (d: DeviceDescriptor) => {
    const km = d.spec.keyMatrix;
    // A layout Shark Deck addresses key by key is drawn and written per key,
    // so each is its own shape; a geometry-only drawing changes no menu.
    const addressed = km?.layout && km.layoutStatus !== 'none' ? km.layout : null;
    if (addressed && !layoutIds.has(addressed)) layoutIds.set(addressed, layoutIds.size);
    const mag = d.spec.magnetic;
    return JSON.stringify([
      d.driver,
      [...d.capabilities].sort(),
      km?.layoutStatus,
      addressed ? layoutIds.get(addressed) : null,
      !!d.spec.wireless,
      d.spec.lighting?.zones,
      // which travel controls exist, not their exact bounds
      mag ? [Object.keys(mag.ranges ?? {}).sort(), !!mag.deadZoneTop] : null,
    ]);
  };
  const keyboards = KEYBOARDS.filter((d) => {
    if (seen.has(d.model) || d.identity === 'unsupported') return false;
    const shape = shapeOf(d);
    if (shapes.has(shape)) return false;
    shapes.add(shape);
    return true;
  });
  const foreign: DeviceDescriptor = {
    ...readOnly(
      { vid: SIM_FOREIGN_VID, pid: SIM_FOREIGN_PID },
      'mouse',
      'foreign',
      'vendor 7, model 2',
    ),
    model: 'simulated-foreign-mouse',
  };
  const gearhub = [...new Map([...GEARHUB_MICE.values()].map((d) => [d.model, d])).values()];
  return [
    ...CATALOG,
    ...keyboards,
    ...hubMouseRoster(),
    ...gearhub,
    ...jxcMouseRoster(),
    foreign,
  ].map((d) => ({
    ...d,
    simulated: true as const,
  }));
}

/** In-memory stand-in for everything the wire protocol would hold. */
interface VirtualState {
  activeProfile: number;
  dpiStages: DpiStage[];
  activeDpiStage: number;
  pollRate: number;
  sensor: SensorSettings;
  power: PowerSettings;
  buttons: Record<number, ButtonMapping>;
  magnetic: MagneticKeySettings[];
  /** slot -> switch model id (magnetism page 252). */
  switchTypes: Record<number, number>;
  lighting: LightingSettings[];
  sideLighting: SideLightingSettings | null;
  perKey: PerKeyColor[];
  receiverLed: ReceiverLedSettings | null;
  dpiLed: DpiLedSettings | null;
  keyBindings: Record<'base' | 'fn', Record<number, KeyBinding>>;
  fnLayer: Record<number, string>;
  /** Mod-tap / DKS zone bindings by slot — like the real driver's, a record of
   *  what was written rather than anything the board reports. */
  zoneBindings: KeyZoneBindings;
  macros: Macro[];
  debounceMs: number;
  keyboardOptions: KeyboardOptions;
  performance: PerformanceSettings;
  dpiDynamic: DpiDynamicSettings;
}

/**
 * A device that answers plausibly and remembers what it was told, without a
 * wire behind it.
 *
 * One class parameterised by the descriptor rather than per-family subclasses:
 * the capability list and `spec` already differ per descriptor, and the UI only
 * asks for what capabilities allow, so the same seeding logic covers a mouse, a
 * Hall-effect keyboard and both generic families.
 *
 * Two rules make the simulated devices feel real rather than broken:
 *
 *  - **Never return `null` for a read the capabilities imply.** `useDeviceData`
 *    (renderer/tabs/common.tsx) registers the aggregate "couldn't read" banner
 *    on strictly `data === null`; `[]` and `{}` are fine. A missing seed would
 *    show up as a read-failure banner on a device that is supposedly online.
 *  - **Writes report `verified: 'match'`.** `useWrite()` toasts an error on
 *    `!ok` and a warning on `'mismatch'`, so anything else makes dev mode
 *    noisy. Each write merges into `state`, so the matching read reflects it.
 */
export class VirtualDriver extends Driver {
  /**
   * One state per onboard slot, because that is what an onboard slot IS.
   *
   * A single shared state made every slot identical, so switching profiles in
   * developer mode changed nothing on screen — and developer mode is this
   * repo's substitute for the rendering tests it does not have, so a feature
   * that cannot be seen there cannot be walked. Slots are seeded lazily: slot
   * 1 on construction, the rest as a copy of slot 1 the first time they are
   * selected, which is also how a real board that has never had a slot
   * configured behaves.
   *
   * A keyboard is the exception, because its slot carries its actuation
   * settings and nothing else (see `profileFieldsFor`): it keeps ONE state,
   * and only `magnetic` is swapped per slot — `slotMagnetic` below, exchanged
   * in `setActiveProfile`. Otherwise developer mode would show a per-slot
   * lighting or remap that the real board does not have.
   */
  private readonly slotStates = new Map<number, VirtualState>();
  private readonly slotMagnetic = new Map<number, MagneticKeySettings[]>();
  private slot = 1;

  constructor(ctx: ConstructorParameters<typeof Driver>[0]) {
    super(ctx);
    this.slotStates.set(this.slot, this.seed());
  }

  /** Only actuation follows the slot — see the class comment. */
  private get actuationOnlySlots(): boolean {
    return this.d.kind === 'keyboard';
  }

  /** The live state — whichever slot is selected. */
  private get s(): VirtualState {
    const key = this.actuationOnlySlots ? 1 : this.slot;
    let st = this.slotStates.get(key);
    if (!st) {
      // Clone of slot 1, not a fresh seed: a fresh seed would randomise the
      // per-key colours and read as corruption rather than as an untouched
      // slot.
      st = structuredClone(this.slotStates.get(1) ?? this.seed());
      st.activeProfile = this.slot;
      this.slotStates.set(this.slot, st);
    }
    return st;
  }

  private has(c: string): boolean {
    return this.d.capabilities.includes(c as never);
  }

  /** Layout entries paired with the firmware slot every per-key wire op uses. */
  private slots(): {
    slot: number;
    row: number;
    col: number;
    label: string;
    code?: number | null;
  }[] {
    const layout = this.d.spec.keyMatrix?.layout ?? [];
    return layout.map((k, i) => ({
      slot: k.slot ?? i,
      row: k.row,
      col: k.col,
      label: k.label,
      code: k.code,
    }));
  }

  private seed(): VirtualState {
    const spec = this.d.spec;
    const rates = spec.pollRates ?? [125, 250, 500, 1000];
    const dpi = spec.dpi;
    const keys = this.slots();

    // Four stages (or the sensor's maximum, if fewer), spread across its range
    // on a rounded step, so the DPI tab's auto-zoom has something sensible to
    // fit rather than N identical values. All enabled, as the real driver
    // reports them: it reads only the stages the mouse cycles
    // (DPI_STAGE_COUNT), and the tab has no per-stage toggle — a disabled
    // stage here drew as a row that was neither on the track nor selectable.
    const stageCount = Math.min(dpi?.stages ?? 0, 4);
    const dpiStages: DpiStage[] = [];
    for (let i = 0; i < stageCount; i++) {
      const raw = dpi ? dpi.min + ((dpi.max - dpi.min) / (stageCount + 2)) * (i + 1) : 800;
      const step = dpi?.step || 50;
      dpiStages.push({
        index: i,
        dpi: Math.max(dpi?.min ?? 50, Math.round(raw / step) * step),
        color: HUES[i % HUES.length]!,
        enabled: true,
      });
    }

    const zones = spec.lighting?.zones ?? [];
    const lighting: LightingSettings[] =
      this.d.kind === 'keyboard' && spec.lighting?.perKey
        ? [
            {
              zone: 'keyboard',
              effect: KB_LIGHT_EFFECTS[4]!,
              brightness: 80,
              speed: 50,
              color: [0, 200, 200],
              enabled: true,
            },
          ]
        : zones
            .filter((z) => z !== 'dpi-led' && z !== 'receiver-led' && z !== 'side')
            .map((zone) => ({
              zone,
              effect: 'Always On',
              brightness: 80,
              speed: 50,
              color: [0, 200, 200] as [number, number, number],
              enabled: true,
            }));

    const base: Record<number, KeyBinding> = {};
    const fn: Record<number, KeyBinding> = {};
    const fnLayer: Record<number, string> = {};
    for (const k of keys) {
      base[k.slot] = binding(k.slot, k.code ?? null, k.label);
      fn[k.slot] = binding(k.slot, null, `Fn+${k.label}`);
      fnLayer[k.slot] = `Fn+${k.label}`;
    }

    const buttons: Record<number, ButtonMapping> = {};
    for (const b of spec.buttonMap ?? []) {
      buttons[b.index] = { actionKey: 'button', action: 1, param: b.index + 1 };
    }

    return {
      activeProfile: 1,
      dpiStages,
      activeDpiStage: 0,
      pollRate: rates[rates.length - 1] ?? 1000,
      sensor: {
        lod: spec.lodOptions?.[0]?.wire ?? 1,
        motionSync: true,
        angleSnapping: false,
        angleDegrees: 0,
        rippleControl: false,
        highFpsScan: false,
        longDistanceMode: false,
        sensorMode: 1,
        angleMode: false,
      },
      power: { sleepTimerSec: 300, deepSleepSec: 0, never: false },
      buttons,
      // The factory values, taken from the same table the Actuation tab
      // reads — a simulated board that seeds different numbers is a fake that
      // disagrees with the panel describing it. As Reset writes them (2.0 mm
      // linked, dead zones 0.3), so every key of a fresh simulated board
      // passes `isFactoryDefault` and opens in the rail's Default group, the
      // way a real untouched board does.
      magnetic: keys.map((k) => ({
        row: k.row,
        col: k.col,
        actuationMm: KB_TRAVEL_RANGE.travel.default,
        releaseMm: KB_TRAVEL_RANGE.travel.default,
        rapidTrigger: false,
        rtPressMm: KB_TRAVEL_RANGE.rt.default,
        rtReleaseMm: KB_TRAVEL_RANGE.rt.default,
        deadZoneMm: KB_TRAVEL_RANGE.deadzone.default,
        deadZoneBottomMm: KB_TRAVEL_RANGE.deadzone.default,
        mode: 'normal' as const,
      })),
      // SWITCH_FACTORY_DEFAULT on every key, which is what a board that has
      // never had a switch assigned actually reads back (and what the only
      // R85HE snapshot shows). Seeding invented switch models would make the
      // simulated board disagree with every real one.
      switchTypes: Object.fromEntries(
        keys.filter((k) => k.slot != null).map((k) => [k.slot!, SWITCH_FACTORY_DEFAULT]),
      ),
      lighting,
      sideLighting: this.has('sideLighting')
        ? {
            effect: 'Breath',
            brightness: 80,
            speed: 50,
            color: [0, 200, 255],
            enabled: true,
            dazzle: false,
          }
        : null,
      perKey: keys.map((k, i) => ({ index: k.slot, color: HUES[i % HUES.length]! })),
      receiverLed: this.has('receiverLed')
        ? { indications: [1, 2, 3], source: 'device' as const }
        : null,
      dpiLed: this.has('dpiIndicatorLed')
        ? { effect: 1, brightness: 100, speed: 50, flagRaw: 1 }
        : null,
      keyBindings: { base, fn },
      fnLayer,
      zoneBindings: {},
      macros: [],
      debounceMs: spec.debounceRange?.min ?? 5,
      // plausible defaults, matching what a real R85HE reads back
      keyboardOptions: {
        fnOs: 'win',
        fnProfile: 0,
        antiMistouch: true,
        rtStab: 0,
        swapWasd: false,
      },
      performance: { enabled: false, timeoutSec: 60 },
      dpiDynamic: { mode: 1 },
    };
  }

  // -- reads --------------------------------------------------------------
  // Every one of these must be non-null whenever the matching capability is
  // present; see the class doc comment.

  override async ping(): Promise<boolean> {
    return true;
  }

  override async getFirmware(): Promise<FirmwareInfo | null> {
    return {
      device: '1.05',
      receiver: this.d.kind === 'mouse' ? '1.02' : null,
      deviceRaw: 0x0105,
      receiverRaw: this.d.kind === 'mouse' ? 0x0102 : 0,
      readState: 'ok',
    };
  }

  override async getBattery(): Promise<{
    level: number | null;
    charging: boolean;
    raw: number | null;
    millivolts: number | null;
  }> {
    // Wired boards have no cell: a null level is what makes the card hide the
    // battery pill, matching the real R85HE.
    if (this.d.kind !== 'mouse')
      return { level: null, charging: false, raw: null, millivolts: null };
    return { level: 72, charging: false, raw: 72, millivolts: 3900 };
  }

  override async getActiveProfile(): Promise<number | null> {
    return this.s.activeProfile;
  }
  override async readDpiStages(): Promise<DpiStage[] | null> {
    return this.s.dpiStages;
  }
  override async readActiveDpiStage(): Promise<number | null> {
    return this.s.activeDpiStage;
  }
  /**
   * The same cheap probe a real mouse answers, so the live-monitoring path is
   * exercised with no hardware — and so this can never silently drift from
   * `CompxMouse8K.readLiveState` (virtual.test.ts asserts both that it answers
   * and that it reports back what was written).
   *
   * A descriptor with no `dpi` capability reports nulls for the DPI fields
   * rather than fabricating stages it does not have.
   */
  override async readLiveState(): Promise<LiveState | null> {
    const hasDpi = this.has('dpi');
    return {
      activeDpiStage: hasDpi ? this.s.activeDpiStage : null,
      dpiStageCount: hasDpi ? this.s.dpiStages.length : null,
      pollRate: this.has('pollRate') ? this.s.pollRate : null,
    };
  }
  override async readPollRate(): Promise<number | null> {
    return this.s.pollRate;
  }
  override async readSensor(): Promise<SensorSettings | null> {
    return this.s.sensor;
  }
  override async readPower(): Promise<PowerSettings | null> {
    return this.s.power;
  }
  override async readButtons(): Promise<Record<number, ButtonMapping> | null> {
    return this.s.buttons;
  }
  override async readMagnetic(): Promise<MagneticKeySettings[]> {
    return this.s.magnetic;
  }
  /**
   * A still board: the stream arms, and every sample is a complete one with no
   * key down — what a real magnetic board answers with nobody touching it.
   *
   * The base answers "no stream", which went unnoticed while the manager never
   * waited for the answer (and quietly gave up after eight empty reads). Now
   * that the answer reaches the Test view, a simulated R85HE would say it has
   * no live travel, and that view could not be walked here at all.
   */
  override async startTravelStream(): Promise<TravelStreamResult> {
    return this.has('magneticSwitches') ? { ok: true } : super.startTravelStream();
  }
  override async readTravel(): Promise<TravelSample | null> {
    return this.has('magneticSwitches')
      ? { raw: new Uint8Array(0), keys: [], complete: true }
      : null;
  }
  override async readKeyZoneBindings(): Promise<KeyZoneBindings | null> {
    return this.has('magneticSwitches') ? this.s.zoneBindings : null;
  }
  override async readSwitchTypes(): Promise<Record<number, number> | null> {
    return this.has('replaceableSwitches') ? this.s.switchTypes : null;
  }
  override async setSwitchTypes(
    assignments: { slot: number; switchId: number }[],
  ): Promise<WriteResult> {
    for (const a of assignments) this.s.switchTypes[a.slot] = a.switchId;
    return { ok: true, verified: 'match' };
  }
  override async readLighting(): Promise<LightingSettings[]> {
    return this.s.lighting;
  }
  override async readSideLighting(): Promise<SideLightingSettings | null> {
    return this.s.sideLighting;
  }
  override async readPerKeyLighting(): Promise<PerKeyColor[] | null> {
    return this.s.perKey;
  }
  override async readReceiverLed(): Promise<ReceiverLedSettings | null> {
    return this.s.receiverLed;
  }
  override async readDpiLed(): Promise<DpiLedSettings | null> {
    return this.s.dpiLed;
  }
  override async readFnLayer(): Promise<Record<number, string>> {
    return this.s.fnLayer;
  }
  override async readKeyBindings(layer: 'base' | 'fn'): Promise<Record<number, KeyBinding> | null> {
    return this.s.keyBindings[layer];
  }
  override async readMacros(): Promise<Macro[]> {
    return this.s.macros;
  }
  override async readDebounce(): Promise<number | null> {
    return this.s.debounceMs;
  }
  override async readPerformance(): Promise<PerformanceSettings | null> {
    return this.s.performance;
  }
  override async readDpiDynamic(): Promise<DpiDynamicSettings | null> {
    return this.s.dpiDynamic;
  }
  /**
   * Simulates a real pairing rather than answering "done" immediately.
   *
   * `{ linked: true }` on the first poll used to make dev mode succeed one
   * second after the button press, which is exactly the bug the pane's state
   * machine now guards against — so it could never be exercised without
   * hardware. Instead: report the link DOWN for the first few seconds after
   * `startPairing`, then up, which is the `false -> true` transition the pane
   * requires. Never `null` — `virtual.test.ts` asserts no read on a
   * capability the descriptor exposes comes back null.
   */
  private pairingStartedAt: number | null = null;

  override async getPairingStatus(): Promise<PairingStatus | null> {
    if (this.pairingStartedAt === null) return { linked: true };
    return { linked: Date.now() - this.pairingStartedAt > VIRTUAL_PAIR_MS };
  }

  /**
   * Empty on purpose. `DeviceManager.ensureBackup()` skips writing a file when
   * a driver returns no blocks, so a simulated device cannot create a backup
   * that would then be reported as belonging to real hardware of this model.
   */
  override async backup(): Promise<Record<string, string>> {
    return {};
  }

  // -- writes -------------------------------------------------------------

  override async setActiveProfile(slot: number): Promise<WriteResult> {
    if (this.actuationOnlySlots && slot !== this.slot) {
      // Park the outgoing slot's actuation and bring in the new one's — a
      // copy of slot 1's the first time, like an unconfigured slot.
      const st = this.s;
      this.slotMagnetic.set(this.slot, st.magnetic);
      st.magnetic =
        this.slotMagnetic.get(slot) ?? structuredClone(this.slotMagnetic.get(1) ?? st.magnetic);
    }
    this.slot = slot;
    this.s.activeProfile = slot; // materialises the slot if it is new
    return this.ack('SET_PROFILE', [slot]);
  }
  /** Mirrors the real driver: disabled stages are dropped rather than stored,
   *  and the active stage is re-clamped onto what survives — so dev mode can't
   *  drift from hardware on the one behaviour that caused a disabled stage to
   *  be applied. See compx-mouse-8k.ts's setDpiStages. */
  override async setDpiStages(stages: DpiStage[]): Promise<WriteResult> {
    this.s.dpiStages = applicableDpiStages(stages);
    this.s.activeDpiStage = clampActiveDpiStage(this.s.activeDpiStage, this.s.dpiStages.length);
    return this.ack('SET_DPI', [this.s.dpiStages.length]);
  }
  override async setActiveDpiStage(i: number): Promise<WriteResult> {
    this.s.activeDpiStage = clampActiveDpiStage(i, this.s.dpiStages.length);
    return this.ack('SET_DPI_STAGE', [this.s.activeDpiStage]);
  }
  override async setPollRate(hz: number): Promise<WriteResult> {
    this.s.pollRate = hz;
    return this.ack('SET_POLL', [hz & 0xff]);
  }
  override async setSensor(v: SensorSettings): Promise<WriteResult> {
    this.s.sensor = { ...this.s.sensor, ...v };
    return this.ack('SET_SENSOR');
  }
  override async setPower(v: PowerSettings): Promise<WriteResult> {
    this.s.power = { ...this.s.power, ...v };
    return this.ack('SET_POWER');
  }
  override async setButton(button: number, action: string): Promise<WriteResult> {
    this.s.buttons[button] = { actionKey: action, action: 1, param: button };
    return this.ack('SET_BUTTON', [button]);
  }
  override async setButtonMapping(button: number, mapping: ButtonMapping): Promise<WriteResult> {
    this.s.buttons[button] = { ...mapping };
    return this.ack('SET_BUTTON', [button]);
  }
  override async setMagneticKey(
    k: MagneticKeySettings,
    opts?: MagneticWriteOpts,
  ): Promise<WriteResult> {
    const i = this.s.magnetic.findIndex((m) => m.row === k.row && m.col === k.col);
    if (i >= 0) this.s.magnetic[i] = { ...k };
    else this.s.magnetic.push({ ...k });
    // As the real driver: a key leaving mod-tap gets its own binding back,
    // which here is only the record letting go of it (the simulated base layer
    // never stopped being the key's own binding).
    if (k.mode !== 'mt' && !opts?.keepZoneBindings) {
      const slot = this.d.spec.keyMatrix?.layout?.find(
        (e) => e.row === k.row && e.col === k.col,
      )?.slot;
      if (slot !== undefined && isModTapEntry(this.s.zoneBindings[slot])) {
        const { [slot]: _gone, ...rest } = this.s.zoneBindings;
        this.s.zoneBindings = rest;
      }
    }
    return this.ack('SET_MAGNETIC', [k.row, k.col]);
  }
  override async setMagneticKeys(
    keys: MagneticKeySettings[],
    _previous?: MagneticKeySettings[],
    opts?: MagneticWriteOpts,
  ): Promise<WriteResult> {
    for (const k of keys) await this.setMagneticKey(k, opts);
    return this.ack('SET_MAGNETIC_BULK', [keys.length]);
  }
  override async setKeyZoneBindings(
    slot: number,
    zones: Array<string | null>,
  ): Promise<WriteResult> {
    // The real driver's rule: zone 0 is only ever a mod-tap hold, and comes
    // with the key's own binding (the tap) in zone 1.
    if (zones[MT_HOLD_ZONE] != null && !zones[MT_TAP_ZONE]) {
      return {
        ok: false,
        verified: 'unverified',
        error: "a binding in zone 0 is a mod-tap hold, and needs the key's own binding in zone 1",
      };
    }
    this.s.zoneBindings = { ...this.s.zoneBindings, [slot]: [...zones] };
    return this.ack('SET_KEYMATRIX_ZONES', [slot, zones.length]);
  }
  override async setMagneticGlobal(mm: number): Promise<WriteResult> {
    this.s.magnetic = this.s.magnetic.map((m) => ({ ...m, actuationMm: mm }));
    return this.ack('SET_MAGNETIC_ALL');
  }
  override async setMagneticCalibration(scope: 'zero' | 'max'): Promise<WriteResult> {
    return this.ack('CALIBRATE_' + scope.toUpperCase());
  }
  override async readKeyboardOptions(): Promise<KeyboardOptions | null> {
    return { ...this.s.keyboardOptions };
  }
  override async setKeyboardOptions(o: Partial<KeyboardOptions>): Promise<WriteResult> {
    this.s.keyboardOptions = { ...this.s.keyboardOptions, ...o };
    return this.ack('SET_KBOPTION');
  }
  override async setDebounce(ms: number): Promise<WriteResult> {
    this.s.debounceMs = ms;
    return this.ack('SET_DEBOUNCE', [ms]);
  }
  override async setPerformance(v: PerformanceSettings): Promise<WriteResult> {
    this.s.performance = { ...v };
    return this.ack('SET_PERFORMANCE');
  }
  override async setDpiDynamic(v: DpiDynamicSettings): Promise<WriteResult> {
    this.s.dpiDynamic = { ...v };
    return this.ack('SET_DPI_DYNAMIC');
  }
  override async setLighting(l: LightingSettings): Promise<WriteResult> {
    const i = this.s.lighting.findIndex((x) => x.zone === l.zone);
    if (i >= 0) this.s.lighting[i] = { ...l };
    else this.s.lighting.push({ ...l });
    return this.ack('SET_LEDPARAM');
  }
  override async setSideLighting(l: SideLightingSettings): Promise<WriteResult> {
    this.s.sideLighting = { ...l };
    return this.ack('SET_SLEDPARAM');
  }
  override async setPerKeyLighting(
    keys: PerKeyColor[],
    opts: PerKeyLightingOpts = {},
  ): Promise<WriteResult> {
    // Mirrors the real driver's ensureCustomEffect: applying a picture puts
    // the board on the per-key layer, and carries the brightness the caller
    // asked for so the pane's own brightness control reads back what it wrote.
    const l = this.s.lighting[0];
    if (l) {
      l.effect = KB_LIGHT_EFFECTS[KB_PERKEY_EFFECT_INDEX] ?? l.effect;
      l.enabled = true;
      if (opts.brightness !== undefined) l.brightness = opts.brightness;
    }
    // The WHOLE picture, as the real driver writes it: SET_USERPIC is one
    // whole-matrix write, and a key not in the list goes dark. This merged the
    // list into the old picture instead, and the editor sends only lit keys —
    // so after Clear all and Apply, the next Read brought the old picture back.
    this.s.perKey = keys.map((k) => ({ ...k }));
    return this.ack('SET_USERPIC', [keys.length]);
  }
  override async setReceiverLed(l: ReceiverLedValues): Promise<WriteResult> {
    this.s.receiverLed = { ...l, source: 'device' };
    return this.ack('SET_RECEIVER_LED');
  }
  override async setDpiLed(l: DpiLedSettings): Promise<WriteResult> {
    // Mirror the real driver's own 0x52 write, so a simulated card can't
    // drift from what CompxMouse8K would actually leave on the device.
    this.s.dpiLed = { ...l, flagRaw: l.effect ? 1 : 0 };
    return this.ack('SET_DPI_LED');
  }
  override async setKeyRemap(
    layer: 'base' | 'fn',
    index: number,
    action: string,
  ): Promise<WriteResult> {
    // Parsed as the real driver parses it — a usage, or an 8-digit raw quad —
    // so a simulated binding has the quad a real one would, and reads back
    // as the key it now is.
    const quad = quadFor(action);
    if (!quad) {
      return { ok: false, verified: 'unverified', error: `not a HID usage or quad: "${action}"` };
    }
    // Read back as the real driver reads its matrix (decodeQuad), so a media
    // key written here is "Media player" on the board, not its eight hex
    // digits, and a plain key is named rather than numbered.
    this.s.keyBindings[layer][index] = { ...decodeQuad(index, quad), provenance: 'unknown' };
    if (layer === 'fn') this.s.fnLayer[index] = action;
    // A mod-tap key's remap is its tap (see CompxHeKeyboard.setKeyRemap).
    const entry = this.s.zoneBindings[index];
    if (layer === 'base' && isModTapEntry(entry)) {
      const next = [...entry!];
      next[MT_TAP_ZONE] = action;
      this.s.zoneBindings = { ...this.s.zoneBindings, [index]: next };
    }
    return this.ack('SET_KEYMAP', [index]);
  }
  override async saveMacro(m: Macro): Promise<WriteResult> {
    const i = this.s.macros.findIndex((x) => x.id === m.id);
    if (i >= 0) this.s.macros[i] = { ...m };
    else this.s.macros.push({ ...m });
    return this.ack('SET_MACRO');
  }
  override async deleteMacro(id: string): Promise<WriteResult> {
    this.s.macros = this.s.macros.filter((x) => x.id !== id);
    return this.ack('DEL_MACRO');
  }
  override async restoreDefaults(): Promise<WriteResult> {
    Object.assign(this.s, this.seed());
    return this.ack('RESTORE');
  }
  override async startPairing(): Promise<WriteResult> {
    this.pairingStartedAt = Date.now();
    return this.ack('PAIR');
  }

  /**
   * A successful, verified write plus a frame-log line.
   *
   * `verified: 'match'` because `useWrite()` toasts on anything else. The hex
   * is fabricated, so it carries a `simulated` note — the Developer panel's
   * frame log is a reverse-engineering aid, and a made-up frame must never be
   * mistaken there for a real capture.
   */
  private ack(label: string, args: number[] = []): WriteResult {
    const hex = [0x00, ...args].map((b) => (b & 0xff).toString(16).padStart(2, '0')).join(' ');
    return { ok: true, verified: 'match', frames: [hex + '  ; simulated ' + label] };
  }
}

/** A readable colour ramp, reused for DPI-stage and per-key seed colours. */
const HUES: [number, number, number][] = [
  [255, 64, 64],
  [255, 160, 32],
  [255, 232, 32],
  [64, 224, 96],
  [32, 200, 255],
  [96, 112, 255],
  [200, 80, 255],
  [255, 96, 176],
];

function binding(
  slot: number,
  code: number | null | undefined,
  label: string,
  raw?: [number, number, number, number],
): KeyBinding {
  const usage = typeof code === 'number' ? code : null;
  return {
    slot,
    code: usage === null ? null : usage.toString(16).padStart(2, '0'),
    kind: usage === null ? 'unknown' : 'key',
    label,
    // The quad a real board holds for this binding — `[0, hi, lo, 0]` for a
    // plain key — so a simulated key's own binding can be written back as it
    // is (a mod-tap key's tap is exactly that).
    raw: raw ?? (usage === null ? [0, 0, 0, 0] : [0, (usage >> 8) & 0xff, usage & 0xff, 0]),
    provenance: 'unknown',
  };
}
