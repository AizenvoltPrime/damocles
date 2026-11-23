// KDE, qt5ct/qt6ct and GTK color schemes as Damocles themes (docs/themes.md "Importing GTK, KDE and Qt color schemes"). The
// shared parsers read the roles; this names the theme and fills what a scheme leaves out. Pure: it reads no file, and the
// caller assigns the id and the origin.
import * as path from 'node:path';
import type { LocalizedText } from '../../shared/localized-text';
import { BUILTIN_THEME } from '../../shared/themes/builtin';
import { MAX_THEME_NAME_CHARS } from '../../shared/themes/limits';
import { LOOK_SEEDS, type Look, type LookColors } from '../../shared/themes/schema';
import { gtkRoles, kdeRoles, LIBADWAITA_SEEDS, lookFromRoles, qtRoles, SchemeImportError, type LookSeed, type SchemeRoles } from '../../shared/themes/schemes';
import { LOOK_KINDS, type LookKind } from '../../shared/themes/tokens';
import { l, verbatim } from '../l10n';
import { oneLine } from '../pi-session/untrusted-text';
import type { Converted } from './import';

interface SchemeFormat {
  // stripped from the file name when the scheme names itself nothing
  readonly extension: RegExp;
  readonly defaults: (kind: LookKind) => LookColors;
  // seeds the format has no role for, which the install card's conversion note covers
  readonly roleless: readonly LookSeed[];
  readonly noName: LocalizedText;
  readonly missing: (file: string, seeds: LocalizedText) => LocalizedText;
}

// Each seed's name in the reader's language, as the theme editor words it.
const SEED_WORDS: Readonly<Record<LookSeed, LocalizedText>> = {
  background: l('background'), panel: l('panel'), text: l('text'), accent: l('accent'),
  success: l('success'), warning: l('warning'), danger: l('danger'), info: l('info'),
};

// Halved at each level, so a long list nests only a few levels deep (parseLocalizedText bounds the depth).
const commaList = (items: readonly LocalizedText[]): LocalizedText => {
  if (items.length === 1) return items[0]!;
  const half = Math.ceil(items.length / 2);
  return l('{0}, {1}', commaList(items.slice(0, half)), commaList(items.slice(half)));
};

/** `items` as one list in the reader's language: "a, b and c". */
const listOf = (items: readonly LocalizedText[]): LocalizedText => (items.length === 1 ? items[0]! : l('{0} and {1}', commaList(items.slice(0, -1)), items.at(-1)!));

const damoclesSeeds = (kind: LookKind): LookColors => BUILTIN_THEME.looks[kind]!.colors;
const missingFromDamocles = (file: string, seeds: LocalizedText): LocalizedText => l('{0} sets no color for {1}, so Damocles\' own colors of that kind stand in.', verbatim(file), seeds);

const KDE: SchemeFormat = {
  extension: /\.colors$/i,
  defaults: damoclesSeeds,
  roleless: [],
  noName: l('This KDE color scheme has no name.'),
  missing: missingFromDamocles,
};

const QT: SchemeFormat = {
  extension: /\.conf$/i,
  defaults: damoclesSeeds,
  roleless: ['success', 'warning', 'danger'],
  noName: l('This Qt color scheme has no name.'),
  missing: missingFromDamocles,
};

const GTK: SchemeFormat = {
  extension: /\.css$/i,
  defaults: (kind) => LIBADWAITA_SEEDS[kind],
  roleless: [],
  noName: l('This GTK color file has no name.'),
  missing: (file, seeds) => l('{0} sets no color for {1}, so libadwaita\'s defaults stand in.', verbatim(file), seeds),
};

/** A theme of a look per kind the scheme covers, named by the scheme or else its file, with one warning for the seeds it lacks. */
function schemeTheme(roles: SchemeRoles, fileName: string, format: SchemeFormat): Converted {
  const stem = path.basename(fileName).replace(format.extension, '');
  const name = (roles.name !== undefined ? oneLine(roles.name, MAX_THEME_NAME_CHARS) : undefined) ?? oneLine(stem, MAX_THEME_NAME_CHARS);
  if (name === undefined) throw new SchemeImportError('noName', format.noName);
  const looks: Partial<Record<LookKind, Look>> = {};
  const missing = new Set<LookSeed>();
  for (const kind of LOOK_KINDS) {
    const palette = roles.palettes[kind];
    if (!palette) continue;
    const { look, filled } = lookFromRoles(palette, format.defaults(kind));
    looks[kind] = look;
    for (const seed of filled) if (!format.roleless.includes(seed) && !palette.unread?.includes(seed)) missing.add(seed);
  }
  const warnings = [...roles.warnings];
  if (missing.size > 0) warnings.push(format.missing(fileName, listOf(LOOK_SEEDS.filter((seed) => missing.has(seed)).map((seed) => SEED_WORDS[seed]))));
  return { theme: { schemaVersion: 1, name, looks }, warnings };
}

/** A KDE `.colors` file or `kdeglobals` as a one-look theme. */
export function importKdeText(text: string, fileName: string): Converted {
  return schemeTheme(kdeRoles(text, fileName), fileName, KDE);
}

/** A qt5ct or qt6ct `.conf` palette as a one-look theme. */
export function importQtText(text: string, fileName: string): Converted {
  return schemeTheme(qtRoles(text, fileName), fileName, QT);
}

/** A GTK CSS file as a theme of one look, or two when it has a media block per kind. */
export function importGtkText(text: string, fileName: string): Converted {
  return schemeTheme(gtkRoles(text, fileName), fileName, GTK);
}
