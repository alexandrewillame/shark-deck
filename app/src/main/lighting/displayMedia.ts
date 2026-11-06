import { desktopCapturer, session } from 'electron';
import { captureArmed } from './ambient';

type Callback = Parameters<
  Parameters<Electron.Session['setDisplayMediaRequestHandler']>[0] & {}
>[1];

/**
 * Refuse a request. `callback({})` reads as "no streams", but Electron 38
 * throws on it whenever video was asked for ("Video was requested, but no
 * video stream was provided") — an uncaught error in main, so the crash window
 * came up. And that was the first Screen Colour on every Mac: until the user
 * grants Screen Recording, `getSources()` lists no screen at all. `null` is
 * the API's own "no" (shell/browser/electron_browser_context.cc,
 * DisplayMediaDeviceChosen): the request fails, nothing throws, and the
 * renderer shows why (useAmbientLighting).
 */
function deny(callback: Callback): void {
  callback(null as unknown as Parameters<Callback>[0]);
}

/**
 * Answer `getDisplayMedia()` for the Screen Colour / Music lighting effects.
 *
 * Electron denies display capture outright unless a handler is installed, and
 * the handler is process-wide — once present it answers ANY such call from
 * any renderer, handing over the user's screen. So it is gated on
 * `captureArmed()`: unless an ambient lighting session is actually running,
 * every request is denied. Nothing else in this app calls `getDisplayMedia`,
 * and the CSP means no third-party script is running to try.
 *
 * `audio: 'loopback'` is what makes the Music effect possible — system audio,
 * not a microphone. It is a Windows capability; elsewhere the stream comes
 * back video-only and the renderer says why (see useAmbientLighting).
 *
 * The video source is the primary screen, chosen here rather than through the
 * system picker: the point of the effect is "match my screen", and making
 * someone pick a window every time they select it would be absurd.
 */
export function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!captureArmed()) {
        deny(callback);
        return;
      }
      // Out of this callback first. On macOS without Screen Recording,
      // getSources() rejects ("Failed to get sources."), and called from
      // inside Electron's display-media callback that rejection reached
      // 'unhandledRejection' before the .catch below ran — the crash window.
      // A tick later the same chain catches it like any other (reproduced on
      // macOS 26 with a bare Electron 38 probe, both ways).
      setImmediate(() => {
        desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const screenSource = sources[0];
            if (!screenSource) {
              deny(callback);
              return;
            }
            // System audio only where Electron can capture it (Windows). Offered
            // elsewhere, it could fail the whole capture — Screen Colour with it.
            callback(
              process.platform === 'win32'
                ? { video: screenSource, audio: 'loopback' }
                : { video: screenSource },
            );
          })
          .catch(() => deny(callback));
      });
    },
    // The app picks the screen itself (see above), so Electron must not put
    // the OS picker in front of the user on every start.
    { useSystemPicker: false },
  );
}
