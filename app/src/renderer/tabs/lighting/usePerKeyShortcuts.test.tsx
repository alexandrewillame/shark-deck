import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setKeyCaptureActive } from '../../state/shortcuts';
import { usePerKeyShortcuts } from './usePerKeyShortcuts';

/**
 * The per-key editor's shortcuts are window listeners, and every device tab
 * stays mounted behind `.view-hidden` — so most of what can go wrong is a
 * shortcut firing where it should not: into a name field, under a dialog, in
 * a tab nobody is looking at.
 */

function setup({ hidden = false, escapeUsed = true } = {}) {
  const calls = {
    onTool: vi.fn(),
    onEscape: vi.fn(() => escapeUsed),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onModifierHeld: vi.fn(),
  };
  function Pane() {
    const probeRef = useRef<HTMLDivElement>(null);
    usePerKeyShortcuts({ probeRef, ...calls });
    return (
      <div className={hidden ? 'view view-hidden' : 'view'}>
        <div ref={probeRef}>
          <input type="text" aria-label="name" />
          <input type="range" aria-label="brightness" />
          {/* Something that claims a key before the window hears it. */}
          <div onKeyDown={(e) => e.preventDefault()}>
            <button>claims keys</button>
          </div>
        </div>
      </div>
    );
  }
  render(<Pane />);
  return calls;
}

/** True when the keystroke was used up (default prevented). */
const press = (key: string, init: KeyboardEventInit = {}, target: Element | Window = window) =>
  !fireEvent.keyDown(target, { key, ...init });

afterEach(() => {
  setKeyCaptureActive(false);
  document.querySelectorAll('.modal-scrim').forEach((el) => el.remove());
});

describe('usePerKeyShortcuts', () => {
  it('I picks the pipette and M the box tool, whatever the case', () => {
    const c = setup();
    expect(press('i')).toBe(true);
    expect(c.onTool).toHaveBeenLastCalledWith('pick');
    // Caps Lock: an upper-case key with no Shift held is still the letter.
    expect(press('M')).toBe(true);
    expect(c.onTool).toHaveBeenLastCalledWith('rect');
    expect(c.onTool).toHaveBeenCalledTimes(2);
  });

  it('leaves Shift+letter and a held-down letter alone', () => {
    const c = setup();
    expect(press('I', { shiftKey: true })).toBe(false);
    expect(press('m', { repeat: true })).toBe(false);
    expect(c.onTool).not.toHaveBeenCalled();
  });

  it('Ctrl+Z undoes; Ctrl+Y and Ctrl+Shift+Z redo', () => {
    const c = setup();
    expect(press('z', { ctrlKey: true })).toBe(true);
    expect(c.onUndo).toHaveBeenCalledTimes(1);
    expect(press('y', { ctrlKey: true })).toBe(true);
    expect(press('Z', { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(c.onRedo).toHaveBeenCalledTimes(2);
    // Ctrl+I is not the pipette.
    expect(press('i', { ctrlKey: true })).toBe(false);
    expect(c.onTool).not.toHaveBeenCalled();
  });

  it("takes the platform's command key: Ctrl on a PC, ⌘ on a Mac", () => {
    const c = setup();
    // Super is metaKey on Linux — not an app modifier there.
    expect(press('z', { metaKey: true })).toBe(false);
    document.documentElement.classList.add('platform-mac');
    try {
      expect(press('z', { metaKey: true })).toBe(true);
      expect(press('z', { metaKey: true, shiftKey: true })).toBe(true);
      // Ctrl+click is a right-click on a Mac; Ctrl is no command key there.
      expect(press('z', { ctrlKey: true })).toBe(false);
      expect(c.onUndo).toHaveBeenCalledTimes(1);
      expect(c.onRedo).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.classList.remove('platform-mac');
    }
  });

  it('finds a letter shortcut by its key on a non-Latin layout', () => {
    // Russian: the Z key types "я"; Arabic: "ئ". Both are shipped languages.
    const c = setup();
    expect(press('я', { ctrlKey: true, code: 'KeyZ' })).toBe(true);
    expect(press('ئ', { ctrlKey: true, code: 'KeyZ' })).toBe(true);
    expect(c.onUndo).toHaveBeenCalledTimes(2);
  });

  it('uses Escape up when it put a tool down', () => {
    const c = setup();
    expect(press('Escape')).toBe(true);
    expect(c.onEscape).toHaveBeenCalledTimes(1);
  });

  it('lets an unused Escape through, to whatever else wants it', () => {
    const c = setup({ escapeUsed: false });
    expect(press('Escape')).toBe(false);
    expect(c.onEscape).toHaveBeenCalledTimes(1);
  });

  it('stands down while a text field has focus, but not for a slider', () => {
    const c = setup();
    const name = screen.getByLabelText('name');
    expect(press('i', {}, name)).toBe(false);
    // Ctrl+Z in a name field is the field's own undo.
    expect(press('z', { ctrlKey: true }, name)).toBe(false);
    expect(c.onTool).not.toHaveBeenCalled();
    expect(c.onUndo).not.toHaveBeenCalled();

    expect(press('m', {}, screen.getByLabelText('brightness'))).toBe(true);
    expect(c.onTool).toHaveBeenCalledWith('rect');
  });

  it('does nothing in a tab nobody can see', () => {
    const c = setup({ hidden: true });
    press('i');
    press('z', { ctrlKey: true });
    press('Escape');
    press('Shift', { shiftKey: true });
    expect(c.onTool).not.toHaveBeenCalled();
    expect(c.onUndo).not.toHaveBeenCalled();
    expect(c.onEscape).not.toHaveBeenCalled();
    expect(c.onModifierHeld).not.toHaveBeenCalled();
  });

  it('does nothing under a dialog, while keys are being captured, or with Alt', () => {
    const c = setup();
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    document.body.appendChild(scrim);
    press('i');
    press('z', { ctrlKey: true });
    scrim.remove();

    setKeyCaptureActive(true);
    press('m');
    setKeyCaptureActive(false);

    // AltGr arrives as Ctrl+Alt on Windows: AltGr+Z is a character, not Undo.
    press('z', { ctrlKey: true, altKey: true });
    press('i', { altKey: true });

    expect(c.onTool).not.toHaveBeenCalled();
    expect(c.onUndo).not.toHaveBeenCalled();
  });

  it('respects a key something else already claimed', () => {
    const c = setup();
    expect(press('i', {}, screen.getByText('claims keys'))).toBe(true);
    expect(c.onTool).not.toHaveBeenCalled();
  });

  it('reports Shift or Ctrl held, and lets go on keyup and on losing focus', () => {
    const c = setup();
    press('Shift', { shiftKey: true });
    expect(c.onModifierHeld).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(window, { key: 'Shift' });
    expect(c.onModifierHeld).toHaveBeenLastCalledWith(false);

    press('Control', { ctrlKey: true });
    expect(c.onModifierHeld).toHaveBeenLastCalledWith(true);
    // Alt-Tab away with Ctrl down: the keyup goes to another window.
    fireEvent.blur(window);
    expect(c.onModifierHeld).toHaveBeenLastCalledWith(false);
  });

  it('does not report Shift typed into a text field', () => {
    const c = setup();
    press('Shift', { shiftKey: true }, screen.getByLabelText('name'));
    expect(c.onModifierHeld).not.toHaveBeenCalled();
  });
});
