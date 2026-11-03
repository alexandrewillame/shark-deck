---
name: add-i18n-string
description: How to add or change a user-facing string in SharkDeck without hand-editing eleven locale files. Use whenever adding UI text, a label, a tooltip, a toast message, a tab name, or a translation.
---

# Adding a user-facing string

## Never hand-edit the locale files to add a key

```bash
cd app && npm run i18n:add -- 'cfg.tab.lighting' 'Lighting'
```

That writes the key into all **11** catalogues, formats them, and exits. Zero
file reads.

## Why the one command matters

`src/shared/i18n/i18n.test.ts` requires **every** canonical key to be present in
**every** locale - a locale that regresses to partial coverage fails the suite
rather than silently rendering English in the app. That rule is deliberate and
stays.

The consequence is that one new string is an 11-file edit across ~7,000 lines:

```
src/shared/i18n/en.ts          canonical, `as const`, defines MessageKey
src/shared/i18n/{fr,es,de}.ts  Partial<Messages>
src/shared/i18n/locales/{ru,tr,ja,ko,zh-CN,zh-TW,ar}.ts
```

Note the inconsistent layout: three locales sit in `i18n/`, the other seven in
`i18n/locales/`. The script handles both.

## What the script does and does not do

Non-English entries are seeded with the **English text** plus a `TODO(i18n)`
marker comment. That satisfies the parity test immediately, and keeps the
untranslated strings visible instead of pretending they are done:

```bash
cd app && npm run i18n:todo
```

lists every placeholder by locale and key. Replace the value with a real
translation and delete the marker comment.

## Three keys the script refuses

`i18n.test.ts` asserts the *content* of these, not just their presence, so
auto-seeding them would either break a test or satisfy it wrongly. The script
refuses them and tells you the rule:

| Key | Rule |
|---|---|
| `as.state.on` / `as.state.off` | Literal `ON`/`OFF` for `en`/`fr`/`es`/`de`/`tr`; must **not** be `ON`/`OFF` for the six non-Latin-script locales. The topbar auto-switch pill is deliberately untranslated for Latin scripts. |
| `set.palette.black` | `Black-White` in `en`, and never bare `Black` in any locale. |

## Using the string

```tsx
const t = useT();
// ...
t('cfg.tab.lighting');
t('hint.batteryLow', { pct: 12 }); // {pct} placeholders
```

`MessageKey` is `keyof typeof en`, so `tsc` rejects a key that does not exist -
you do not need to check for typos by hand.

In the main process (tray labels, device hints) use `getT(locale)` from
`@shared/i18n` instead.

## Changing existing text

Editing a value in `en.ts` by hand is fine - the key already exists everywhere,
so parity is unaffected. But the other locales still hold the *old* wording, and
nothing detects that. If the meaning changed rather than just the phrasing, note
it so the translations get revisited.

## Verify

```bash
cd app && npm run test:unit -- src/shared/i18n
```

Nine assertions: parity across all 11 locales, the fallback chain, and the three
content rules above.
