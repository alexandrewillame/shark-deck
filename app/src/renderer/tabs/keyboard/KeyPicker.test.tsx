import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KEY_GROUPS } from '@shared/keys';
import { KeyPicker } from './KeyPicker';

/**
 * "I pressed Choose for the Hold key and typed the key, and it did not select
 * it." A picker that is the question being answered listens to the keyboard:
 * the key pressed is the key picked.
 */
describe('KeyPicker', () => {
  it('stacks every group: its name on one line, its keys wrapping under it', () => {
    // Beside the name, a row's control never shrinks, so the 26 letters stayed
    // on one line and the chooser around the picker scrolled sideways.
    render(<KeyPicker onPick={vi.fn()} />);
    const rows = document.querySelectorAll('.row');
    expect(rows.length).toBe(KEY_GROUPS.length);
    for (const row of rows) expect(row.classList.contains('row-stack')).toBe(true);
  });

  it('picks the key pressed on the keyboard while it listens', () => {
    const onPick = vi.fn();
    render(<KeyPicker onPick={onPick} listen />);
    expect(screen.getByText(/Press a key on your keyboard/)).toBeTruthy();
    fireEvent.keyDown(window, { code: 'KeyB', key: 'b' });
    expect(onPick).toHaveBeenLastCalledWith('5');
    // A modifier on its own is a key to hold, too.
    fireEvent.keyDown(window, { code: 'ControlLeft', key: 'Control' });
    expect(onPick).toHaveBeenLastCalledWith('e0');
    fireEvent.keyDown(window, { code: 'F5', key: 'F5' });
    expect(onPick).toHaveBeenLastCalledWith('3e');
  });

  it('leaves Escape to close whatever it sits in, and ignores auto-repeat', () => {
    const onPick = vi.fn();
    render(<KeyPicker onPick={onPick} listen />);
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a', repeat: true });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('does not listen unless asked, or while disabled', () => {
    const onPick = vi.fn();
    const { rerender } = render(<KeyPicker onPick={onPick} />);
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' });
    rerender(<KeyPicker onPick={onPick} listen disabled />);
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByText(/Press a key on your keyboard/)).toBeNull();
  });
});
