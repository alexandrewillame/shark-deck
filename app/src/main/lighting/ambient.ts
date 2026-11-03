import type { LightingSettings } from '@shared/types/lighting';
import { deviceManager } from '../devices/manager';

/**
 * Host-driven lighting: Screen Colour and Music.
 *
 * ## Why this exists at all
 *
 * `LightScreenColor` and the two `LightMusicFollow*` entries are not
 * self-contained firmware effects. The vendor app feeds the board a stream of
 * desktop colour / audio level and the board renders it; SharkDeck set the
 * effect and streamed nothing, so the LEDs simply went dark.
 *
 * ## Why it does not send the vendor's own frame
 *
 * There isn't one to send. No streaming command appears in `KB_CMD`, in the
 * extracted `KB_HE_EXTRA_CMD` table, or anywhere in `docs/protocol/`, and the
 * protocol extractor does not look for one. So this drives the board over a
 * command that IS known — `SET_LEDPARAM`, one frame at a time, holding
 * `Always On` at a computed colour. `provenance: inferred` — a SharkDeck
 * implementation of the feature, not a port of the vendor's.
 *
 * ## Why the measuring happens in the renderer
 *
 * The first version called `desktopCapturer.getSources()` on every tick. That
 * is a picker-building API: it enumerates every screen AND window and
 * composites a thumbnail for each, which at 8 Hz visibly slowed the whole
 * machine down. A renderer sampling one already-open video stream onto a tiny
 * canvas costs almost nothing by comparison, and the audio has to be there
 * anyway (WebAudio is the only analyser available). So this module no longer
 * captures anything: it receives values and owns the wire.
 *
 * ## Why writes are rate-limited AND change-gated
 *
 * The vendor endpoint wedges under sustained feature-report traffic and only
 * a replug clears it. Writing unconditionally at a fixed rate also made the
 * lighting visibly stutter every couple of seconds as those writes collided
 * with the manager's own liveness poll. A still screen now produces no
 * traffic at all.
 *
 * A per-key level meter — the bar graph the Music (Level) preview illustrates
 * — would be 7 chunked writes per update, and is deliberately not attempted:
 * whole-board colour and brightness follow the audio instead.
 */

/** Minimum gap between two writes. ~6 Hz ceiling. */
const MIN_WRITE_GAP_MS = 160;

/** How far a channel must move before it is worth a frame. The board has five
 *  brightness steps and eight-bit colour; anything under this is invisible. */
const COLOR_EPSILON = 10;

/** Stop rather than keep hammering a board that has stopped accepting writes. */
const FAIL_GIVE_UP = 5;

export type AmbientMode = 'screen' | 'music';

interface Session {
  mode: AmbientMode;
  /** Base colour, from whatever the pane had selected (music mode). */
  color: [number, number, number];
  /**
   * The pane's Rainbow toggle, carried on every streamed frame.
   *
   * The one-shot Apply already encoded it (`compx-keyboard.ts` gives the music
   * effects their own `0 = dazzle / 4 = plain` nibble), but this stream takes
   * over immediately afterwards and used to send `dazzle: undefined`, so the
   * driver fell through to "plain" and the board sat on one fixed colour for
   * the whole session. The toggle appeared to do nothing.
   */
  dazzle: boolean;
  /** What was last actually written, so an unchanged frame is skipped. */
  sent: { color: [number, number, number]; brightness: number; dazzle: boolean } | null;
  lastWriteAt: number;
  busy: boolean;
  fails: number;
}

const sessions = new Map<string, Session>();

export function isAmbientActive(deviceId: string): AmbientMode | null {
  return sessions.get(deviceId)?.mode ?? null;
}

export function startAmbient(
  deviceId: string,
  mode: AmbientMode,
  color: [number, number, number],
  dazzle = false,
): { ok: boolean; error?: string } {
  if (!deviceManager.getDriver(deviceId)) return { ok: false, error: 'device not connected' };
  sessions.set(deviceId, {
    mode,
    color,
    dazzle,
    sent: null,
    lastWriteAt: 0,
    busy: false,
    fails: 0,
  });
  return { ok: true };
}

export function stopAmbient(deviceId: string): void {
  sessions.delete(deviceId);
}

export function stopAllAmbient(): void {
  sessions.clear();
}

/**
 * A measurement from the renderer.
 *
 * `color` is the screen's mean colour (screen mode); `level` is 0..1 audio
 * loudness (music mode). Pushed rather than polled so the capture runs at its
 * own cadence and the wire stays on ours.
 */
export function pushAmbientSample(
  deviceId: string,
  sample: { color?: [number, number, number]; level?: number },
): void {
  const s = sessions.get(deviceId);
  if (!s) return;
  if (s.mode === 'screen') {
    if (!sample.color) return;
    void write(deviceId, s, sample.color, 100);
  } else {
    const level = Math.max(0, Math.min(1, sample.level ?? 0));
    // Level drives brightness, not colour: the board has five brightness
    // steps, so a beat reads as a clear pulse rather than a colour wobble.
    void write(deviceId, s, s.color, Math.round(25 + level * 75));
  }
}

/** Would this actually look different on the board? */
function changed(s: Session, color: [number, number, number], brightness: number): boolean {
  if (!s.sent) return true;
  // Rainbow first: in rainbow mode the colour never moves, so without this the
  // change gate would swallow the very frame that turns it on or off.
  if (s.sent.dazzle !== s.dazzle) return true;
  if (Math.abs(s.sent.brightness - brightness) >= 20) return true;
  return color.some((c, i) => Math.abs(c - s.sent!.color[i]!) >= COLOR_EPSILON);
}

async function write(
  deviceId: string,
  s: Session,
  color: [number, number, number],
  brightness: number,
): Promise<void> {
  if (s.busy) return;
  const now = Date.now();
  if (now - s.lastWriteAt < MIN_WRITE_GAP_MS) return;
  if (!changed(s, color, brightness)) return;
  const driver = deviceManager.getDriver(deviceId);
  if (!driver) {
    stopAmbient(deviceId);
    return;
  }
  s.busy = true;
  s.lastWriteAt = now;
  const next: LightingSettings = {
    zone: 'keyboard',
    effect: 'Always On',
    brightness,
    speed: 50,
    color,
    // With rainbow on the board paints its own hues and `color` is ignored;
    // the audio level still drives brightness, which is the whole effect.
    dazzle: s.dazzle,
    enabled: true,
  };
  try {
    // `streaming` drops the read-back: verifying each frame would double the
    // traffic on the endpoint this is already pacing itself against, to
    // confirm a value that is about to be replaced.
    const r = await driver.setLighting(next, { quiet: true, streaming: true });
    if (r.ok) {
      s.sent = { color, brightness, dazzle: s.dazzle };
      s.fails = 0;
    } else {
      s.fails += 1;
    }
  } catch {
    s.fails += 1;
  } finally {
    s.busy = false;
    if (s.fails >= FAIL_GIVE_UP) stopAmbient(deviceId);
  }
}

/**
 * Screen/audio capture is armed only while an ambient effect wants it.
 *
 * `setDisplayMediaRequestHandler` is process-wide: once installed it answers
 * ANY `getDisplayMedia()` call from any renderer, and answering it hands over
 * the user's screen. Gating on a live session means a stray or injected call
 * gets nothing — the handler denies unless something in this module actually
 * asked for a capture.
 */
export function captureArmed(): boolean {
  for (const s of sessions.values()) if (s) return true;
  return false;
}
