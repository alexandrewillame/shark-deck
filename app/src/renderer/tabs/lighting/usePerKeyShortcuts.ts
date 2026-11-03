import { useEffect, useRef, type RefObject } from 'react';
import {
  isCommandKey,
  isInHiddenView,
  isKeyCaptureActive,
  isTextEntryTarget,
  shortcutKey,
} from '../../state/shortcuts';

/**
 * The per-key editor's keyboard shortcuts:
 *
 *  - **I** picks up the pipette, **M** the box tool — Photoshop's letters. A
 *    letter selects its tool; Escape puts it down again.
 *  - **Ctrl/⌘+Z** undoes, **Ctrl/⌘+Y** or **Ctrl/⌘+Shift+Z** redoes.
 *  - Holding Shift or Ctrl is reported, for the box cursor — the box GESTURE
 *    is decided by the press itself (KeyboardMap's `marqueeOnModifier`), so a
 *    keyup lost to Alt-Tab only ever leaves a cursor wrong, never the board.
 *
 * Window listeners, bubble phase, so anything that claims a key first — the
 * colour popover closing on Escape — has already said so (`defaultPrevented`).
 * Matched on `e.key`, which follows the keyboard layout: the I and M a French
 * AZERTY user sees on their keys are the ones that work.
 *
 * Each handler stands down while someone is typing (a name or a hex field —
 * where Ctrl+Z belongs to the field), while a dialog is open, while the macro
 * recorder is capturing keys, and when this pane is not the one on screen:
 * every device tab stays mounted, hidden, so without that check a shortcut
 * would fire in every per-key editor ever opened.
 */
export function usePerKeyShortcuts(opts: {
  /** Any element of the pane — what "is this pane on screen" is asked of. */
  probeRef: RefObject<HTMLElement | null>;
  onTool: (tool: 'pick' | 'rect') => void;
  /** Return true when Escape put a tool down (and so is used up). */
  onEscape: () => boolean;
  onUndo: () => void;
  onRedo: () => void;
  onModifierHeld: (held: boolean) => void;
}): void {
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    const offScreen = () => isInHiddenView(ref.current.probeRef.current);
    const onDown = (e: KeyboardEvent) => {
      if (offScreen()) return;
      if (!isTextEntryTarget(e.target)) {
        ref.current.onModifierHeld(e.shiftKey || e.ctrlKey || e.metaKey);
      }
      if (
        e.defaultPrevented ||
        e.altKey ||
        isKeyCaptureActive() ||
        isTextEntryTarget(e.target) ||
        document.querySelector('.modal-scrim')
      )
        return;
      // Layout-proof letters and the platform's own command key — see both
      // helpers in state/shortcuts.ts.
      const k = shortcutKey(e);
      if (isCommandKey(e)) {
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          ref.current.onUndo();
        } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          ref.current.onRedo();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (ref.current.onEscape()) e.preventDefault();
        return;
      }
      if (e.shiftKey || e.repeat) return;
      if (k === 'i') {
        e.preventDefault();
        ref.current.onTool('pick');
      } else if (k === 'm') {
        e.preventDefault();
        ref.current.onTool('rect');
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!offScreen()) ref.current.onModifierHeld(e.shiftKey || e.ctrlKey || e.metaKey);
    };
    const release = () => ref.current.onModifierHeld(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, []);
}
