import { useEffect, useRef, useState } from 'react';
import { sd } from '../../state/bridge';

/**
 * Drives the two host-fed lighting effects while one of them is on the board.
 *
 * Screen Colour and Music are not self-contained firmware effects — the board
 * expects a stream from the host and shows nothing without one (see
 * main/lighting/ambient.ts). Main owns the wire; this owns the measuring.
 *
 * ## One capture, sampled
 *
 * A single `getDisplayMedia()` stream provides both: a video track to sample
 * the screen's mean colour from, and — on Windows — a system-audio loopback
 * track to measure loudness on. The first version instead called Electron's
 * `desktopCapturer.getSources()` once per frame, which builds a thumbnail of
 * every screen and window on the machine and made the whole computer sluggish,
 * and asked for audio through the legacy `chromeMediaSource` constraint, which
 * current Electron does not honour.
 *
 * Sampling draws the video into a 32x18 canvas: 576 pixels is more than enough
 * for a mean, and keeps each sample to a fraction of a millisecond.
 *
 * ## Nothing here throws into React
 *
 * Capture can fail for entirely ordinary reasons — no loopback on this OS, the
 * user's screen-recording permission, a stream ending because a display was
 * unplugged. Every one of those is caught and reported through `error`, so a
 * lighting effect can never take the window down with it.
 *
 * ## Platform
 *
 * `audio: 'loopback'` is a Windows capability. macOS has no OS-level loopback
 * without a virtual audio device, and Linux depends on the PulseAudio setup;
 * there the stream returns video-only and the pane says so. See
 * docs/platform-support.md.
 */

/** Sample cadence. Deliberately faster than the board is written — measuring
 *  is nearly free, writing is not, and main throttles and change-gates. */
const SAMPLE_MS = 100;
/** Audio is sampled faster: a beat missed is a pulse missed. */
const AUDIO_SAMPLE_MS = 50;

const W = 32;
const H = 18;

/** Ignore near-black pixels: a letterboxed video or a dark theme is mostly
 *  black, and averaging it in drags every result to the same muddy grey. */
const DARK_CUTOFF = 24;

export type AmbientMode = 'screen' | 'music' | null;

export function useAmbientLighting(
  deviceId: string,
  mode: AmbientMode,
  color: [number, number, number],
  enabled: boolean,
  /** The pane's Rainbow toggle — see `Session.dazzle` in main/lighting/ambient.ts. */
  dazzle = false,
): { error: string | null; noAudio: boolean } {
  const [error, setError] = useState<string | null>(null);
  const [noAudio, setNoAudio] = useState(false);
  // Colour changes must not tear the capture down and rebuild it. Same for
  // the rainbow toggle: it changes what is sent, not what is measured.
  const colorRef = useRef(color);
  colorRef.current = color;
  const dazzleRef = useRef(dazzle);
  dazzleRef.current = dazzle;

  const active = enabled && mode !== null;

  useEffect(() => {
    if (!active || !mode) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let video: HTMLVideoElement | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];

    setError(null);
    setNoAudio(false);

    const cleanup = () => {
      timers.forEach(clearInterval);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) {
        video.srcObject = null;
        video = null;
      }
      void ctx?.close().catch(() => {});
      ctx = null;
      stream = null;
    };

    void (async () => {
      try {
        const started = await sd.startAmbientLighting(
          deviceId,
          mode,
          colorRef.current,
          dazzleRef.current,
        );
        if (stopped) return;
        if (!started.ok) {
          setError(started.error ?? 'Could not start.');
          return;
        }

        // Main only answers this while an ambient session is live — see
        // installDisplayMediaHandler. Audio is requested for both modes
        // because asking is free and the track is simply absent when the
        // platform cannot provide it.
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (stopped) {
          cleanup();
          return;
        }

        // A stream can end without us: a display unplugged, or the user
        // revoking the capture. Tear down rather than sampling a dead track.
        stream.getTracks().forEach((t) => {
          t.addEventListener('ended', () => {
            if (!stopped) setError('The screen capture ended.');
            cleanup();
          });
        });

        if (mode === 'screen') {
          video = document.createElement('video');
          video.muted = true;
          video.srcObject = stream;
          await video.play();
          if (stopped) {
            cleanup();
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = W;
          canvas.height = H;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          if (!g) {
            setError('This build cannot read the screen image.');
            cleanup();
            return;
          }
          timers.push(
            setInterval(() => {
              if (stopped || !video || video.readyState < 2) return;
              try {
                g.drawImage(video, 0, 0, W, H);
                void sd.pushAmbientSample(deviceId, {
                  color: meanColor(g.getImageData(0, 0, W, H).data),
                });
              } catch {
                /* a frame we could not read is simply skipped */
              }
            }, SAMPLE_MS),
          );
        } else {
          const track = stream.getAudioTracks()[0];
          if (!track) {
            // Not an error so much as a platform fact — the effect just has
            // nothing to follow.
            setNoAudio(true);
            return;
          }
          ctx = new AudioContext();
          const analyser = ctx.createAnalyser();
          // Small window, heavy smoothing: this drives a five-step
          // brightness, so responsiveness matters far more than frequency
          // resolution, and an unsmoothed level makes the board strobe.
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.75;
          ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
          const buf = new Uint8Array(analyser.frequencyBinCount);
          timers.push(
            setInterval(() => {
              if (stopped) return;
              analyser.getByteFrequencyData(buf);
              let sum = 0;
              for (const v of buf) sum += v;
              // Music sits well below full scale, so the raw mean barely
              // moves off zero. Expand it into something five brightness
              // steps can actually show.
              const level = Math.min(1, sum / buf.length / 255 / 0.31);
              void sd.pushAmbientSample(deviceId, { level });
            }, AUDIO_SAMPLE_MS),
          );
        }
      } catch (e) {
        if (!stopped) setError(String((e as Error)?.message ?? e));
        cleanup();
      }
    })();

    return () => {
      stopped = true;
      cleanup();
      void sd.stopAmbientLighting(deviceId);
    };
  }, [deviceId, mode, active]);

  return { error, noAudio };
}

/** Mean colour of RGBA pixels, skipping near-black, lightly saturated. */
function meanColor(px: Uint8ClampedArray): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const pr = px[i] ?? 0;
    const pg = px[i + 1] ?? 0;
    const pb = px[i + 2] ?? 0;
    if (pr < DARK_CUTOFF && pg < DARK_CUTOFF && pb < DARK_CUTOFF) continue;
    r += pr;
    g += pg;
    b += pb;
    n++;
  }
  // An entirely dark screen is a legitimate answer, not a failure — dim the
  // board rather than snapping it to some invented colour.
  if (!n) return [12, 12, 14];
  // A desktop average is washed out, and a washed-out RGB LED just looks like
  // dim white, so pull the channels apart a little.
  const mean = (r + g + b) / 3 / n;
  return [r / n, g / n, b / n].map((v) =>
    Math.max(0, Math.min(255, Math.round(mean + (v - mean) * 1.5))),
  ) as [number, number, number];
}
