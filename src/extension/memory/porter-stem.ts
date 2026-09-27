/**
 * The Porter stem SQLite's FTS5 `porter` tokenizer indexes for a lowercase ASCII token, ported from
 * `fts5PorterCb` in `ext/fts5/fts5_tokenize.c`. It keeps that code's quirks (a `y` after the first
 * letter always counts as a vowel in the `*v*` test, tokens under 3 or over 64 characters pass through)
 * so a stem computed here equals the term a MATCH on the token looks up. `porter-stem.test.ts` checks
 * it against SQLite over every reference word.
 */
export function porterStem(token: string): string {
  if (token.length < 3 || token.length > MAX_TOKEN || !ASCII_LOWER_ALNUM.test(token)) return token;
  let w = step1a(token);
  w = step1b(w);
  if (w.endsWith('y') && hasVowel(w, w.length - 1)) w = `${w.slice(0, -1)}i`;
  w = applyFirst(w, STEP2, measureGt0);
  w = applyFirst(w, STEP3, measureGt0);
  w = step4(w);
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    if (measureGt1(stem) || (measureEq1(stem) && !endsCvc(stem))) w = stem;
  }
  if (w.length > 1 && w.endsWith('ll') && measureGt1(w.slice(0, -1))) w = w.slice(0, -1);
  return w;
}

const MAX_TOKEN = 64;
const ASCII_LOWER_ALNUM = /^[a-z0-9]+$/;

function isVowel(c: string, yIsVowel: boolean): boolean {
  return c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u' || (yIsVowel && c === 'y');
}

/** Index just past the first vowel-then-consonant run of `s`, or 0 when there is none. */
function gobbleVc(s: string, prevConsonant: boolean): number {
  let consonant = prevConsonant;
  let i = 0;
  for (; i < s.length; i++) {
    consonant = !isVowel(s[i]!, consonant);
    if (!consonant) break;
  }
  for (i++; i < s.length; i++) {
    consonant = !isVowel(s[i]!, consonant);
    if (consonant) return i + 1;
  }
  return 0;
}

function measureGt0(stem: string): boolean {
  return gobbleVc(stem, false) > 0;
}

function measureGt1(stem: string): boolean {
  const n = gobbleVc(stem, false);
  return n > 0 && gobbleVc(stem.slice(n), true) > 0;
}

function measureEq1(stem: string): boolean {
  const n = gobbleVc(stem, false);
  return n > 0 && gobbleVc(stem.slice(n), true) === 0;
}

/** `*o`: the stem ends consonant-vowel-consonant and the last letter is not w, x or y. */
function endsCvc(stem: string): boolean {
  const last = stem[stem.length - 1];
  if (last === 'w' || last === 'x' || last === 'y') return false;
  let mask = 0;
  let consonant = false;
  for (const c of stem) {
    consonant = !isVowel(c, consonant);
    mask = ((mask << 1) + (consonant ? 1 : 0)) & 0b111;
  }
  return mask === 0b101;
}

/** `*v*` as SQLite tests it: `y` is a vowel anywhere but the first letter. */
function hasVowel(s: string, length: number): boolean {
  for (let i = 0; i < length; i++) if (isVowel(s[i]!, i > 0)) return true;
  return false;
}

function step1a(w: string): string {
  if (!w.endsWith('s')) return w;
  if (w[w.length - 2] === 'e') {
    const n = w.length;
    return (n > 4 && w.endsWith('sses')) || (n > 3 && w[n - 3] === 'i') ? w.slice(0, -2) : w.slice(0, -1);
  }
  return w[w.length - 2] === 's' ? w : w.slice(0, -1);
}

function step1b(w: string): string {
  let stem: string;
  if (w.length > 3 && w.endsWith('eed')) return measureGt0(w.slice(0, -3)) ? w.slice(0, -1) : w;
  if (w.length > 2 && w.endsWith('ed') && hasVowel(w, w.length - 2)) stem = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('ing') && hasVowel(w, w.length - 3)) stem = w.slice(0, -3);
  else return w;
  if (stem.length > 2 && (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz'))) return `${stem}e`;
  const last = stem[stem.length - 1]!;
  if (!isVowel(last, false) && last !== 'l' && last !== 's' && last !== 'z' && last === stem[stem.length - 2]) {
    return stem.slice(0, -1);
  }
  return measureEq1(stem) && endsCvc(stem) ? `${stem}e` : stem;
}

type Rule = readonly [suffix: string, replacement: string];

// Ordered as SQLite tries them; only the first suffix that matches is considered, even when its condition fails.
const STEP2: readonly Rule[] = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['logi', 'log'],
  ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'],
  ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'],
  ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
];
const STEP3: readonly Rule[] = [
  ['ical', 'ic'], ['ness', ''], ['icate', 'ic'], ['iciti', 'ic'], ['ful', ''], ['ative', ''], ['alize', 'al'],
];
const STEP4: readonly string[] = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti',
  'ous', 'ive', 'ize',
];

/**
 * SQLite dispatches each step on the second-to-last letter, so a rule is reachable only when its
 * suffix shares that letter; within that group the first matching suffix wins.
 */
function applyFirst(w: string, rules: readonly Rule[], cond: (stem: string) => boolean): string {
  const key = w[w.length - 2];
  for (const [suffix, replacement] of rules) {
    if (suffix[suffix.length - 2] !== key || w.length <= suffix.length || !w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    return cond(stem) ? stem + replacement : w;
  }
  return w;
}

function step4(w: string): string {
  const key = w[w.length - 2];
  for (const suffix of STEP4) {
    if (suffix[suffix.length - 2] !== key || w.length <= suffix.length || !w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    const ok = suffix === 'ion' ? (stem.endsWith('s') || stem.endsWith('t')) && measureGt1(stem) : measureGt1(stem);
    return ok ? stem : w;
  }
  return w;
}
