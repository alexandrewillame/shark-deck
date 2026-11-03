import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a popover portalled to <body>: into it when it opens,
 * back to its trigger when it closes.
 *
 * Portalled, a popover sits at the very end of the document, so Tab from its
 * trigger skipped it entirely, and closing it with Escape left focus on
 * nothing. `ready` is the moment it has been positioned (it is drawn
 * off-screen until then, and focusing it there would scroll).
 *
 * Focus goes back to the trigger only if it was inside the popover (it falls
 * to <body> when the popover unmounts) — a click elsewhere that closed it
 * keeps the focus it gave.
 */
export function usePopoverFocus(
  open: boolean,
  ready: boolean,
  panel: RefObject<HTMLElement>,
  trigger: RefObject<HTMLElement>,
  /** What to focus first, if present: the current choice, say. */
  preferred?: string,
): void {
  const shown = useRef(false);
  useEffect(() => {
    if (open && ready) {
      const p = panel.current;
      if (p && !p.contains(document.activeElement)) {
        const first =
          (preferred ? p.querySelector<HTMLElement>(preferred) : null) ??
          p.querySelector<HTMLElement>(FOCUSABLE);
        first?.focus({ preventScroll: true });
      }
      shown.current = true;
    } else if (!open && shown.current) {
      shown.current = false;
      const at = document.activeElement;
      if (!at || at === document.body) trigger.current?.focus({ preventScroll: true });
    }
    // The refs are stable; `preferred` is read when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);
}

/** Up/Down (and Home/End) between a list's options — for a listbox popover. */
export function moveFocusInList(
  e: { key: string; preventDefault(): void },
  list: HTMLElement | null,
) {
  if (!list || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
  items[next]?.focus();
}
