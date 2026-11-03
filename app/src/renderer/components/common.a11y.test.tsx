import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, Row, Segmented, Slider, Toggle, Tooltip } from './common';
import { Icon } from './icons';

/**
 * What the shared controls say to a keyboard and a screen reader. Every
 * switch in the app was an unnamed "toggle button", every icon-only button an
 * unnamed "button", and the confirm dialogs could be neither escaped nor
 * reached with Tab — one fix each, here, rather than one per call site.
 */
describe('shared controls, without a mouse', () => {
  it('names a switch, a slider and a segmented control after the row they sit in', () => {
    render(
      <>
        <Row label="Motion Sync">
          <Toggle on onChange={vi.fn()} />
        </Row>
        <Row label="Intensity">
          <Slider value={40} min={0} max={100} onChange={vi.fn()} editable={false} />
        </Row>
        <Row label="Sensor mode">
          <Segmented
            value="hp"
            options={[
              { value: 'lp', label: 'LP' },
              { value: 'hp', label: 'HP' },
            ]}
            onChange={vi.fn()}
          />
        </Row>
      </>,
    );
    const sw = screen.getByRole('switch', { name: 'Motion Sync' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('slider', { name: 'Intensity' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Sensor mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'HP' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'LP' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('takes a switch name of its own outside a row', () => {
    render(<Toggle on={false} onChange={vi.fn()} label="Animate" />);
    expect(screen.getByRole('switch', { name: 'Animate' })).toBeTruthy();
  });

  it('names an icon-only button by its tooltip, and leaves a worded one alone', () => {
    render(
      <>
        <Tooltip text="Settings">
          <button>
            <Icon name="gear" />
          </button>
        </Tooltip>
        <Tooltip text="Writes the layout to the board">
          <button>
            <Icon name="upload" /> Apply
          </button>
        </Tooltip>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('applies a clickable row from the keyboard', () => {
    const onClick = vi.fn();
    render(
      <Row label="Stage 2" onClick={onClick}>
        <span />
      </Row>,
    );
    const row = screen.getByRole('radio', { name: 'Stage 2' });
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('asks a confirm as a dialog: focus on Cancel, Escape cancels, focus comes back', () => {
    const onResolve = vi.fn();
    const { unmount } = render(
      <>
        <button>Reset all keys</button>
        <ConfirmDialog title="Reset every key?" onResolve={onResolve} />
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Reset every key?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The safe answer has focus, so a stray Enter does not reset anything.
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onResolve).toHaveBeenCalledWith(false);
    unmount();
  });

  it('keeps Tab inside an open dialog', () => {
    render(
      <>
        <button>Behind</button>
        <ConfirmDialog title="Discard?" onResolve={vi.fn()} />
      </>,
    );
    const [cancel, ok] = screen.getAllByRole('button').filter((b) => b.closest('[role=dialog]'));
    ok!.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ok);
  });
});
