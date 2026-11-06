import { afterEach, describe, expect, it } from 'vitest';
import { keyName, keyNameForCode } from './shortcuts';

/**
 * The HID usages a PC keyboard prints Win and Alt on are ⌘ and ⌥ on a Mac. A
 * macro recorded on macOS 26 with ⌘ held came back as "Left Win" — the name
 * of a key that Mac does not have.
 */
describe('key names', () => {
  afterEach(() => document.documentElement.classList.remove('platform-mac'));

  it('keep the keycap legend off a Mac', () => {
    expect(keyNameForCode('e3')).toBe('Left Win');
    expect(keyNameForCode('e6')).toBe('Right Alt');
    expect(keyName('e7', 'Right Win')).toBe('Right Win');
  });

  it('say ⌘ and ⌥ on a Mac, whichever way the usage is spelt', () => {
    document.documentElement.classList.add('platform-mac');
    expect(keyNameForCode('e3')).toBe('Left ⌘');
    expect(keyNameForCode('E7')).toBe('Right ⌘');
    expect(keyNameForCode('e2')).toBe('Left ⌥');
    expect(keyName('00e6', 'Right Alt')).toBe('Right ⌥');
  });

  it('leave every other key alone on a Mac', () => {
    document.documentElement.classList.add('platform-mac');
    expect(keyNameForCode('e0')).toBe('Left Ctrl');
    expect(keyNameForCode('4')).toBe('A');
    expect(keyName('2c', 'Space')).toBe('Space');
  });
});
