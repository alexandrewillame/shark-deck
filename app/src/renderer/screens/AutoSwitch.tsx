import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunningProcess, ScannedGame } from '@shared/types/diagnostics';
import type { LiveDevice } from '@shared/types/live';
import { type AppProfile, type ProfileTrigger, resolveLink } from '@shared/types/profiles';
import type { MessageKey } from '@shared/i18n';
import {
  InlineRename,
  PaneHeader,
  Panel,
  PromptDialog,
  Row,
  Toggle,
  Tooltip,
} from '../components/common';
import { Icon } from '../components/icons';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { slotLabel } from '../state/ui';

import { sd } from '../state/bridge';

/** One row of the merged "scanned games + running processes" list in the
 *  Processes & games panel. Keyed by lowercase exe name, same as
 *  ProfileTrigger.exe. */
interface ProcRow {
  exe: string;
  label: string;
  iconDataUrl: string | null;
  source: 'steam' | 'epic' | 'manual' | 'running';
}

const SOURCE_LABEL: Record<ProcRow['source'], MessageKey> = {
  steam: 'as.source.steam',
  epic: 'as.source.epic',
  manual: 'as.source.manual',
  running: 'as.source.running',
};

/** Renders a profile's small icon: its own built-in/exe icon if set, else the
 *  icon carried by the first trigger that captured one, else a letter
 *  avatar built from the profile's name. */
function ProfileIconView({ profile }: { profile: AppProfile }) {
  if (profile.icon?.kind === 'builtin') return <Icon name={profile.icon.name} size={13} />;
  if (profile.icon?.kind === 'exe') return <img src={profile.icon.dataUrl} alt="" />;
  const withIcon = profile.triggers.find((t) => t.iconDataUrl);
  if (withIcon?.iconDataUrl) return <img src={withIcon.iconDataUrl} alt="" />;
  return (
    <span style={{ fontSize: 10, fontWeight: 700 }}>{profile.name.slice(0, 1).toUpperCase()}</span>
  );
}

/**
 * One row per known device model (a second device of the same model shares
 * its column) — the profiles x devices table. Every profile always resolves
 * to *some* slot for a connected device (see `resolveLink()` in
 * shared/types.ts): Desktop defaults to slot 1, Gaming to slot 2, and any
 * other profile also defaults to slot 1 until explicitly changed here — there
 * is no longer an "off" state per cell, matching every device always having
 * some profile applied.
 */
function DeviceCell({
  profile,
  device,
  onChange,
}: {
  profile: AppProfile;
  device: LiveDevice;
  onChange: (links: AppProfile['links']) => void;
}) {
  const t = useT();
  const link = resolveLink(profile, device);
  const count = device.ui.profileCount || 4;
  return (
    <select
      value={link.slot}
      onChange={(e) => {
        const next = { ...(profile.links ?? {}) };
        next[device.model] = { slot: Number(e.target.value) };
        onChange(next);
      }}
    >
      {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
        <option key={n} value={n}>
          {slotLabel(device, n, t)}
        </option>
      ))}
    </select>
  );
}

