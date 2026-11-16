import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KEY_GROUPS } from '@shared/keys';
import { KeyPicker } from './KeyPicker';
import { REMAP_GROUPS } from './remapGroups';

/** The names of the key buttons on screen, in order. */
const shownKeys = () =>
  [...document.querySelectorAll('.remap-key')].map((b) => b.getAttribute('aria-label'));

/**
 * "Have a search box so the user can type the shortcut he wants and easily
 * find it, instead of having to look through the whole list."
 */
describe('KeyPicker search', () => {
  it('has no box unless asked for one', () => {
    render(<KeyPicker onPick={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('narrows the list to what is typed, and the clear button brings it all back', () => {
    render(<KeyPicker onPick={vi.fn()} groups={REMAP_GROUPS} searchable />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search keys…' }), {
      target: { value: 'vol' },
    });
    expect(shownKeys()).toEqual(['Volume -', 'Volume +']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(document.querySelectorAll('.row').length).toBe(REMAP_GROUPS.length);
  });

  it('says so when nothing matches', () => {
    render(<KeyPicker onPick={vi.fn()} groups={REMAP_GROUPS} searchable />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No key matches “zzzz”.')).toBeTruthy();
    expect(shownKeys()).toEqual([]);
  });

  it('empties the box on Escape', () => {
    render(<KeyPicker onPick={vi.fn()} groups={REMAP_GROUPS} searchable />);
    const box = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'f5' } });
    expect(shownKeys()).toEqual(['F5']);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
  });

  it('picks nothing from what is typed into the box, while it listens', () => {
    const onPick = vi.fn();
    render(<KeyPicker onPick={onPick} listen searchable />);
    fireEvent.keyDown(screen.getByRole('textbox'), { code: 'KeyV', key: 'v' });
    expect(onPick).not.toHaveBeenCalled();
  });
});

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
