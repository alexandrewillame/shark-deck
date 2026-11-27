import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  hexToRgb,
  hsvToRgb,
  ledPresets,
  rgbToHex,
  rgbToHsv,
  shownCss,
  shownRgb,
  type LedPreset,
  type LedResponse,
} from '../colorUtil';
import type { MessageKey, TFunc } from '@shared/i18n';
import { useAnchoredPosition, type AvoidRect } from './usePortalPosition';
import { Icon } from './icons';
import { Tooltip } from './common';
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
 * Every colour in it is SHOWN as the zone's diodes light it (`shownCss`, by
 * the zone's `response`) — the square, the strip, the presets, the chip on the
 * trigger — while the hex and the three channels are what the diodes are told.
 * A keyboard's side strip mixes light linearly and a screen does not, so there
 * the same numbers look different: #ff9500 is an orange on screen and a yellow
 * on the strip. Shown as sent, the picker promised colours the strip did not
 * make; its presets are sent as whatever makes the colour they show.
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
  response = 'screen',
  disabled,
  variant = 'field',
  align = 'start',
  className,
}: {
  /** `#rrggbb`. */
  value: string;
  onChange: (hex: string) => void;
  ariaLabel?: string;
  /** How the zone this colour is for lights what it is sent (`LedResponse`):
   *  the side strip is `linear`, everything else as a screen. */
  response?: LedResponse;
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
  // Never over a pane's Apply: picking a colour and applying it is one
  // gesture, done again and again while trying colours on the board, and a
  // picker sitting on the button made each try a close-then-click.
  const pos = useAnchoredPosition(triggerRef, popRef, open, { align, avoid: applyButtons });

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
      const el = e.target as Element;
      if (popRef.current?.contains(el) || triggerRef.current?.contains(el)) return;
      // Applying keeps it open, so the next colour is one click away.
      if (el.closest?.('.panel-actions')) return;
      setOpen(false);
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
  const shown = shownCss(value, response);
  const presets = ledPresets(response);

  /** Pointer position inside an element, as 0..1 on both axes. */
  const track = (e: React.PointerEvent<HTMLElement>, to: (x: number, y: number) => void) => {
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
          <span className="cpf-tool-swatch" style={{ background: shown }} />
        ) : (
          <>
            <span className="cpf-trigger-swatch" style={{ background: shown }} />
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
              onPointerDown={(e) => track(e, (x, y) => emit(hsvToRgb(hue, x, 1 - y)))}
            >
              <LitCanvas
                className="cpf-canvas"
                draw={(x, y) => shownRgb(hsvToRgb(hue, x, 1 - y), response)}
              />
              <span
                className="cpf-dot"
                style={{ left: `${sat * 100}%`, top: `${(1 - val) * 100}%`, background: shown }}
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
              <LitCanvas
                className="cpf-canvas"
                rows={1}
                draw={(x) => shownRgb(hsvToRgb(x * 360, 1, 1), response)}
              />
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
            {/* One column per colour family, and down it three colours of
                that family (colorUtil `LED_PALETTE`). Rendered row by row so
                the grid is the DOM's shape too, not only the stylesheet's.
                A preset's name shows under the picker, never over the hex and
                channels: clicking presets one after another to compare them
                is reading those fields each time. */}
            <div className="cpf-swatches">
              {presets.map((row, r) => (
                <div className="cpf-swatch-row" key={r}>
                  {row.map((p) => {
                    const name = swatchName(p, t);
                    return (
                      <Tooltip key={p.name} text={name} under={popRef}>
                        <button
                          type="button"
                          aria-label={name}
                          className={value.toLowerCase() === p.hex ? 'cpf-sw on' : 'cpf-sw'}
                          style={{ background: shownCss(p.hex, response) }}
                          onClick={() => emit(hexToRgb(p.hex))}
                        />
                      </Tooltip>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Every pane's Apply (and the buttons beside it) on screen, for the popover to keep clear of. */
function applyButtons(): AvoidRect[] {
  return [...document.querySelectorAll('.panel-actions')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
}

/** A preset's name and what it sends: "Orange · #ff8000". */
function swatchName(p: LedPreset, t: TFunc): string {
  return `${t(`light.swatch.${p.name}` as MessageKey)} · ${p.hex}`;
}

/**
 * A gradient drawn as the zone's diodes light it: `draw` gives the colour to
 * show at each point (0..1 across, 0..1 down), already through `shownRgb`. A
 * CSS gradient can only blend screen colours, and a linear strip's in-between
 * colours are not the screen's.
 *
 * Drawn small and stretched by CSS: it is a smooth gradient, and a few
 * thousand points of `shownRgb` redraw at once while the hue is dragged.
 */
function LitCanvas({
  draw,
  rows = 48,
  cols = 96,
  className,
}: {
  draw: (x: number, y: number) => [number, number, number];
  rows?: number;
  cols?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(cols, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const [r, g, b] = draw(x / (cols - 1), rows > 1 ? y / (rows - 1) : 0);
        const i = (y * cols + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  return <canvas ref={ref} className={className} width={cols} height={rows} aria-hidden="true" />;
}
