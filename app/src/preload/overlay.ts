import { contextBridge, ipcRenderer } from 'electron';

/** What main/overlayWindow.ts sends the card — see `OverlayContent` there. */
interface OverlayContent {
  id: number;
  kind: 'game' | 'desktop';
  ms: number;
  logo: string;
  brand: string;
  mode: string;
  exe: string;
  exeIcon: string | null;
}

/**
 * Bridge for overlay.html only. Mirrors preload/crash.ts's shape: minimal,
 * and read-only in this direction — the overlay window only ever displays
 * what main/overlayWindow.ts pushes to it, it never calls back into main.
 */
contextBridge.exposeInMainWorld('overlay', {
  onContent: (cb: (data: OverlayContent) => void): (() => void) => {
    const listener = (_e: unknown, data: OverlayContent) => cb(data);
    ipcRenderer.on('overlay:content', listener);
    return () => ipcRenderer.removeListener('overlay:content', listener);
  },
  /** The pointer, in this window's coordinates — sampled by main, since the
   *  window ignores the mouse and so never sees it move. */
  onPointer: (cb: (at: { x: number; y: number }) => void): (() => void) => {
    const listener = (_e: unknown, at: { x: number; y: number }) => cb(at);
    ipcRenderer.on('overlay:pointer', listener);
    return () => ipcRenderer.removeListener('overlay:pointer', listener);
  },
  /** Fade the card out over `ms` — sent on Linux only, where the window's own
   *  opacity cannot be animated (see overlayWindow.ts `beginFade`). */
  onFade: (cb: (ms: number) => void): (() => void) => {
    const listener = (_e: unknown, ms: number) => cb(ms);
    ipcRenderer.on('overlay:fade', listener);
    return () => ipcRenderer.removeListener('overlay:fade', listener);
  },
});
