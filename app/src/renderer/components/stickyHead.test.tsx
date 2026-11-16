import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Panel } from './common';
import { useStuckHead } from './stickyHead';

function Box() {
  const ref = useRef<HTMLDivElement>(null);
  useStuckHead(ref);
  return (
    <div ref={ref} data-testid="box" className="has-sticky-head">
      <h4 className="sticky-head">Heading</h4>
      <p>Body</p>
    </div>
  );
}

const top = (el: Element, y: number) => {
  el.getBoundingClientRect = () => ({ top: y }) as DOMRect;
};
const nextFrame = () => new Promise((r) => setTimeout(r, 50));

/**
 * "When we modify a setting but have not saved yet, there is a Save / Apply
 * button somewhere. Make it always visible, even scrolled to the bottom of
 * the page." The heading that holds it is pinned (panes.css); this is the half
 * that says WHEN it is pinned, so it only paints a surface of its own then.
 */
describe('useStuckHead', () => {
  it('marks the box while its heading has moved down from the top, and not after', async () => {
    render(<Box />);
    const box = screen.getByTestId('box');
    const head = box.querySelector('h4')!;
    expect(box.hasAttribute('data-stuck')).toBe(false);

    // Scrolled: the box's top is far above, the pinned heading still in view.
    top(box, -300);
    top(head, 60);
    fireEvent.scroll(document);
    await nextFrame();
    expect(box.hasAttribute('data-stuck')).toBe(true);

    // Back at the top: the heading sits on the box's own top edge again.
    top(box, 40);
    top(head, 41);
    fireEvent.scroll(document);
    await nextFrame();
    expect(box.hasAttribute('data-stuck')).toBe(false);
  });

  it('is what a Panel asks for with stickyHead, and only then', () => {
    const { container } = render(
      <>
        <Panel title="Pinned" stickyHead actions={<button>Apply</button>}>
          body
        </Panel>
        <Panel title="Plain">body</Panel>
      </>,
    );
    const [pinned, plain] = [...container.querySelectorAll('.panel')];
    expect(pinned!.classList.contains('has-sticky-head')).toBe(true);
    expect(pinned!.querySelector(':scope > h4')!.classList.contains('sticky-head')).toBe(true);
    expect(plain!.classList.contains('has-sticky-head')).toBe(false);
    expect(plain!.querySelector('.sticky-head')).toBeNull();
  });
});
