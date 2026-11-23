// qt5ct and qt6ct color schemes (`.conf`) as palette roles (docs/themes.md "Importing GTK, KDE and Qt color schemes").
import { l } from '../../localized-text';
import { formatHex } from '../color';
import { kindOfBackground } from '../contrast';
import type { TokenName } from '../tokens';
import { SchemeImportError } from './errors';
import { iniList, readIni, type Ini } from './ini';
import { qtColor, type LookSeed, type SchemeRoles } from './palette';

// QPalette::ColorRole, the order of active_colors; Accent (Qt 6.6 and later) is optional.
export const QT_ROLES = [
  'WindowText', 'Button', 'Light', 'Midlight', 'Dark', 'Mid', 'Text', 'BrightText', 'ButtonText', 'Base', 'Window', 'Shadow',
  'Highlight', 'HighlightedText', 'Link', 'LinkVisited', 'AlternateBase', 'NoRole', 'ToolTipBase', 'ToolTipText',
  'PlaceholderText', 'Accent',
] as const;
type QtRole = (typeof QT_ROLES)[number];
// Qt 5.12 added PlaceholderText, so an older palette has the 20 roles before it.
const MIN_QT_COLORS = 20;

// Qt has no success, warning or danger role: those seeds stay unset.
const QT_SEEDS: Readonly<Partial<Record<LookSeed, readonly QtRole[]>>> = {
  background: ['Base'], panel: ['Window'], text: ['Text'], accent: ['Accent', 'Highlight'], info: ['Link'],
};
const QT_TOKENS: Readonly<Partial<Record<TokenName, QtRole>>> = { '--d-muted': 'PlaceholderText' };

/** The roles a qt5ct or qt6ct palette's `[ColorScheme] active_colors` gives; with `lenient`, a role that is no color is unset. */
export function qtRolesOfIni(ini: Ini, fileName: string, { lenient = false }: { readonly lenient?: boolean } = {}): SchemeRoles {
  const raw = ini.get('ColorScheme')?.get('active_colors');
  if (raw === undefined) throw new SchemeImportError('noColors', l('{0} is not a Qt color scheme: it has no active_colors in [ColorScheme].', fileName));
  const colors = iniList(raw);
  if (colors.length < MIN_QT_COLORS) {
    throw new SchemeImportError('noColors', l('{0} is not a Qt color scheme: active_colors lists {1} colors, and a Qt palette has at least {2}.', fileName, String(colors.length), String(MIN_QT_COLORS)));
  }
  const read = (role: QtRole): string | undefined => {
    const value = colors[QT_ROLES.indexOf(role)];
    if (value === undefined || value === '') return undefined;
    const color = qtColor(value);
    if (color) return formatHex(color);
    if (!lenient) throw new SchemeImportError('badColor', l('{0} is not a Qt color scheme: its {1} color is not a color.', fileName, role));
    return undefined;
  };
  const seeds: Partial<Record<LookSeed, string>> = {};
  for (const [seed, roles] of Object.entries(QT_SEEDS) as [LookSeed, readonly QtRole[]][]) {
    for (const role of roles) {
      const color = read(role);
      if (color === undefined) continue;
      seeds[seed] = color;
      break;
    }
  }
  const tokens: Partial<Record<TokenName, string>> = {};
  for (const [token, role] of Object.entries(QT_TOKENS) as [TokenName, QtRole][]) {
    const color = read(role);
    if (color !== undefined) tokens[token] = color;
  }
  if (seeds.background === undefined) throw new SchemeImportError('noColors', l('{0} is not a Qt color scheme: it has no Base color.', fileName));
  const kind = kindOfBackground(seeds.background);
  return { palettes: { [kind]: { kind, seeds, tokens } }, warnings: [] };
}

/** A qt5ct or qt6ct `.conf` palette's text as palette roles. It has no name of its own. */
export function qtRoles(text: string, fileName: string): SchemeRoles {
  return qtRolesOfIni(readIni(text, fileName, { qsettings: true }), fileName);
}
