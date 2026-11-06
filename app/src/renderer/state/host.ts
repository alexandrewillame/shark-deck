/**
 * Which host this renderer runs in — the Electron app, or the browser edition
 * (src/web/, published on GitHub Pages) — and what that host can do.
 *
 * Fixed at build time: vite.web.config.ts defines `__SD_HOST__` as
 * 'browser'; the desktop build and the tests leave it undefined, which means
 * the desktop. Being a constant (not an IPC answer) is the point: the window
 * buttons and the auto-switch pill must not flash in the browser while a
 * round trip resolves, and the web bundle can drop what it never shows.
 *
 * Gate UI on `hostFeatures`, not on `HOST` — the same way device UI is gated
 * on capabilities rather than on model names.
 */
export type Host = 'desktop' | 'browser';

export const HOST: Host =
  typeof __SD_HOST__ === 'string' && __SD_HOST__ === 'browser' ? 'browser' : 'desktop';

const desktop = HOST === 'desktop';

export const hostFeatures = {
  /** Our own title bar: window buttons, drag-to-move, double-click to maximize. */
  windowChrome: desktop,
  /** Auto-switch, app profiles and the switch overlay — they watch the computer's running programs. */
  autoSwitch: desktop,
  /** The tray icon and minimise-to-tray. */
  tray: desktop,
  /** Start with the computer. */
  startAtBoot: desktop,
  /** The on-screen profile-switch popup. */
  overlay: desktop,
  /** A shortcut to the operating system's mouse settings. */
  mouseSettingsLink: desktop,
  /** Lighting that follows the screen or the music — a capture that must outlive the window's focus. */
  ambientLighting: desktop,
  /**
   * The row that offers developer mode's simulated devices. Its panel already
   * shows only in development builds; the browser edition's published build
   * never adds them (src/web/main.ts), its dev server does.
   */
  simulatedDevices: desktop || import.meta.env.DEV,
  /** Devices are reached one at a time, after the user picks each in the browser's own dialog. */
  devicePicker: !desktop,
  /** Quitting with a change nobody applied asks first, in the app's own prompt. */
  quitPrompt: desktop,
  /** Closing or reloading the page with a change nobody applied asks first, in the browser's own words. */
  unloadPrompt: !desktop,
} as const;

export type HostFeature = keyof typeof hostFeatures;
