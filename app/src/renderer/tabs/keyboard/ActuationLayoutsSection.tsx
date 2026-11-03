import { useEffect, useState } from 'react';
import type { ActuationLayout, KeyGroup } from '@shared/types/keyboard-settings';
import type { KeyLayoutEntry } from '@shared/types/keys';
import type { LiveDevice } from '@shared/types/live';
import { Tooltip } from '../../components/common';
import { Icon } from '../../components/icons';
import { KeyboardMap } from '../../components/KeyboardMap';
import { SavedLibraryPanel } from '../../components/SavedLibraryPanel';
import { sd, useWrite } from '../common';
import { useT } from '../../state/i18n';
import { layoutZoneBindings } from './magneticModes';

/**
 * Saved actuation layouts — the per-key lighting library's panel, with one
 * button instead of two.
 *
 * Lighting splits Load from Apply because its editor is a picture you compose
 * before sending it. This tab has no such step: the board above always shows
 * what the keyboard holds, every slider writes as you let go of it, and there
 * is nothing an "applied but not written" state could mean here. So **Apply**
 * does the one thing — writes the layout, through `useWrite().run` so a refused
 * backup or a read-back mismatch surfaces as a toast, and then hydrates the tab
 * from it so the board keeps telling the truth.
 *
 * Naming, the overwrite prompt, renaming and the row thumbnails (the board
 * painted in the layout's own group colours) are `SavedLibraryPanel`'s, shared
 * with lighting so the two libraries cannot drift apart again.
 */
export function ActuationLayoutsSection({
  device,
  layout,
  current,
  onLoad,
}: {
  device: LiveDevice;
  /** The board's own key layout, for the row thumbnails. */
  layout?: KeyLayoutEntry[];
  /** What Save captures — the tab's live per-key settings and groups. */
  current: () => Pick<ActuationLayout, 'keys' | 'groups'>;
  /** Hydrate the tab from a saved layout, after it has reached the device. */
  onLoad: (l: ActuationLayout) => void;
}) {
  const t = useT();
  const { run } = useWrite();
  const [layouts, setLayouts] = useState<ActuationLayout[]>([]);

  useEffect(() => {
    sd.listActuationLayouts()
      .then(setLayouts)
      .catch(() => undefined);
  }, []);

  return (
    <SavedLibraryPanel
      title={t('act.layouts.title')}
      tip={t('act.layouts.tip')}
      entries={layouts}
      emptyText={t('act.layouts.none')}
      // Saving under a name already in the list reuses that entry's id (the
      // panel asks first), so it replaces the row instead of adding a second
      // one with the same label — the store upserts by id.
      onSave={async (id, name) => {
        const now = current();
        // The Mod-tap holds and DKS actions: key bindings, not pages, so not
        // in `keys`. Saved without them if the record cannot be read — the
        // keys themselves are still worth keeping.
        const record = await sd.readKeyZoneBindings(device.id).catch(() => null);
        const zoneBindings = layoutZoneBindings(now.keys, layout, record);
        setLayouts(
          await sd.saveActuationLayout({
            id,
            name,
            createdAt: Date.now(),
            model: device.model,
            ...now,
            ...(zoneBindings.length ? { zoneBindings } : {}),
          }),
        );
      }}
      // Same entry, same contents, new label.
      onRename={async (l, name) => setLayouts(await sd.saveActuationLayout({ ...l, name }))}
      replaceTitle={(name) => t('act.layouts.replace', { name })}
      replaceBody={t('act.layouts.replace.body')}
      renameLabel={t('act.layouts.rename')}
      thumb={(l, u) => <LayoutBoard layout={layout} groups={l.groups} u={u} />}
      hint={(l) => (l.model && l.model !== device.model ? t('act.layouts.otherModel') : undefined)}
      actions={(l) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <Tooltip text={t('act.layouts.apply.tip')}>
            <button
              className="btn primary"
              onClick={async () => {
                // Write first, hydrate second, and only on success: the tab
                // must never end up showing a layout the keyboard refused.
                const r = await run(l.name, () => sd.applyActuationLayout(device.id, l.id));
                if (r?.ok) onLoad(l);
              }}
            >
              <Icon name="upload" size={12} /> {t('act.layouts.apply')}
            </button>
          </Tooltip>
          <Tooltip text={t('act.layouts.delete')}>
            <button
              className="btn icon-only danger"
              onClick={async () => setLayouts(await sd.deleteActuationLayout(l.id))}
            >
              <Icon name="trash" size={13} />
            </button>
          </Tooltip>
        </div>
      )}
    />
  );
}

/**
 * A saved layout drawn as the board it describes, painted by group.
 *
 * The same component at u=5 is the row thumbnail and at u=14 the hover
 * preview, so the two cannot drift — exactly the arrangement the per-key
 * lighting library uses for its presets (`PresetBoard` in lighting/PerKeyPane).
 */
function LayoutBoard({
  layout,
  groups,
  u,
}: {
  layout?: KeyLayoutEntry[];
  groups: KeyGroup[];
  u: number;
}) {
  const bySlot = new Map<number, string>();
  for (const g of groups) for (const s of g.slots) bySlot.set(s, g.color);
  return (
    <span className="preset-board">
      <KeyboardMap
        layout={layout}
        interactive={false}
        fit={false}
        bare
        keyU={u}
        showLabels={false}
        accent={(k) => (k.slot == null ? undefined : bySlot.get(k.slot))}
      />
    </span>
  );
}
