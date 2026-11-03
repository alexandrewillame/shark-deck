import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import {
  Fragment,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { getT } from '@shared/i18n';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { isSubmitEnter } from '../state/shortcuts';
import { useAnchoredPosition } from './usePortalPosition';
import { Icon } from './icons';
import { useDragOrClick } from './useDragOrClick';
import { ColorPickerField } from './ColorPickerField';
import { hexToRgb, rgbToHex } from '../colorUtil';

const TT_OPEN_DELAY = 150;

/**
 * Hover/focus tooltip, rendered into a `document.body` portal at
 * `position: fixed` so it can never be clipped by an ancestor's
 * `overflow: hidden` (every device card, `.pane`, `.content`, `.overview`)
 * or by the window edge — the previous version was positioned absolutely
 * inside the anchor and had no horizontal clamping at all. Positioning
 * itself lives in `useAnchoredPosition` (usePortalPosition.ts), shared with
 * every other floating panel that needs the same treatment (the language
 * menu, the device colour picker).
 *
 * `media`, when given, renders above the text — a small illustration/loop of
 * what the setting actually does (see components/tooltipMedia.tsx for the
 * sensor-option ones). Plain inline content rather than a video/image `src`:
 * every one of these is a placeholder standing in for real footage, and a
 * small looping SVG needs no asset file, no extra CSP allowance, and no
 * "loading" state to placeholder.
 */
/** Whether a node renders any text — an icon-only button renders none. */
function hasText(n: ReactNode): boolean {
  if (typeof n === 'string') return n.trim().length > 0;
  if (typeof n === 'number') return true;
  if (Array.isArray(n)) return n.some(hasText);
  if (isValidElement<{ children?: ReactNode }>(n) && typeof n.type === 'string') {
    return hasText(n.props.children);
  }
  return false;
}

export function Tooltip({
  children,
  text,
  media,
  mediaBare,
  placement = 'auto',
  open: forcedOpen,
}: {
  children: ReactNode;
  text: string;
  media?: ReactNode;
  /** Shown from outside, not by hover or focus — a listbox shows the
   *  explanation of the option the keyboard is on, which neither hovering
   *  nor focusing the option does. Left undefined, hover and focus decide. */
  open?: boolean;
  /** Where the bubble goes — above when it fits, else below, by default.
   *  `right`/`left` for one beside a list, where above or below would cover
   *  the options it is explaining. */
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  /**
   * The media is a picture of something whose own edges matter — a keyboard
   * layout preview, say — so it must not be rounded, clipped or boxed.
   * `.tt-media-box` is `overflow: hidden` with a 6px radius and no padding,
   * which cut the corner keys off a saved per-key layout, and the bubble's
   * 280px cap cropped the right of the board into a scroll area that cannot
   * be scrolled (the bubble is `pointer-events: none`).
   */
  mediaBare?: boolean;
}) {
  const [show, setShow] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  const visible = forcedOpen ?? show;
  const pos = useAnchoredPosition(wrapRef, bubbleRef, visible, {
    placement,
    align: placement === 'left' || placement === 'right' ? 'start' : 'center',
  });

  const open = () => {
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setShow(true), TT_OPEN_DELAY);
  };
  const close = () => {
    clearTimeout(openTimer.current);
    setShow(false);
  };
  useEffect(() => () => clearTimeout(openTimer.current), []);

  /*
   * The tooltip is also what the control is called, or what it says more.
   *
   * An icon-only button's tip IS its name: without this, every one of them —
   * the topbar's settings, language and appearance buttons, each trash can —
   * was announced as a bare "button". Any other element child is described
   * by the tip while it shows. Both go on the element itself: the wrapper
   * span carried the description before, and nothing reads a span's.
   */
  const el = isValidElement<Record<string, unknown>>(children) ? children : null;
  const dom = !!el && typeof el.type === 'string';
  const iconOnly =
    dom &&
    el!.type === 'button' &&
    !hasText(el!.props.children as ReactNode) &&
    el!.props['aria-label'] == null &&
    el!.props['aria-labelledby'] == null;
  const child = iconOnly
    ? cloneElement(el!, { 'aria-label': text })
    : dom && visible
      ? cloneElement(el!, { 'aria-describedby': id })
      : children;

  return (
    <span
      ref={wrapRef}
      className="tt-wrap"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      aria-describedby={visible && !dom ? id : undefined}
    >
      {child}
      {visible &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            id={id}
            className={`tt tt-${pos?.placement ?? 'top'} ${pos ? 'tt-visible' : ''} ${media ? 'tt-media' : ''} ${mediaBare ? 'tt-media-bare' : ''}`}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            {media && <span className={`tt-media-box ${mediaBare ? 'is-bare' : ''}`}>{media}</span>}
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

/**
 * An info icon whose text opens on hover or focus.
 *
 * Every "what is this" note in the app takes this shape: a pane's or panel's
 * description, a control's explanation. Descriptions used to be paragraphs
 * under each title — a line of text per menu, every visit, for something read
 * once — and are this instead. Focusable, so a keyboard user reaches the text
 * too (the Tooltip opens on focus).
 */
export function InfoDot({
  text,
  media,
  size = 13,
  className,
}: {
  text: string;
  media?: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <Tooltip text={text} media={media}>
      <span
        className={className ? `panel-tip ${className}` : 'panel-tip'}
        tabIndex={0}
        role="img"
        aria-label={text}
      >
        <Icon name="info" size={size} />
      </span>
    </Tooltip>
  );
}

export function BatteryPill({ level, charging }: { level: number | null; charging: boolean }) {
  const t = useT();
  if (level === null) {
    // A battery glyph with "?" instead of the bare "n/a" text — reads at a
    // glance as "this is battery info, just not known right now" instead of
    // looking like an unrelated missing value.
    return (
      <Tooltip text={t('common.na')}>
        <span className="pill mono">
          <Icon name="battery" size={12} />?
        </span>
      </Tooltip>
    );
  }
  const cls = level <= 15 ? 'bad' : level <= 35 ? 'warn' : 'good';
  const pill = (
    <span className={`pill ${cls} mono`}>
      <Icon name={charging ? 'batteryCharging' : 'battery'} size={12} />
      {level}%
    </span>
  );
  if (!charging) return pill;
  return <Tooltip text={t('status.battery.charging')}>{pill}</Tooltip>;
}

export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** Locked in its current state — for a switch whose other position isn't a
   *  state the device can be in (the last enabled DPI stage, say). Rendered as
   *  `aria-disabled` rather than a real `disabled` button on purpose: a
   *  disabled button takes no focus and fires no mouse events, so a wrapping
   *  Tooltip explaining *why* it's locked would never open. */
  disabled?: boolean;
  /** Its accessible name, where it does not sit in a `Row` — inside one it is
   *  named by the row's label (`RowLabel`). */
  label?: string;
}) {
  const rowLabel = useContext(RowLabel);
  return (
    <button
      className={`toggle ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-labelledby={label ? undefined : rowLabel}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

/**
 * A number rendered as a button that, clicked, pops a small floating input
 * over it (portalled + anchored the same way `Tooltip` is, so it can never be
 * clipped by a card/pane's `overflow: hidden`). Used wherever a value used to
 * be readable-only but draggable — the DPI track's tick labels, the mouse
 * angle-mode degree readout — and needed a way to type an exact number
 * instead of fighting a slider/handle for it.
 */
export function EditableNumber({
  value,
  min,
  max,
  step = 1,
  onCommit,
  render,
  ariaLabel,
  className,
  style,
  dataSide,
  overlay,
  triggerRef,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (next: number) => void;
  /** How to render the trigger when not editing (defaults to the bare number). */
  render?: (value: number) => ReactNode;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  /** Passed through as the `data-side` attribute — the DPI tick labels use it
   *  to flip above/below the track. */
  dataSide?: string;
  /** Position the editor exactly over the trigger's own box (hiding the
   *  trigger for the duration) instead of anchoring a small popover beside
   *  it — so editing reads as typing directly into the number you just
   *  clicked on, rather than opening a separate box next to it. Used for the
   *  mouse angle-mode degree readout. */
  overlay?: boolean;
  /** Exposes the underlying trigger `<button>` so a sibling control can open
   *  this same editor programmatically (`el.click()`) — the DPI track's tick
   *  handle uses this so clicking the tick (not just its ID label) opens the
   *  identical editor. */
  triggerRef?: (el: HTMLButtonElement | null) => void;
  /** When given, the trigger becomes draggable too, not just clickable — a
   *  plain click still opens the editor as usual, but dragging past a small
   *  threshold instead calls these with the pointer's `clientX` on every
   *  move (`onDragStart`/`onDragEnd` bracket the gesture) and suppresses the
   *  click that would otherwise follow. Used by the DPI tick's ID label so
   *  dragging *it* moves the stage exactly like dragging the tick itself. */
  onDragStart?: () => void;
  onDragMove?: (clientX: number) => void;
  onDragEnd?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  // `HTMLButtonElement | null` (not just `HTMLButtonElement`) explicitly in
  // the generic — that's what makes this a MutableRefObject (writable
  // `.current`) instead of the read-only RefObject useRef's other overload
  // returns, since the merged callback ref below assigns to it directly.
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchorRef, bubbleRef, editing && !overlay);
  const [overlayRect, setOverlayRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  /**
   * Focus AND select the digits the moment the input mounts, so clicking a
   * value and typing replaces it — no drag-select or Ctrl+A first.
   *
   * A callback ref rather than an effect keyed on `editing`, because in
   * `overlay` mode the input is not in the DOM on the render where `editing`
   * flips true: the portal waits for `overlayRect`, which a layout effect sets
   * afterwards. An `[editing]` effect therefore ran while the ref was still
   * null and never ran again — the editor opened without focus.
   *
   * ONCE per editing session, though, which the previous version was not.
   * An inline arrow is a new function identity every render, so React
   * detached and re-attached this ref on each one — re-running `select()`
   * after every keystroke. Typing "1" then "0" gave "0", because the "1" was
   * selected again the instant it appeared: the reported "cannot type a
   * two-digit number".
   */
  const selectedOnce = useRef(false);
  const focusOnMount = useCallback((el: HTMLInputElement | null) => {
    if (!el) {
      selectedOnce.current = false;
      return;
    }
    if (selectedOnce.current) return;
    selectedOnce.current = true;
    el.focus();
    el.select();
  }, []);

  useLayoutEffect(() => {
    if (!overlay || !editing) {
      setOverlayRect(null);
      return;
    }
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      // Never smaller than a comfortably readable box — the trigger it's
      // covering can be as small as its own rendered text (e.g. "15°" at
      // 12px), which made the editor itself unreadably tiny. Centred on the
      // trigger's own centre point so it still reads as covering the same
      // spot rather than growing off to one side.
      //
      // 56px was not actually enough: a `type="number"` reserves ~16px for
      // its spinner, so three digits plus a unit had barely 30px left and
      // "100%" was clipped. This fits four characters and the spinner.
      const width = Math.max(r.width, 78);
      const height = Math.max(r.height, 26);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      setOverlayRect({ top: cy - height / 2, left: cx - width / 2, width, height });
    };
    measure();
    window.addEventListener('resize', measure);
    // Capturing (same as useAnchoredPosition) so a scroll on any nested
    // scroll container — not just the window — re-measures too, since the
    // trigger can sit inside a scrollable pane.
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [overlay, editing]);

  const commit = () => {
    const n = Number(draft);
    setEditing(false);
    if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, n)));
  };

  // Drag-to-set on the trigger itself (see `onDragMove`'s doc comment) — a
  // pointerdown that moves past a small threshold before release is a drag,
  // not a click; `wasDragging` survives from pointerup into the `click`
  // event right after it (pointer events fire pointerdown/move/up, *then*
  // click, for the same gesture) so the click handler can tell the two
  // apart and not also pop the editor open right after a drag.
  const dragState = useRef<{ startX: number; dragging: boolean } | null>(null);
  const wasDragging = useRef(false);

  const input = (
    <input
      ref={focusOnMount}
      type="number"
      className="mono"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isSubmitEnter(e)) commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );

  return (
    <>
      <button
        type="button"
        ref={(el) => {
          anchorRef.current = el;
          triggerRef?.(el);
        }}
        className={`editable-number-trigger ${className ?? ''}`}
        style={overlay && editing ? { ...style, visibility: 'hidden' } : style}
        data-side={dataSide}
        aria-label={ariaLabel}
        onPointerDown={(e) => {
          if (!onDragMove) return;
          dragState.current = { startX: e.clientX, dragging: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragState.current;
          if (!d || !onDragMove) return;
          if (!d.dragging && Math.abs(e.clientX - d.startX) > 3) {
            d.dragging = true;
            onDragStart?.();
          }
          if (d.dragging) onDragMove(e.clientX);
        }}
        onPointerUp={() => {
          wasDragging.current = dragState.current?.dragging ?? false;
          if (wasDragging.current) onDragEnd?.();
          dragState.current = null;
        }}
        onClick={() => {
          // A drag just ended right before this click (pointerdown/move/up
          // fire, then click, for the same gesture) — the value's already
          // set from dragging, so don't also pop the editor open.
          if (wasDragging.current) {
            wasDragging.current = false;
            return;
          }
          setDraft(String(value));
          setEditing(true);
        }}
      >
        {render ? render(value) : value}
      </button>
      {editing &&
        overlay &&
        overlayRect &&
        createPortal(
          <span
            className="editable-number-popover editable-number-overlay is-visible"
            style={{
              top: overlayRect.top,
              left: overlayRect.left,
              width: overlayRect.width,
              height: overlayRect.height,
            }}
          >
            {input}
          </span>,
          document.body,
        )}
      {editing &&
        !overlay &&
        createPortal(
          <span
            ref={bubbleRef}
            className={`editable-number-popover ${pos ? 'is-visible' : ''}`}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            {input}
          </span>,
          document.body,
        )}
    </>
  );
}

export function Panel({
  title,
  tip,
  actions,
  className,
  children,
}: {
  /** `ReactNode`, not `string`: the remap panel's heading names the selected
   *  key by drawing the keycap itself, which is the same object the board
   *  above is showing. */
  title?: ReactNode;
  tip?: string;
  /**
   * Controls for the panel as a whole — Apply, Read from keyboard — placed on
   * the heading's own line, pushed to its far end.
   *
   * As a `Row` at the top or bottom of the body they cost a whole line each,
   * next to a heading with nothing but a word in it. Several panels stacked in
   * one pane, and the buttons were most of what was on screen.
   */
  actions?: ReactNode;
  /** Extra classes on the panel box — `panel-board-first` is the one that
   *  matters: see keyboard-map.css. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `panel ${className}` : 'panel'}>
      {(title || actions) && (
        <h4>
          {title}
          {tip && <InfoDot text={tip} />}
          {actions && <span className="panel-actions">{actions}</span>}
        </h4>
      )}
      {children}
    </div>
  );
}

/**
 * The id of the enclosing `Row`'s label, so the control in it is named by it.
 *
 * Every switch, slider and segmented control in the app sits in a Row whose
 * label says what it is — and none of them said so to a screen reader: a
 * Toggle was an empty button announced as "toggle button". Labelling by
 * reference makes the label on screen the name, in every language, with
 * nothing to pass at each call site.
 */
const RowLabel = createContext<string | undefined>(undefined);

export function Row({
  label,
  hint,
  children,
  className,
  onClick,
  selected,
}: {
  label: ReactNode;
  hint?: string;
  children: ReactNode;
  className?: string;
  /** Makes the whole row a click target (e.g. "pick this as the active
   *  stage") in addition to whatever its own children handle. */
  onClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** Radio-style "this one is the current value" state, distinct from any
   *  hover/focus highlight the caller applies via `className`. */
  selected?: boolean;
}) {
  const cls = ['row', className, onClick ? 'row-clickable' : '', selected ? 'row-selected' : '']
    .filter(Boolean)
    .join(' ');
  const labelId = useId();
  return (
    <div
      className={cls}
      onClick={onClick}
      role={onClick ? 'radio' : undefined}
      aria-checked={onClick ? selected : undefined}
      aria-labelledby={onClick ? labelId : undefined}
      // A clickable row is a choice (the DPI stage to apply): reachable and
      // usable from the keyboard like the radio it says it is. Only the row's
      // own surface — a key pressed in its number field stays the field's.
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              onClick(e as unknown as ReactMouseEvent<HTMLDivElement>);
            }
          : undefined
      }
    >
      <div>
        <div className="label" id={labelId}>
          {label}
        </div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <RowLabel.Provider value={labelId}>
        <div className="row-ctl">{children}</div>
      </RowLabel.Provider>
    </div>
  );
}

/**
 * Title + an inline `right`-slotted control on one line — the shared shape
 * for "Lighting" (its zone switcher) and "Keys" (its Base/Fn selector), which
 * used to each solve "put a segmented control next to the section title" a
 * different way.
 *
 * `sub`, the pane's one-line description, is an info dot on the title rather
 * than a paragraph under it: the paragraph was a line of the pane spent on
 * every visit for something read once.
 */
export function PaneHeader({
  title,
  sub,
  right,
}: {
  /** A plain string is wrapped in the pane's own `h2`. Anything else is
   *  rendered as-is and is expected to BE the heading — see `TitleTabs`, which
   *  is an `h2` whose words are the sub-view selector. */
  title: string | ReactNode;
  sub?: string;
  right?: ReactNode;
}) {
  /**
   * Publish this header's height to the pane, as `--pane-head-h`.
   *
   * A pane can have TWO levels of sticky selector — Lighting has Main/Side in
   * this header and Global/Per-key below it — and both were pinned to `top: 0`.
   * They landed on each other, and the second one, being later in the DOM at
   * the same z-index, hid the first: scrolling the Lighting tab lost the
   * zone selector entirely.
   *
   * The offset cannot be a constant: the header is one line with a plain
   * title, two with a tab rail, and more when it wraps on a narrow pane. So it
   * is measured, and written on the PARENT (`.pane`), which is the element the
   * level-2 rail inherits from — a custom property set here would not reach a
   * sibling.
   */
  const headRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = headRef.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    const publish = () => pane.style.setProperty('--pane-head-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      pane.style.removeProperty('--pane-head-h');
    };
  }, []);

  // A TitleTabs heading takes the dot on its own rail, after the last tab, so
  // it stays with the words it explains (and sticks with them on scroll).
  const heading =
    typeof title === 'string' ? (
      <h2 className={sub ? 'has-info' : undefined}>
        {title}
        {sub && <InfoDot text={sub} />}
      </h2>
    ) : sub && takesInfo(title) ? (
      cloneElement(title, { info: sub })
    ) : (
      <>
        {title}
        {sub && <InfoDot text={sub} className="pane-head-info" />}
      </>
    );
  return (
    <div className="pane-head" ref={headRef}>
      {heading}
      {right}
    </div>
  );
}

/**
 * A pane heading that IS its own sub-view selector.
 *
 * The sub-views (Global / Per-key, Base / Fn, Receiver LED / DPI LED) used to
 * be a `Segmented` pill slotted into `PaneHeader`'s `right`, which
 * `.pane-head .seg { margin-left: auto }` pinned to the far right of the pane
 * — diagonally opposite the tab rail on the left, so choosing where you are
 * and choosing what you are looking at happened at opposite corners of the
 * window. Worse, the pane then printed the chosen name AGAIN as a heading
 * just below, so the same word appeared twice, once inert.
 *
 * Here the options are the heading: the active one reads as the title, the
 * rest sit beside it dimmed and clickable. One place, one word each, and the
 * alternatives are visible without a click (which a dropdown would have cost).
 */
/**
 * Whether a heading element can carry the pane's info dot itself — a
 * TitleTabs. Asked by a marker property rather than `type === TitleTabs`: a
 * dev server that has hot-swapped this module can hand two copies of the
 * component to different importers, and an identity check then fails.
 */
function takesInfo(el: ReactNode): el is ReactElement<{ info?: string }> {
  return (
    isValidElement(el) &&
    typeof el.type === 'function' &&
    !!(el.type as { takesInfo?: boolean }).takesInfo
  );
}

export function TitleTabs<T extends string | number>({
  value,
  options,
  onChange,
  level = 1,
  info,
}: {
  value: T;
  options: Array<{ value: T; label: string; tip?: string }>;
  onChange: (v: T) => void;
  /** 2 for a sub-view of a sub-view — smaller, so the nesting reads as
   *  nesting rather than as two peer rows of tabs. */
  level?: 1 | 2;
  /** The pane's description, as an info dot after the last tab — see
   *  PaneHeader's `sub`, which passes it here for a TitleTabs heading. */
  info?: string;
}) {
  return (
    <h2 className={level === 2 ? 'title-tabs level-2' : 'title-tabs'}>
      {options.map((o, i) => {
        const btn = (
          <button
            className={o.value === value ? 'active' : ''}
            aria-current={o.value === value ? 'page' : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
        return (
          <Fragment key={String(o.value)}>
            {i > 0 && (
              <span className="title-tabs-sep" aria-hidden="true">
                ·
              </span>
            )}
            {o.tip ? <Tooltip text={o.tip}>{btn}</Tooltip> : btn}
          </Fragment>
        );
      })}
      {info && <InfoDot text={info} className="title-tabs-info" />}
    </h2>
  );
}
TitleTabs.takesInfo = true;

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  /** `tip` adds a hover/focus tooltip to that one segment — for controls whose
   *  options do materially different things and can't be told apart from a
   *  one-word label (e.g. Lighting's Global vs Per-Key). Per option rather than
   *  per control, and wrapping the button rather than the group, so the
   *  segments still render as one joined pill. */
  options: Array<{ value: T; label: string; tip?: string }>;
  onChange: (v: T) => void;
}) {
  const rowLabel = useContext(RowLabel);
  return (
    <div className="seg" role="group" aria-labelledby={rowLabel}>
      {options.map((o) => {
        const btn = (
          <button
            className={o.value === value ? 'active' : ''}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
        return o.tip ? (
          <Tooltip key={String(o.value)} text={o.tip}>
            {btn}
          </Tooltip>
        ) : (
          <Fragment key={String(o.value)}>{btn}</Fragment>
        );
      })}
    </div>
  );
}

/**
 * Thin wrapper over a native `<select>` so option lists are declared as data
 * and every dropdown in the config UI shares one markup/behaviour. `options`
 * may be flat or grouped (`{ label, options }`). Values round-trip as strings;
 * `onChange` gets the raw string.
 */
export function Select({
  value,
  options,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  value: string | number;
  options: Array<
    | { value: string | number; label: string }
    | { label: string; options: Array<{ value: string | number; label: string }> }
  >;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      className={className}
      value={String(value)}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o, i) =>
        'options' in o ? (
          <optgroup key={i} label={o.label}>
            {o.options.map((c) => (
              <option key={String(c.value)} value={String(c.value)}>
                {c.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ),
      )}
    </select>
  );
}

/**
 * A colour control that speaks the `[r, g, b]` tuples every lighting and DPI
 * type uses on the wire, wrapping the app's own picker.
 *
 * It used to be a native `<input type="color">` plus its own hard-coded
 * swatch row — a second, different preset list from the one the per-key
 * editor showed, and a `swatches` override no caller ever used. There is one
 * preset grid now, `COLOR_PRESET_ROWS`, and the picker carries it.
 */
export function ColorField({
  value,
  onChange,
  swatches,
  ariaLabel,
}: {
  value: [number, number, number];
  onChange: (rgb: [number, number, number]) => void;
  swatches?: readonly (readonly string[])[];
  ariaLabel?: string;
}) {
  return (
    <ColorPickerField
      value={rgbToHex(value)}
      onChange={(hex) => onChange(hexToRgb(hex))}
      swatches={swatches}
      ariaLabel={ariaLabel}
    />
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  unit,
  ariaLabel,
  editable,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  unit?: string;
  /** Names the value's edit trigger for a screen reader. The `Row` label beside
   *  it is only a sibling, and the trigger is a real button now. */
  ariaLabel?: string;
  /**
   * Lets the value itself be clicked and typed into directly, instead of only
   * ever draggable.
   *
   * **Defaults on.** It started as an opt-in for the mouse-angle slider, where
   * landing on an exact degree by dragging is genuinely painful — but that is
   * true of every value on a track, and having some numbers on the page
   * typeable and others inert, with nothing to tell them apart, is worse than
   * either rule applied consistently. Pass `false` for a track whose exact
   * number is genuinely not meaningful.
   */
  editable?: boolean;
}) {
  const canEdit = editable !== false;
  const rowLabel = useContext(RowLabel);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : rowLabel}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {canEdit ? (
        // The same trigger the Actuation tab's travel values use, rather than a
        // second hand-rolled inline editor: a plain-text number with a dashed
        // underline that says it can be clicked, and a portalled editor that a
        // pane's `overflow: hidden` can never clip (which is exactly the case
        // the all-keys panel's own scroll box used to be). `overlay` puts that
        // editor over the number itself, so the row doesn't shift while typing.
        //
        // The fixed column width lives on the WRAPPER, not on the trigger: on
        // the trigger, the dashed underline would stretch the full 56px under
        // right-aligned digits and read as an empty text field.
        <span className="slider-value">
          <EditableNumber
            value={value}
            min={min}
            max={max}
            step={step}
            onCommit={onChange}
            overlay
            ariaLabel={ariaLabel}
            render={(v) => `${v}${unit ?? ''}`}
            className="mono"
          />
        </span>
      ) : (
        <span className="slider-value mono" style={{ color: 'var(--accent)' }}>
          {value}
          {unit ?? ''}
        </span>
      )}
    </div>
  );
}

/**
 * A vertical `<input type="range">`, oriented with CSS (`writing-mode` +
 * `direction`) rather than the old `-webkit-appearance: slider-vertical` —
 * dropped from the platform, and this app's Electron/Chromium is well past
 * the version that shipped the standards-track replacement. Used by
 * `SwitchTravelStage` so the actuation/release/dead-zone handles sit at the
 * exact depth their value represents on the shared travel axis
 * (`tabs/keyboard/switchGeometry.ts`), instead of a horizontal track whose
 * geometry has nothing to do with the millimetre depth it sets.
 */
export function VerticalSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  invert,
  heightPx,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Grow from the bottom of the track upward instead of from the top down
   *  — the bottom dead-zone slider's value is a depth measured up from the
   *  base of the stroke, so 0 sits at the track's bottom, not its top. */
  invert?: boolean;
  heightPx: number;
  ariaLabel?: string;
}) {
  return (
    <input
      type="range"
      className="vslider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      // Verified empirically (writing-mode alone doesn't affect a
      // single-track range input in Chromium; `direction` is what decides
      // which end is `min`): `ltr` puts min at the top, growing downward —
      // what every column except the bottom dead zone wants. `rtl` puts min
      // at the bottom, growing upward — `invert`.
      style={{ writingMode: 'vertical-lr', direction: invert ? 'rtl' : 'ltr', height: heightPx }}
      aria-label={ariaLabel}
      aria-orientation="vertical"
    />
  );
}

/**
 * A name shown as plain (non-editable) text with a small, borderless pencil
 * next to it — clicking the pencil swaps the text itself, in place, for a
 * borderless input at the same size/position (no separate dialog box).
 * Commits on Enter or blur; Escape cancels back to the original value. Shared
 * by the device Profile tab's slot rename and the Auto-Switch profiles table.
 */
/** Strips one trailing, case-insensitive occurrence of `suffix` from `v`, if
 *  present — used to keep a fixed suffix (e.g. ".exe") out of the editable
 *  part of a value. Loops so a value the user has typed the suffix into
 *  more than once still normalises to exactly one. */
function stripSuffixLoop(v: string, suffix: string): string {
  let s = v;
  while (suffix && s.toLowerCase().endsWith(suffix.toLowerCase())) s = s.slice(0, -suffix.length);
  return s;
}

export function InlineRename({
  value,
  onCommit,
  editLabel,
  className,
  hideText,
  suffix,
  overlayRef,
}: {
  value: string;
  onCommit: (next: string) => void;
  editLabel: string;
  className?: string;
  /** Show only the pencil, not the value text — for when the value is
   *  already visible right next to this (e.g. the profile <select>). */
  hideText?: boolean;
  /** A fixed suffix (e.g. ".exe") shown greyed-out and non-editable at the
   *  end of the field while editing, and always appended to whatever is
   *  committed — for names that are really executables. */
  suffix?: string;
  /** When given, editing renders the input as a `document.body` portal sized
   *  and placed to exactly cover this element (e.g. the sibling <select> it
   *  names), hiding that element for the duration — so editing reads as
   *  typing directly into the dropdown's current item rather than opening a
   *  separate box beside it. The box is measured synchronously in the same
   *  click that starts editing (see `startEdit` below), so the very first
   *  render with `editing` on already has it — an earlier version measured
   *  it only in a later effect, so editing's first render had nowhere to put
   *  the portal and fell back to rendering the input inline; the *next*
   *  render then swapped it into the portal, which — being a structurally
   *  different position in the tree — made React discard and recreate the
   *  input instead of reusing it, losing focus (and with it, the ability to
   *  exit editing on blur) the instant editing began. Not supported together
   *  with `suffix`. */
  overlayRef?: RefObject<HTMLElement | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(suffix ? stripSuffixLoop(value, suffix) : value);
  const [overlayRect, setOverlayRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Keeps the overlay glued to its target across a resize/scroll while
  // editing, and hides the target for the same span — but does *not* do the
  // first measurement (see `startEdit`/`overlayRef`'s own comment above).
  useLayoutEffect(() => {
    const target = overlayRef?.current;
    if (!target || !editing) return;
    const measure = () => {
      const r = target.getBoundingClientRect();
      setOverlayRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    target.style.visibility = 'hidden';
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      target.style.visibility = '';
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [editing, overlayRef]);

  const startEdit = () => {
    setDraft(suffix ? stripSuffixLoop(value, suffix) : value);
    // Synchronous, plain DOM read — not an effect — so the very first render
    // with `editing` true already has a rect to portal into.
    const target = overlayRef?.current;
    if (target) {
      const r = target.getBoundingClientRect();
      setOverlayRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }
    setEditing(true);
  };

  const commit = () => {
    const body = stripSuffixLoop(draft.trim(), suffix ?? '').trim();
    const next = suffix ? `${body}${suffix}` : body;
    setEditing(false);
    if (body && next !== value) onCommit(next);
  };

  if (editing) {
    const startValue = suffix ? stripSuffixLoop(value, suffix) : value;
    const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
      // Not the Enter that confirms an IME conversion — see isSubmitEnter.
      if (isSubmitEnter(e)) commit();
      if (e.key === 'Escape') {
        setDraft(startValue);
        setEditing(false);
      }
    };
    if (overlayRef && overlayRect) {
      return createPortal(
        <input
          ref={inputRef}
          type="text"
          className={`inline-rename-input inline-rename-overlay ${className ?? ''}`}
          style={{
            position: 'fixed',
            top: overlayRect.top,
            left: overlayRect.left,
            width: overlayRect.width,
            height: overlayRect.height,
          }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />,
        document.body,
      );
    }
    // `field-sizing: content` (see `.inline-rename-input` in styles.css) is
    // what makes this grow to fit the typed text natively — no JS
    // measurement involved. Two earlier attempts tried to compute a pixel
    // width from an invisible sizer span instead, and both had a fatal flaw:
    // the sizer's own available width was, one way or another, derived from
    // the *input's current width* (the very thing being computed), so it
    // could never measure wider than whatever the input already was —
    // typing a longer name just scrolled the input's text instead of
    // growing the box, which is why only the tail end of what was typed
    // stayed visible.
    const input = (
      <input
        ref={inputRef}
        type="text"
        className={`inline-rename-input ${className ?? ''}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    );
    const editor = (
      <span className="inline-rename-edit">
        {input}
        {suffix && <span className="inline-rename-suffix">{suffix}</span>}
      </span>
    );
    if (hideText) return editor;
    // Text-in-flow rename (the Auto-Switch Modes/Games-Apps lists): float the
    // editor over a same-size, hidden copy of the read-mode content instead
    // of replacing it in flow — so the row/cell keeps reserving exactly the
    // width it had at rest and the editor is free to grow past that without
    // shifting anything around it (a table with no fixed column widths would
    // otherwise re-layout live as you type). No pencil any more (see the
    // read-mode branch below) — just a same-size hidden copy of the text.
    return (
      <span className={`inline-rename inline-rename-editing ${className ?? ''}`}>
        <span className="inline-rename-text inline-rename-trigger" style={{ visibility: 'hidden' }}>
          {value}
        </span>
        <span className="inline-rename-editor-float">{editor}</span>
      </span>
    );
  }

  if (hideText) {
    // Pencil-only: the value is already visible right next to this (e.g.
    // ProfileSwitcher's onboard/software slot rename sits beside the
    // <select> that shows the name), so the pencil stays the sole
    // affordance — this is the one remaining case that needs it.
    return (
      <span className={`inline-rename ${className ?? ''}`}>
        <Tooltip text={editLabel}>
          <button type="button" className="inline-rename-btn" onClick={startEdit}>
            <Icon name="pencil" size={12} />
          </button>
        </Tooltip>
      </span>
    );
  }
  // Text-in-flow: the name itself is the click target, no separate pencil —
  // used by the Auto-Switch Modes list and the Games/Apps rows.
  return (
    <span className={`inline-rename ${className ?? ''}`}>
      <Tooltip text={editLabel}>
        <button
          type="button"
          className="inline-rename-text inline-rename-trigger"
          onClick={startEdit}
        >
          {value}
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * In-app text prompt. Electron's renderer has no `window.prompt`, so anything
 * that used it (auto-switch profile naming) silently did nothing — this is the
 * replacement. Resolves to the entered string, or null on cancel.
 *
 * Portaled to `document.body` — same reason as the language menu
 * (`.lang-menu-list`) and `Tooltip`: `.topbar`'s `backdrop-filter` gives it
 * its own stacking context, so anything rendered as its DOM descendant (e.g.
 * a dialog opened from a topbar control) would otherwise paint — and
 * hit-test — *behind* the later `.content` sibling regardless of this
 * dialog's own `z-index`, making it visible-but-unclickable whenever
 * `.content` has anything covering that area.
 */
export function PromptDialog({
  title,
  defaultValue = '',
  confirmLabel,
  suffix,
  onBrowse,
  browseLabel,
  onResolve,
}: {
  title: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** A fixed suffix (e.g. ".exe") shown greyed-out at the end of the field and
   *  always appended to whatever is resolved — for prompts naming an
   *  executable. Any occurrence the user types (or a browsed path ends in) is
   *  normalised away rather than duplicated. */
  suffix?: string;
  /** When given, renders a "browse for it on disk" button next to the field;
   *  its resolved value (if any) replaces the field's contents rather than
   *  submitting immediately, so it can still be edited before OK. */
  onBrowse?: () => Promise<string | null>;
  browseLabel?: string;
  onResolve: (value: string | null) => void;
}) {
  const t = useT();
  const strip = (v: string) => (suffix ? stripSuffixLoop(v, suffix) : v);
  const [value, setValue] = useState(strip(defaultValue));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => {
    const body = strip(value).trim();
    onResolve(body ? `${body}${suffix ?? ''}` : null);
  };
  // Picking a file is itself the decision — it validates immediately instead
  // of just filling the field and leaving OK to be clicked separately.
  const browse = async () => {
    const picked = await onBrowse?.();
    if (picked) onResolve(`${strip(picked)}${suffix ?? ''}`);
  };
  return createPortal(
    <div className="modal-scrim" onMouseDown={() => onResolve(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h4>{title}</h4>
        <div className="modal-input-row">
          <span className={`modal-input-suffixed ${suffix ? 'has-suffix' : ''}`}>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitEnter(e)) submit();
                if (e.key === 'Escape') onResolve(null);
              }}
            />
            {suffix && <span className="inline-rename-suffix">{suffix}</span>}
          </span>
          {onBrowse && (
            <Tooltip text={browseLabel ?? t('as.browse')}>
              <button
                type="button"
                className="btn icon-only"
                aria-label={browseLabel ?? t('as.browse')}
                onClick={() => void browse()}
              >
                <Icon name="folder" size={13} />
              </button>
            </Tooltip>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => onResolve(null)}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={submit}>
            {confirmLabel ?? t('common.ok')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A yes/no confirmation, same `.modal-scrim`/`.modal` chrome as PromptDialog
 * but with no input — for a decision that needs a sentence of context first
 * (e.g. "enabling auto-switch will disable Pin a mode — continue?").
 * Resolves `true` on confirm, `false` on cancel/dismiss.
 *
 * Portaled to `document.body` — see PromptDialog's doc comment just above:
 * a caller inside `.topbar` (e.g. AutoSwitchControl in App.tsx) would
 * otherwise render a dialog that's visible but unclickable, trapped behind
 * `.content` by `.topbar`'s own stacking context.
 */
/** What a focus trap cycles through. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The frame both confirm dialogs are drawn in — and what makes them dialogs
 * for everyone, not only for a mouse.
 *
 * They were a box over a scrim and nothing more: Escape did nothing, focus
 * stayed on the page behind (so Tab walked off under the scrim, and a screen
 * reader never learned a question had been asked), and no element said it was
 * a dialog. Now it is a labelled modal dialog; focus moves to its FIRST
 * button, which is Cancel in every caller — the safe answer to an accidental
 * Enter on "reset every key" — stays inside it, and goes back where it was
 * when the dialog closes. Escape and a click on the scrim both cancel.
 */
function ModalFrame({
  title,
  body,
  onCancel,
  children,
}: {
  title: string;
  body?: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = box.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (before?.isConnected) before.focus();
    };
  }, []);
  return createPortal(
    <div className="modal-scrim" onMouseDown={() => cancel.current()}>
      <div
        ref={box}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h4 id={titleId}>{title}</h4>
        {body && <p>{body}</p>}
        <div className="modal-actions">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onResolve,
}: {
  title: string;
  body?: string;
  confirmLabel?: string;
  onResolve: (confirmed: boolean) => void;
}) {
  const t = useT();
  return (
    <ModalFrame title={title} body={body} onCancel={() => onResolve(false)}>
      <button className="btn" onClick={() => onResolve(false)}>
        {t('common.cancel')}
      </button>
      <button className="btn primary" onClick={() => onResolve(true)}>
        {confirmLabel ?? t('common.ok')}
      </button>
    </ModalFrame>
  );
}

/**
 * The three-way version of ConfirmDialog, for leaving an editor with unsaved
 * work: Save, Discard, or stay put.
 *
 * A separate component rather than a fourth button on ConfirmDialog — a
 * two-button confirm that silently gained a third option would change what
 * every existing caller's dialog looks like. Dismissing (scrim or Cancel)
 * resolves 'cancel', so the safe answer is always the accidental one.
 */
export function SaveDiscardDialog({
  title,
  body,
  saveLabel,
  discardLabel,
  onResolve,
}: {
  title: string;
  body?: string;
  saveLabel: string;
  discardLabel: string;
  onResolve: (choice: 'save' | 'discard' | 'cancel') => void;
}) {
  const t = useT();
  return (
    <ModalFrame title={title} body={body} onCancel={() => onResolve('cancel')}>
      <button className="btn" onClick={() => onResolve('cancel')}>
        {t('common.cancel')}
      </button>
      <button className="btn danger" onClick={() => onResolve('discard')}>
        {discardLabel}
      </button>
      <button className="btn primary" onClick={() => onResolve('save')}>
        {saveLabel}
      </button>
    </ModalFrame>
  );
}

/**
 * Last-resort fallback if `WindowControls` itself errors — used as the
 * `fallback` of the `ErrorBoundary` wrapping it in App.tsx. No hooks, no
 * IPC round-trip to read maximize state, nothing that can itself throw:
 * just enough that the frameless window always stays closable even if the
 * fancier controls around it broke. Its one word of text is read from the
 * store's language as it renders, which is a lookup, not a subscription.
 */
export function MinimalWindowControls() {
  const t = getT(useStore.getState().settings?.language ?? 'en');
  return (
    <div className="winctl">
      <button
        className="winctl-btn winctl-close"
        title={t('win.close')}
        onClick={() => window.sharkdeck.windowClose()}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}

/** Custom titlebar window buttons (the window is frameless — see main/index.ts). */
export function WindowControls() {
  const t = useT();
  const sd = window.sharkdeck;
  const [max, setMax] = useState(false);
  useEffect(() => {
    sd.windowIsMaximized().then(setMax);
    return sd.on('window:maximized', setMax);
  }, [sd]);
  const minDrag = useDragOrClick<HTMLButtonElement>(() => sd.windowMinimize());
  const maxDrag = useDragOrClick<HTMLButtonElement>(() => sd.windowToggleMaximize());
  const closeDrag = useDragOrClick<HTMLButtonElement>(() => sd.windowClose());
  return (
    <div className="winctl">
      <button className="winctl-btn" title={t('win.minimize')} {...minDrag}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="winctl-btn"
        title={max ? t('win.restore') : t('win.maximize')}
        {...maxDrag}
      >
        {max ? (
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <rect x="3" y="1.5" width="7" height="7" fill="none" stroke="currentColor" />
            <rect x="1.5" y="3.5" width="7" height="7" fill="var(--bg-1)" stroke="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button className="winctl-btn winctl-close" title={t('win.close')} {...closeDrag}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}

/**
 * A slider over a small number of discrete device steps, labelled by the step
 * itself rather than as a percentage.
 *
 * Keyboard LED brightness and speed are `0..4` on the wire — the vendor's own
 * per-effect table gives every effect `maxValue: 4, maxSpeed: 4`, and the
 * driver's `brightnessToWire`/`speedToWire` divide by 25. Showing them as
 * 0-100% offered 101 positions over 5 real values, so the slider appeared to
 * move without the board changing, four times out of five.
 *
 * The 0-100 scale is kept on the wire side deliberately: `LightingSettings` is
 * shared with mouse lighting and is the persisted shape in software profiles
 * and backups, so it must not be redefined under stored data. This converts at
 * the edge instead.
 */
export function StepSlider({
  value,
  steps,
  onChange,
  ariaLabel,
}: {
  /** 0-100, as stored. Snapped to the nearest step for display. */
  value: number;
  /** How many device steps there are, counting 0 (so 5 means 0..4). */
  steps: number;
  /** Reports back on the same 0-100 scale. */
  onChange: (v: number) => void;
  ariaLabel?: string;
}) {
  const max = steps - 1;
  const toStep = (pct: number) => Math.max(0, Math.min(max, Math.round((pct / 100) * max)));
  const toPct = (step: number) => Math.round((step / max) * 100);
  const step = toStep(value);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={step}
        aria-label={ariaLabel}
        onChange={(e) => onChange(toPct(Number(e.target.value)))}
      />
      <span className="slider-value mono" style={{ color: 'var(--accent)' }}>
        {step}
      </span>
    </div>
  );
}
