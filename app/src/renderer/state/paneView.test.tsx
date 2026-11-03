import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { dropPaneViews, peekPaneView, usePaneView } from './paneView';

/**
 * Every config pane is rebuilt when the device's profile changes — that is how
 * each one is made to re-read the board (`key={active}:{configEpoch}` in
 * DeviceConfig). A sub-view held in `useState` dies with it, so switching
 * profile while working on the Fn layer put you back on Base, and the same for
 * every other sub-view in the app. Which layer you are editing has nothing to
 * do with which profile it belongs to.
 */
function Pane({ id }: { id: string }) {
  const [view, setView] = usePaneView<'base' | 'fn'>(`${id}:keys.layer`, 'base');
  return (
    <>
      <span data-testid="view">{view}</span>
      <button onClick={() => setView('fn')}>fn</button>
    </>
  );
}

describe('usePaneView', () => {
  it('survives the pane being rebuilt', () => {
    const { unmount } = render(<Pane id="dev-1" />);
    fireEvent.click(screen.getByText('fn'));
    expect(screen.getByTestId('view').textContent).toBe('fn');
    // What a configEpoch bump does: the whole subtree goes and comes back.
    unmount();
    render(<Pane id="dev-1" />);
    expect(screen.getByTestId('view').textContent).toBe('fn');
    dropPaneViews('dev-1');
  });

  it('keeps two devices apart', () => {
    render(<Pane id="dev-a" />);
    fireEvent.click(screen.getByText('fn'));
    expect(peekPaneView('dev-a:keys.layer')).toBe('fn');
    expect(peekPaneView('dev-b:keys.layer')).toBeUndefined();
    dropPaneViews('dev-a');
  });

  it('falls back until something is chosen, and only until then', () => {
    expect(peekPaneView('dev-c:keys.layer')).toBeUndefined();
    render(<Pane id="dev-c" />);
    expect(screen.getByTestId('view').textContent).toBe('base');
    fireEvent.click(screen.getByText('fn'));
    expect(peekPaneView('dev-c:keys.layer')).toBe('fn');
    dropPaneViews('dev-c');
    expect(peekPaneView('dev-c:keys.layer')).toBeUndefined();
  });
});
