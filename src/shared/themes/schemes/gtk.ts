// GTK color definitions (`@define-color`, and libadwaita's `:root { --name: value }`) as palette roles (docs/themes.md
// "Importing GTK, KDE and Qt color schemes"). Untrusted text: a single-pass tokenizer, each definition evaluated at most once
// per look with a cycle check and a depth cap, `@import` never followed.
import { l, type LocalizedText } from '../../localized-text';
import { formatHex, parseHex, type Rgba } from '../color';
import { kindOfBackground } from '../contrast';
import { NOT_ONE_LINE } from '../limits';
import { LOOK_KINDS, type LookKind } from '../tokens';
import { CSS_NAMED_COLORS } from './css-colors';
import { SchemeImportError } from './errors';
import { LIBADWAITA_COLORS, LIBADWAITA_INFO } from './libadwaita';
import type { LookSeed, PaletteRoles, SchemeRoles } from './palette';

export const MAX_GTK_DEPTH = 32;

// The first name a file defines wins. Seeds are fills, so each `*_bg_color` comes before the standalone `*_color` text variant.
const GTK_SEEDS: Readonly<Record<Exclude<LookSeed, 'info'>, readonly string[]>> = {
  background: ['view_bg_color', 'theme_base_color'],
  panel: ['window_bg_color', 'theme_bg_color'],
  text: ['view_fg_color', 'theme_text_color', 'window_fg_color', 'theme_fg_color'],
  accent: ['accent_bg_color', 'theme_selected_bg_color', 'accent_color'],
  success: ['success_bg_color', 'success_color'],
  warning: ['warning_bg_color', 'warning_color'],
  danger: ['error_bg_color', 'destructive_bg_color', 'error_color', 'destructive_color'],
};
const ROLE_NAMES: ReadonlySet<string> = new Set(Object.values(GTK_SEEDS).flat());

interface Definition {
  readonly key: string;
  // the name as the file writes it, `@name` or `--name`
  readonly written: string;
  readonly value: string;
  // the media block it is in; undefined at the top level
  readonly kind?: LookKind;
}
type Definitions = ReadonlyMap<string, Definition>;

interface Sheet {
  // in source order
  readonly definitions: Definition[];
  readonly imports: string[];
}

const SPACE = /\s/;
const IDENT = /[\w-]+/y;
const MEDIA = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;
const UNSAFE = new RegExp(`[${NOT_ONE_LINE}]`, 'g');
const MAX_QUOTED = 80;

/** Text from the file as a warning quotes it: one line, at most MAX_QUOTED code points. */
const quoted = (text: string): string => {
  const flat = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const points = [...flat];
  return points.length <= MAX_QUOTED ? flat : `${points.slice(0, MAX_QUOTED - 1).join('')}…`;
};

const LIBADWAITA_NAMES: ReadonlySet<string> = new Set(LIBADWAITA_COLORS.dark.keys());

/**
 * The key a name written `@name` or `--name` is looked up by. libadwaita's own names are one name in both spellings
 * (`@accent_bg_color` and `--accent-bg-color`); any other `@name` and `--name` are apart, as in GTK.
 */
const keyOf = (written: string): string => {
  const variable = written.startsWith('--');
  const name = variable ? written.slice(2) : written.slice(1);
  const libadwaita = variable ? !name.includes('_') && LIBADWAITA_NAMES.has(name.replace(/-/g, '_')) : !name.includes('-') && LIBADWAITA_NAMES.has(name);
  return libadwaita ? name.replace(/-/g, '_') : written;
};

/** The definitions that apply to `kind`, the later one of a name winning; the top level's alone when `kind` is undefined. */
const definitionsOf = (sheet: Sheet, kind: LookKind | undefined): Definitions =>
  new Map(sheet.definitions.filter((definition) => definition.kind === undefined || definition.kind === kind).map((definition) => [definition.key, definition]));

