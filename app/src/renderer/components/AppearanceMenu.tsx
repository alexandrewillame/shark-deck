import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BACKGROUND_INTENSITY_DEFAULT, type BackgroundEffect } from '@shared/backgrounds';
import type { AppSettings, ThemeMode, ThemePalette } from '@shared/types/app-settings';
import type { MessageKey } from '@shared/i18n';
import { setLiveIntensity } from '../background/live';
import { useBackgroundAnimates } from '../background/motion';
import { readPalette, type BgPalette } from '../background/palette';
import { BACKGROUNDS, DRAWN_EFFECTS, type DrawnEffect } from '../background/registry';
import { thumbnails } from '../background/renderer';
import { Segmented, Slider, Toggle, Tooltip } from './common';
import { Icon } from './icons';
import { useAnchoredPosition } from './usePortalPosition';
import { usePopoverFocus } from './usePopoverFocus';
import { useDragOrClick } from './useDragOrClick';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { applyTheme } from '../state/theme';
import { sd } from '../state/bridge';

/**
 * Colour palette, light/dark and the app background, as a topbar popover.
 *
 * These were rows in the Settings screen, which meant changing the accent
 * colour — the one setting people fiddle with repeatedly and judge by eye —
 * took a trip to another tab and back, with the thing being judged no longer
 * on screen. The other frequently-touched controls (language, auto-switch)
 * already live in the topbar; this joins them.
 *
 * Structure is deliberately `LanguageMenu`'s: portaled to `document.body` at
 * `position: fixed`, because `.topbar` sets `backdrop-filter` and that creates
 * a stacking context which traps a nested `z-index` inside it.
 */

// Swatch gradients mirror each palette's dark-mode accent + secondary tokens
// in tokens.css (--accent / --violet under [data-palette]) — keep them in sync.
// The `black` swatch is the one exception: it runs black to white rather than
// showing an accent. It is named "Black-White" and is the one palette with no
// colour of its own, so a near-black-to-grey gradient read as "the dark grey
// one". The two ends stay flat so both are unmistakable; the middle is a soft
// ramp rather than a hard seam, which at 30px read as two chips wedged
// together rather than one swatch.
/**
 * The palettes, in the picker's order: two rows of seven. The two-tone ones
 * first — an accent and a second colour of a different hue, the way Shark
 * cyan pairs cyan with violet — then the single colours and the neutrals.
 * Each swatch is its two colours, accent first.
 */
const PALETTES: { value: ThemePalette; swatch: string; labelKey: MessageKey }[] = [
  {
    value: 'shark-cyan',
    swatch: 'linear-gradient(135deg,#3df8e8,#8b7dff)',
    labelKey: 'set.palette.sharkCyan',
  },
  {
    value: 'frost',
    swatch: 'linear-gradient(135deg,#7fd0ff,#c3a6ff)',
    labelKey: 'set.palette.frost',
  },
  {
    value: 'synthwave',
    swatch: 'linear-gradient(135deg,#d63cff,#3db8ff)',
    labelKey: 'set.palette.synthwave',
  },
  {
    value: 'violet',
    swatch: 'linear-gradient(135deg,#8f7bff,#ff6fd8)',
    labelKey: 'set.palette.violet',
  },
  {
    value: 'pink',
    swatch: 'linear-gradient(135deg,#ff8dd6,#2ee6c8)',
    labelKey: 'set.palette.pink',
  },
  {
    value: 'amber',
    swatch: 'linear-gradient(135deg,#ffb02e,#ff5c8a)',
    labelKey: 'set.palette.amber',
  },
  {
    value: 'crimson',
    swatch: 'linear-gradient(135deg,#b0122d,#f0a53a)',
    labelKey: 'set.palette.crimson',
  },
  {
    value: 'lime',
    swatch: 'linear-gradient(135deg,#c4f53d,#2ed6c4)',
    labelKey: 'set.palette.lime',
  },
  {
    value: 'emerald',
    swatch: 'linear-gradient(135deg,#35e08a,#a06bff)',
    labelKey: 'set.palette.emerald',
  },
  {
    value: 'blue',
    swatch: 'linear-gradient(135deg,#4d9dff,#7d8bff)',
    labelKey: 'set.palette.blue',
  },
  { value: 'red', swatch: 'linear-gradient(135deg,#ff3131,#ff7a6b)', labelKey: 'set.palette.red' },
  {
    value: 'grey-brown',
    swatch: 'linear-gradient(135deg,#c3ad98,#9d856c)',
    labelKey: 'set.palette.greyBrown',
  },
  {
    value: 'grey',
    swatch: 'linear-gradient(135deg,#b0b0b0,#8a8a8a)',
    labelKey: 'set.palette.grey',
  },
  {
    value: 'black',
    swatch: 'linear-gradient(135deg,#0b0b0b 0 22%,#4a4a4a 42%,#b8b8b8 58%,#f2f2f2 78% 100%)',
    labelKey: 'set.palette.black',
  },
];

