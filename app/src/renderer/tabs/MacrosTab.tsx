import { HeroPane, type TabProps } from './common';
import { useT } from '../state/i18n';
import { MacroEditor } from '../components/macro/MacroEditor';

/**
 * Macro library, promoted out of Device into its own tab — see
 * tabs/index.tsx. Already worked for both mouse and keyboard before this
 * move (MacroEditor handles key AND mouse-button steps, and the macro list
 * itself was never gated behind Advanced mode — only its raw-hex input was),
 * this just gives it a dedicated, discoverable spot instead of being bundled
 * under Device alongside firmware/pairing/restore.
 */
export function MacrosTab({ device }: TabProps) {
  const t = useT();
  return (
    <HeroPane device={device} title={t('cfg.tab.macros')} sub={t('cfg.tab.macros.desc')}>
      <MacroEditor device={device} />
    </HeroPane>
  );
}
