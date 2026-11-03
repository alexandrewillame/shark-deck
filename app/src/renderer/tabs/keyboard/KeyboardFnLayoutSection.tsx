import { Panel, Row, Segmented } from '../../components/common';
import { type TabProps } from '../common';
import { useT } from '../../state/i18n';
import { useKeyboardOptions } from './useKeyboardOptions';

/** Which Fn row layout the board reports. */
export function KeyboardFnLayoutSection({ device }: TabProps) {
  const t = useT();
  const { opts, patch } = useKeyboardOptions(device);
  if (!opts) return null;
  return (
    // Named once, by the panel; the row says what the choice does. It was
    // "Fn layout" twice over, in English in every language.
    <Panel title={t('kbfn.title')}>
      <Row label={<span className="row-desc">{t('kbfn.hint')}</span>}>
        <Segmented
          value={opts.fnOs}
          options={[
            { value: 'win', label: 'Windows' },
            { value: 'mac', label: 'macOS' },
          ]}
          onChange={(v) => void patch(t('kbfn.title'), { fnOs: v as 'win' | 'mac' })}
        />
      </Row>
    </Panel>
  );
}