export function AppearanceMenu() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const setStored = useStore((s) => s.setSettings);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The portaled panel lives outside `btnRef`'s subtree, so outside-click
  // detection has to check both — see LanguageMenu.
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(btnRef, panelRef, open, { align: 'end', placement: 'bottom' });
  usePopoverFocus(open, !!pos, panelRef, btnRef, '.pal-swatch.active');

  // The background tiles take a couple of seconds to draw the first time in a
  // session (nine shaders to build, and the GPU's shader cache does not keep
  // them between launches), so they are drawn ahead: a few seconds after
  // launch, once the window is showing — one started to the tray waits until
  // it is opened. The popover then opens on finished tiles.
  useEffect(() => {
    let stop: (() => void) | undefined;
    const warm = () => {
      if (document.hidden || stop) return;
      document.removeEventListener('visibilitychange', warm);
      stop = drawTiles(
        readPalette(),
        useStore.getState().settings?.backgroundPalette ?? true,
        () => undefined,
      );
    };
    const timer = setTimeout(() => {
      document.addEventListener('visibilitychange', warm);
      warm();
    }, WARM_AFTER_MS);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', warm);
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const patch = async (p: Partial<AppSettings>) => {
    const next = await sd.setSettings(p);
    // <html> first, so a re-render reading the theme (the background
    // thumbnails do) reads the new one.
    applyTheme(next);
    setStored(next);
  };

  const drag = useDragOrClick<HTMLButtonElement>(() => setOpen((v) => !v));
  return (
    <div className="appearance-menu">
      <Tooltip text={t('set.appearance')}>
        <button
          ref={btnRef}
          className="btn topbar-btn icon-only"
          aria-haspopup="dialog"
          aria-expanded={open}
          {...drag}
        >
          <Icon name="palette" />
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="appearance-panel"
            role="dialog"
            aria-label={t('set.appearance')}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            <div className="appearance-group">
              <div className="appearance-label">{t('set.palette')}</div>
              <div className="pal-swatches">
                {PALETTES.map((p) => (
                  <Tooltip key={p.value} text={t(p.labelKey)}>
                    <button
                      className={`pal-swatch ${settings?.palette === p.value ? 'active' : ''}`}
                      style={{ background: p.swatch }}
                      aria-label={t(p.labelKey)}
                      aria-pressed={settings?.palette === p.value}
                      onClick={() => void patch({ palette: p.value })}
                    />
                  </Tooltip>
                ))}
              </div>
            </div>
            <div className="appearance-group">
              <div className="appearance-label">{t('set.mode')}</div>
              <Segmented<ThemeMode>
                value={settings?.themeMode ?? 'dark'}
                options={[
                  { value: 'dark', label: t('set.mode.dark') },
                  { value: 'light', label: t('set.mode.light') },
                  { value: 'system', label: t('set.mode.system') },
                ]}
                onChange={(v) => void patch({ themeMode: v })}
              />
            </div>
            <BackgroundGroup settings={settings} patch={patch} />
          </div>,
          document.body,
        )}
    </div>
  );
}

const THUMB_W = 88;
const THUMB_H = 58;
/** Late enough that the app's own start (the background's shader, the first
 *  device reads) is done; early enough to beat most first visits. */
const WARM_AFTER_MS = 4000;

