import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { deviceName, identityHint, slotLabel } from '../state/ui';
import { DeviceArt } from '../components/DeviceArt';
import { ArtAnchor, ArtAnchorContext, type ArtMode, type ArtRect } from '../components/ArtAnchor';
import { ColorPicker } from '../components/ColorPicker';
import { BatteryPill, Tooltip } from '../components/common';
import { ConnectDeviceButton } from '../components/ConnectDevice';
import { Icon } from '../components/icons';
import { hostFeatures } from '../state/host';
import type { LiveDevice } from '@shared/types/live';

import { sd } from '../state/bridge';

// `cable` — a USB connector body with a lead — reads as "wired" at a glance;
// the wall-plug glyph it replaced read as "mains power", and the earlier USB
// trident was routinely misread as an unrelated logo.
const CONNECTION_ICON = {
  usb: 'cable',
  bt: 'wireless',
  '2.4g': 'wireless',
  unknown: null,
} as const;
const CONNECTION_TIP_KEY = {
  usb: 'status.connection.usb',
  bt: 'status.connection.bt',
  '2.4g': 'status.connection.wireless',
  unknown: null,
} as const;

function Card({
  d,
  dragging,
  dropSide,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  registerEl,
}: {
  d: LiveDevice;
  dragging: boolean;
  dropSide: 'before' | 'after' | null;
  onDragStart: () => void;
  onDragOver: (after: boolean) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  /** Reports this card's own DOM node so the grid container can resolve the
   *  nearest card to a drop that lands in a gap rather than on a card (see
   *  DeviceGrid's `nearestCard`). */
  registerEl: (id: string, el: HTMLDivElement | null) => void;
}) {
  const openTab = useStore((s) => s.openTab);
  const setArtFlight = useStore((s) => s.setArtFlight);
  const patchArtFlightRect = useStore((s) => s.patchArtFlightRect);
  const artFlight = useStore((s) => s.artFlight);
  const activeTabId = useStore((s) => s.activeTabId);
  // The card's config tab is open somewhere -> the travelling <PersistentDeviceArt>
  // covers this card's art slot while Home is showing, and needs this card's
  // box as its target. The card still renders its own inline art underneath
  // (identical image, so no artifact) so it keeps its hover lift/scale/glow
  // once the image has flown back and the overlay hides.
  const configOpen = useStore((s) =>
    s.tabs.some((tb) => tb.route.name === 'config' && tb.route.deviceId === d.id),
  );
  // While this card's own return flight is airborne, the travelling overlay
  // is sitting right on top of this exact box — hide the inline copy for
  // that span, or both images are visible at once (see PersistentDeviceArt's
  // `artFlight.landed`). Only matters on Home: elsewhere the card is already
  // `view-hidden`.
  const flightInProgress =
    activeTabId === 'home' && artFlight?.deviceId === d.id && !artFlight.landed;
  const t = useT();
  const name = deviceName(d, t);
  const clickable = d.online || d.kind === 'keyboard' || d.kind === 'mouse';
  const connIcon = CONNECTION_ICON[d.connection];
  const connTipKey = CONNECTION_TIP_KEY[d.connection];
  const artRef = useRef<HTMLDivElement>(null);
  // Live-previewed on hovering a colour swatch (see ColorPicker's onPreview)
  // — the card's own art cross-fades to that variant's photo, reverting the
  // same way on mouse-leave; only a click actually commits it. `layers` holds
  // at most two stacked art boxes: whatever was showing before, underneath,
  // and the newest one fading in on top (see the `art-layer`/
  // `art-layer-entering` CSS) — once the fade finishes, the old one is
  // dropped and only the current layer remains. This is what lets sweeping
  // the cursor across several swatches transition each colour into the next
  // instead of just the committed colour into the first hovered one.
  const [previewVariant, setPreviewVariant] = useState<string | null>(null);
  const activeVariant = previewVariant ?? d.colorVariant ?? null;
  const [layers, setLayers] = useState<{ key: number; variant: string | null }[]>(() => [
    { key: 0, variant: activeVariant },
  ]);
  const layerSeq = useRef(1);
  useEffect(() => {
    setLayers((prev) =>
      prev[prev.length - 1]?.variant === activeVariant
        ? prev
        : [...prev, { key: layerSeq.current++, variant: activeVariant }],
    );
    const timer = setTimeout(
      () => setLayers((prev) => (prev.length > 1 ? [prev[prev.length - 1]!] : prev)),
      260, // a touch past --dur-med (220ms), so the fade-in animation finishes first
    );
    return () => clearTimeout(timer);
  }, [activeVariant]);

  const open = () => {
    if (!clickable) return;
    // Launch the travelling image from this card's current on-screen box, so
    // it visibly flies to the device page instead of fading in at the first
    // tab's anchor. From here on the flight belongs to this device until its
    // config tab is closed (see store.artFlight).
    const r = artRef.current?.getBoundingClientRect();
    setArtFlight({
      deviceId: d.id,
      from: r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null,
      mode: 'hero',
    });
    openTab({ name: 'config', deviceId: d.id });
  };

  // Publishes this card's art box as the travelling image's target while the
  // config tab is open. Reuses <ArtAnchor>'s measure / ResizeObserver /
  // scroll plumbing — the RO fires when this grid's view un-hides from
  // display:none, re-reporting a real rect so the image lands back here.
  const reportCardArt = useCallback(
    (rect: ArtRect, m: ArtMode) => patchArtFlightRect(d.id, rect, m),
    [d.id, patchArtFlightRect],
  );

  return (
    <div
      ref={(el) => registerEl(d.id, el)}
      className={[
        'card',
        !d.online ? 'offline' : '',
        // A mouse that is off while its dongle is still plugged in. Same
        // greying as any other unreachable device — the point of the reported
        // gap was that the card looked fully available when the device was
        // not — with the connection pill left in colour, since the receiver
        // genuinely is connected.
        d.receiverOnline ? 'receiver-only' : '',
        dragging ? 'dragging' : '',
        dropSide === 'before' ? 'drag-over' : dropSide === 'after' ? 'drag-over-after' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable
      onClick={open}
      // The card is the only way into a device's settings, so it is a
      // button for the keyboard too — it was a bare div no key could reach.
      role="button"
      tabIndex={clickable ? 0 : -1}
      aria-label={name}
      aria-disabled={!clickable || undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open();
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', d.id);
        // Explicit whole-card drag ghost — without this, starting the drag
        // on the product photo used the browser's own auto-ghost for that
        // <img> (images are draggable by default in Chromium, see
        // DeviceArt.tsx's draggable={false}), which is why only the photo
        // visibly moved even though dragstart still bubbled up here and the
        // reorder logic itself worked. Must be set synchronously in this
        // same dragstart handler.
        const rect = e.currentTarget.getBoundingClientRect();
        e.dataTransfer.setDragImage(e.currentTarget, e.clientX - rect.left, e.clientY - rect.top);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientX > rect.left + rect.width / 2);
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      <div className={`art ${flightInProgress ? 'art-flying' : ''}`}>
        {/* The photo's own box, inset from the band's edges: the hover zoom
            needs room inside the frame, and the flight takes off from and
            lands on this same box, so the travelling copy matches the photo
            at rest exactly. */}
        <div className="art-box" ref={artRef}>
          {layers.map((l, i) => (
            <div
              key={l.key}
              className={`art-layer ${i === layers.length - 1 && layers.length > 1 ? 'art-layer-entering' : ''}`}
              style={{ zIndex: i }}
            >
              <DeviceArt
                kind={d.kind}
                art={d.art}
                artKey={d.ui.artKey}
                colorVariant={l.variant}
                layout={d.ui.keyMatrix?.layout}
              />
            </div>
          ))}
          {configOpen && (
            <ArtAnchorContext.Provider value={reportCardArt}>
              <ArtAnchor mode="hero" className="card-art-anchor card-art-ghost" />
            </ArtAnchorContext.Provider>
          )}
        </div>
      </div>
      {/* The card splits into the photo and everything else, each on its own
          surface tone with a rule between them. No status dot: whether a
          device is reachable is already said by the whole card greying out,
          and a green pip beside every name on a grid where nearly everything
          is online competes with the name for attention. */}
      <div className="card-body">
        <Tooltip text={d.online ? t('status.online.tip') : t('status.offline.tip')}>
          <h3 className="card-name">{name}</h3>
        </Tooltip>

        <div className="meta">
          {connIcon && connTipKey && (
            <Tooltip text={t(connTipKey)}>
              {/* Bigger glyph than the other icon-bearing pills — the cable
                  icon in particular reads poorly small; `conn-pill` trims the
                  padding back so the pill's own footprint stays the same size
                  as its siblings despite the larger icon inside it. */}
              <span className="pill conn-pill">
                <Icon name={connIcon} size={16} />
              </span>
            </Tooltip>
          )}
          {d.wireless && (
            <Tooltip text={t('status.battery.tip', { pct: d.battery ?? '?' })}>
              <BatteryPill level={d.battery} charging={d.charging} />
            </Tooltip>
          )}
          {/* One wording, because there is one kind of slot: a device only
              reports an active profile if it has real onboard memory behind
              it. Keyboards used to take a second branch here that described
              an app-side snapshot instead — see catalog/r85he.ts. */}
          {d.activeProfile != null && (
            <Tooltip text={t('status.profile.tip')}>
              <span className="pill mono">{slotLabel(d, d.activeProfile, t)}</span>
            </Tooltip>
          )}
          {/* Firmware version lives in the Device tab. On a card it is a number
              nobody acts on, taking a pill's worth of room from the ones they
              do. */}
          <ColorPicker
            model={d.model}
            current={d.colorVariant}
            variants={d.ui.colorVariants}
            onPreview={setPreviewVariant}
          />
        </div>

        {/* Always rendered (even empty) so a stretched row-mate's extra height
            has somewhere to go — see .card-hint's flex:1 in styles.css. */}
        <div className="card-hint" style={{ color: d.online ? 'var(--amber)' : 'var(--text-mut)' }}>
          {d.hint ?? identityHint(d, t) ?? ''}
        </div>
      </div>
    </div>
  );
}

/**
 * Resolves a drop that landed in a gap (not on any card) to the nearest card
 * and which side of it to insert on — the same before/after model `Card`'s
 * own per-card `onDragOver` already uses, just computed geometrically
 * instead of being handed a card to compare against. Vertical distance is
 * weighted heavier than horizontal so a card in the same row wins over a
 * nearer one a row up/down (rows are typically wider than they are tall).
 */
function nearestCard(
  clientX: number,
  clientY: number,
  cards: Map<string, HTMLElement>,
  excludeId: string,
): { id: string; after: boolean } | null {
  let bestId: string | null = null;
  let bestAfter = false;
  let bestDist = Infinity;
  cards.forEach((el, id) => {
    if (id === excludeId) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = dx * dx + dy * dy * 4;
    if (dist < bestDist) {
      bestDist = dist;
      bestId = id;
      bestAfter = clientX > cx;
    }
  });
  return bestId ? { id: bestId, after: bestAfter } : null;
}

/** Sorts by the user's saved drag order (state.deviceOrder, by id); anything
 *  not in that list — a new pairing, or simply no reorder ever saved — keeps
 *  its natural (scan) position after the ones that are. */
function sortByOrder(devices: LiveDevice[], order: string[]): LiveDevice[] {
  if (order.length === 0) return devices;
  return [...devices].sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export function DeviceGrid() {
  const devices = useStore((s) => s.devices);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const t = useT();
  const [dragId, setDragId] = useState<string | null>(null);
  // Which card the drag is over, and which side of it — the side is what
  // lets a card land after the very last one (see reorder() below), and
  // fixes the previous "drop on a card" behaviour, where the dragged card
  // always replaced the target's own index regardless of which side you
  // dropped on — the same before/after pattern the tab strip already uses.
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  // Home is never unmounted — switching tabs just toggles `display:none` (see
  // App.tsx's `.view-hidden`) — but a CSS `animation` (unlike a transition)
  // restarts from its `from` state every time an element goes from
  // `display:none` back to displayed, so `.card`'s cardIn entrance replayed
  // on *every* return to Home, not just the first. That replay's `transform`
  // is what getBoundingClientRect() reports mid-animation, so the travelling
  // art overlay (which measures the card's box the instant this view
  // un-hides) chased a rect that was still a few pixels off from the card's
  // true resting position — then snapped the rest of the way the moment the
  // card settled, after the overlay had already hidden. `entered` disables
  // the animation for good after its one legitimate play (the app's first
  // paint), long enough past the longest stagger delay + duration that it
  // can't still be mid-flight.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 600);
    return () => clearTimeout(timer);
  }, []);

  // Every rendered card's own DOM node, keyed by device id — lets a drop
  // that lands in a gap (not on any card) resolve to the nearest one instead
  // of the browser treating the gap as "not a drop target" and refusing the
  // drop outright (see the container handlers below).
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerCardEl = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) cardEls.current.set(id, el);
    else cardEls.current.delete(id);
  }, []);

  const sorted = sortByOrder(devices, settings?.deviceOrder ?? []);

  const reorder = (dragDeviceId: string, overDeviceId: string, after: boolean) => {
    if (dragDeviceId === overDeviceId) return;
    const ids = sorted.map((d) => d.id);
    const from = ids.indexOf(dragDeviceId);
    if (from === -1) return;
    // Remove first, THEN find the target's index in the reduced array —
    // doing it the other way (splice-insert against the pre-removal index)
    // is directionally wrong depending on which side of the target you drop
    // on, which is exactly the "which side did I mean" ambiguity a bare
    // "drop on a card" model has no way to resolve.
    ids.splice(from, 1);
    const to = ids.indexOf(overDeviceId);
    if (to === -1) return;
    ids.splice(to + (after ? 1 : 0), 0, dragDeviceId);
    void sd.setSettings({ deviceOrder: ids }).then(setSettings);
  };

  const commitDrop = () => {
    if (dragId && over) reorder(dragId, over.id, over.after);
    setDragId(null);
    setOver(null);
  };

  // Handlers on the two containers a drag can be over without being over any
  // card — the 20px gaps between cards (`.grid`) and the leading/trailing
  // whitespace around the grid itself (`.devicegrid-wrap`, centred with
  // vertical slack). Guarded to `e.target === e.currentTarget` so a
  // dragover/drop that lands on a card (or bubbles up through one) is left
  // entirely to that card's own handlers — same pattern the tab strip uses
  // for its own trailing region (see App.tsx). Without this, the moment the
  // pointer left a card's own box the browser found no element willing to
  // cancel `dragover` and showed the "not allowed" cursor, silently losing
  // the drop.
  const containerDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragId || e.target !== e.currentTarget) return;
    e.preventDefault();
    const nearest = nearestCard(e.clientX, e.clientY, cardEls.current, dragId);
    if (nearest) setOver(nearest);
  };
  const containerDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragId || e.target !== e.currentTarget) return;
    e.preventDefault();
    commitDrop();
  };

  return (
    <div className="devicegrid-wrap" onDragOver={containerDragOver} onDrop={containerDrop}>
      <h2 style={{ fontSize: 18 }}>{t('grid.title')}</h2>
      <p className="sub" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        {t(devices.length === 1 ? 'grid.count' : 'grid.count.plural', { n: devices.length })}
      </p>
      <div
        className={`grid ${entered ? 'entered' : ''}`}
        onDragOver={containerDragOver}
        onDrop={containerDrop}
      >
        {sorted.map((d) => (
          <Card
            key={d.id}
            d={d}
            dragging={d.id === dragId}
            dropSide={
              over?.id === d.id && d.id !== dragId ? (over.after ? 'after' : 'before') : null
            }
            registerEl={registerCardEl}
            onDragStart={() => setDragId(d.id)}
            onDragOver={(after) => dragId && dragId !== d.id && setOver({ id: d.id, after })}
            onDragLeave={() => setOver((o) => (o?.id === d.id ? null : o))}
            onDrop={commitDrop}
            onDragEnd={() => {
              setDragId(null);
              setOver(null);
            }}
          />
        ))}
      </div>
      {/* Browser edition: each device is reached only once picked in the
          browser's own list — the welcome screen offers the first, this the rest. */}
      {hostFeatures.devicePicker && (
        <div className="grid-connect">
          <ConnectDeviceButton label="web.connect.another" />
        </div>
      )}
    </div>
  );
}
