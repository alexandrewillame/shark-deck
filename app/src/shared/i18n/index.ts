/**
 * Tiny dependency-free i18n. `en` is the canonical catalogue; every other locale
 * is a `Partial<Messages>` merged over it key by key, so a locale that only
 * translates half its keys still renders — the rest fall back to English.
 *
 * Used by both the renderer (via a React context + `useT()`) and the main
 * process (tray labels, device hints) through `getT(locale)`.
 */
import { en, type MessageKey, type Messages } from './en';
import { fr } from './fr';
import { es } from './es';
import { de } from './de';
import { ar } from './locales/ar';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { ru } from './locales/ru';
import { tr } from './locales/tr';
import { zhCN } from './locales/zh-CN';
import { zhTW } from './locales/zh-TW';

export type { MessageKey, Messages };
export { en };

export interface LocaleMeta {
  code: string;
  label: string;
  /** Writing direction — only Arabic is RTL here. Metadata only: it's used
   *  per-item in the language-menu list (so that entry's own label reads
   *  correctly) and nowhere else. It is deliberately never applied to the
   *  document itself (`<html dir>` always stays `'ltr'` — see
   *  renderer/state/i18n.tsx) since this app's chrome is a fixed layout that
   *  isn't meant to mirror by locale; `unicode-bidi: plaintext` (styles.css)
   *  is what keeps RTL text itself reading correctly in place instead. */
  dir: 'ltr' | 'rtl';
  messages: Partial<Messages>;
}

/** Order here is the order shown in the Settings language picker. */
export const LOCALES: LocaleMeta[] = [
  { code: 'en', label: 'English', dir: 'ltr', messages: en },
  { code: 'fr', label: 'Français', dir: 'ltr', messages: fr },
  { code: 'es', label: 'Español', dir: 'ltr', messages: es },
  { code: 'de', label: 'Deutsch', dir: 'ltr', messages: de },
  { code: 'ru', label: 'Русский', dir: 'ltr', messages: ru },
  { code: 'tr', label: 'Türkçe', dir: 'ltr', messages: tr },
  { code: 'ja', label: '日本語', dir: 'ltr', messages: ja },
  { code: 'ko', label: '한국어', dir: 'ltr', messages: ko },
  { code: 'zh-CN', label: '简体中文', dir: 'ltr', messages: zhCN },
  { code: 'zh-TW', label: '繁體中文', dir: 'ltr', messages: zhTW },
  { code: 'ar', label: 'العربية', dir: 'rtl', messages: ar },
];

const BY_CODE = new Map(LOCALES.map((l) => [l.code, l]));

export function localeMeta(code: string): LocaleMeta {
  return BY_CODE.get(code) ?? LOCALES[0]!;
}

export type TFunc = (key: MessageKey, vars?: Record<string, string | number>) => string;

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/** Build a translator for one locale. Missing keys fall back to `en`, then to the key. */
export function getT(code: string): TFunc {
  const loc = localeMeta(code).messages;
  return (key, vars) => interpolate((loc[key] ?? en[key] ?? key) as string, vars);
}
