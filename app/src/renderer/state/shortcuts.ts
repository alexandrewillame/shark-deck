import { useEffect, useRef } from 'react';
import { useStore, HOME_TAB } from './store';

/**
 * Set by any live keystroke-capture surface (currently only the macro
 * recorder in components/macro/useMacroRecorder.ts) while it is actively grabbing
 * key events, so the global tab shortcuts below don't also react to the same
 * keypress — without this, Ctrl+W while recording a macro would both record
 * a "Ctrl release" step *and* close the tab out from under the recording.
 * A module-level flag rather than store state: it flips on every recording
 * start/stop and nothing needs to re-render off of it.
 */
let keyCaptureActive = false;
export function setKeyCaptureActive(active: boolean): void {
  keyCaptureActive = active;
}
/** For a pane's own shortcuts, which must stand down the same way. */
export function isKeyCaptureActive(): boolean {
  return keyCaptureActive;
}

/** `<input>` types a letter key types INTO — as opposed to a range or a
 *  checkbox, where a focused control still leaves letters free. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'number', 'password', 'url', 'tel']);

/**
 * Whether a keystroke here is someone typing, so a single-letter shortcut or
 * Ctrl+Z must leave it alone (a name field, a hex field, a rename box).
 *
 * Type-aware on purpose: a focused brightness slider is an `<input>` too, and
 * treating it as text would switch a pane's shortcuts off whenever the slider
 * had been touched last.
 */
export function isTextEntryTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)
    return true;
  return t instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(t.type);
}

/**
 * Whether `el` is in a view nobody can see. Every device tab stays mounted
 * behind `.view-hidden` (App.tsx hides rather than unmounts), so a pane's
 * window-level key listener is live in every tab ever opened unless it asks.
 */
export function isInHiddenView(el: Element | null | undefined): boolean {
  return !el || !el.isConnected || !!el.closest('.view-hidden');
}

const isMacUi = () => document.documentElement.classList.contains('platform-mac');

/** True on macOS — for wording that names keys (⌘ and ⌥ there, Ctrl and Alt
 *  elsewhere). False until the platform is known. */
export const useIsMac = (): boolean => useStore((s) => s.platformInfo?.os === 'darwin');

/**
 * An Enter that submits a text field — not the Enter that confirms an input
 * method's conversion (Japanese, Chinese, Korean). On a Mac that Enter arrives
 * as an ordinary "Enter" keydown with `isComposing` set (Windows reports it as
 * "Process"), and a name field committed on it saved the half-converted text.
 * keyCode 229 is the same signal from older event paths.
 */
export function isSubmitEnter(e: {
  key: string;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}): boolean {
  if (e.key !== 'Enter') return false;
  const composing = e.nativeEvent?.isComposing ?? e.isComposing ?? false;
  return !composing && e.keyCode !== 229;
}

/** How a Ctrl/Cmd shortcut is written in a tooltip on this platform. */
export function modKeyLabel(): string {
  return isMacUi() ? '⌘' : 'Ctrl+';
}

/**
 * Is the platform's command modifier down — ⌘ on macOS, Ctrl elsewhere?
 *
 * Taking either key on every OS made Super an app modifier on Linux (it is
 * `metaKey` there): Super+W closed a tab and Super+Z undid a change wherever
 * the desktop doesn't claim those keys first.
 */
export function isCommandKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMacUi() ? e.metaKey : e.ctrlKey;
}

/**
 * The key a letter shortcut names, lowercased.
 *
 * `e.key` follows the keyboard layout, which is right for a Latin one — on
 * AZERTY, Ctrl+Z is the key printed Z, wherever it sits. But Russian and
 * Arabic are both languages this app ships, and on those layouts the same
 * press arrives as `я` or `ئ`, so no letter shortcut ever matched. Where the
 * layout's character is not a Latin letter, the key's position stands in.
 */
export function shortcutKey(e: { key: string; code: string }): string {
  const k = e.key.toLowerCase();
  if (k.length !== 1 || /^[a-z0-9]$/.test(k)) return k;
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1]!.toLowerCase() : k;
}

/**
 * Ctrl+W closes the active tab (a no-op on Home, which the store already
 * refuses to close), Ctrl+Tab / Ctrl+Shift+Tab cycle the tabs, Ctrl+T opens
 * Home — mirrors what "new tab" does in a browser, since Home is this app's
 * closest equivalent.
 *
 * The cycle treats Home as the seam of the ring — `[Home, ...visible tabs]`
 * — rather than excluding it outright: Ctrl+Tab from the last open tab and
 * Ctrl+Shift+Tab from the first both land on Home, same as wrapping past
 * either end of a browser's tab strip loops back round. Cycling away from
 * Home itself is unaffected (forward -> first tab, backward -> last tab).
 *
 * All three call `preventDefault()`: Electron's default application menu
 * binds Ctrl+W to close-window, and this app is frameless with no OS-level
 * way to close a tab if that fires instead of this handler.
 *
 * Accepts Cmd (`metaKey`) as well as Ctrl so the same shortcuts work on
 * macOS, where Cmd is the modifier every app menu and keyboard convention
 * uses instead of Ctrl.
 */
export function useTabShortcuts(options?: {
  /**
   * Close a tab through the app's own path instead of the store directly, so
   * Ctrl+W gets the same "you have unsaved work" prompt the close button does
   * (App.tsx). Held in a ref: the handler is attached once, but the caller
   * passes a fresh closure every render.
   */
  closeTab?: (id: string) => void;
}): void {
  const closeRef = useRef(options?.closeTab);
  closeRef.current = options?.closeTab;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || keyCaptureActive) return;
      const key = shortcutKey(e);
      // Ctrl+Tab cycles tabs on every OS — on a Mac too, as in its browsers
      // (⌘Tab is the system's app switcher). The rest take the platform's
      // command key.
      if (!(key === 'tab' ? e.ctrlKey : isCommandKey(e))) return;

      const { tabs, activeTabId, closeTab, openTab } = useStore.getState();

      if (key === 'w') {
        // ⌘W with no tab to close is a Mac's "close the window": left to the
        // app menu's Close item rather than swallowed here.
        if (activeTabId === HOME_TAB.id && isMacUi()) return;
        e.preventDefault();
        (closeRef.current ?? closeTab)(activeTabId);
      } else if (key === 't') {
        e.preventDefault();
        openTab({ name: 'devices' });
      } else if (key === 'tab') {
        e.preventDefault();
        const visible = tabs.filter((t) => t.id !== HOME_TAB.id);
        if (visible.length === 0) return;
        const order = [HOME_TAB, ...visible];
        const dir = e.shiftKey ? -1 : 1;
        const idx = order.findIndex((t) => t.id === activeTabId);
        const nextIdx =
          ((((idx === -1 ? 0 : idx) + dir) % order.length) + order.length) % order.length;
        openTab(order[nextIdx]!.route);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
