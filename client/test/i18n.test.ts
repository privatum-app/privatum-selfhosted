// Every string marked with t('…') has an English translation with the same placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EN } from '../src/i18n-en.ts';

const files = ['../src/App.tsx', '../src/admin/Admin.tsx', '../src/ui.tsx', '../src/admin/main.tsx'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'));
const keys = new Set<string>();
for (const src of files) for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
// Keys that reach t() through a variable: avatar names (read from ui.tsx) and timer labels.
const avatarNames = [...files[2].match(/AVATAR_NAMES = \[([^\]]*)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
assert.equal(avatarNames.length, 20);
for (const k of [...avatarNames, 'Desligadas', '1 hora', '1 dia', '7 dias']) keys.add(k);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every marked string has an English translation', () => {
  const missing = [...keys].filter((k) => !(k in EN));
  assert.deepEqual(missing, []);
});

test('translations keep the same placeholders', () => {
  for (const k of keys) assert.deepEqual(placeholders(EN[k] ?? k), placeholders(k), k);
});
