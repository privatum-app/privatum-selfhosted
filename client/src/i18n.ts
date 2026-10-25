// Interface language. The Portuguese text in the code is the key; EN holds its translation.
// Tor Browser reports English to every site (anti-fingerprinting), so the language is
// never guessed: Portuguese by default, and the person picks (stored only in this browser).
import { EN } from './i18n-en.ts';

export type Lang = 'pt' | 'en';
const KEY = 'privatum-lang';

function read(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'pt';
  } catch {
    return 'pt';
  }
}

let current: Lang = read();

export const lang = () => current;

/** Locale for dates and times. */
export const locale = () => (current === 'en' ? 'en-US' : 'pt-BR');

/** Switches and reloads, so every screen is drawn again in the new language. */
export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  current = next;
  location.reload();
}

/** Translates a Portuguese source string; `{name}` placeholders are filled from `vars`. */
export function t(pt: string, vars?: Record<string, string | number>): string {
  const s = current === 'en' ? (EN[pt] ?? pt) : pt;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s;
}