function parseSheet(text: string, fileName: string): Sheet {
  const sheet: Sheet = { definitions: [], imports: [] };
  const n = text.length;
  let i = 0;
  const lineOf = (at: number): string => String(text.slice(0, at).split('\n').length);
  const neverEnds = (at: number): SchemeImportError => new SchemeImportError('syntax', l('{0} is not GTK CSS: what starts at line {1} never ends.', fileName, lineOf(at)));
  const unreadable = (at: number): SchemeImportError => new SchemeImportError('syntax', l('{0} is not GTK CSS: line {1} cannot be read.', fileName, lineOf(at)));
  // the index after a comment or string that starts at `at`, or `at` when none does
  const skipped = (at: number): number => {
    const char = text[at];
    if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      if (end < 0) throw neverEnds(at);
      return end + 2;
    }
    if (char !== '"' && char !== '\'') return at;
    for (let j = at + 1; j < n; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === char) return j + 1;
      else if (text[j] === '\n' || text[j] === '\r' || text[j] === '\f') break;
    }
    throw neverEnds(at);
  };
  const skipSpace = (): void => {
    while (i < n) {
      if (SPACE.test(text[i]!)) i++;
      else if (text[i] === '/' && text[i + 1] === '*') i = skipped(i);
      else return;
    }
  };
  // the text up to the first of `stops` outside brackets, strings and comments, comments left out
  const readUntil = (stops: string): string => {
    let out = '';
    let from = i;
    let depth = 0;
    while (i < n) {
      const char = text[i]!;
      const after = skipped(i);
      if (after !== i) {
        if (char === '/') {
          out += `${text.slice(from, i)} `;
          from = after;
        }
        i = after;
        continue;
      }
      if (char === '(' || char === '[') depth++;
      else if ((char === ')' || char === ']') && depth > 0) depth--;
      else if (depth === 0 && stops.includes(char)) break;
      i++;
    }
    return (out + text.slice(from, i)).trim();
  };
  // past the block whose `{` was just read
  const skipBlock = (start: number): void => {
    let depth = 1;
    while (i < n) {
      const after = skipped(i);
      if (after !== i) {
        i = after;
        continue;
      }
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
    throw neverEnds(start);
  };
  const readIdent = (): string => {
    IDENT.lastIndex = i;
    const match = IDENT.exec(text);
    i = IDENT.lastIndex;
    return match ? match[0] : '';
  };
  const define = (written: string, value: string, kind: LookKind | undefined): void => {
    sheet.definitions.push({ key: keyOf(written), written, value, ...(kind ? { kind } : {}) });
  };
  // the declarations of a `:root` block whose `{` was just read
  const declarations = (kind: LookKind | undefined, start: number): void => {
    for (;;) {
      skipSpace();
      if (i >= n) throw neverEnds(start);
      if (text[i] === '}') {
        i++;
        return;
      }
      if (text[i] === ';') {
        i++;
        continue;
      }
      const property = readUntil(':;{}');
      if (text[i] === '{') {
        i++;
        skipBlock(i - 1);
        continue;
      }
      if (text[i] !== ':') continue;
      i++;
      const value = readUntil(';{}');
      if (text[i] === '{') {
        i++;
        skipBlock(i - 1);
        continue;
      }
      if (property.startsWith('--') && value !== '') define(property, value.replace(/!\s*important$/i, '').trim(), kind);
    }
  };
  // `start` is where the media block of `kind` opened; undefined at the top level
  const statements = (kind: LookKind | undefined, start: number | undefined): void => {
    for (;;) {
      skipSpace();
      if (i >= n) {
        if (start !== undefined) throw neverEnds(start);
        return;
      }
      const at = i;
      if (text[i] === '}') {
        if (start === undefined) throw unreadable(at);
        i++;
        return;
      }
      if (text[i] === ';') {
        i++;
        continue;
      }
      if (text[i] === '@') {
        i++;
        const keyword = readIdent().toLowerCase();
        if (keyword === 'define-color') {
          skipSpace();
          const name = readIdent();
          const value = readUntil(';{}');
          if (name === '' || value === '' || text[i] === '{') throw unreadable(at);
          if (text[i] === ';') i++;
          define(`@${name}`, value, kind);
          continue;
        }
        const prelude = readUntil(';{}');
        if (text[i] === '{') {
          i++;
          const media = keyword === 'media' && start === undefined ? MEDIA.exec(prelude)?.[1]?.toLowerCase() as LookKind | undefined : undefined;
          if (media) statements(media, i - 1);
          else skipBlock(i - 1);
          continue;
        }
        if (keyword === 'import') sheet.imports.push(prelude);
        if (text[i] === ';') i++;
        continue;
      }
      const prelude = readUntil('{;}');
      if (text[i] !== '{') throw unreadable(at);
      i++;
      if (prelude === ':root') declarations(kind, i - 1);
      else skipBlock(i - 1);
    }
  };
  statements(undefined, undefined);
  return sheet;
}

