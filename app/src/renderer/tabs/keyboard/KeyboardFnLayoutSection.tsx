import { Panel, Segmented } from '../../components/common';
import { type TabProps } from '../common';
import { useT } from '../../state/i18n';
import { useKeyboardOptions } from './useKeyboardOptions';

/** Which Fn row layout the board reports. */
export function KeyboardFnLayoutSection({ device }: TabProps) {
  const t = useT();
  const { opts, patch } = useKeyboardOptions(device);
  if (!opts) return null;
  return (
    // One line: the name, what it does on its info dot, the choice. It was
    // the heading, then a row under it saying what the choice does.
    <Panel title={t('kbfn.title')} tip={t('kbfn.hint')} inline>
      <Segmented
        value={opts.fnOs}
        options={[
          { value: 'win', label: 'Windows' },
          { value: 'mac', label: 'macOS' },
        ]}
        onChange={(v) => void patch(t('kbfn.title'), { fnOs: v as 'win' | 'mac' })}
      />
    </Panel>
  );
}
