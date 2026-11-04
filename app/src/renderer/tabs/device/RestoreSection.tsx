import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Panel, Tooltip } from '../../components/common';
import { type TabProps, sd, useDeviceBusy, useWrite, Loading } from '../common';
import { useT } from '../../state/i18n';
import { useStore } from '../../state/store';
import { hostFeatures } from '../../state/host';
import type { BackupInfo } from '@shared/types/diagnostics';

const useStoreToast = () => useStore((s) => s.toast);

/**
 * Hand text to the user as a file: a download in a browser, a save dialog in
 * the desktop app. A Blob link rather than a request — nothing leaves the
 * page.
 */
function saveFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked late, not at once: Chromium starts the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Backup & restore.
 *
 * Every button here talks to hardware or to the backup store, and a restore
 * replays every block — 5-10 s on a V8. So one `busy` marker gates the whole
 * panel: the operation in flight names itself, and nothing else can be
 * started next to it on the same serialized HID channel.
 *
 * The handlers must also catch. `backupNow` REJECTS for a simulated device
 * (see ipc.ts) and for a disconnected one, and before this the rejection went
 * unhandled — no toast, and with a spinner added it would have spun forever.
 */
export function RestoreSection({ device }: TabProps) {
  const t = useT();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState<{
    kind: 'backup' | 'restore' | 'factory' | 'delete' | 'import';
    file?: string;
  } | null>(null);
  const toast = useStoreToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const { run } = useWrite();
  // Only the two that genuinely write to the device get the menu-wide
  // block. Taking a backup and deleting a file are fast and local, and
  // their own row spinner is the right weight for them.
  const { whileBusy } = useDeviceBusy(device.id);
  const load = () => sd.listBackups(device.id).then(setBackups);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  const backupNow = async () => {
    setBusy({ kind: 'backup' });
    try {
      const info = await sd.backupNow(device.id);
      toast('info', t('restore.saved', { n: info.blocks }));
      await load();
    } catch (err) {
      toast('err', String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  // `useWrite().run` already folds a rejection into `{ok:false}` and toasts
  // the verification outcome, so these two need no try/catch of their own —
  // only the `finally` that releases the panel.
  const restore = async (file: string) => {
    setBusy({ kind: 'restore', file });
    try {
      await whileBusy(t('restore.restoring'), () =>
        run(t('restore.title'), () => sd.restoreBackup(device.id, file)),
      );
    } finally {
      setBusy(null);
    }
  };

  const factoryReset = async () => {
    setBusy({ kind: 'factory' });
    try {
      await whileBusy(t('restore.factoryRunning'), () =>
        run(t('restore.factory'), () => sd.restoreDefaults(device.id)),
      );
    } finally {
      setBusy(null);
    }
  };

  // Both of these only move a backup between the store and a file the user
  // holds — the device is never touched, so neither takes the menu-wide block.
  const download = async (file: string) => {
    try {
      const exported = await sd.exportBackup(device.id, file);
      if (exported) saveFile(exported.name, exported.json);
      else toast('err', t('restore.exportFailed'));
    } catch (err) {
      toast('err', String((err as Error)?.message ?? err));
    }
  };

  const importFile = async (picked: File) => {
    setBusy({ kind: 'import' });
    try {
      const r = await sd.importBackup(device.id, await picked.text());
      if (r.ok) {
        toast('info', t('restore.imported'));
        await load();
      } else {
        toast('err', t('restore.importFailed', { error: r.error }));
      }
    } catch (err) {
      toast('err', String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
      // So picking the same file again still fires `change`.
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = async (file: string) => {
    setBusy({ kind: 'delete', file });
    try {
      const r = await sd.deleteBackup(device.id, file);
      toast(
        r.ok ? 'info' : 'err',
        r.ok ? t('restore.deleted') : (r.error ?? t('restore.deleteFailed')),
      );
      await load();
    } catch (err) {
      toast('err', String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title={t('restore.title')} tip={t('restore.sub')}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center' }}>
        <button className="btn" disabled={!!busy} onClick={() => void backupNow()}>
          {t('restore.backupNow')}
        </button>
        <button className="btn danger" disabled={!!busy} onClick={() => setConfirmReset(true)}>
          {t('restore.factory')}
        </button>
        <Tooltip text={t('restore.import.tip')}>
          <button className="btn" disabled={!!busy} onClick={() => fileInput.current?.click()}>
            {t('restore.import')}
          </button>
        </Tooltip>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void importFile(picked);
          }}
        />
        {/* One status line for the whole panel. The per-row marker below is
            just a bare spinner saying WHICH backup is being worked on — a
            full sentence there would fight the two buttons for the row. */}
        {busy?.kind === 'backup' && <Loading inline label={t('restore.backingUp')} />}
        {busy?.kind === 'factory' && <Loading inline label={t('restore.factoryRunning')} />}
        {busy?.kind === 'restore' && <Loading inline label={t('restore.restoring')} />}
        {busy?.kind === 'delete' && <Loading inline label={t('restore.deleting')} />}
      </div>
      {/* Browser storage is the browser's to clear (site data, a cleanup
          tool), unlike the desktop's folder — say so where the backups are. */}
      {hostFeatures.devicePicker && <p className="hint">{t('restore.browserNote')}</p>}
      {confirmReset && (
        <ConfirmDialog
          title={t('restore.factory')}
          body={t('restore.factoryConfirm')}
          confirmLabel={t('restore.factory')}
          onResolve={(ok) => {
            setConfirmReset(false);
            if (ok) void factoryReset();
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('restore.delete')}
          // Deleting the only backup leaves no restore point until the next
          // write to the device takes one (ensureBackup re-arms itself), which
          // is worth saying out loud rather than refusing the delete.
          body={
            t('restore.deleteConfirm', { d: new Date(confirmDelete.createdAt).toLocaleString() }) +
            (backups.length === 1 ? ` ${t('restore.deleteLastWarning')}` : '')
          }
          confirmLabel={t('common.delete')}
          onResolve={(ok) => {
            const file = confirmDelete.file;
            setConfirmDelete(null);
            if (ok) void remove(file);
          }}
        />
      )}
      {backups.length === 0 ? (
        <div className="empty">{t('restore.none')}</div>
      ) : (
        <div className="list">
          {backups.map((b) => (
            <div className="list-item" key={b.file}>
              <span className="mono" style={{ fontSize: 12 }}>
                {new Date(b.createdAt).toLocaleString()} · {b.blocks} blocks
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {busy?.file === b.file && <span className="spinner" aria-hidden="true" />}
                <button className="btn" disabled={!!busy} onClick={() => void restore(b.file)}>
                  {t('restore.restore')}
                </button>
                <Tooltip text={t('restore.download.tip')}>
                  <button className="btn" disabled={!!busy} onClick={() => void download(b.file)}>
                    {t('restore.download')}
                  </button>
                </Tooltip>
                <button
                  className="btn danger"
                  disabled={!!busy}
                  onClick={() => setConfirmDelete(b)}
                >
                  {t('restore.delete')}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
