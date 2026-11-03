/**
 * Capabilities: the single hinge of the modular architecture. A device
 * descriptor declares what it HAS; a config tab declares what it NEEDS; the
 * config screen renders the intersection.
 *
 * Split out of the former shared/types.ts.
 */

// ---------------------------------------------------------------------------
// Capabilities — the single hinge of the modular architecture.
// A device descriptor declares what it HAS; a config tab declares what it
// NEEDS; the config screen renders the intersection.
// ---------------------------------------------------------------------------

export type Capability =
  // shared
  /** real per-slot hardware memory the device switches between, selected with
   *  one SET_PROFILE frame (the V8 mouse and both keyboards) */
  | 'profiles'
  | 'firmwareUpdate'
  | 'restore'
  // mouse
  | 'dpi'
  | 'pollRate'
  | 'sensorTuning'
  | 'motionSync'
  | 'angleSnapping'
  | 'rippleControl'
  | 'lod'
  | 'highFpsScan'
  | 'longDistanceMode'
  | 'angleMode'
  | 'buttonRemap'
  | 'sleepTimer'
  | 'dpiIndicatorLed'
  | 'receiverLed'
  | 'mouseLighting'
  | 'pairing'
  /** sensor performance mode select — LP / HP / Corded (vendor "Select mode") */
  | 'sensorMode'
  /** key-response-time / debounce on a mouse (the keyboard uses `debounce`) */
  | 'mouseDebounce'
  /** "Highest performance" mode with an idle timeout (no V8 control — future mice) */
  | 'perfMode'
  /** DPI Dynamic Sensitivity curve — Classic / Natural / Jump / Custom (future mice) */
  | 'dpiDynamic'
  // keyboard
  | 'magneticSwitches'
  | 'rapidTrigger'
  | 'dks'
  /** SOCD / snap-tap key pairing (magnetic page 9) */
  | 'socd'
  /** mod-tap: modifier when held, normal key when tapped (magnetic page 5) */
  | 'modTap'
  /**
   * Hot-swappable magnetic switches: which model is fitted per key is stored
   * on the board (magnetism page 252) and can be reassigned.
   *
   * `inferred`. The page is documented and the id space comes from the
   * vendor's own enum, but no Attack Shark board has been observed acting on
   * it — see shared/keyboard-switches.ts.
   */
  | 'replaceableSwitches'
  | 'keyRemap'
  | 'fnLayer'
  | 'perKeyLighting'
  | 'sideLighting'
  | 'screen'
  | 'debounce'
  /** the KBOPTION register: Fn OS/profile, anti-mistouch, RT stabilisation (and
   *  swap-WASD, which is read and preserved but not exposed — see
   *  `KeyboardOptions.swapWasd`) */
  | 'keyboardOptions'
  | 'keystroke'
  // shared advanced
  | 'macros'
  | 'autoSwitch';
