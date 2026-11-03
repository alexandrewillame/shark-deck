import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../state/store';
import { SavedLibraryPanel, type SavedEntry } from './SavedLibraryPanel';

/**
 * Actuation's saved layouts and per-key lighting's share this panel, so the
 * rules for naming a saved board live in one place: saving is one click, a
 * name is never silently duplicated, and a rename cannot make two rows read
 * the same.
 */

function setup(entries: SavedEntry[]) {
  const onSave = vi.fn(async (_id: string, _name: string) => undefined);
  const onRename = vi.fn(async (_e: SavedEntry, _name: string) => undefined);
  const view = render(
    <SavedLibraryPanel
      title="Saved layouts"
      tip="Layouts saved on this computer."
      entries={entries}
      emptyText="Nothing saved yet."
      onSave={onSave}
      onRename={onRename}
      replaceTitle={(name) => `Replace “${name}”?`}
      replaceBody="The saved one is overwritten."
      renameLabel="Rename"
      thumb={(e) => <i data-testid={`thumb-${e.id}`} />}
      actions={(e) => <button>Load {e.name}</button>}
    />,
  );
  return { onSave, onRename, ...view };
}

const nameField = () => screen.getByLabelText('Layout name') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /^Save$/ });

beforeEach(() => {
  useStore.setState({ toasts: [] });
});

describe('SavedLibraryPanel', () => {
  it('saves under the next free default name in one click', async () => {
    const { onSave } = setup([
      { id: 'a', name: 'Layout 1' },
      { id: 'b', name: 'layout 3 ' },
    ]);
    // The lowest free number, counting "layout 3 " as Layout 3.
    expect(nameField().placeholder).toBe('Layout 2');
    await userEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith('', 'Layout 2');
  });

  it('saves a typed name cleaned, on Enter too, and empties the field', async () => {
    const { onSave } = setup([]);
    expect(nameField().placeholder).toBe('Layout 1');
    await userEvent.type(nameField(), '  WASD   fast {Enter}');
    expect(onSave).toHaveBeenCalledWith('', 'WASD fast');
    await waitFor(() => expect(nameField().value).toBe(''));
  });

  it('asks before overwriting a name already in the list, and overwrites that entry', async () => {
    const { onSave } = setup([
      { id: 'a', name: 'Layout 1' },
      { id: 'b', name: 'Gaming' },
    ]);
    await userEvent.type(nameField(), 'gaming');
    await userEvent.click(saveButton());
    expect(onSave).not.toHaveBeenCalled();

    const dialog = screen.getByText('Replace “gaming”?').closest('.modal') as HTMLElement;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Overwrite' }));
    expect(onSave).toHaveBeenCalledWith('b', 'gaming');
  });

  it('saves nothing when the overwrite is cancelled', async () => {
    const { onSave } = setup([{ id: 'a', name: 'Layout 1' }]);
    await userEvent.type(nameField(), 'Layout 1');
    await userEvent.click(saveButton());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText('Replace “Layout 1”?')).toBeNull();
  });

  it('refuses a rename onto another entry’s name, with a toast', async () => {
    const { onRename, container } = setup([
      { id: 'a', name: 'Desk' },
      { id: 'b', name: 'Gaming' },
    ]);
    const pencils = container.querySelectorAll<HTMLButtonElement>('.inline-rename-btn');
    await userEvent.click(pencils[1]!);
    const box = container.querySelector<HTMLInputElement>('.inline-rename-input')!;
    await userEvent.clear(box);
    await userEvent.type(box, 'desk{Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.map((t) => t.kind)).toEqual(['warn']);
  });

  it('renames to a free name, cleaned', async () => {
    const { onRename, container } = setup([{ id: 'a', name: 'Desk' }]);
    await userEvent.click(container.querySelector<HTMLButtonElement>('.inline-rename-btn')!);
    const box = container.querySelector<HTMLInputElement>('.inline-rename-input')!;
    await userEvent.clear(box);
    await userEvent.type(box, 'Desk   two{Enter}');
    expect(onRename).toHaveBeenCalledWith({ id: 'a', name: 'Desk' }, 'Desk two');
  });

  it('draws each entry with its thumbnail and actions, or says the list is empty', () => {
    const { unmount } = setup([{ id: 'a', name: 'Desk' }]);
    expect(screen.getByTestId('thumb-a')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load Desk' })).toBeTruthy();
    expect(screen.queryByText('Nothing saved yet.')).toBeNull();
    unmount();
    setup([]);
    expect(screen.getByText('Nothing saved yet.')).toBeTruthy();
  });
});
