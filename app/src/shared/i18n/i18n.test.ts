import { describe, expect, it } from 'vitest';
import { getT, LOCALES, localeMeta } from './index';
import { en } from './en';

const LATIN_SCRIPT_LOCALES = ['en', 'fr', 'es', 'de', 'tr'];
const OTHER_SCRIPT_LOCALES = ['ru', 'ja', 'ko', 'zh-CN', 'zh-TW', 'ar'];

describe('i18n fallback chain', () => {
  it('returns the locale string when present', () => {
    expect(getT('fr')('app.nav.settings')).toBe('Réglages');
  });

  it('an unrecognised locale code falls back entirely to English, key by key', () => {
    const t = getT('xx');
    expect(t('grid.title')).toBe(en['grid.title']);
    expect(t('as.sub')).toBe(en['as.sub']);
  });

  it('interpolates {vars}', () => {
    expect(getT('en')('onboard.slot', { n: 2 })).toBe('Profile 2');
    expect(getT('fr')('as.saved', { name: 'CS2' })).toBe('Mode « CS2 » créé.');
  });

  it('marks Arabic as RTL and the rest LTR', () => {
    expect(localeMeta('ar').dir).toBe('rtl');
    expect(LOCALES.filter((l) => l.dir === 'rtl').map((l) => l.code)).toEqual(['ar']);
  });

  it('every locale message key exists in the canonical catalogue', () => {
    const canonical = new Set(Object.keys(en));
    for (const loc of LOCALES) {
      for (const key of Object.keys(loc.messages)) {
        expect(canonical.has(key), `${loc.code}: stray key ${key}`).toBe(true);
      }
    }
  });

  // Every locale is a *complete* translation now (not a partial skeleton that
  // silently falls back to English key by key) — this is the parity guard
  // called for in docs/roadmap.md-adjacent planning after de/ru/tr/ja/ko/
  // zh-CN/zh-TW/ar went from a 59-key hardware-vocabulary skeleton to the
  // full catalogue. A locale that regresses back to partial coverage fails
  // here instead of silently reading as English in the app.
  it('every canonical key is translated in every locale', () => {
    const canonical = Object.keys(en);
    for (const loc of LOCALES) {
      if (loc.code === 'en') continue;
      const missing = canonical.filter((key) => !(key in loc.messages));
      expect(missing, `${loc.code} is missing: ${missing.join(', ')}`).toEqual([]);
    }
  });

  // Product decision: the topbar auto-switch pill's compact "ON"/"OFF" label
  // stays literal, untranslated English for every Latin-alphabet locale, and
  // is translated for every locale using a non-Latin script.
  it('the auto-switch ON/OFF pill stays literal English for Latin-script locales', () => {
    for (const code of LATIN_SCRIPT_LOCALES) {
      const t = getT(code);
      expect(t('as.state.on'), code).toBe('ON');
      expect(t('as.state.off'), code).toBe('OFF');
    }
  });

  it('the auto-switch ON/OFF pill is translated for non-Latin-script locales', () => {
    for (const code of OTHER_SCRIPT_LOCALES) {
      const t = getT(code);
      expect(t('as.state.on'), code).not.toBe('ON');
      expect(t('as.state.off'), code).not.toBe('OFF');
    }
  });

  it('the monochrome palette is labelled Black-White (or its translation), never bare "Black"', () => {
    expect(getT('en')('set.palette.black')).toBe('Black-White');
    for (const loc of LOCALES) {
      if (loc.code === 'en') continue;
      expect(getT(loc.code)('set.palette.black'), loc.code).not.toBe('Black');
    }
  });
});
