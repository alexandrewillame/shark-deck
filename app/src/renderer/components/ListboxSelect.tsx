import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './common';
import { Icon } from './icons';
import { useAnchoredPosition } from './usePortalPosition';

export interface ListboxOption<V extends string> {
  value: V;
  label: string;
  /** What this choice does — shown beside it while it is hovered, or while
   *  the keyboard is on it. */
  tip?: string;
  /** Listed but not choosable; `tip` should then say why. */
  disabled?: boolean;
  /** After the label — an "Experimental" tag, say. */
  badge?: ReactNode;
}

/**
 * A select whose options can explain themselves.
 *
 * A native `<select>` cannot: the OS draws its options and they take no
 * tooltip, so the Actuation tab's six modes were explained in one long
 * tooltip on the row's label, read before opening the list and gone once it
 * was open — exactly when the choice is being made. Here each option carries
 * its own explanation, beside the list rather than over it.
 *
 * The WAI-ARIA select-only combobox. Focus stays on the button and the
 * keyboard's option is `aria-activedescendant`, so screen readers follow it
 * and nothing in the list ever takes focus. ↓ ↑ Enter or Space open it; in
 * the list ↓ ↑ move (skipping what cannot be chosen), Home and End jump,
 * Enter or Space choose, a letter jumps to the next option starting with it,
 * and Escape or Tab close it with nothing changed.
 *
 * `value` matching no option shows `placeholder` — "Mixed", for a selection
 * of keys that disagree.
 */
export function ListboxSelect<V extends string>({
  value,
  options,
  onChange,
  placeholder = '',
  ariaLabel,
  disabled,
  className,
  face,
}: {
  value: V | null;
  options: ListboxOption<V>[];
  onChange: (v: V) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  /** Shown on the button in place of the chosen option's label — for a cell
   *  whose menu says more than the cell has room for (the DKS grid: "Tap
   *  here" in the list, a dot and "Tap" in the cell). */
  face?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** Being walked with the keyboard: the active option shows its tip. With
   *  the mouse, hovering an option shows its own. */
  const [keyed, setKeyed] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const pos = useAnchoredPosition(btnRef, listRef, open, {
    align: 'start',
    placement: 'bottom',
    gap: 4,
  });
  const current = options.find((o) => o.value === value) ?? null;

  /** The first option that can be chosen from `start`, walking by `step`. */
  const enabledFrom = (start: number, step: 1 | -1): number => {
    for (let i = start; i >= 0 && i < options.length; i += step) {
      if (!options[i]!.disabled) return i;
    }
    return -1;
  };

  const openList = (byKey: boolean) => {
    if (disabled) return;
    const selected = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(selected >= 0 ? selected : enabledFrom(0, 1));
    setKeyed(byKey);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setKeyed(false);
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    if (o.value !== value) onChange(o.value);
  };

  // A press anywhere else closes it, with nothing changed.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const move = (to: number) => {
    if (to < 0) return;
    setKeyed(true);
    setActive(to);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(enabledFrom(active + 1, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(enabledFrom(active - 1, -1));
        return;
      case 'Home':
        e.preventDefault();
        move(enabledFrom(0, 1));
        return;
      case 'End':
        e.preventDefault();
        move(enabledFrom(options.length - 1, -1));
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(active);
        return;
      case 'Escape':
        // Used up here: the list closing is what Escape meant, not whatever
        // the page around it would do with it.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case 'Tab':
        close();
        return;
    }
    if (e.key.length === 1 && e.key.trim() && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      for (let n = 1; n <= options.length; n++) {
        const i = (active + n) % options.length;
        const o = options[i]!;
        if (!o.disabled && o.label.toLowerCase().startsWith(k)) {
          move(i);
          break;
        }
      }
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={className ? `listbox-select ${className}` : 'listbox-select'}
        onClick={() => (open ? close() : openList(false))}
        onKeyDown={onKeyDown}
      >
        <span className={current ? 'listbox-select-value' : 'listbox-select-value is-placeholder'}>
          {face ?? (current ? current.label : placeholder)}
        </span>
        {current?.badge}
        <Icon name="arrowDown" size={12} className="listbox-select-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            aria-label={ariaLabel}
            className="listbox-select-list"
            style={
              pos
                ? {
                    left: pos.left,
                    top: pos.top,
                    maxHeight: pos.maxHeight,
                    minWidth: btnRef.current?.offsetWidth,
                  }
                : { left: -9999, top: -9999 }
            }
          >
            {options.map((o, i) => {
              const row = (
                <div
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  className={
                    i === active ? 'listbox-select-option is-active' : 'listbox-select-option'
                  }
                  onMouseEnter={() => {
                    setKeyed(false);
                    if (!o.disabled) setActive(i);
                  }}
                  // Keep focus on the button: the list never takes it.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span className="listbox-select-check" aria-hidden="true">
                    {o.value === value && <Icon name="check" size={12} />}
                  </span>
                  <span className="listbox-select-label">{o.label}</span>
                  {o.badge}
                </div>
              );
              return o.tip ? (
                <Tooltip
                  key={o.value}
                  text={o.tip}
                  placement="right"
                  open={keyed ? i === active : undefined}
                >
                  {row}
                </Tooltip>
              ) : (
                <span key={o.value} className="tt-wrap">
                  {row}
                </span>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
