#!/usr/bin/env node
/**
 * Adds a message key to all 11 locale catalogues in one command.
 *
 *   npm run i18n:add  'cfg.tab.foo' 'Foo'   add a key everywhere
 *   npm run i18n:todo                       list untranslated placeholders
 *
 * Why this exists: `src/shared/i18n/i18n.test.ts` requires every canonical key
 * to be present in every locale, so one new user-facing string is an 11-file
 * edit across ~7,000 lines. That rule is deliberate - it stops half-translated
 * UI shipping - but hand-editing eleven 600-line files to satisfy it is pure
 * overhead. This does it mechanically, seeding non-English entries with the
 * English text and a TODO(i18n) marker so `i18n:todo` can list what still
 * needs a real translation.
 *
 * Never hand-edit the locale files to add a key. Use this.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const APP = resolve(import.meta.dirname, '..');
const MARKER = 'TODO(i18n)';

/** [file, exported const name]. `en` is canonical and ends in `as const`. */
const CATALOGUES = [
  ['src/shared/i18n/en.ts', 'en'],
  ['src/shared/i18n/fr.ts', 'fr'],
  ['src/shared/i18n/es.ts', 'es'],
  ['src/shared/i18n/de.ts', 'de'],
  ['src/shared/i18n/locales/ru.ts', 'ru'],
  ['src/shared/i18n/locales/tr.ts', 'tr'],
  ['src/shared/i18n/locales/ja.ts', 'ja'],
  ['src/shared/i18n/locales/ko.ts', 'ko'],
  ['src/shared/i18n/locales/zh-CN.ts', 'zhCN'],
  ['src/shared/i18n/locales/zh-TW.ts', 'zhTW'],
  ['src/shared/i18n/locales/ar.ts', 'ar'],
];

/**
 * Keys whose *content* is asserted by i18n.test.ts, not just their presence.
 * Auto-seeding them with English would either break a test or, worse, satisfy
 * it wrongly. They have to be edited by hand, with the rule in front of you.
 */
const PROTECTED = {
  'as.state.on':
    'must stay literal "ON" for en/fr/es/de/tr and must NOT be "ON" for the six non-Latin locales',
  'as.state.off':
    'must stay literal "OFF" for en/fr/es/de/tr and must NOT be "OFF" for the six non-Latin locales',
  'set.palette.black': 'must be "Black-White" in en, and never bare "Black" in any locale',
};

function die(msg) {
  console.error(`i18n: ${msg}`);
  process.exit(1);
}

function keysOf(text) {
  // Object keys are always single-quoted string literals in these files.
  return new Set([...text.matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1]));
}

function add(key, value) {
  if (!key || !value) {
    die("usage: npm run i18n:add 'some.key' 'The English text'");
  }
  if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/.test(key)) {
    die(`"${key}" does not look like a namespaced key (e.g. cfg.tab.lighting)`);
  }
  if (key in PROTECTED) {
    die(
      `"${key}" is content-asserted by i18n.test.ts and must be edited by hand:\n` +
        `      it ${PROTECTED[key]}.`,
    );
  }

  const enPath = resolve(APP, CATALOGUES[0][0]);
  if (keysOf(readFileSync(enPath, 'utf8')).has(key)) {
    die(`"${key}" already exists in en.ts`);
  }

  const touched = [];
  for (const [rel, name] of CATALOGUES) {
    const abs = resolve(APP, rel);
    let text = readFileSync(abs, 'utf8');
    const canonical = name === 'en';

    if (keysOf(text).has(key)) {
      console.log(`  = ${rel} already had it, skipped`);
      continue;
    }

    // Close of the object literal: `} as const;` for en, `};` for the rest.
    const close = canonical ? '\n} as const;' : '\n};';
    const at = text.lastIndexOf(close);
    if (at < 0) die(`could not find the end of the ${name} object in ${rel}`);

    // JSON.stringify handles quotes/newlines in the value; prettier normalises
    // the quote style afterwards.
    const entry = canonical
      ? `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)},`
      : `\n  // ${MARKER}: seeded with the English text.\n  ${JSON.stringify(key)}: ${JSON.stringify(value)},`;

    text = text.slice(0, at) + entry + text.slice(at);
    writeFileSync(abs, text);
    touched.push(rel);
  }

  if (touched.length) {
    // Invoke prettier's JS entry through node directly rather than the npx
    // shim: no shell, so this needs no platform branch and raises no
    // "args with shell:true" deprecation.
    const prettierBin = resolve(APP, 'node_modules/prettier/bin/prettier.cjs');
    execFileSync(process.execPath, [prettierBin, '--write', ...touched], {
      cwd: APP,
      stdio: 'ignore',
    });
  }

  console.log(`Added ${key} to ${touched.length} catalogue(s).`);
  console.log(`Translations are placeholders; list them with: npm run i18n:todo`);
}

function todo() {
  let total = 0;
  for (const [rel, name] of CATALOGUES) {
    if (name === 'en') continue;
    const text = readFileSync(resolve(APP, rel), 'utf8');
    const lines = text.split('\n');
    const pending = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(MARKER)) continue;
      const next = lines[i + 1] ?? '';
      const key = /'([^']+)':/.exec(next)?.[1] ?? '(?)';
      pending.push(key);
    }
    if (pending.length) {
      total += pending.length;
      console.log(`${name} (${relative(APP, resolve(APP, rel))}): ${pending.length}`);
      for (const k of pending) console.log(`    ${k}`);
    }
  }
  console.log(
    total
      ? `\n${total} placeholder(s) still showing English. Replace the value and drop the ${MARKER} comment.`
      : 'No untranslated placeholders.',
  );
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'add') add(rest[0], rest[1]);
else if (cmd === 'todo') todo();
else {
  console.error(
    'usage: node scripts/i18n.mjs add <key> <english>   |   node scripts/i18n.mjs todo',
  );
  process.exit(1);
}
