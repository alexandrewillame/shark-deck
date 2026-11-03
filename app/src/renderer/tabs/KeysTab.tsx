import type { TabProps } from './common';
import { useT } from '../state/i18n';
import { PaneHeader, TitleTabs } from '../components/common';
import { KeyRemapSection } from './keyboard/KeyRemapSection';
import { usePaneView } from '../state/paneView';

/** Key/Fn-layer remap, promoted out of Profile into its own tab — see
 *  tabs/index.tsx. Base/Fn IS the title (`TitleTabs`): it used to be a pill
 *  pinned to the far right of the pane, as far from the tab rail as the window
 *  allows, for a choice of the same kind the rail itself offers. */
export function KeysTab({ device }: TabProps) {
  const t = useT();
  // Outside the component's own state, so switching profile — which remounts
  // every pane to make it re-read the board — does not also send you back to
  // the Base layer. See usePaneView.
  const [layer, setLayer] = usePaneView<'base' | 'fn'>(`${device.id}:keys.layer`, 'base');
  return (
    <div className="pane">
      <PaneHeader
        title={
          <TitleTabs
            value={layer}
            options={[
              { value: 'base', label: t('keys.layer.base') },
              { value: 'fn', label: t('keys.layer.fn') },
            ]}
            onChange={setLayer}
          />
        }
        sub={t('cfg.tab.keys.desc')}
      />
      <KeyRemapSection device={device} layer={layer} />
    </div>
  );
}