/** Every background's tile, at the picker's size (2x, for sharp edges). */
const drawTiles = (
  palette: BgPalette,
  usePalette: boolean,
  onTile: (id: DrawnEffect, url: string | null) => void,
) =>
  thumbnails(
    DRAWN_EFFECTS.map((id) => BACKGROUNDS[id]),
    palette,
    usePalette,
    THUMB_W * 2,
    THUMB_H * 2,
    onTile,
  );

/**
 * The app background: a tile per effect, each a still of the effect itself in
 * the current palette, then its three options.
 *
 * The tiles are drawn ahead of time (see `AppearanceMenu`), and again when
 * the palette, the mode or the palette switch changes them. All nine shaders
 * compile at once, in the background, and each tile appears as its own is
 * ready — compiled one by one on the main thread they were a few seconds of
 * stalls right as the popover opened, and taken in order, every tile after
 * Electricity waited on it.
 *
 * Intensity follows the slider live through `setLiveIntensity` and is saved
 * once the slider settles — a settings write per tick would re-render every
 * screen that reads settings.
 */
function BackgroundGroup({
  settings,
  patch,
}: {
  settings: AppSettings | null;
  patch: (p: Partial<AppSettings>) => Promise<void>;
}) {
  const t = useT();
  const effect: BackgroundEffect = settings?.background ?? 'none';
  const off = effect === 'none';
  const usePalette = settings?.backgroundPalette ?? true;
  const stored = settings?.backgroundIntensity ?? BACKGROUND_INTENSITY_DEFAULT;
  const [intensity, setIntensity] = useState(stored);
  useEffect(() => setIntensity(stored), [stored]);

  const animates = useBackgroundAnimates(settings?.backgroundAnimate);

  const [thumbs, setThumbs] = useState<Partial<Record<DrawnEffect, string | null>>>({});
  const look = `${settings?.palette}|${document.documentElement.dataset.mode}|${usePalette}`;
  useEffect(
    () =>
      drawTiles(readPalette(), usePalette, (id, url) => setThumbs((p) => ({ ...p, [id]: url }))),
    // `look` names everything the tiles depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [look],
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const flush = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const v = pending.current;
    pending.current = null;
    if (v !== null) void patch({ backgroundIntensity: v }).finally(() => setLiveIntensity(null));
  };
  const onIntensity = (v: number) => {
    setIntensity(v);
    setLiveIntensity(v);
    pending.current = v;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 250);
  };
  // Closing the popover mid-drag still saves where the slider was left.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, []);

  const label = (id: BackgroundEffect): string =>
    t(id === 'none' ? 'set.background.none' : BACKGROUNDS[id].labelKey);

  return (
    <div className="appearance-group">
      <div className="appearance-label">{t('set.background')}</div>
      <div className="bg-swatches">
        {(['none', ...DRAWN_EFFECTS] as BackgroundEffect[]).map((id) => {
          const url = id === 'none' ? undefined : thumbs[id];
          return (
            <Tooltip key={id} text={label(id)}>
              <button
                className={`bg-swatch ${effect === id ? 'active' : ''}`}
                aria-label={label(id)}
                aria-pressed={effect === id}
                onClick={() => void patch({ background: id })}
              >
                {id === 'none' ? (
                  <span className="bg-swatch-none" />
                ) : url ? (
                  <img src={url} alt="" draggable={false} />
                ) : (
                  <span className="bg-swatch-plain" />
                )}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div className={`bg-options ${off ? 'is-off' : ''}`} aria-disabled={off || undefined}>
        <div className="bg-option">
          <span>{t('set.background.usePalette')}</span>
          <Toggle
            on={usePalette}
            disabled={off}
            onChange={(v) => void patch({ backgroundPalette: v })}
          />
        </div>
        <div className="bg-option bg-option-wide">
          <span>{t('set.background.intensity')}</span>
          <Slider
            value={intensity}
            min={10}
            max={100}
            step={5}
            unit="%"
            editable={false}
            onChange={onIntensity}
          />
        </div>
        <div className="bg-option">
          <span>{t('set.background.animate')}</span>
          <Toggle
            on={animates}
            disabled={off}
            onChange={(v) => void patch({ backgroundAnimate: v })}
          />
        </div>
      </div>
    </div>
  );
}
