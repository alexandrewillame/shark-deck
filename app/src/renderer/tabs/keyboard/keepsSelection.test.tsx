import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { EditableNumber } from '../../components/common';
import { KeyChooser } from './KeyModePanels';

/**
 * The Actuation tab clears its key selection on a click anywhere that is not
 * part of the selection's own UI, and decides that with one `closest()`
 * selector. Nothing links that selector to the markup it is supposed to match,
 * so this is the link — the real selector, read out of the tab, against real
 * elements.
 *
 * Two defects have come through here:
 *
 *  - `EditableNumber`'s editor is portalled to `document.body`, so it is
 *    "outside" the tab by construction and the selector did not name it.
 *    Clicking the spinner arrows on an actuation value deselected the key the
 *    value belonged to, and the edit had nothing left to apply to.
 *  - The selector then named whole CONTAINERS (`.kbmap`, and a
 *    `.keeps-selection` marker on the toolbar row, the group rail and the
 *    settings column), so most of the tab silently kept the selection: the
 *    empty half of the board, the gaps between the toolbar buttons, the status
 *    line, the space under the last group. There was almost nowhere left to
 *    click to drop a selection.
 *
 * And one request since, which names a container on purpose: the region under
 * the board (`.act-cols` — the Key panel and the saved layouts) keeps the
 * selection, because everything in it works on the selected keys. Clicking
 * the empty space beside a slider dropped the key the slider was editing.
 */
const SRC = readFileSync(resolve(__dirname, 'MagneticSection.tsx'), 'utf8');

const SELECTOR = (() => {
  const m = SRC.match(/const KEEPS_SELECTION\s*=\s*\n?\s*'([^']+)'/);
  if (!m) throw new Error('KEEPS_SELECTION moved or changed shape — re-point this test');
  return m[1]!;
})();

/** Does a click on this markup keep the selection? */
const keeps = (html: string, pick = 'x') => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    const el = host.querySelector(`#${pick}`);
    expect(el, `the fixture has no #${pick}`).not.toBeNull();
    return el!.closest(SELECTOR) !== null;
  } finally {
    host.remove();
  }
};

