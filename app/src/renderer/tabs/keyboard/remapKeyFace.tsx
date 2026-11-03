import type { ReactNode } from 'react';
import type { KeyDef } from '@shared/keys';
import { Icon, type IconName } from '../../components/icons';
import { legendIcon } from '../../components/KeyboardMap';

/**
 * How a key is drawn in the assign picker — a glyph where one exists, the
 * label otherwise.
 *
 * Lives in the renderer rather than in `shared/keys.ts` beside the table
 * itself: that table is also the macro recorder's usage <-> name map and is
 * imported by the main process, which has no business knowing about icons.
 * Keyed by HID usage, not by label, so a wording change cannot silently drop
 * an icon.
 *
 * What gets one, and why:
 *  - **Arrows.** Four buttons reading Left / Right / Up / Down, in a row, in
 *    no particular order, when the thing they stand for is a shape.
 *  - **Media.** "Play/Pause" is eleven characters in a button sized for two,
 *    and every one of these has a glyph nobody has to read.
 *  - **Numpad digits** keep their number and lose the "Num " — the row is
 *    already headed Numpad, so the prefix was repeated eighteen times to say
 *    what the heading said once.
 *  - **Shift** is the hollow ⇧ printed on the key, with a small L or R
 *    (`SIDE_FOR`): two identical arrows side by side in the Modifiers row
 *    would only be told apart by their tooltips.
 */
const ICON_FOR: Record<string, IconName> = {
  '50': 'arrowLeft',
  '4f': 'arrowRight',
  '52': 'arrowUp',
  '51': 'arrowDown',
  e8: 'play',
  ea: 'trackNext',
  eb: 'trackPrev',
  ef: 'mute',
  ed: 'volumeUp',
  ee: 'volumeDown',
  // The same six as the Remap tab writes them: Consumer-page quads
  // (remapGroups.ts). Stop and the launcher keys keep their names — there is
  // no glyph for "Media player" that reads faster than the words.
  '0300cd00': 'play',
  '0300b500': 'trackNext',
  '0300b600': 'trackPrev',
  '0300e200': 'mute',
  '0300e900': 'volumeUp',
  '0300ea00': 'volumeDown',
  '2a': 'backspace',
  '28': 'enterKey',
  '2c': 'spacebar',
  '2b': 'tabKey',
  e1: 'shiftKey',
  e5: 'shiftKey',
};

/** The side of a modifier drawn as a glyph, for the two that share one. */
const SIDE_FOR: Record<string, string> = { e1: 'L', e5: 'R' };

/**
 * Keys whose name is longer than the thing it names.
 *
 * A key printed with a symbol should show that symbol: "Backslash" is nine
 * characters for one glyph, and the row it sits in is full of keys already
 * drawn as `- _` and `= +`. The ISO key (0x64, the extra one left of Z on
 * European boards) shows what is printed on it on most layouts, `< >`. Its
 * old face, "ISO \", said neither what the key was nor where it is — and an
 * ANSI board like the R85HE has no such key to look at.
 */
const GLYPH_FOR: Record<string, string> = {
  '31': '\\ |',
  '64': '< >',
  '35': '` ~',
  '46': 'PrtSc',
  '47': 'ScrLk',
  '39': 'Caps',
  '4b': 'PgUp',
  '4e': 'PgDn',
  '49': 'Ins',
  '4c': 'Del',
  '53': 'NumLk',
};

/** Prefixes the group heading already says. */
const STRIP = /^Num /;

export function keyFaceIcon(code: string): IconName | undefined {
  return ICON_FOR[code.toLowerCase()];
}

/** A glyph, with the L/R it needs when two keys share it. */
function glyphFace(code: string, icon: IconName, size: number): ReactNode {
  const side = SIDE_FOR[code];
  if (!side) return <Icon name={icon} size={size} />;
  return (
    <span className="kbkey-sided">
      <Icon name={icon} size={size} />
      <span className="kbkey-side">{side}</span>
    </span>
  );
}

/** What the button shows. The full label stays as its accessible name. */
export function keyFace(def: KeyDef): ReactNode {
  const code = def.code.toLowerCase();
  const icon = keyFaceIcon(code);
  if (icon) return glyphFace(code, icon, 13);
  return GLYPH_FOR[code] ?? def.label.replace(STRIP, '');
}

/** The face of a whole-quad action (a media or launcher key): its glyph where
 *  it has one, its keycap-sized name otherwise. */
export function quadFace(code: string, short: string): ReactNode {
  const icon = keyFaceIcon(code);
  return icon ? <Icon name={icon} size={12} /> : short;
}

/** The same face, from a bare HID usage — for showing what a key already
 *  sends, where all there is to go on is the number. */
export function usageFace(usage: number, label: string): ReactNode {
  const code = usage.toString(16);
  const icon = keyFaceIcon(code);
  if (icon) return glyphFace(code, icon, 12);
  return GLYPH_FOR[code] ?? label.replace(STRIP, '');
}

/**
 * A keycap, drawn the way the board above draws it.
 *
 * The assign panel's heading named the key in prose — "Assign S" — while the
 * thing it was talking about was sitting right there on the board as a
 * coloured square. Same shape, same colour, same paint rules, so the heading
 * points at an object you can see rather than describing one.
 *
 * `.kbkey` is reused deliberately: a second set of keycap styles would be a
 * second set to keep in step with the palette.
 */
export function KeyCap({
  label,
  face,
  color,
  small,
}: {
  label: string;
  /** What to draw instead of the label — a glyph, where the key has one. The
   *  label stays as the accessible name either way. */
  face?: ReactNode;
  /** The board's paint for this key, if it has any. */
  color?: string;
  small?: boolean;
}) {
  return (
    <span
      className={`kbkey kbkey-chip${small ? ' is-small' : ''}`}
      style={color ? { background: color, borderColor: color } : undefined}
      aria-label={label}
      title={label}
    >
      <span className="kbkey-label">{face ?? capFace(label, small)}</span>
    </span>
  );
}

/** The board's own glyph for a legend (Tab, Backspace, Enter, the arrows), so
 *  a heading's keycap is drawn exactly like the key it names. */
function capFace(label: string, small?: boolean): ReactNode {
  const icon = legendIcon(label);
  return icon ? <Icon name={icon} size={small ? 11 : 12} /> : label;
}
