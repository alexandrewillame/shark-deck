import { describe, expect, it } from 'vitest';
import { heldModifiers } from './keyRemapState';

/**
 * Typing a remap — the modifiers held when the key goes down.
 *
 * Reported shape of the bug: holding Right Alt and pressing 8 staged
 * "Left Alt + 8" (the side was read off the 8), and on Linux with an AltGr
 * layout it staged a plain "8" (AltGr is no Alt there). The Remap tab's own
 * hint tells users to type exactly that combination.
 */
const flags = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
const down = (code: string, timeStamp = 0) => ({ type: 'keydown', code, timeStamp });
const up = (code: string, timeStamp = 0) => ({ type: 'keyup', code, timeStamp });

describe('heldModifiers', () => {
  it('knows Right Alt from Left Alt', () => {
    const h = heldModifiers();
    h.track(down('AltRight'));
    expect(h.usages({ ...flags, altKey: true })).toEqual([0xe6]);
  });

  it('sees AltGr on Linux, where the browser reports no Alt at all', () => {
    const h = heldModifiers();
    h.track(down('AltRight'));
    // e.key is "AltGraph" and altKey is false on an AltGr layout.
    expect(h.usages(flags)).toEqual([0xe6]);
  });

  it('drops the Left Ctrl Windows invents for AltGr', () => {
    const h = heldModifiers();
    h.track(down('ControlLeft', 100));
    h.track(down('AltRight', 100));
    // …and the 8 then arrives with both ctrlKey and altKey set.
    expect(h.usages({ ...flags, ctrlKey: true, altKey: true })).toEqual([0xe6]);
  });

  it('keeps a Left Ctrl really pressed before Right Alt', () => {
    const h = heldModifiers();
    h.track(down('ControlLeft', 100));
    h.track(down('AltRight', 600));
    expect(h.usages({ ...flags, ctrlKey: true, altKey: true })).toEqual([0xe0, 0xe6]);
  });

  it('lets go on keyup, and ignores auto-repeat', () => {
    const h = heldModifiers();
    h.track(down('ShiftRight', 1));
    h.track(down('ShiftRight', 30));
    expect(h.usages({ ...flags, shiftKey: true })).toEqual([0xe5]);
    h.track(up('ShiftRight'));
    expect(h.usages(flags)).toEqual([]);
  });

  it('takes a modifier held before it was listening from the flags, as the left one', () => {
    const h = heldModifiers();
    expect(h.usages({ ...flags, ctrlKey: true, metaKey: true })).toEqual([0xe0, 0xe3]);
  });

  it('forgets everything when the window loses focus', () => {
    const h = heldModifiers();
    h.track(down('MetaLeft'));
    h.clear();
    expect(h.usages(flags)).toEqual([]);
  });
});
