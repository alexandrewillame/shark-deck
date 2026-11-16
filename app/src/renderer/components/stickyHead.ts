import { useEffect, type RefObject } from 'react';

/**
 * A box whose heading line holds its Apply / Cancel / Save — the Remap
 * picker, a lighting pane, the macro editor — keeps that line pinned under the
 * pane's own sticky bars while the box's body scrolls beneath it (`.has-sticky-
 * head > .sticky-head`, panes.css). Sticky binds to the box: scrolled past the
 * box, its heading goes with it.
 *
 * This marks the box `data-stuck` while the heading is actually pinned. Only
 * then does the heading need a surface of its own: over an app background the
 * box is frosted glass, and a second layer of glass on its top line would read
 * as a darker band whenever nothing is scrolling under it.
 *
 * Pinned = the heading has moved down from the top of its box. One listener in
 * the capture phase hears every scroll container, whichever holds the box.
 */
export function useStuckHead(boxRef: RefObject<HTMLElement | null>, on = true): void {
  useEffect(() => {
    const box = boxRef.current;
    const head = box?.querySelector<HTMLElement>(':scope > .sticky-head');
    if (!on || !box || !head) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const stuck = head.getBoundingClientRect().top - box.getBoundingClientRect().top > 2;
      box.toggleAttribute('data-stuck', stuck);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    check();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      if (frame) cancelAnimationFrame(frame);
      box.removeAttribute('data-stuck');
    };
  }, [boxRef, on]);
}
