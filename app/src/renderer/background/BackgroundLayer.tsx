import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { BACKGROUND_INTENSITY_DEFAULT } from '@shared/backgrounds';
import { useStore } from '../state/store';
import { BackgroundLayerController, type LayerSettings, type SinkFactory } from './layer';
import { useLiveIntensity } from './live';
import { useBackgroundAnimates } from './motion';
import { isDrawn } from './registry';

/**
 * The app background: a fixed layer under everything in `.app` (styles/
 * background.css), with the canvas `BackgroundLayerController` draws into.
 *
 * Nothing at all is rendered for `none` — the plain theme is `.app`'s own
 * gradient, which is also what shows wherever WebGL is unavailable.
 *
 * The canvas is made inside the effect and removed in its cleanup, not
 * rendered by React: a canvas whose context has been released cannot be given
 * another, and StrictMode runs this effect twice.
 */
export function BackgroundLayer({ makeSink }: { makeSink?: SinkFactory } = {}) {
  const s = useStore(
    useShallow((st) => ({
      effect: st.settings?.background ?? 'none',
      usePalette: st.settings?.backgroundPalette ?? true,
      intensity: st.settings?.backgroundIntensity ?? BACKGROUND_INTENSITY_DEFAULT,
      animate: st.settings?.backgroundAnimate,
    })),
  );
  const animate = useBackgroundAnimates(s.animate);
  const live = useLiveIntensity();
  const hostRef = useRef<HTMLDivElement>(null);
  const ctl = useRef<BackgroundLayerController | null>(null);
  const effect = isDrawn(s.effect) ? s.effect : null;
  const settings: LayerSettings | null = effect
    ? { effect, usePalette: s.usePalette, intensity: live ?? s.intensity, animate }
    : null;
  const latest = useRef(settings);
  latest.current = settings;

  const on = !!effect;
  useEffect(() => {
    const host = hostRef.current;
    if (!on || !host || !latest.current) return;
    const c = new BackgroundLayerController(host, latest.current, makeSink);
    if (!c.start()) return;
    ctl.current = c;
    return () => {
      c.dispose();
      ctl.current = null;
    };
  }, [on, makeSink]);

  useEffect(() => {
    if (settings) ctl.current?.update(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.effect, settings?.usePalette, settings?.intensity, settings?.animate]);

  if (!on) return null;
  return <div ref={hostRef} className="bg-layer" aria-hidden="true" />;
}
