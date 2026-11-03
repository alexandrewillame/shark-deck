import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ListboxSelect, type ListboxOption } from './ListboxSelect';

/**
 * The Mode picker's list. What it must get right: each option explains itself
 * while being considered — by mouse or by keyboard — an option that cannot be
 * chosen is never chosen, and leaving the list (Escape, Tab, a click away)
 * changes nothing.
 */

type Mode = 'normal' | 'snap' | 'mt' | 'dks';
const OPTIONS: ListboxOption<Mode>[] = [
  { value: 'normal', label: 'Normal', tip: 'One action at the actuation point.' },
  { value: 'snap', label: 'Snap-tap', tip: 'Pairs two opposing keys.' },
  { value: 'mt', label: 'Mod-tap', tip: 'Tap for one key, hold for another.', disabled: true },
  { value: 'dks', label: 'Dynamic keystroke (DKS)', tip: 'Up to four actions per press.' },
];

function setup(value: Mode | null = 'normal') {
  const onChange = vi.fn();
  render(
    <ListboxSelect
      value={value}
      options={OPTIONS}
      onChange={onChange}
      placeholder="Mixed"
      ariaLabel="Mode"
    />,
  );
  const box = screen.getByRole('combobox', { name: 'Mode' });
  return { onChange, box };
}

const activeLabel = (box: HTMLElement) =>
  document.getElementById(box.getAttribute('aria-activedescendant') ?? '')?.textContent;

describe('ListboxSelect', () => {
  it('shows the chosen option, or the placeholder when there is none', () => {
    const { box } = setup('snap');
    expect(box.textContent).toContain('Snap-tap');
    document.body.innerHTML = '';
    expect(setup(null).box.textContent).toContain('Mixed');
  });

  it('opens on click and chooses with a click, closing behind it', async () => {
    const { box, onChange } = setup();
    await userEvent.click(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    await userEvent.click(screen.getByRole('option', { name: /Snap-tap/ }));
    expect(onChange).toHaveBeenCalledWith('snap');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marks the current option selected, and does not re-choose it', async () => {
    const { box, onChange } = setup('normal');
    await userEvent.click(box);
    expect(screen.getByRole('option', { name: /Normal/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('option', { name: /Normal/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never chooses an option that cannot be chosen', async () => {
    const { box, onChange } = setup();
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('option', { name: /Mod-tap/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('walks with the arrows, skipping what cannot be chosen, and chooses with Enter', () => {
    const { box, onChange } = setup('normal');
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // opens on Normal
    expect(activeLabel(box)).toContain('Normal');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(activeLabel(box)).toContain('Snap-tap');
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // Mod-tap is disabled
    expect(activeLabel(box)).toContain('DKS');
    fireEvent.keyDown(box, { key: 'Home' });
    expect(activeLabel(box)).toContain('Normal');
    fireEvent.keyDown(box, { key: 'End' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('dks');
  });

  it("shows the keyboard's option's explanation beside it", () => {
    const { box } = setup('normal');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('tooltip').textContent).toBe('Pairs two opposing keys.');
  });

  it('jumps to the next option starting with a typed letter', () => {
    const { box } = setup('normal');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'd' });
    expect(activeLabel(box)).toContain('DKS');
  });

  it('closes on Escape or Tab without changing anything', () => {
    const { box, onChange } = setup('normal');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    // Used up, so the tab around it does not also act on it.
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on a press anywhere else', async () => {
    const { box, onChange } = setup();
    await userEvent.click(box);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