/** An expression Damocles does not evaluate: the role it sets is left to libadwaita. */
class Unsupported extends Error {}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

type Hsla = readonly [number, number, number, number];

function toHsla([r, g, b, a]: Rgba): Hsla {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness, a];
  const d = max - min;
  const saturation = lightness > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, saturation, lightness, a];
}

function fromHsla([h, s, lightness, a]: Hsla): Rgba {
  const c = (1 - Math.abs(2 * lightness - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m, a];
}

/** GTK's shade(): HLS lightness and saturation times `factor`, each kept within 0 to 1. */
function gtkShade(color: Rgba, factor: number): Rgba {
  const [h, s, lightness, a] = toHsla(color);
  return fromHsla([h, clamp01(s * factor), clamp01(lightness * factor), a]);
}

/** GTK's mix(): each channel, alpha included, `factor` of the way from `a` to `b`. */
function gtkMix(a: Rgba, b: Rgba, factor: number): Rgba {
  const channel = (index: number): number => clamp01(a[index]! + (b[index]! - a[index]!) * factor);
  return [channel(0), channel(1), channel(2), channel(3)];
}

const HEX_DIGITS = /#([0-9a-f]+)/iy;
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(%)?/iy;
const REFERENCE = /@([\w-]+)/y;
const VARIABLE = /--[\w-]+/y;

interface Scope {
  readonly kind: LookKind;
  readonly definitions: Definitions;
  readonly memo: Map<string, Rgba | undefined>;
  readonly stack: string[];
  readonly fileName: string;
}

const valueOf = (scope: Scope, key: string): string | undefined => scope.definitions.get(key)?.value ?? LIBADWAITA_COLORS[scope.kind].get(key);

/**
 * The color `key` has in `scope`: the file's definition, else libadwaita's, whose compatibility names refer to the file's
 * definitions; undefined when neither gives one Damocles reads.
 */
function resolve(scope: Scope, key: string): Rgba | undefined {
  if (scope.memo.has(key)) return scope.memo.get(key);
  const value = valueOf(scope, key);
  if (value === undefined) return undefined;
  if (scope.stack.includes(key)) {
    throw new SchemeImportError('cycle', l('{0} defines the color {1} through itself.', scope.fileName, quoted(scope.definitions.get(key)?.written ?? `@${key}`)));
  }
  if (scope.stack.length > MAX_GTK_DEPTH) throw new SchemeImportError('depth', l('{0} defines its colors through more than {1} references in a row.', scope.fileName, String(MAX_GTK_DEPTH)));
  scope.stack.push(key);
  let color: Rgba | undefined;
  try {
    color = evaluate(value, scope);
  } finally {
    scope.stack.pop();
  }
  scope.memo.set(key, color);
  return color;
}

/** A GTK CSS color expression's color, or undefined when it uses anything Damocles does not evaluate. */
function evaluate(source: string, scope: Scope): Rgba | undefined {
  let p = 0;
  const space = (): void => {
    while (p < source.length && SPACE.test(source[p]!)) p++;
  };
  const sticky = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = p;
    const match = pattern.exec(source);
    if (match) p = pattern.lastIndex;
    return match;
  };
  const expect = (char: string): void => {
    space();
    if (source[p] !== char) throw new Unsupported();
    p++;
  };
  const number = (): { readonly value: number; readonly percent: boolean } => {
    space();
    const match = sticky(NUMBER);
    const value = match ? Number.parseFloat(match[0]) : Number.NaN;
    if (!match || !Number.isFinite(value)) throw new Unsupported();
    return { value, percent: match[1] !== undefined };
  };
  // mix(), alpha() and shade() take a plain number
  const factor = (): number => {
    const { value, percent } = number();
    if (percent) throw new Unsupported();
    return value;
  };
  // rgb() and rgba() in either syntax: `r, g, b[, a]` or `r g b[ / a]`, each channel 0 to 255 or a percentage
  const rgb = (): Rgba => {
    const parts = [number()];
    let alpha: ReturnType<typeof number> | undefined;
    space();
    if (source[p] === ',') {
      while (source[p] === ',' && parts.length < 4) {
        p++;
        parts.push(number());
        space();
      }
      if (parts.length === 4) alpha = parts.pop();
    } else {
      parts.push(number(), number());
      space();
      if (source[p] === '/') {
        p++;
        alpha = number();
      }
    }
    expect(')');
    if (parts.length !== 3) throw new Unsupported();
    const [r, g, b] = parts.map(({ value, percent }) => clamp01(percent ? value / 100 : value / 255)) as [number, number, number];
    return [r, g, b, alpha === undefined ? 1 : clamp01(alpha.percent ? alpha.value / 100 : alpha.value)];
  };
  // past the `)` that closes the call whose `(` is already read
  const skipCall = (): void => {
    for (let depth = 1; p < source.length; p++) {
      if (source[p] === '(') depth++;
      else if (source[p] === ')' && --depth === 0) {
        p++;
        return;
      }
    }
    throw new Unsupported();
  };
  const color = (depth: number): Rgba => {
    if (depth > MAX_GTK_DEPTH) throw new SchemeImportError('depth', l('{0} nests its color functions more than {1} levels deep.', scope.fileName, String(MAX_GTK_DEPTH)));
    space();
    if (source[p] === '#') {
      const digits = sticky(HEX_DIGITS)?.[1] ?? '';
      const full = digits.length === 3 || digits.length === 4 ? [...digits].map((digit) => digit.repeat(2)).join('') : digits;
      const parsed = full.length === 6 || full.length === 8 ? parseHex(`#${full}`) : undefined;
      if (!parsed) throw new Unsupported();
      return parsed;
    }
    if (source[p] === '@') {
      const name = sticky(REFERENCE)?.[1];
      const resolved = name === undefined ? undefined : resolve(scope, keyOf(`@${name}`));
      if (!resolved) throw new Unsupported();
      return resolved;
    }
    const name = sticky(IDENT)?.[0].toLowerCase();
    if (name === undefined) throw new Unsupported();
    if (source[p] !== '(') {
      const named = CSS_NAMED_COLORS.get(name);
      const parsed = named === undefined ? undefined : parseHex(named);
      if (!parsed) throw new Unsupported();
      return parsed;
    }
    p++;
    const argument = (): Rgba => {
      const value = color(depth + 1);
      expect(',');
      return value;
    };
    switch (name) {
      case 'rgb':
      case 'rgba':
        return rgb();
      case 'mix': {
        const [a, b] = [argument(), argument()];
        const f = factor();
        expect(')');
        return gtkMix(a, b, f);
      }
      case 'alpha': {
        const c = argument();
        const f = factor();
        expect(')');
        return [c[0], c[1], c[2], clamp01(c[3] * f)];
      }
      case 'shade': {
        const c = argument();
        const f = factor();
        expect(')');
        return gtkShade(c, f);
      }
      case 'lighter':
      case 'darker': {
        const c = color(depth + 1);
        expect(')');
        return gtkShade(c, name === 'lighter' ? 1.3 : 0.7);
      }
      case 'var': {
        space();
        const variable = sticky(VARIABLE)?.[0];
        if (variable === undefined) throw new Unsupported();
        const key = keyOf(variable);
        space();
        if (valueOf(scope, key) !== undefined) {
          const resolved = resolve(scope, key);
          if (!resolved) throw new Unsupported();
          if (source[p] === ',') skipCall();
          else expect(')');
          return resolved;
        }
        expect(',');
        const fallback = color(depth + 1);
        expect(')');
        return fallback;
      }
      default:
        throw new Unsupported();
    }
  };
  try {
    const result = color(0);
    space();
    return p === source.length ? result : undefined;
  } catch (err) {
    if (err instanceof Unsupported) return undefined;
    throw err;
  }
}

