import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

import { sd } from '../state/bridge';

/** Matches Windows' own `SM_CXDRAG` drag threshold. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Lets a topbar button both move the window on a press-drag AND still fire
 * its normal click — something a native `-webkit-app-region: drag` region
 * can't do (Windows swallows all mouse input over a drag region, so a
 * button inside one never receives `click`). See Api.windowStartDrag's doc
 * comment.
 *
 * Uses window-level listeners rather than `setPointerCapture`: once the
 * window starts following the cursor (main process), the pointer barely
 * moves relative to the button any more, so element-targeted moves dry up —
 * screen-coordinate tracking in the main process is what actually drives
 * the drag; this hook only needs to detect "was this gesture a drag" so it
 * can suppress the click that follows.
 */
export function useDragOrClick<T extends HTMLElement>(onClick?: (e: ReactMouseEvent<T>) => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);
  const draggedThisGesture = useRef(false);

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
  };

  // If the button unmounts mid-gesture (a tab close re-rendering the topbar,
  // the language menu closing, …) the pointerup that would remove these
  // listeners never arrives — drop them on unmount, and end any drag still
  // believed to be in progress.
  useEffect(() => cleanup, []);

  const onMove = (e: PointerEvent) => {
    if (!start.current) return;
    if (!dragging.current) {
      const dx = e.screenX - start.current.x;
      const dy = e.screenY - start.current.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        dragging.current = true;
        draggedThisGesture.current = true;
        void sd.windowStartDrag();
      }
    }
  };

  const onUp = () => {
    if (dragging.current) void sd.windowEndDrag();
    dragging.current = false;
    start.current = null;
    cleanup();
  };

  const onPointerDown = (e: ReactPointerEvent<T>) => {
    if (e.button !== 0) return;
    start.current = { x: e.screenX, y: e.screenY };
    draggedThisGesture.current = false;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
  };

  const handleClick = (e: ReactMouseEvent<T>) => {
    if (draggedThisGesture.current) {
      draggedThisGesture.current = false;
      return;
    }
    onClick?.(e);
  };

  return { onPointerDown, onClick: handleClick };
}
