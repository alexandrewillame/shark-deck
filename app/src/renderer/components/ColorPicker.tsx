import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeviceColorVariant } from '@shared/types/device';
import type { MessageKey, TFunc } from '@shared/i18n';
import { Tooltip } from './common';
import { useAnchoredPosition } from './usePortalPosition';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { Icon } from './icons';

import { sd } from '../state/bridge';

/**
 * A device card's cosmetic colour/edition choice (`DeviceColorVariant`,
 * declared per model in main/devices/catalog/) — purely which product photo
 * to show, so the card matches what the user actually owns. Never sent to
 * the device. Renders nothing when the model has no variants declared.
 *
 * The trigger is a fixed palette glyph (never tinted by the device's own
 * colour, so it doesn't read as "this is the current colour" the way the
 * collapsed swatch used to). Hovering it pops the full swatch list in a
 * `document.body` portal above the trigger (same idiom as Tooltip — see
 * usePortalPosition.ts — so it can't be clipped by the card's
 * `overflow: hidden`); sweeping the cursor across swatches calls `onPreview`
 * so the card's own art cross-fades live to that colour, and a CSS
 * transition on the preview layer animates the swap. Clicking a swatch is
 * what actually commits the choice.
 *
 * The trigger also opens it on a click or a key press, which moves focus to
 * the current swatch; arrow keys preview and Escape closes. It used to open on
 * hover alone, so the colour could not be changed without a mouse.
 */
/** A colour's name: translated for a plain colour, as the store writes it for an edition. */
export function variantLabel(v: DeviceColorVariant, t: TFunc): string {
  return v.labelKey ? t(v.labelKey as MessageKey) : (v.label ?? v.id);
}

export function ColorPicker({
  model,
  current,
  variants,
  onPreview,
}: {
  model: string;
  current: string | null;
  variants: DeviceColorVariant[];
  /** Called with a variant id while hovering it, and `null` on mouse-leave
   *  to revert the live preview back to the actually-saved colour. */
  onPreview?: (variantId: string | null) => void;
}) {
  const t = useT();
  const setDevices = useStore((s) => s.setDevices);
  const [hovering, setHovering] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(triggerRef, popoverRef, hovering, {
    placement: 'top',
    align: 'end',
  });

  // The popover is a `document.body` portal (see below) — it isn't a DOM
  // descendant of `.color-picker`, so the small gap between the trigger and
  // the popover above it is genuinely "outside" both elements. Closing the
  // instant the pointer left the trigger (the old behaviour) meant the
  // popover vanished before the cursor could ever reach it, mid-move,
  // however directly it was heading there. A short close delay — cancelled
  // by re-entering either the trigger or the popover — gives that move time
  // to land, the same "hover intent" idiom as a native OS menu.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setHovering(false);
      onPreview?.(null);
    }, 300);
  };
  useEffect(() => () => cancelClose(), []);

  /** Opened from the keyboard: focus goes into the swatches once they exist. */
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  useEffect(() => {
    if (!hovering || !focusOnOpen || !pos) return;
    setFocusOnOpen(false);
    const swatches = popoverRef.current?.querySelectorAll<HTMLButtonElement>('button');
    const at = Math.max(
      0,
      variants.findIndex((v) => v.id === current),
    );
    swatches?.[at]?.focus();
  }, [hovering, focusOnOpen, pos, variants, current]);
  // A popover that holds focus closes on Escape and when focus leaves both it
  // and the trigger — the keyboard's version of the pointer leaving.
  useEffect(() => {
    if (!hovering) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancelClose();
      setHovering(false);
      onPreview?.(null);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovering]);

  if (variants.length === 0) return null;

  const choose = async (id: string) => {
    cancelClose();
    const next = await sd.setDeviceColor(model, id);
    setDevices(next);
    setHovering(false);
    onPreview?.(null);
  };

  const open = () => {
    cancelClose();
    setHovering(true);
  };

  return (
    <div
      className="color-picker"
      // The card itself is `draggable` (for the Home reorder feature). A plain
      // `draggable={false}` here wouldn't help — the HTML5 drag-source search
      // skips non-draggable descendants and keeps walking up to the nearest
      // draggable ancestor, so a press on the swatch would still start
      // dragging the *card*. Marking this element draggable="true" instead
      // makes the browser stop its search here (this becomes the drag
      // source), and cancelling its own dragstart kills the gesture outright
      // before it can reach the card.
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="color-picker-trigger"
        aria-haspopup="true"
        aria-expanded={hovering}
        aria-label={t('dev.colour')}
        onClick={(e) => {
          // A pointer already opened it by hovering; a click (or Enter/Space,
          // which arrive as a click with no pointer) opens it for the keyboard.
          if (e.detail === 0 || !hovering) {
            open();
            setFocusOnOpen(true);
          }
        }}
      >
        <Icon name="palette" size={14} />
      </button>
      {hovering &&
        createPortal(
          <div
            ref={popoverRef}
            className={`color-picker-popover ${pos ? 'is-visible' : ''}`}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            role="group"
            aria-label={t('dev.colour')}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              const all = [
                ...(popoverRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []),
              ];
              const i = all.indexOf(document.activeElement as HTMLButtonElement);
              const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
              e.preventDefault();
              next?.focus();
            }}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to && (popoverRef.current?.contains(to) || triggerRef.current?.contains(to)))
                return;
              scheduleClose();
            }}
          >
            {variants.map((v) => (
              <Tooltip key={v.id} text={variantLabel(v, t)}>
                <button
                  className={`color-picker-swatch-btn ${v.id === current ? 'active' : ''}`}
                  style={{ background: v.swatch }}
                  aria-label={variantLabel(v, t)}
                  aria-pressed={v.id === current}
                  onMouseEnter={() => onPreview?.(v.id)}
                  onFocus={() => {
                    cancelClose();
                    onPreview?.(v.id);
                  }}
                  onClick={() => void choose(v.id)}
                />
              </Tooltip>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
