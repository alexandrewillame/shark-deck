import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { getT, localeMeta, type TFunc } from '@shared/i18n';
import { useStore } from './store';

const TContext = createContext<TFunc>(getT('en'));

/**
 * Provides `t()` for the whole renderer, keyed off `settings.language`.
 * Switching the language in Settings re-renders every consumer immediately.
 *
 * `dir` on `<html>` is deliberately always `'ltr'`, never `meta.dir` — this
 * app's layout (topbar, tab strip, device rail, cards) is a fixed chrome
 * that isn't meant to mirror by locale; setting `dir="rtl"` on the document
 * flips every flex/grid and logical-property direction app-wide, which used
 * to move every UI region to its mirror corner when switching to Arabic
 * instead of just changing the text. `LocaleMeta.dir` still exists as data
 * (the language-menu list gives each item its own `dir` so the label itself
 * reads correctly — see App.tsx's LanguageMenu) — it's just never applied to
 * the whole document. `lang` is still set for real text-shaping/a11y.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useStore((s) => s.settings?.language ?? 'en');
  const t = useMemo(() => getT(language), [language]);

  useEffect(() => {
    document.documentElement.lang = localeMeta(language).code;
  }, [language]);

  return <TContext.Provider value={t}>{children}</TContext.Provider>;
}

/** `const t = useT(); t('grid.title')` */
export function useT(): TFunc {
  return useContext(TContext);
}