export function AutoSwitchScreen() {
  const switcher = useStore((s) => s.switcher);
  const toast = useStore((s) => s.toast);
  const devices = useStore((s) => s.devices);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const activeTabId = useStore((s) => s.activeTabId);
  const platformInfo = useStore((s) => s.platformInfo);
  // '.exe' on Windows, '' elsewhere (see PlatformInfo) — falls back to '.exe'
  // before platformInfo resolves so the very first render isn't ambiguous.
  const processSuffix = platformInfo?.processSuffix ?? '.exe';
  const t = useT();
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [games, setGames] = useState<ScannedGame[]>([]);
  const [runningProcs, setRunningProcs] = useState<RunningProcess[]>([]);
  const [manualExes, setManualExes] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [dragExe, setDragExe] = useState<string | null>(null);
  const [overExe, setOverExe] = useState<string | null>(null);

  // In-app replacement for window.prompt (Electron's renderer has none) —
  // used for naming a new mode and for the manual "add a Game / App" flow.
  // The latter also carries `suffix`/`browse` so PromptDialog shows the fixed
  // ".exe" tail and a "browse for it on disk" button right inside the dialog.
  const [prompt, setPrompt] = useState<{
    title: string;
    def: string;
    suffix?: string;
    browse?: boolean;
  } | null>(null);
  const promptResolve = useRef<(v: string | null) => void>(() => undefined);
  const ask = (title: string, def: string, opts?: { suffix?: string; browse?: boolean }) =>
    new Promise<string | null>((resolve) => {
      promptResolve.current = resolve;
      setPrompt({ title, def, ...opts });
    });
  const askName = () => ask(t('as.namePrompt'), t('as.nameDefault'));

  const deviceModels = useMemo(
    () =>
      Array.from(new Map(devices.map((d) => [d.model, d])).values()).filter((d) =>
        d.capabilities.includes('profiles'),
      ),
    [devices],
  );

  const loadProfiles = () => sd.listProfiles().then(setProfiles);
  useEffect(() => {
    loadProfiles();
  }, []);
  // The Auto-Switch tab is never unmounted while open (see App.tsx), so it
  // never re-fetches on its own — re-load whenever the user switches back to
  // it, which is also when a stale profile/software-slot rename made
  // elsewhere is most likely to matter.
  useEffect(() => {
    if (activeTabId === 'autoswitch') loadProfiles();
  }, [activeTabId]);

  // A Game/App's icon can be backfilled from the main process itself, the
  // first time it's seen running (see switcher.ts's `backfillTriggerIcons`)
  // — reload so the row picks it up live instead of only on next tab focus.
  useEffect(() => sd.on('appProfiles:changed', loadProfiles), []);

  const captureProfile = async (): Promise<AppProfile[] | undefined> => {
    if (devices.length === 0) {
      toast('warn', t('as.connectFirst'));
      return undefined;
    }
    const name = await askName();
    if (!name) {
      toast('info', t('as.captureCancelled'));
      return undefined;
    }
    setCapturing(true);
    try {
      await sd.captureProfileFromDevices(name);
      const next = await sd.listProfiles();
      setProfiles(next);
      toast('info', t('as.saved', { name }));
      return next;
    } finally {
      setCapturing(false);
    }
  };

  const renameProfile = (p: AppProfile, name: string) =>
    sd.saveProfile({ ...p, name }).then(setProfiles);
  const deleteProfile = (p: AppProfile) => {
    if (p.isDefault) return;
    sd.deleteProfile(p.id).then(setProfiles);
  };
  const patchProfileLinks = (p: AppProfile, links: AppProfile['links']) =>
    sd.saveProfile({ ...p, links }).then(setProfiles);

  // ---- Games / Apps ---------------------------------------------------
  // Memoised so the downstream `useMemo`s keyed on it (flatTriggers,
  // assignedExes, rows) don't recompute on every unrelated render.
  const assignableProfiles = useMemo(() => profiles.filter((p) => !p.isDefault), [profiles]);

  /** Every trigger across every mode, as one flat, user-orderable list. */
  const flatTriggers = useMemo(() => {
    const list = assignableProfiles.flatMap((p) => p.triggers.map((tr) => ({ tr, profile: p })));
    return list.sort(
      (a, b) =>
        (a.tr.order ?? Number.MAX_SAFE_INTEGER) - (b.tr.order ?? Number.MAX_SAFE_INTEGER) ||
        (a.tr.label ?? a.tr.exe).localeCompare(b.tr.label ?? b.tr.exe),
    );
  }, [assignableProfiles]);
  const assignedExes = useMemo(() => new Set(flatTriggers.map((f) => f.tr.exe)), [flatTriggers]);

  /** Candidate rows to *add* — scanned games + running apps + manually
   *  typed exes, minus anything already in the list above. */
  const rows: ProcRow[] = useMemo(() => {
    const map = new Map<string, ProcRow>();
    for (const g of games) {
      map.set(g.exe.toLowerCase(), {
        exe: g.exe.toLowerCase(),
        label: g.label,
        iconDataUrl: null,
        source: g.source,
      });
    }
    for (const r of runningProcs) {
      const key = r.name.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        if (!existing.iconDataUrl && r.iconDataUrl) existing.iconDataUrl = r.iconDataUrl;
      } else {
        map.set(key, { exe: key, label: r.name, iconDataUrl: r.iconDataUrl, source: 'running' });
      }
    }
    for (const exe of manualExes) {
      if (!map.has(exe)) map.set(exe, { exe, label: exe, iconDataUrl: null, source: 'manual' });
    }
    return (
      Array.from(map.values())
        .filter((r) => !assignedExes.has(r.exe))
        // Manually added entries always sort first — the user typed/browsed to
        // them on purpose, so they shouldn't get buried under whatever Steam/Epic
        // or the running-process list happens to alphabetize above them.
        .sort(
          (a, b) =>
            Number(b.source === 'manual') - Number(a.source === 'manual') ||
            a.label.localeCompare(b.label),
        )
    );
  }, [games, runningProcs, manualExes, assignedExes]);

  const findAssignment = (exe: string): { profile: AppProfile; trigger: ProfileTrigger } | null => {
    for (const p of profiles) {
      const tr = p.triggers.find((x) => x.exe === exe);
      if (tr) return { profile: p, trigger: tr };
    }
    return null;
  };

  /** Rename one Game / App (the trigger's display label). */
  const renameTrigger = (p: AppProfile, exe: string, label: string) =>
    sd
      .saveProfile({ ...p, triggers: p.triggers.map((x) => (x.exe === exe ? { ...x, label } : x)) })
      .then(setProfiles);

  /** Move `exe` to just before `beforeExe` in the flat list, renumber every
   *  trigger's `order`, and persist each mode whose triggers changed. */
  const reorderTriggers = async (exe: string, beforeExe: string) => {
    if (exe === beforeExe) return;
    const ordered = flatTriggers.map((f) => f.tr.exe);
    const from = ordered.indexOf(exe);
    const to = ordered.indexOf(beforeExe);
    if (from === -1 || to === -1) return;
    const [moved] = ordered.splice(from, 1);
    // `to` was computed before the removal — when dragging downward (from < to)
    // every later index has shifted left by one, so inserting at `to` lands the
    // row one slot past `beforeExe`. Insert at the adjusted index instead.
    ordered.splice(from < to ? to - 1 : to, 0, moved!);
    const rank = new Map(ordered.map((e, i) => [e, i]));
    // group the new ranks back by mode
    let latest = profiles;
    for (const p of assignableProfiles) {
      if (!p.triggers.some((x) => rank.has(x.exe))) continue;
      const nextTriggers = p.triggers.map((x) => ({ ...x, order: rank.get(x.exe) ?? x.order }));
      latest = await sd.saveProfile({ ...p, triggers: nextTriggers });
    }
    setProfiles(latest);
  };

  const assignProfile = async (row: ProcRow, profileId: string) => {
    if (!profileId) {
      const cur = findAssignment(row.exe);
      if (!cur) return;
      const next = await sd.saveProfile({
        ...cur.profile,
        triggers: cur.profile.triggers.filter((x) => x.exe !== row.exe),
      });
      setProfiles(next);
      return;
    }
    const target = profiles.find((p) => p.id === profileId);
    if (!target) return;
    const already = target.triggers.find((x) => x.exe === row.exe);
    const maxOrder = Math.max(-1, ...flatTriggers.map((f) => f.tr.order ?? -1));
    const trigger: ProfileTrigger = {
      exe: row.exe,
      label: row.label,
      enabled: already?.enabled ?? true,
      iconDataUrl: row.iconDataUrl,
      order: already?.order ?? maxOrder + 1,
    };
    const nextTriggers = [...target.triggers.filter((x) => x.exe !== row.exe), trigger];
    // saveProfile strips this exe out of every other profile's triggers on
    // the main-process side, so re-assigning here doesn't need to touch `cur`.
    const next = await sd.saveProfile({ ...target, triggers: nextTriggers });
    setProfiles(next);
  };

  const setTriggerEnabled = async (row: ProcRow, enabled: boolean) => {
    const cur = findAssignment(row.exe);
    if (!cur) return;
    const nextTriggers = cur.profile.triggers.map((x) =>
      x.exe === row.exe ? { ...x, enabled } : x,
    );
    const next = await sd.saveProfile({ ...cur.profile, triggers: nextTriggers });
    setProfiles(next);
  };

  const removeTrigger = (p: AppProfile, exe: string) =>
    sd.saveProfile({ ...p, triggers: p.triggers.filter((x) => x.exe !== exe) }).then(setProfiles);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      // GUI apps only — the background-process escape hatch was removed; the
      // browse-for-exe button covers anything the window filter misses.
      setRunningProcs(await sd.listRunningProcesses(true));
    } finally {
      setRefreshing(false);
    }
  };

  const manualAdd = async () => {
    const name = await ask(t('as.manualPrompt', { example: `cs2${processSuffix}` }), '', {
      suffix: processSuffix,
      browse: true,
    });
    if (!name) return;
    const exe = name.trim().toLowerCase();
    if (exe) setManualExes((prev) => (prev.includes(exe) ? prev : [...prev, exe]));
  };

  /** Renaming a manually-added candidate (not yet assigned to a mode) is just
   *  replacing its exe string in place — `label` for a manual `ProcRow` is
   *  always the same as `exe` (see `rows` above), so there's no separate
   *  display name to update. */
  const renameManualExe = (oldExe: string, next: string) => {
    const exe = next.trim().toLowerCase();
    if (!exe) return;
    setManualExes((prev) => prev.map((e) => (e === oldExe ? exe : e)));
  };

  return (
    <div className="pane pane-centered" style={{ maxWidth: 900 }}>
      {prompt && (
        <PromptDialog
          title={prompt.title}
          defaultValue={prompt.def}
          suffix={prompt.suffix}
          onBrowse={prompt.browse ? () => sd.pickExecutable() : undefined}
          browseLabel={t('as.browse')}
          onResolve={(v) => {
            setPrompt(null);
            promptResolve.current(v);
          }}
        />
      )}
      <PaneHeader title={t('as.title')} sub={t('as.sub')} />

      <Panel title={t('as.engine')}>
        <Row label={t('as.pin')} hint={t('as.pin.hint')}>
          <select
            value={switcher?.pinnedProfileId ?? ''}
            onChange={(e) => sd.pinProfile(e.target.value || null)}
          >
            <option value="">{t('as.notPinned')}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Row>
        {settings && (
          <Row label={t('set.pollInterval')}>
            <select
              value={settings.pollSeconds}
              onChange={(e) =>
                sd.setSettings({ pollSeconds: Number(e.target.value) }).then(setSettings)
              }
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          </Row>
        )}
      </Panel>

      {/* The panel's description is its info tip, and the one action on the
          whole list — capture a new mode — sits on the heading line. */}
      <Panel
        title={t('as.profiles')}
        tip={t('as.modesHint')}
        actions={
          <Tooltip text={t('as.capture.hint')}>
            <button
              className="btn icon-only"
              disabled={capturing}
              aria-label={t('as.newMode')}
              onClick={() => void captureProfile()}
            >
              <Icon name={capturing ? 'restore' : 'plus'} size={13} />
            </button>
          </Tooltip>
        }
      >
        {profiles.length > 0 && (
          <div className="as-table-wrap" style={{ marginTop: 10 }}>
            <table className="as-table">
              <thead>
                <tr>
                  <th>{t('as.colProfile')}</th>
                  <th>{t('as.colTriggers')}</th>
                  {deviceModels.map((d) => (
                    <th key={d.model}>{d.displayName}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const on = p.triggers.filter((x) => x.enabled).length;
                  const off = p.triggers.length - on;
                  const triggersText = p.isDefault
                    ? t('as.defaultHint')
                    : p.triggers.length === 0
                      ? t('as.noTriggers')
                      : p.triggers.length === 1
                        ? (p.triggers[0]!.label ?? p.triggers[0]!.exe)
                        : t('as.triggersSummary', { on, off });
                  // Which mode is actually in force. The table listed every
                  // mode identically, so the one thing it could not tell you
                  // was which of them you were currently in.
                  const active = p.isDefault
                    ? switcher?.activeProfileId == null
                    : switcher?.activeProfileId === p.id;
                  return (
                    <tr key={p.id} className={active ? 'as-row-active' : undefined}>
                      <td className="as-col-profile">
                        <span className="as-col-profile-inner">
                          <span className="as-profile-icon">
                            <ProfileIconView profile={p} />
                          </span>
                          {active && (
                            <span className="pill as-active-pill">{t('as.mode.active')}</span>
                          )}
                          <InlineRename
                            value={p.name}
                            editLabel={t('common.rename')}
                            onCommit={(name) => renameProfile(p, name)}
                          />
                          {p.builtIn && <span className="pill">{t('as.builtIn')}</span>}
                        </span>
                      </td>
                      <td className="as-triggers-cell">{triggersText}</td>
                      {deviceModels.map((d) => (
                        <td key={d.model}>
                          <DeviceCell
                            profile={p}
                            device={d}
                            onChange={(links) => patchProfileLinks(p, links)}
                          />
                        </td>
                      ))}
                      <td>
                        {!p.isDefault && (
                          <Tooltip text={t('common.delete')}>
                            <button className="btn-icon danger" onClick={() => deleteProfile(p)}>
                              <Icon name="trash" size={14} />
                            </button>
                          </Tooltip>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t('as.processes')} tip={t('as.processes.sub')}>
        {/* The list of Games / Apps — flat, reorderable, no per-mode headings.
            Higher in the list wins when two match at once. */}
        {flatTriggers.length === 0 ? (
          <div className="empty">{t('as.addBelow')}</div>
        ) : (
          <div className="as-trigger-list">
            {flatTriggers.map(({ tr, profile }) => (
              <div
                key={tr.exe}
                className={`as-trigger-row ${tr.exe === dragExe ? 'dragging' : ''} ${
                  tr.exe === overExe && tr.exe !== dragExe ? 'drag-over' : ''
                }`}
                draggable
                onDragStart={(e) => {
                  setDragExe(tr.exe);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragExe && dragExe !== tr.exe) setOverExe(tr.exe);
                }}
                onDragLeave={() => setOverExe((x) => (x === tr.exe ? null : x))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragExe) void reorderTriggers(dragExe, tr.exe);
                  setDragExe(null);
                  setOverExe(null);
                }}
                onDragEnd={() => {
                  setDragExe(null);
                  setOverExe(null);
                }}
              >
                <Tooltip text={t('as.dragReorder')}>
                  <span className="as-drag-handle">⋮⋮</span>
                </Tooltip>
                <Tooltip text={t('as.triggerEnableTip')}>
                  <span style={{ display: 'inline-flex' }}>
                    <Toggle
                      on={tr.enabled}
                      onChange={(v) =>
                        setTriggerEnabled(
                          {
                            exe: tr.exe,
                            label: tr.label ?? tr.exe,
                            iconDataUrl: tr.iconDataUrl ?? null,
                            source: 'manual',
                          },
                          v,
                        )
                      }
                    />
                  </span>
                </Tooltip>
                <span className="as-process-icon">
                  {tr.iconDataUrl ? (
                    <img src={tr.iconDataUrl} alt="" />
                  ) : (
                    <Icon name="chip" size={11} />
                  )}
                </span>
                <InlineRename
                  value={tr.label ?? tr.exe}
                  editLabel={t('common.rename')}
                  onCommit={(name) => renameTrigger(profile, tr.exe, name)}
                  suffix={processSuffix}
                />
                <select
                  className="as-trigger-mode"
                  value={profile.id}
                  onChange={(e) =>
                    void assignProfile(
                      {
                        exe: tr.exe,
                        label: tr.label ?? tr.exe,
                        iconDataUrl: tr.iconDataUrl ?? null,
                        source: 'manual',
                      },
                      e.target.value,
                    )
                  }
                >
                  {assignableProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Tooltip text={t('common.delete')}>
                  <button
                    className="btn-icon danger"
                    onClick={() => removeTrigger(profile, tr.exe)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}

        {/* Add new Games / Apps — manual entry first, then the two scanners. */}
        <div className="as-add-section">
          <div className="label" style={{ marginBottom: 8 }}>
            {t('as.addSection')}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <Tooltip text={t('as.manualAddTip')}>
              <button className="btn" onClick={() => void manualAdd()}>
                {t('as.manualAdd')}
              </button>
            </Tooltip>
            <button
              className="btn"
              disabled={scanning}
              onClick={async () => {
                setScanning(true);
                try {
                  setGames(await sd.scanGames());
                } finally {
                  setScanning(false);
                }
              }}
            >
              {/* Epic is a Windows-only source (platform extraGameSources). */}
              {scanning
                ? t('as.scanning')
                : t(platformInfo && platformInfo.os !== 'win32' ? 'as.scan.steam' : 'as.scan')}
            </button>
            <button className="btn" disabled={refreshing} onClick={() => void doRefresh()}>
              {refreshing ? t('as.refreshing') : t('as.refreshRunning')}
            </button>
          </div>

          {rows.length > 0 && (
            <div className="list">
              {rows.map((row) => (
                <div className="list-item" key={row.exe}>
                  <div className="as-process-row" style={{ flex: 1, minWidth: 0 }}>
                    <span className="as-process-icon">
                      {row.iconDataUrl ? (
                        <img src={row.iconDataUrl} alt="" />
                      ) : (
                        <Icon name="chip" size={11} />
                      )}
                    </span>
                    {row.source === 'manual' ? (
                      // A manual candidate's label is always its exe (see
                      // `rows` above) — rename it in place, same as any
                      // already-assigned trigger, instead of only being able
                      // to rename it after picking a mode for it.
                      <InlineRename
                        value={row.exe}
                        editLabel={t('common.rename')}
                        onCommit={(name) => renameManualExe(row.exe, name)}
                        suffix={processSuffix}
                      />
                    ) : (
                      <>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {row.label}
                        </span>
                        {/* Only scanned rows can have a label distinct from
                            the exe — a manual row's label is always the same
                            string, which used to print e.g. "cs3.exe · cs3.exe". */}
                        {row.label !== row.exe && (
                          <span className="mono" style={{ color: 'var(--text-mut)' }}>
                            · {row.exe}
                          </span>
                        )}
                      </>
                    )}
                    <span className="pill">{t(SOURCE_LABEL[row.source])}</span>
                  </div>
                  <select value="" onChange={(e) => void assignProfile(row, e.target.value)}>
                    <option value="">{t('as.unassigned')}</option>
                    {assignableProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {t('as.assignMode')}: {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
