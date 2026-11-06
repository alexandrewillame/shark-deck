import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useCallback } from 'react';
import { useStore } from '../state/store';
import { ArtAnchor, ArtAnchorContext, type ArtMode, type ArtRect } from './ArtAnchor';

/**
 * An anchor keeps one ResizeObserver for its whole life.
 *
 * It used to re-create it whenever the travelling photo's target came or
 * went. A target is usually found from inside an observer callback (a tab
 * un-hiding), so every anchor tore its observer down and made a new one in
 * the middle of the browser's delivery. The new observations of the shallower
 * boxes (the Home card's) could not be delivered that frame, and Chromium
 * raised "ResizeObserver loop completed with undelivered notifications", which
 * the app toasted as an unexpected error (Ctrl+Tab from Home to a device tab
 * right after closing another).
 */
class FakeObserver {
  static made: FakeObserver[] = [];
  disconnected = false;
  constructor(readonly fire: () => void) {
    FakeObserver.made.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

const RECT = { top: 100, left: 200, width: 380, height: 200 };
let box = { top: 0, left: 0, width: 0, height: 0 };

function Anchor({ deviceId }: { deviceId: string }) {
  const patch = useStore((s) => s.patchArtFlightRect);
  const report = useCallback(
    (rect: ArtRect, mode: ArtMode) => patch(deviceId, rect, mode),
    [deviceId, patch],
  );
  return (
    <ArtAnchorContext.Provider value={report}>
      <ArtAnchor mode="hero" />
    </ArtAnchorContext.Provider>
  );
}

const live = () => FakeObserver.made.filter((o) => !o.disconnected);

describe('ArtAnchor', () => {
  beforeEach(() => {
    FakeObserver.made = [];
    box = { top: 0, left: 0, width: 0, height: 0 };
    vi.stubGlobal('ResizeObserver', FakeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }) as DOMRect,
    );
    useStore.setState({ artFlight: null, artTarget: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps its observer when a target is found from inside a callback', () => {
    // Two anchors, as on screen: the tab's own and the Home card's ghost.
    render(
      <>
        <Anchor deviceId="kb" />
        <Anchor deviceId="kb" />
      </>,
    );
    // Both hidden (0x0), and a flight claimed with no target yet — the state
    // Ctrl+Tab leaves after closing the tab that owned the previous flight.
    act(() => useStore.getState().setArtFlight({ deviceId: 'kb', from: null, mode: 'hero' }));
    expect(live()).toHaveLength(2);
    const first = [...live()];

    // The tab un-hides: its observer fires and the anchor reports a target.
    box = RECT;
    act(() => first[0]!.fire());

    expect(useStore.getState().artTarget?.rect).toEqual(RECT);
    expect(FakeObserver.made).toHaveLength(2);
    expect(live()).toEqual(first);
  });

  it('re-reports when the target is lost, still on the same observer', () => {
    box = RECT;
    useStore.getState().setArtFlight({ deviceId: 'kb', from: null, mode: 'hero' });
    render(<Anchor deviceId="kb" />);
    expect(useStore.getState().artTarget?.rect).toEqual(RECT);

    // A new flight clears the target. Nothing resized or scrolled, so only the
    // target-lost path can have set it again.
    act(() => useStore.getState().setArtFlight({ deviceId: 'kb', from: null, mode: 'hero' }));
    expect(useStore.getState().artTarget?.rect).toEqual(RECT);
    expect(FakeObserver.made).toHaveLength(1);
    expect(live()).toHaveLength(1);
  });
});
