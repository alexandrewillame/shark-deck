import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { flickerTiming, KeyboardMap } from './KeyboardMap';

/**
 * The key map has to stay clickable.
 *
 * Twice now a change elsewhere has made this board inert: an overlay taking
 * pointer events on top of it, and a tooltip wrapper becoming an in-flow grid
 * child that displaced the cap. Neither showed up in any test, because
 * nothing asserted the one thing the component is for.
 */
const LAYOUT: KeyLayoutEntry[] = [
  { label: 'A', row: 0, col: 0, slot: 0, code: 0x04, x: 0, y: 0 },
  { label: 'B', row: 0, col: 1, slot: 1, code: 0x05, x: 1, y: 0 },
];

const keyEl = (label: string): HTMLElement => {
  const el = screen.getByText(label).closest('.kbkey');
  expect(el, `no key rendered for ${label}`).not.toBeNull();
  return el as HTMLElement;
};

describe('KeyboardMap', () => {
  it('draws Tab as its keycap glyph, not the word', () => {
    // Every board in the app draws from this one legend table, so the Tab key
    // looks the same on Remap, Actuation and Lighting — like Backspace and
    // Enter already did.
    const { container } = render(
      <KeyboardMap
        layout={[{ label: 'TAB', row: 0, col: 0, slot: 2, code: 0x2b, x: 0, y: 0, w: 1.5 }]}
      />,
    );
    const cap = container.querySelector('.kbkey')!;
    expect(cap.querySelector('svg')).not.toBeNull();
    expect(cap.textContent).not.toContain('TAB');
  });

  it('draws Enter, Backspace and both Shifts as their keycap glyphs', () => {
    // Reported: Return and Backspace were not the symbols printed on a
    // keyboard, and Shift was the only big modifier still spelled out.
    const { container } = render(
      <KeyboardMap
        layout={[
          { label: 'Enter', row: 0, col: 0, slot: 81, code: 0x28, x: 0, y: 0, w: 2.25 },
          { label: 'Bksp', row: 0, col: 1, slot: 79, code: 0x2a, x: 2.25, y: 0, w: 2 },
          { label: 'SHIFT', row: 1, col: 0, slot: 4, code: 0xe1, x: 0, y: 1, w: 2.25 },
          { label: 'SHIFT', row: 1, col: 1, slot: 76, code: 0xe5, x: 2.25, y: 1, w: 1.75 },
        ]}
      />,
    );
    const caps = [...container.querySelectorAll('.kbkey')];
    expect(caps).toHaveLength(4);
    for (const cap of caps) {
      expect(cap.querySelector('svg'), cap.textContent ?? '').not.toBeNull();
      expect(cap.textContent).toBe('');
    }
  });

  it('reports the key that was clicked', async () => {
    const onSelect = vi.fn();
    render(<KeyboardMap layout={LAYOUT} onSelect={onSelect} />);
    await userEvent.click(keyEl('B'));
    expect(onSelect).toHaveBeenCalledWith({ row: 0, col: 1 }, expect.anything());
  });

  it('still reports a click when the key carries a tooltip', async () => {
    // The tooltip renders a hit layer over the whole key. It must sit ON the
    // key, not swallow it — this is the Remap tab's "reserved"/"remapped"
    // hover explanation.
    const onSelect = vi.fn();
    render(<KeyboardMap layout={LAYOUT} onSelect={onSelect} tip={(k) => `about ${k.label}`} />);
    await userEvent.click(keyEl('A'));
    expect(onSelect).toHaveBeenCalledWith({ row: 0, col: 0 }, expect.anything());
  });

  it('takes every overlay inside a key out of the grid flow', () => {
    // `.kbkey` centres its content with a grid, so an in-flow overlay becomes
    // a second grid item and pushes the label off centre — which is what a
    // tooltip wrapper did. Asserted against the stylesheet rather than
    // `getComputedStyle`, because jsdom loads no CSS and would report
    // `static` for everything.
    // Comments are stripped first. The search below is a plain `indexOf`, so a
    // selector merely MENTIONED in a comment above its own rule would match the
    // comment and hand back the wrong declaration block — a failure that reads
    // as "this rule is not absolute" when the rule is fine.
    const css = readFileSync(resolve(__dirname, '../styles/keyboard-map.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    /**
     * The declaration block following a selector.
     *
     * The match has to START a selector, not merely appear in one: a
     * theme override is written `:root[data-mode='light'] .kbmap-lit
     * .kbkey.is-lit::before`, which CONTAINS the base selector, so a plain
     * `indexOf` found the override and read its block instead — reporting
     * that the base rule is not absolute when it is.
     */
    const bodyOf = (selector: string): string => {
      for (let at = css.indexOf(selector); at !== -1; at = css.indexOf(selector, at + 1)) {
        const before = css.slice(0, at).trimEnd().slice(-1);
        if (before && before !== '}' && before !== ',') continue;
        const open = css.indexOf('{', at);
        const close = css.indexOf('}', open);
        return open === -1 || close === -1 ? '' : css.slice(open, close);
      }
      return '';
    };
    for (const sel of [
      '.kbkey > .tt-wrap',
      '.kbkey-cap',
      '.kbkey-hit',
      // The backlit key's halo. A pseudo-element is still a grid item if it is
      // in flow, so it pushes the legend off centre exactly as a real child would.
      '.kbmap-lit .kbkey.is-lit::before',
      // The per-key preview's flicker veil, for the same reason.
      '.kbmap-lit.kbmap-flicker .kbkey.is-lit::after',
    ]) {
      const body = bodyOf(sel);
      expect(body, `${sel} has no rule in keyboard-map.css`).not.toBe('');
      expect(body, `${sel} must be positioned out of the key's grid flow`).toContain(
        'position: absolute',
      );
    }
  });

  it('renders a look-only board with no click handling', async () => {
    const onSelect = vi.fn();
    render(<KeyboardMap layout={LAYOUT} interactive={false} onSelect={onSelect} />);
    await userEvent.click(keyEl('A'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/**
 * Where a dragged key may land: another key, or a group row.
 *
 * Dropping on a key copies the dragged key's settings onto it — a device write
 * with no confirmation, so what keeps it safe is that a plain drag cannot mean
 * anything else. It used to double as the marquee, and then dragging across the
 * keys you wanted to SELECT copied the first one over all of them; the marquee
 * lives on shift/ctrl now, and the drag has an 8px threshold and a keycap
 * following the cursor. Dropping a key back on itself does nothing.
 */
describe('KeyboardMap key drags', () => {
  /** jsdom implements no hit testing at all, so the drop target has to be
   *  supplied. Defined rather than spied on: the property does not exist. */
  const at = (el: HTMLElement | null) => {
    const doc = document as unknown as Record<string, unknown>;
    const had = 'elementFromPoint' in doc;
    doc.elementFromPoint = () => el;
    return {
      mockRestore() {
        if (!had) delete doc.elementFromPoint;
      },
    };
  };
  const drag = (from: HTMLElement, to: { x: number; y: number }) => {
    fireEvent.pointerDown(from, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
  };

  it('copies onto the key it is dropped on', () => {
    const onKeyDrop = vi.fn();
    render(
      <KeyboardMap
        layout={LAYOUT}
        onSelect={vi.fn()}
        onMarquee={vi.fn()}
        marqueeFromKeys
        onKeyDrop={onKeyDrop}
      />,
    );
    const spy = at(keyEl('B'));
    try {
      drag(keyEl('A'), { x: 200, y: 10 });
    } finally {
      spy.mockRestore();
    }
    expect(onKeyDrop).toHaveBeenCalledTimes(1);
    expect(onKeyDrop.mock.calls[0]![1]).toEqual({ key: { row: 0, col: 1 } });
  });

  it('does nothing when a key is dropped back on itself', () => {
    const onKeyDrop = vi.fn();
    render(
      <KeyboardMap
        layout={LAYOUT}
        onSelect={vi.fn()}
        onMarquee={vi.fn()}
        marqueeFromKeys
        onKeyDrop={onKeyDrop}
      />,
    );
    const spy = at(keyEl('A'));
    try {
      drag(keyEl('A'), { x: 200, y: 10 });
    } finally {
      spy.mockRestore();
    }
    expect(onKeyDrop).not.toHaveBeenCalled();
  });

  it('moves the key when it is dropped on a group row', () => {
    const onKeyDrop = vi.fn();
    render(
      <KeyboardMap
        layout={LAYOUT}
        onSelect={vi.fn()}
        onMarquee={vi.fn()}
        marqueeFromKeys
        onKeyDrop={onKeyDrop}
      />,
    );
    const row = document.createElement('div');
    row.dataset.groupId = 'g-7';
    document.body.appendChild(row);
    const spy = at(row);
    try {
      drag(keyEl('A'), { x: 400, y: 300 });
    } finally {
      spy.mockRestore();
      row.remove();
    }
    expect(onKeyDrop).toHaveBeenCalledTimes(1);
    expect(onKeyDrop.mock.calls[0]![1].groupId).toBe('g-7');
  });

  it('still selects the key when the press never became a drag', () => {
    const onSelect = vi.fn();
    render(
      <KeyboardMap
        layout={LAYOUT}
        onSelect={onSelect}
        onMarquee={vi.fn()}
        marqueeFromKeys
        onKeyDrop={vi.fn()}
      />,
    );
    const spy = at(null);
    try {
      // Two pixels of travel: a click, not a drag. The threshold has to be
      // above a hand tremor or half the clicks on this board are a coin toss.
      fireEvent.pointerDown(keyEl('A'), { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 12, clientY: 10 });
      fireEvent.pointerUp(window, { clientX: 12, clientY: 10 });
    } finally {
      spy.mockRestore();
    }
    expect(onSelect).toHaveBeenCalledWith({ row: 0, col: 0 }, expect.anything());
  });
});

/**
 * Which gesture a press becomes.
 *
 * Dragging is the direct manipulation — you have hold of that key — so it is
 * what an unmodified drag does, and the marquee takes shift or ctrl, which it
 * already accepted as "add to the selection". They were the other way round
 * while a drag could also drop onto a key and copy settings there: an
 * unmodified drag was then one slip away from rewriting the board.
 */
describe('KeyboardMap gestures', () => {
  /** jsdom lays nothing out, so the marquee's hit test needs boxes to hit. */
  const withBoxes = <T,>(fn: () => T): T => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 } as DOMRect;
    };
    const doc = document as unknown as Record<string, unknown>;
    doc.elementFromPoint = () => null;
    try {
      return fn();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
      delete doc.elementFromPoint;
    }
  };

  const board = () => {
    const props = { onSelect: vi.fn(), onMarquee: vi.fn(), onKeyDrop: vi.fn() };
    render(<KeyboardMap layout={LAYOUT} marqueeFromKeys {...props} />);
    return props;
  };
  const dragFrom = (el: HTMLElement, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, ...mods });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 60, ...mods });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 60, ...mods });
  };

  it('does not rubber-band on a plain drag from a key', () => {
    const p = board();
    withBoxes(() => dragFrom(keyEl('A')));
    expect(p.onMarquee).not.toHaveBeenCalled();
  });

  for (const [name, mods] of [
    ['shift', { shiftKey: true }],
    ['ctrl', { ctrlKey: true }],
  ] as const) {
    it(`rubber-bands with ${name} held`, () => {
      const p = board();
      withBoxes(() => dragFrom(keyEl('A'), mods));
      expect(p.onMarquee).toHaveBeenCalledTimes(1);
    });
  }

  it('still rubber-bands from the board background with no modifier', () => {
    // There is nothing to drag there, so the modifier would be asking for a
    // distinction that does not exist.
    const p = board();
    const host = document.querySelector('.kbmap') as HTMLElement;
    withBoxes(() => dragFrom(host));
    expect(p.onMarquee).toHaveBeenCalledTimes(1);
  });

  describe('on a painting board (per-key lighting)', () => {
    const paintBoard = () => {
      const props = { onPaint: vi.fn(), onMarquee: vi.fn() };
      render(<KeyboardMap layout={LAYOUT} marqueeOnModifier {...props} />);
      return props;
    };
    const press = (el: HTMLElement, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
      fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, ...mods });
      fireEvent.mouseDown(el, { button: 0, ...mods });
      fireEvent.mouseEnter(keyEl('B'), { buttons: 1, ...mods });
      fireEvent.pointerMove(window, { clientX: 120, clientY: 60, ...mods });
      fireEvent.pointerUp(window, { clientX: 120, clientY: 60, ...mods });
    };

    it('paints on a plain press, and draws no box', () => {
      const p = paintBoard();
      withBoxes(() => press(keyEl('A')));
      expect(p.onPaint).toHaveBeenCalledWith({ row: 0, col: 0 });
      expect(p.onMarquee).not.toHaveBeenCalled();
    });

    for (const [name, mods] of [
      ['shift', { shiftKey: true }],
      ['ctrl', { ctrlKey: true }],
    ] as const) {
      it(`boxes with ${name} held, and paints nothing on the way`, () => {
        const p = paintBoard();
        withBoxes(() => press(keyEl('A'), mods));
        expect(p.onMarquee).toHaveBeenCalledTimes(1);
        expect(p.onPaint).not.toHaveBeenCalled();
      });
    }

    it('does nothing on a plain drag over the background', () => {
      const p = paintBoard();
      const host = document.querySelector('.kbmap') as HTMLElement;
      withBoxes(() => {
        fireEvent.pointerDown(host, { button: 0, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(window, { clientX: 120, clientY: 60 });
        fireEvent.pointerUp(window, { clientX: 120, clientY: 60 });
      });
      expect(p.onMarquee).not.toHaveBeenCalled();
    });
  });

  it('reports a double-click on a key', () => {
    const onKeyDoubleClick = vi.fn();
    render(<KeyboardMap layout={LAYOUT} onSelect={vi.fn()} onKeyDoubleClick={onKeyDoubleClick} />);
    fireEvent.doubleClick(keyEl('B'));
    expect(onKeyDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ row: 0, col: 1 }));
  });
});