/**
 * The kinds the file's top-level colors make: none when the top level sets no color Damocles reads, else the kind of its
 * background (or panel), or both kinds when it sets neither or that color differs by kind, as one that follows libadwaita's does.
 */
function baseKinds(sheet: Sheet, fileName: string): readonly LookKind[] {
  const base = definitionsOf(sheet, undefined);
  if (![...base.keys()].some((key) => ROLE_NAMES.has(key))) return [];
  const name = [...GTK_SEEDS.background, ...GTK_SEEDS.panel].find((candidate) => base.has(candidate));
  if (name === undefined) return LOOK_KINDS;
  const [first, ...others] = LOOK_KINDS.map((kind) => resolve({ kind, definitions: base, memo: new Map(), stack: [], fileName }, name));
  return first && others.every((color) => color && formatHex(color) === formatHex(first)) ? [kindOfBackground(first)] : LOOK_KINDS;
}

export interface GtkOptions {
  // the kinds to read the file for, whatever kinds its own colors make
  readonly kinds?: readonly LookKind[];
}

/**
 * A GTK CSS file's colors as palette roles. Top-level definitions apply to every kind and `@media (prefers-color-scheme: dark)`
 * or `light` blocks to theirs, the later definition of a name winning, over libadwaita's values, which a reference to a name
 * the file does not define reads. The looks are the kinds with a media block plus the kinds `baseKinds` gives.
 */
