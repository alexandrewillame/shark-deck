import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { proximity } from '@shared/proximityFade';
import { Icon, type IconName } from './icons';

/** Each kind says what it is in a glyph as well as a colour: under the Red
 *  palette the accent is a red, and an info toast's stripe was the same red as
 *  an error's. */
const KIND_ICON: Record<Shown['kind'], IconName> = {
  info: 'check',
  warn: 'warning',
  err: 'close',
};

interface Shown {
  id: number;
  kind: 'info' | 'warn' | 'err';
  text: string;
  closing: boolean;
}

// How close the pointer may come before a toast fades, and how far: shared
// with the auto-switch overlay — see shared/proximityFade.ts. The stack is
// pinned bottom-right, which is where most of the keyboard tabs put their
// buttons and sliders, so whatever a toast sits on must stay readable.

/**
 * The store drops a toast from its list the instant it expires — this component
 * keeps a local shadow copy so a departing toast gets one more render with
 * `.toast-out` before it actually leaves the DOM, instead of just popping out
 * of existence.
 *
 * The stack is entirely click-through (see the `.toasts` comment in
 * styles.css): it overlaps the bottom-right of every pane, and a live toast
 * used to eat the clicks meant for the controls under it. Click-to-dismiss
 * went with that — it was unreachable anyway once a toast under the pointer is
 * transparent to it, and nothing needs dismissing by hand since `toast()`
 * expires every one of them after 6 s.
 *
 * Proximity fading is written straight to the DOM as a CSS custom property
 * rather than held in React state: it updates on every pointer move, and
 * re-rendering the tree at that rate to change one number would be wasteful.
 */
export function Toasts() {
  // Selector + shallow-equal so a store no-op (`set(() => ({}))`) doesn't
  // re-render this on every art-flight frame.
  const { toasts } = useStore(useShallow((s) => ({ toasts: s.toasts })));
  const [shown, setShown] = useState<Shown[]>([]);
  const exitTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const els = useRef(new Map<number, HTMLDivElement>());
  const frame = useRef<number | null>(null);

  useEffect(() => {
    setShown((prev) => {
      const liveIds = new Set(toasts.map((t) => t.id));
      const stillClosing = prev.filter((p) => p.closing && !liveIds.has(p.id));
      const justLeft = prev.filter((p) => !p.closing && !liveIds.has(p.id));
      const live = toasts.map((t) => ({ ...t, closing: false }));
      return [...live, ...stillClosing, ...justLeft.map((p) => ({ ...p, closing: true }))];
    });
  }, [toasts]);

  // Schedule the DOM-removal timer for each toast that has just entered its
  // closing state — in a plain effect, NOT inside the setState updater above
  // (an impure updater runs twice under StrictMode, leaking a timer each time).
  useEffect(() => {
    for (const t of shown) {
      if (!t.closing || exitTimers.current.has(t.id)) continue;
      const timer = setTimeout(() => {
        setShown((cur) => cur.filter((x) => x.id !== t.id));
        exitTimers.current.delete(t.id);
      }, 220);
      exitTimers.current.set(t.id, timer);
    }
  }, [shown]);

  useEffect(() => {
    const timers = exitTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const setProx = useCallback((x: number | null, y: number | null) => {
    for (const el of els.current.values()) {
      const prox = x === null || y === null ? 1 : proximity(x, y, el.getBoundingClientRect());
      el.style.setProperty('--toast-prox', String(prox));
    }
  }, []);

  // Only listen while something is actually on screen: this fires on every
  // pointer move, so it must not be a permanent subscription. Measuring is
  // coalesced into one animation frame per burst — `getBoundingClientRect` on
  // each toast is a layout read, and doing it per raw move event is what makes
  // this kind of tracking janky.
  useEffect(() => {
    if (shown.length === 0) return;
    let last: { x: number; y: number } | null = null;

    const flush = () => {
      frame.current = null;
      setProx(last?.x ?? null, last?.y ?? null);
    };
    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    };
    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      schedule();
    };
    // Pointer gone from the window entirely — nothing is near any more, so put
    // every toast back to full opacity instead of leaving it stuck faded at
    // wherever the cursor last was.
    const onLeave = () => {
      last = null;
      schedule();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('blur', onLeave);
    document.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('pointerleave', onLeave);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [shown.length, setProx]);

  // A live region: a toast is the only word that a setting was saved, or was
  // not, and without one a screen reader heard nothing either way.
  //
  // Portalled to <body>, outside `.app`: `.app` is its own stacking context
  // (`isolation: isolate`, for the background layer), so a toast inside it
  // could never rise above a dialog — and the profile comparator raises its
  // write errors while its own dialog is open, under the scrim.
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {shown.map((t) => (
        <div
          key={t.id}
          ref={(el) => {
            if (el) els.current.set(t.id, el);
            else els.current.delete(t.id);
          }}
          className={`toast ${t.kind === 'warn' ? 'warn' : t.kind === 'err' ? 'err' : ''} ${t.closing ? 'toast-out' : 'toast-in'}`}
        >
          <span className="toast-icon" aria-hidden="true">
            <Icon name={KIND_ICON[t.kind]} size={13} />
          </span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
