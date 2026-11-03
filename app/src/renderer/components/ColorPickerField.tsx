import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COLOR_PRESET_ROWS, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../colorUtil';
import type { MessageKey } from '@shared/i18n';
import { useAnchoredPosition } from './usePortalPosition';
import { Icon } from './icons';
import { useT } from '../state/i18n';

/**
 * The app's colour picker — a swatch trigger plus a saturation/value square,
 * a hue strip, a hex field and the shared presets.
 *
 * Replaces `<input type="color">`, which was used at five places and was the
 * one control in the app that did not look like the app: unstyleable native
 * chrome, and a click opened the OS colour dialog, which has its own
 * typeface, its own corner radius and its own idea of what a colour is.
 * Setting an LED is not a moment to leave the application.
 *
 * Not to be confused with `ColorPicker.tsx`, which picks which product PHOTO
 * to show on a home card and never touches hardware.
 *
 * The popover is portalled to `document.body` — not a choice. `.topbar` sets
 * `backdrop-filter`, which creates a stacking context that traps a nested
 * `z-index`, and several card ancestors are `overflow: hidden`. The same
 * reason AppearanceMenu and ColorPicker portal theirs.
 */
export function ColorPickerField({
  value,
  onChange,
  ariaLabel,
  swatches = COLOR_PRESET_ROWS,
  disabled,
  variant = 'field',
  align = 'start',
  className,
}: {
  /** `#rrggbb`. */
  value: string;
  onChange: (hex: string) => void;
  ariaLabel?: string;
  /** Rows of a swatch grid, hue across and level down. */
  swatches?: readonly (readonly string[])[];
  disabled?: boolean;
  /**
   * `tool`: a square chip the size of an icon button, for a toolbar of them
   * (the per-key lighting tools, where the brush colour sits beside the
   * pipette and the box). No caret — the chip is the brush's colour, and what
   * it opens is the brush.
   */
  variant?: 'field' | 'tool';
  /** Which edge of the trigger the popover lines up with: `end` for a
   *  trigger at the right of the pane. */
  align?: 'start' | 'end';
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(triggerRef, popRef, open, { align });

  // Hue is state of its own, not derived from `value`. At pure black and at
  // pure white the hue is mathematically undefined, so deriving it would snap
  // the strip back to red the moment you dragged the square into a corner and
  // make the picker impossible to get out of.
  const [hue, setHue] = useState(() => rgbToHsv(hexToRgb(value))[0]);
  const [hex, setHex] = useState(value);
  useEffect(() => {
    setHex(value);
    const [h, s, v] = rgbToHsv(hexToRgb(value));
    if (s > 0.02 && v > 0.02) setHue(h);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    // Escape closes this, and only this: claimed, so a pane listening for
    // Escape itself (the per-key tools put the brush back) leaves it alone.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node;
      if (!popRef.current?.contains(el) && !triggerRef.current?.contains(el)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    // Capture: a swatch inside the popover stops propagation of its own click,
    // and some hosts (the device cards) do too, so bubbling would miss.
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  const [, sat, val] = rgbToHsv(hexToRgb(value));
  const emit = (rgb: [number, number, number]) => onChange(rgbToHex(rgb));

  /** Pointer position inside an element, as 0..1 on both axes. */
  const track = (e: React.PointerEvent<HTMLDivElement>, to: (x: number, y: number) => void) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent | React.PointerEvent) => {
      const r = el.getBoundingClientRect();
      to(
        Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
        Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
      );
    };
    move(e);
    const up = () => {
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up);
  };

  const commitHex = (raw: string) => {
    const s = raw.trim().replace(/^#?/, '#');
    setHex(s);
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) emit(hexToRgb(s));
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={[variant === 'tool' ? 'btn icon-only cpf-tool' : 'cpf-trigger', className]
          .filter(Boolean)
          .join(' ')}
        disabled={disabled}
        aria-label={ariaLabel ?? t('common.colour')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {variant === 'tool' ? (
          <span className="cpf-tool-swatch" style={{ background: value }} />
        ) : (
          <>
            <span className="cpf-trigger-swatch" style={{ background: value }} />
            <Icon name="arrowDown" size={11} />
          </>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className={`cpf-popover ${pos ? 'is-visible' : ''}`}
            role="dialog"
            aria-label={ariaLabel ?? t('common.colour')}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            <div
              className="cpf-area"
              style={{ '--cpf-hue': `hsl(${hue}, 100%, 50%)` } as React.CSSProperties}
              onPointerDown={(e) => track(e, (x, y) => emit(hsvToRgb(hue, x, 1 - y)))}
            >
              <span
                className="cpf-dot"
                style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, background: value }}
              />
            </div>
            <div
              className="cpf-hue"
              onPointerDown={(e) =>
                track(e, (x) => {
                  const h = x * 360;
                  setHue(h);
                  // Keep S/V where they are, so dragging the strip sweeps hue
                  // rather than jumping to a fully saturated colour.
                  emit(hsvToRgb(h, sat, val));
                })
              }
            >
              <span className="cpf-dot cpf-dot-hue" style={{ left: `${(hue / 360) * 100}%` }} />
            </div>
            <div className="cpf-row">
              <input
                className="cpf-hex"
                type="text"
                spellCheck={false}
                value={hex}
                aria-label={t('light.colour.hex')}
                onChange={(e) => commitHex(e.target.value)}
                onBlur={() => setHex(value)}
              />
              {/* The three channels, editable. Hex is what gets copied around,
                  but a channel is what an LED actually takes — and nudging one
                  of them is not something a hex field can express. */}
              <span className="cpf-rgb">
                {(['r', 'g', 'b'] as const).map((ch, i) => (
                  <label key={ch} className="cpf-chan">
                    <span aria-hidden="true">{ch.toUpperCase()}</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={hexToRgb(value)[i]}
                      aria-label={t(`light.colour.${ch}` as MessageKey)}
                      onChange={(e) => {
                        const next = hexToRgb(value);
                        next[i] = Math.max(0, Math.min(255, Number(e.target.value) || 0));
                        emit(next);
                      }}
                    />
                  </label>
                ))}
              </span>
            </div>
            {/* One row per level, one column per hue — the same grid the key
                group picker offers, so "that colour" means the same thing on
                both tabs. Rendered row by row so the grid is the DOM's shape
                too, not only the stylesheet's. */}
            <div className="cpf-swatches">
              {swatches.map((row, r) => (
                <div className="cpf-swatch-row" key={r}>
                  {row.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-label={s}
                      className={value.toLowerCase() === s.toLowerCase() ? 'cpf-sw on' : 'cpf-sw'}
                      style={{ background: s }}
                      onClick={() => emit(hexToRgb(s))}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
