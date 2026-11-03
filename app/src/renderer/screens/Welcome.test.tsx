import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from '../state/store';
import { Welcome } from './Welcome';

/** What the Welcome screen says when HID enumeration itself fails. */
describe('Welcome: enumeration failure', () => {
  afterEach(() => useStore.setState({ scanDiag: null }));

  const fail = (lastError: string) =>
    useStore.setState({
      scanDiag: { totalCollections: 0, vendorMatches: 0, resolved: 0, lastError, unmatched: [] },
    });

  it('names libusb when that is what is missing (node-hid on Linux)', () => {
    fail('libusb-1.0.so.0: cannot open shared object file: No such file or directory');
    render(<Welcome />);
    expect(screen.getByText(/needs libusb 1\.0/)).toBeTruthy();
    expect(screen.queryByText(/Try reconnecting the device/)).toBeNull();
  });

  it('keeps the general advice for any other failure', () => {
    fail('could not read the HID bus');
    render(<Welcome />);
    expect(screen.getByText(/Try reconnecting the device/)).toBeTruthy();
  });
});
