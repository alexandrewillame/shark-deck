/**
 * App-level settings and static per-OS facts.
 *
 * Split out of the former shared/types.ts.
 */
import type { BackgroundEffect } from '../backgrounds';

export type ThemePalette =
  | 'shark-cyan'
  | 'blue'
  | 'emerald'
  | 'amber'
  | 'red'
  | 'crimson'
  | 'pink'
  | 'violet'
  | 'grey'
  | 'grey-brown'
  | 'black'
  | 'synthwave'
  | 'lime'
  | 'frost';
/** Light/dark selection; 'system' follows the OS via nativeTheme. */
export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppSettings {
  startAtBoot: boolean;
  minimizeToTray: boolean;
  language: string;
  /** accent colour palette */
  palette: ThemePalette;
  /** light / dark / follow-system */
  themeMode: ThemeMode;
  /** The background behind every screen — `none` is the plain theme. Drawn by
   *  renderer/background/, under panels that turn frosted while it is on. */
  background: BackgroundEffect;
  /** Colour the background from the palette (its accent and secondary)
   *  rather than the effect's own colours — orange fire, green aurora. */
  backgroundPalette: boolean;
  /** How strongly the background is drawn, 0-100. */
  backgroundIntensity: number;
  /** Let the background move; off, it is one still frame. Unset until the
   *  Animate switch is first flipped, and until then the system decides: still
   *  where it asks for reduced motion (renderer/background/motion.ts). */
  backgroundAnimate?: boolean;
  pollSeconds: number;
  overlayEnabled: boolean;
  batteryLowThreshold: number;
  /** the per-device config screen's tab rail (Overview/Profile/…) shows icons only */
  railCollapsed: boolean;
  /** user-dragged card order on the home grid, by device id — devices not
   *  listed here (new pairings, or a stale id for a device that's gone) sort
   *  after the ones that are, in their natural (scan) order. */
  deviceOrder: string[];
  /**
   * Developer mode: populate the home grid with one simulated device per
   * supported shape, so the whole UI is navigable with no hardware attached.
   * The toggle is only rendered in unpackaged builds (see AppSettingsScreen
   * and PlatformInfo.isDev); the flag itself is inert otherwise.
   */
  devMode: boolean;
  /**
   * Per-effect lighting parameters, remembered so each effect keeps its own
   * brightness/speed/colour instead of inheriting whatever the last one used.
   *
   * The device holds exactly one effect and one set of parameters — this is
   * UI memory, not device state, which is why it lives in app settings rather
   * than in a profile payload. Keyed `model/zone/effectId`; effect **id**, not
   * label, so correcting a display name does not orphan someone's settings.
   *
   * Unknown or missing keys just fall through to whatever the board reports,
   * so an old settings file and a new one both work.
   */
  lightingPresets?: Record<string, LightingPreset>;
}

/** One effect's remembered parameters — see `AppSettings.lightingPresets`. */
export interface LightingPreset {
  /** 0-100, the same scale as `LightingSettings`. */
  brightness?: number;
  speed?: number;
  color?: [number, number, number];
  dazzle?: boolean;
  /** direction/variant index */
  option?: number;
}

/** OS-dependent facts the renderer needs to stop hardcoding Windows
 *  assumptions (the ".exe" suffix, the mouse-settings deep link, native
 *  window-chrome buttons). See main/platform/index.ts. */
export interface PlatformInfo {
  os: 'win32' | 'darwin' | 'linux';
  /** '.exe' on Windows, '' elsewhere — appended to a bare process name in the
   *  Auto-Switch trigger UI. */
  processSuffix: string;
  /** a realistic example for the "type a process name" placeholder */
  processExample: string;
  /** whether openMouseSettings() can do anything on this OS/DE */
  canOpenMouseSettings: boolean;
  /** macOS draws native traffic lights (titleBarStyle: 'hidden'); the
   *  renderer should hide its own minimize/maximize/close buttons. */
  nativeTrafficLights: boolean;
  /** true when the app is unpackaged (`!app.isPackaged`) — the renderer gates
   *  developer-only controls on this rather than on a separate IPC call. */
  isDev: boolean;
  /** SharkDeck's own version, from package.json via `app.getVersion()`.
   *  Rides along here rather than getting its own IPC method — this is
   *  already the "static facts about this install" channel. */
  appVersion: string;
}