export function gtkRoles(text: string, fileName: string, options: GtkOptions = {}): SchemeRoles {
  const sheet = parseSheet(text, fileName);
  if (!sheet.definitions.some((definition) => ROLE_NAMES.has(definition.key))) {
    const imported = sheet.imports.find((target) => !target.includes('resource://'));
    if (imported !== undefined) {
      throw new SchemeImportError('noColors', l('{0} defines none of the GTK colors Damocles reads and imports {1}, which Damocles does not follow. Import that file instead.', fileName, quoted(imported)));
    }
    if (sheet.imports.length > 0) {
      throw new SchemeImportError('noColors', l('{0} only imports a theme whose colors are compiled into a .gresource file, which Damocles cannot read. Import a gtk.css that defines the colors, such as ~/.config/gtk-4.0/gtk.css.', fileName));
    }
    throw new SchemeImportError('noColors', l('{0} defines none of the GTK colors Damocles reads, such as window_bg_color, view_bg_color or accent_bg_color.', fileName));
  }
  const wanted = options.kinds ?? [...baseKinds(sheet, fileName), ...LOOK_KINDS.filter((kind) => sheet.definitions.some((definition) => definition.kind === kind))];
  const kinds = LOOK_KINDS.filter((kind) => wanted.includes(kind));
  const warnings: LocalizedText[] = [];
  const warned = new Set<string>();
  const palettes: Partial<Record<LookKind, PaletteRoles>> = {};
  for (const kind of kinds) {
    const scope: Scope = { kind, definitions: definitionsOf(sheet, kind), memo: new Map(), stack: [], fileName };
    const seeds: Partial<Record<LookSeed, string>> = { info: LIBADWAITA_INFO };
    const unread: LookSeed[] = [];
    for (const [seed, names] of Object.entries(GTK_SEEDS) as [LookSeed, readonly string[]][]) {
      const name = names.find((candidate) => scope.definitions.has(candidate));
      if (name === undefined) continue;
      const color = resolve(scope, name);
      if (color) {
        seeds[seed] = formatHex(color);
        continue;
      }
      unread.push(seed);
      const { written, value } = scope.definitions.get(name)!;
      const said = `${written}\n${value}`;
      if (warned.has(said)) continue;
      warned.add(said);
      warnings.push(l('{0} sets {1} to {2}, which Damocles cannot read, so that color comes from libadwaita.', fileName, quoted(written), quoted(value)));
    }
    palettes[kind] = { kind, seeds, tokens: {}, ...(unread.length > 0 ? { unread } : {}) };
  }
  for (const target of sheet.imports) warnings.push(l('{0} imports {1}, which Damocles does not follow.', fileName, quoted(target)));
  return { palettes, warnings };
}
