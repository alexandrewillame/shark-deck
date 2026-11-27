import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './common';

/**
 * A colour preset's name goes under the whole picker, level with its swatch:
 * above the swatch it covered the hex and channel fields, read right after a
 * click (the owner's report, 11-27); below it, the next row of presets.
 */

const box = (left: number, top: number, right: number, bottom: number) =>
  ({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
  }) as DOMRect;

function Picker({ under }: { under: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) el.getBoundingClientRect = () => box(100, 100, 400, 400);
      }}
    >
      <Tooltip text="Orange · #ff8000" under={under ? ref : undefined}>
        <button
          ref={(el) => {
            const wrap = el?.parentElement;
            if (wrap) wrap.getBoundingClientRect = () => box(150, 300, 170, 320);
          }}
        >
          swatch
        </button>
      </Tooltip>
    </div>
  );
}

const bubble = async () => {
  fireEvent.mouseEnter(screen.getByText('swatch').parentElement!);
  const tip = await screen.findByRole('tooltip');
  await waitFor(() => expect(tip.className).toContain('tt-visible'));
  return tip;
};

describe('Tooltip under', () => {
  it('sits below the element it is given, centred on its own child', async () => {
    render(<Picker under />);
    const tip = await bubble();
    expect(parseFloat(tip.style.top)).toBe(400 + 8);
    expect(parseFloat(tip.style.left)).toBe(160);
    expect(tip.className).toContain('tt-bottom');
  });

  it('goes above it instead when there is no room below', async () => {
    const h = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 405, configurable: true });
    try {
      render(<Picker under />);
      const tip = await bubble();
      expect(parseFloat(tip.style.top)).toBeLessThanOrEqual(100 - 8);
      expect(tip.className).toContain('tt-top');
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    }
  });

  it('without it, places against the child as before', async () => {
    render(<Picker under={false} />);
    const tip = await bubble();
    expect(parseFloat(tip.style.top)).toBe(300 - 8);
  });
});
