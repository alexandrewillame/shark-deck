import { Tooltip } from '../../components/common';
import { Icon } from '../../components/icons';
import { useT } from '../../state/i18n';

/**
 * The one Apply control, shared by the Global, Per-Key and side-strip panes so
 * they cannot drift into different interaction models again — that divergence
 * (auto write on one side, an `enabled` toggle on the other) is what made the
 * lighting tab confusing in the first place.
 *
 * The "Not written yet" pill, Read from keyboard, Apply to keyboard — and, for
 * an editor with undo (Per-Key), Cancel: back to what the board was last read
 * or applied as, without touching the device.
 */
export function PanelActions({
  dirty,
  busy,
  onApply,
  onRead,
  onCancel,
  cancelTip,
}: {
  dirty: boolean;
  busy: boolean;
  onApply: () => void;
  /** Re-read the board into the editor, discarding unapplied edits. Omitted
   *  where the pane has no read of its own to go back to. */
  onRead?: () => void;
  /** Discard unapplied edits locally. Omitted where there is nothing to go
   *  back to but a re-read. */
  onCancel?: () => void;
  cancelTip?: string;
}) {
  const t = useT();
  const cancel = onCancel && (
    <button className="btn" onClick={onCancel} disabled={busy || !dirty}>
      {t('common.cancel')}
    </button>
  );
  return (
    <>
      {dirty && <span className="pill warn">{t('light.modified')}</span>}
      {onRead && (
        <Tooltip text={t('light.read.tip')}>
          <button className="btn" onClick={onRead} disabled={busy}>
            <Icon name="download" size={12} /> {t('light.read')}
          </button>
        </Tooltip>
      )}
      <button className="btn primary" onClick={onApply} disabled={busy}>
        <Icon name="upload" size={12} /> {t('light.apply')}
      </button>
      {cancel && (cancelTip ? <Tooltip text={cancelTip}>{cancel}</Tooltip> : cancel)}
    </>
  );
}
