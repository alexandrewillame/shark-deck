import { useEffect, useMemo, useRef } from 'react';
import { KEY_GROUPS, hidUsageForBrowserCode, normalizeUsage, type KeyGroup } from '@shared/keys';
import { Row } from '../../components/common';
import { useT } from '../../state/i18n';
import { keyFace } from './remapKeyFace';

/**
 * Every key a binding can name, as rows of buttons by group — the Remap
 * tab's picker, and the one the Actuation tab's mod-tap and DKS panels use to
 * choose what a key holds or fires.
 *
 * `isOn` says which buttons are lit (what is chosen now); `onPick` gets the
 * HID usage of a button pressed. What a press MEANS — add to a combination,
 * replace the choice — is the caller's.
 *
 * `listen`: a key pressed on the keyboard picks it too, as clicking its
 * button would — "choose the key to hold" is answered fastest by pressing it.
 * For a picker that is the thing being answered (a chooser popover, the macro
 * editor's key list); the Remap tab captures combinations itself. Escape is
 * never picked — it closes the popover around the picker — and typing into a
 * text field stays typing.
 */
export function KeyPicker({
  isOn = () => false,
  onPick,
  disabled,
  groups = KEY_GROUPS,
  listen,
}: {
  isOn?: (code: string) => boolean;
  onPick: (code: string) => void;
  disabled?: boolean;
  groups?: readonly KeyGroup[];
  listen?: boolean;
}) {
  const t = useT();
  /** The picker's own code for each usage it offers, by normalised usage. */
  const offered = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const k of g.keys) m.set(normalizeUsage(k.code), k.code);
    return m;
  }, [groups]);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!listen || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.key === 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const usage = hidUsageForBrowserCode(e.code);
      const code = usage === null ? undefined : offered.get(normalizeUsage(usage));
      if (code === undefined) return;
      // Picked, and nothing else: no Tab focus move, no Alt menu, no app
      // shortcut firing underneath.
      e.preventDefault();
      e.stopPropagation();
      pick.current(code);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listen, disabled, offered]);

  return (
    <>
      {listen && !disabled && <p className="hint key-picker-listen">{t('keypick.listen')}</p>}
      {groups.map((g) => (
        // Stacked: the group's name above its keys, which wrap to the width
        // they have. Beside the name, a row's control never shrinks (`.row-ctl`),
        // so the 26 letters stayed on one line and whatever held the picker
        // scrolled sideways.
        <Row key={g.label} className="row-stack" label={g.labelKey ? t(g.labelKey) : g.label}>
          <div className="remap-picker">
            {g.keys.map((k) => {
              const on = isOn(k.code);
              // A media or launcher key is named for what it does, and that
              // name is translated; a key legend stays as printed.
              const name = k.labelKey ? t(k.labelKey) : k.label;
              return (
                <button
                  key={k.code + k.label}
                  className={`btn remap-key${on ? ' on' : ''}`}
                  aria-pressed={on}
                  aria-label={name}
                  // The ISO key is on no board this app draws, so its name
                  // alone does not say what or where it is.
                  title={k.code === '64' ? t('remap.iso.tip') : name}
                  disabled={disabled}
                  onClick={() => onPick(k.code)}
                >
                  {keyFace({ ...k, label: name })}
                </button>
              );
            })}
          </div>
        </Row>
      ))}
    </>
  );
}
