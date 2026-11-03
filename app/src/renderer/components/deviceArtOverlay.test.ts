import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The travelling device photo must not intercept pointer input by default.
 *
 * It is a `position: fixed` overlay painted on top of whatever pane is
 * showing. On the Keys / Actuation / per-key Lighting panes it is anchored
 * onto the interactive key map itself and merely faded out — opacity 0, still
 * laid out — so giving the base rule `pointer-events: auto` put an invisible
 * rectangle over the whole keyboard and killed every click and tooltip on it.
 *
 * That is exactly what happened when the rubber-band drag was added, and it
 * is not visible in a screenshot: the board looks perfect and simply does not
 * respond. Hence a test.
 */
describe('device-art overlay pointer handling', () => {
  const css = readFileSync(resolve(__dirname, '../styles/device-art.css'), 'utf8');

  /** The declaration block following a selector, by plain text search. */
  const bodyOf = (selector: string): string => {
    const at = css.indexOf(selector);
    if (at === -1) return '';
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    return open === -1 || close === -1 ? '' : css.slice(open, close);
  };

  it('is click-through in its base state', () => {
    const base = bodyOf('.device-art-persistent {');
    expect(base, 'no base rule found').not.toBe('');
    expect(base, 'the travelling photo must not take pointer events by default').toContain(
      'pointer-events: none',
    );
  });

  it('never opts back in, in any state', () => {
    // The rubber-band gesture listens on `window` now, so no state needs the
    // overlay to take events — and any rule that gave it some would put an
    // invisible rectangle back over the key map. Assert the whole file.
    expect(css, 'nothing may set pointer-events: auto on the travelling photo').not.toMatch(
      /pointer-events:\s*auto/,
    );
  });

  it('does not bind the gesture to the element', () => {
    const tsx = readFileSync(resolve(__dirname, 'PersistentDeviceArt.tsx'), 'utf8');
    expect(tsx, 'the drag must stay a window listener, not a prop on the overlay').not.toContain(
      'onPointerDown',
    );
  });

  it('never enables pointer events for the keyboard mode', () => {
    const tsx = readFileSync(resolve(__dirname, 'PersistentDeviceArt.tsx'), 'utf8');
    const at = tsx.indexOf('const draggable =');
    expect(at, 'draggable is no longer derived in one place').toBeGreaterThan(-1);
    const line = tsx.slice(at, tsx.indexOf(';', at));
    expect(line, 'the key-map mode must be excluded from dragging').toContain(
      "mode !== 'keyboard'",
    );
  });
});
