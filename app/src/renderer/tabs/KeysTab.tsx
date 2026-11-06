import type { TabProps } from './common';
import { useT } from '../state/i18n';
import { PaneHeader, TitleTabs } from '../components/common';
import { KeyRemapSection } from './keyboard/KeyRemapSection';
import { usePaneView } from '../state/paneView';
import { confirmLeave } from '../state/leaveGuard';
import { gate } from '@shared/menuGates';
import { Gated } from '../components/Gated';

/** Key/Fn-layer remap, promoted out of Profile into its own tab — see
 *  tabs/index.tsx. Base/Fn IS the title (`TitleTabs`): it used to be a pill
 *  pinned to the far right of the pane, as far from the tab rail as the window
 *  allows, for a choice of the same kind the rail itself offers. */
export function KeysTab({ device }: TabProps) {
  const t = useT();
  // Outside the component's own state, so switching profile — which remounts
  // every pane to make it re-read the board — does not also send you back to
  // the Base layer. See usePaneView.
  const [picked, setLayer] = usePaneView<'base' | 'fn'>(`${device.id}:keys.layer`, 'base');
  // Each layer only where the model has it (keyRemap / fnLayer): a board
  // with one of the two used to get both sub-tabs.
  const layers = (['base', 'fn'] as const).filter((l) =>
    gate(l === 'base' ? 'keys.base' : 'keys.fn', device),
  );
  const layer = layers.includes(picked) ? picked : (layers[0] ?? 'base');
  return (
    <div className="pane">
      <PaneHeader
        title={
          layers.length > 1 ? (
            <TitleTabs
              value={layer}
              options={layers.map((l) => ({
                value: l,
                label: t(l === 'base' ? 'keys.layer.base' : 'keys.layer.fn'),
              }))}
              // The other layer drops a staged pick: ask first (state/leaveGuard.ts).
              onChange={(l) => l !== layer && confirmLeave(device.id, () => setLayer(l))}
            />
          ) : (
            t(layer === 'base' ? 'keys.layer.base' : 'keys.layer.fn')
          )
        }
        sub={t('cfg.tab.keys.desc')}
      />
      <Gated id={layer === 'base' ? 'keys.base' : 'keys.fn'} device={device}>
        <KeyRemapSection device={device} layer={layer} />
      </Gated>
    </div>
  );
}
