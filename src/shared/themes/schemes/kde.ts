// KDE color schemes (`.colors`, `kdeglobals`) as palette roles (docs/themes.md "Importing GTK, KDE and Qt color schemes").
import { l } from '../../localized-text';
import { formatHex, type Rgba } from '../color';
import { kindOfBackground } from '../contrast';
import type { TokenName } from '../tokens';
import { SchemeImportError } from './errors';
import { readIni, type Ini } from './ini';
import { qtColor, type LookSeed, type SchemeRoles } from './palette';

type KdeKey = readonly [group: string, key: string];

// KDE stores no status backgrounds (KColorScheme tints them from the foregrounds), so the foregrounds are the status fills.
const KDE_SEEDS: Readonly<Record<Exclude<LookSeed, 'accent'>, KdeKey>> = {
  background: ['Colors:View', 'BackgroundNormal'],
  panel: ['Colors:Window', 'BackgroundNormal'],
  text: ['Colors:View', 'ForegroundNormal'],
  success: ['Colors:View', 'ForegroundPositive'],
  warning: ['Colors:View', 'ForegroundNeutral'],
  danger: ['Colors:View', 'ForegroundNegative'],
  info: ['Colors:View', 'ForegroundActive'],
};
// Plasma 5.25 and later keep the user's accent in [General] AccentColor; older schemes only have the selection color.
const KDE_ACCENT: readonly KdeKey[] = [['General', 'AccentColor'], ['Colors:Selection', 'BackgroundNormal']];
const KDE_TOKENS: Readonly<Partial<Record<TokenName, KdeKey>>> = { '--d-muted': ['Colors:View', 'ForegroundInactive'] };

// what QByteArray::toInt reads in base 10: an optional sign and digits
const INTEGER = /^[+-]?\d+$/;

/** A KConfig color: `r,g,b` or `r,g,b,a` with each part 0 to 255, or a name QColor reads; undefined otherwise. */
export function kdeColor(value: string): Rgba | undefined {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 4) return qtColor(value);
  if (!parts.every((part) => INTEGER.test(part) && Number(part) >= 0 && Number(part) <= 255)) return undefined;
  const [r, g, b, a = 255] = parts.map(Number) as [number, number, number, number?];
  return [r / 255, g / 255, b / 255, a / 255];
}

const KCONFIG_ESCAPES: Readonly<Record<string, string>> = { s: ' ', t: '\t', n: '\n', r: '\r', '\\': '\\' };
const HEX_BYTE = /^[0-9a-f]{2}$/i;

/** A KConfig value with its escapes read: `\s`, `\t`, `\n`, `\r`, `\\` and `\xNN` (a UTF-8 byte); quotes are literal. */
function kconfigValue(value: string): string {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let from = 0;
  for (let at = value.indexOf('\\'); at >= 0 && at < value.length - 1; at = value.indexOf('\\', from)) {
    parts.push(encoder.encode(value.slice(from, at)));
    const next = value[at + 1]!;
    const hex = value.slice(at + 2, at + 4);
    if (next === 'x' && HEX_BYTE.test(hex)) {
      parts.push(Uint8Array.of(Number.parseInt(hex, 16)));
      from = at + 4;
    } else if (Object.hasOwn(KCONFIG_ESCAPES, next)) {
      parts.push(encoder.encode(KCONFIG_ESCAPES[next]));
      from = at + 2;
    } else {
      parts.push(encoder.encode('\\'));
      from = at + 1;
    }
  }
  parts.push(encoder.encode(value.slice(from)));
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((offset, part) => {
    bytes.set(part, offset);
    return offset + part.length;
  }, 0);
  return new TextDecoder().decode(bytes);
}

export interface KdeOptions {
  // a value that is no color reads as `defaults`' value of its key, else as unset, as KConfig falls back to its default
  readonly lenient?: boolean;
  readonly defaults?: Ini;
}

/**
 * The roles a KDE color scheme's groups give; a file with neither View/BackgroundNormal nor View/ForegroundNormal is refused,
 * and so is a value that is no color unless `lenient`.
 */
export function kdeRolesOfIni(ini: Ini, fileName: string, { lenient = false, defaults }: KdeOptions = {}): SchemeRoles {
  const read = ([group, key]: KdeKey): string | undefined => {
    const value = ini.get(group)?.get(key);
    if (value === undefined || value === '') return undefined;
    const color = kdeColor(value);
    if (color) return formatHex(color);
    if (!lenient) throw new SchemeImportError('badColor', l('{0} is not a KDE color scheme: {1} in [{2}] is not a color.', fileName, key, group));
    const fallback = defaults?.get(group)?.get(key);
    const fallbackColor = fallback === undefined ? undefined : kdeColor(fallback);
    return fallbackColor && formatHex(fallbackColor);
  };
  const seeds: Partial<Record<LookSeed, string>> = {};
  for (const [seed, key] of Object.entries(KDE_SEEDS) as [LookSeed, KdeKey][]) {
    const color = read(key);
    if (color !== undefined) seeds[seed] = color;
  }
  for (const key of KDE_ACCENT) {
    const color = read(key);
    if (color === undefined) continue;
    seeds.accent = color;
    break;
  }
  if (seeds.background === undefined && seeds.text === undefined) {
    throw new SchemeImportError('noColors', l('{0} is not a KDE color scheme: it sets neither BackgroundNormal nor ForegroundNormal in [Colors:View].', fileName));
  }
  const tokens: Partial<Record<TokenName, string>> = {};
  for (const [token, key] of Object.entries(KDE_TOKENS) as [TokenName, KdeKey][]) {
    const color = read(key);
    if (color !== undefined) tokens[token] = color;
  }
  // a background's alpha is translucency over the desktop, not a different color
  const kind = seeds.background !== undefined ? kindOfBackground(seeds.background) : kindOfBackground(seeds.text!) === 'light' ? 'dark' : 'light';
  const general = ini.get('General');
  const name = [general?.get('Name'), general?.get('ColorScheme')].map((value) => (value === undefined ? '' : kconfigValue(value).trim())).find((value) => value !== '');
  return { ...(name !== undefined ? { name } : {}), palettes: { [kind]: { kind, seeds, tokens } }, warnings: [] };
}

/** A KDE `.colors` file's or `kdeglobals`' text as palette roles. */
export function kdeRoles(text: string, fileName: string): SchemeRoles {
  return kdeRolesOfIni(readIni(text, fileName), fileName);
}