describe('LED flicker', () => {
  it('gives each key its own steady beat', () => {
    // Deterministic, so a re-render never restarts a key's animation...
    expect(flickerTiming(2, 5)).toEqual(flickerTiming(2, 5));
    // ...and spread, so the board does not pulse in step.
    const durs = new Set<string>();
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 16; c++) {
        const { dur, delay } = flickerTiming(r, c);
        expect(dur).toBeGreaterThanOrEqual(3.5);
        expect(dur).toBeLessThanOrEqual(8);
        expect(delay).toBeLessThanOrEqual(0);
        expect(delay).toBeGreaterThan(-dur);
        durs.add(dur.toFixed(2));
      }
    expect(durs.size).toBeGreaterThan(60);
  });

  it('only animates lit keys on a board that asks for it', () => {
    const { container, rerender } = render(
      <KeyboardMap
        layout={LAYOUT}
        lit
        flicker
        accent={(k) => (k.label === 'A' ? '#ff0000' : undefined)}
      />,
    );
    expect(container.querySelector('.kbmap')!.classList.contains('kbmap-flicker')).toBe(true);
    const [a, b] = [...container.querySelectorAll<HTMLElement>('.kbkey')];
    expect(a!.style.getPropertyValue('--kf-dur')).not.toBe('');
    expect(b!.style.getPropertyValue('--kf-dur')).toBe('');
    rerender(<KeyboardMap layout={LAYOUT} lit accent={() => '#ff0000'} />);
    expect(container.querySelector('.kbmap')!.classList.contains('kbmap-flicker')).toBe(false);
  });
});
