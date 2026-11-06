import type { MessageKey } from '@shared/i18n';
import type { TabProps } from '../common';
import { Panel, Row } from '../../components/common';
import { useT } from '../../state/i18n';

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** Title and explanation per identity state (shared/menuGates.ts `configurable`). */
const COPY: Record<'pending' | 'foreign' | 'unknown' | 'unsupported', [MessageKey, MessageKey]> = {
  pending: ['identity.pending.title', 'identity.pending.body'],
  foreign: ['identity.foreign.name', 'identity.foreign.body'],
  unknown: ['identity.unknown.title', 'identity.unknown.body'],
  unsupported: ['identity.unsupported.hint', 'identity.unsupported.body'],
};

/**
 * What a device Shark Deck does not configure is: still identifying, another
 * brand's, a model no table knows, or an Attack Shark model with no driver
 * yet. The only thing its config screen shows — with the identifiers someone
 * would need to report it.
 */
export function IdentityPanel({ device }: TabProps) {
  const t = useT();
  const state = device.ui.identity;
  if (state !== 'pending' && state !== 'foreign' && state !== 'unknown' && state !== 'unsupported')
    return null;
  const [title, body] = COPY[state];
  return (
    <Panel title={t(title)}>
      <p className="hint">{t(body)}</p>
      {state !== 'pending' && device.ui.identityNote && (
        <Row label={t('identity.reported')}>
          <span className="mono" style={{ userSelect: 'text' }}>
            {device.ui.identityNote}
          </span>
        </Row>
      )}
      <Row label={t('identity.usb')}>
        <span className="mono" style={{ userSelect: 'text' }}>
          {hex4(device.vid)}:{hex4(device.pid)}
        </span>
      </Row>
    </Panel>
  );
}