const openEditor = () => {
  render(<EditableNumber value={1.5} min={0} max={4} step={0.01} onCommit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button'));
  const el = document.querySelector('.editable-number-popover input');
  expect(el, 'the editor did not open').not.toBeNull();
  return el as HTMLElement;
};

describe("what counts as inside the Actuation tab's selection", () => {
  it('keeps it for a key, which is the selection gesture itself', () => {
    expect(keeps('<div class="kbmap"><span class="kbkey" id="x">A</span></div>')).toBe(true);
  });

  it('keeps it for every control the panels are built from', () => {
    // Nothing here is marked: they are ordinary native controls, which is what
    // makes the rule need no per-component upkeep.
    expect(keeps('<button id="x">Live board</button>')).toBe(true);
    expect(keeps('<input id="x" type="range">')).toBe(true);
    expect(keeps('<select id="x"><option>a</option></select>')).toBe(true);
    // A group row: a div that says it is a button.
    expect(keeps('<div class="kg-row" role="button"><span id="x">Group #1</span></div>')).toBe(
      true,
    );
  });

  it('keeps it for the number editor, which is portalled out of the tab', () => {
    expect(SELECTOR).toContain('.editable-number-popover');
    expect(openEditor().closest(SELECTOR)).not.toBeNull();
  });

  it('keeps it for the Mode list, portalled and role=listbox', () => {
    expect(keeps('<div role="listbox"><div role="option" id="x">Snap-tap</div></div>')).toBe(true);
  });

  it('keeps it for the group colour popover, portalled and role=dialog', () => {
    expect(keeps('<div class="kg-colors" role="dialog"><i id="x"></i></div>')).toBe(true);
  });

  it('keeps it for the key chooser, a modal portalled out of the tab — scrim included', () => {
    // The chooser's scrim covers the window, and a press on it is how the
    // chooser is dismissed: that press must not also drop the key the chooser
    // was opened for. The dialog itself is covered by role=dialog; the scrim
    // around it is the one surface that needs the marker.
    expect(
      keeps('<div class="modal-scrim keeps-selection" id="x"><div role="dialog"></div></div>'),
    ).toBe(true);
    render(<KeyChooser value={null} onChange={vi.fn()} label="Key to hold" />);
    fireEvent.click(screen.getByRole('button', { name: 'Key to hold' }));
    const scrim = document.querySelector('.modal-scrim');
    expect(scrim, 'the chooser did not open').not.toBeNull();
    expect(scrim!.closest(SELECTOR)).not.toBeNull();
  });

  // ---- the reported cases: all of these used to keep the selection ----------

  it('CLEARS it on the empty part of the board', () => {
    expect(keeps('<div class="kbmap"><div class="kbrow" id="x"></div></div>')).toBe(false);
  });

  it('CLEARS it in the gap between the toolbar buttons', () => {
    expect(keeps('<div class="act-toolbar" id="x"><button>Live board</button></div>')).toBe(false);
  });

  it('CLEARS it on the "1 key selected" status line', () => {
    expect(keeps('<span class="hint kb-status" id="x">1 key selected</span>')).toBe(false);
  });

  it('CLEARS it under the last row of the group rail', () => {
    expect(
      keeps('<div class="kg-rail" id="x"><div class="kg-row" role="button"></div></div>'),
    ).toBe(false);
  });

  it("CLEARS it on the board panel's heading or padding", () => {
    expect(keeps('<div class="panel" id="x"><h3>Per-key</h3></div>')).toBe(false);
  });

  it('KEEPS it anywhere in the Key panel and saved layouts, empty space included', () => {
    expect(keeps('<div class="act-cols"><div class="act-col" id="x"></div></div>')).toBe(true);
    expect(keeps('<div class="act-cols"><div class="panel"><h3 id="x">Key</h3></div></div>')).toBe(
      true,
    );
    expect(
      keeps('<div class="act-cols"><div class="panel"><p class="hint" id="x">…</p></div></div>'),
    ).toBe(true);
  });

  it('CLEARS it on some unrelated part of the page', () => {
    expect(keeps('<div id="x"></div>')).toBe(false);
  });

  it('never clears on a modified press, whatever it lands on', () => {
    // Shift/ctrl-drag rubber-bands a block of keys and ADDS it, and that drag
    // can start on empty board — so the modifier has to be checked before the
    // selector, or the gesture would begin by discarding what it extends.
    const guard = SRC.slice(SRC.indexOf('const onDown'), SRC.indexOf('KEEPS_SELECTION)'));
    expect(guard).toMatch(/shiftKey/);
    expect(guard).toMatch(/ctrlKey/);
    expect(guard).toMatch(/metaKey/);
  });

  // ---- and the containers are no longer named at all -----------------------

  it('names no other container, so a panel cannot swallow the click by enclosing it', () => {
    const entries = SELECTOR.split(',').map((x) => x.trim());
    for (const container of ['.kbmap', '.kg-rail', '.panel', '.act-col', '.act-toolbar']) {
      expect(entries, `${container} is a container and must not be in the selector`).not.toContain(
        container,
      );
    }
    // The one container that is named, deliberately — see the top of the file.
    expect(entries).toContain('.act-cols');
  });

  it('keeps .keeps-selection for a non-native surface, never for a region of the tab', () => {
    // Still in the selector for a surface with no native role to name it (the
    // key chooser's scrim, above), but nothing in the tab may mark a whole
    // region with it again.
    expect(SELECTOR).toContain('.keeps-selection');
    const markup = SRC.slice(SRC.indexOf('return ('));
    expect(markup).not.toContain('keeps-selection');
  });
});
