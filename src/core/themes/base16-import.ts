// Tinted Theming base16 and base24 schemes as Damocles themes (docs/themes.md "Importing base16 and base24 schemes"): the
// current YAML layout (`palette`, `system`) and the legacy one (top-level baseXX keys, `scheme`). Pure: it reads no file, and the
// caller assigns the id and the origin.
import * as path from 'node:path';
import { CST, isAlias, Lexer, parseDocument, visit } from 'yaml';
import { BACKGROUND_ANSI, kindOfBackground } from '../../shared/themes/contrast';
import { MAX_THEME_AUTHOR_CHARS, MAX_THEME_DESCRIPTION_CHARS, MAX_THEME_NAME_CHARS } from '../../shared/themes/limits';
import type { Look, LookColors } from '../../shared/themes/schema';
import { SchemeImportError } from '../../shared/themes/schemes/errors';
import type { LookKind, TokenName } from '../../shared/themes/tokens';
import { l, verbatim } from '../l10n';
import { oneLine } from '../pi-session/untrusted-text';
import type { Converted } from './import';

const MAX_YAML_DEPTH = 64;

const BASE16_KEYS: readonly string[] = Array.from({ length: 16 }, (_, i) => `base0${i.toString(16).toUpperCase()}`);
// base24's bright colors and the base16 color each falls back to (base24 styling 0.1.3); base10 and base11 map to nothing
const BASE24_FALLBACKS: Readonly<Record<string, string>> = {
  base12: 'base08', base13: 'base0A', base14: 'base0B', base15: 'base0C', base16: 'base0D', base17: 'base0E',
};
const HEX = /^#?[0-9a-f]{6}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether `text` nests more than MAX_YAML_DEPTH collections, in one pass over yaml's own tokens so quoted brackets open
 * nothing. A block collection is counted at the column of its `-`, `?` or `:` until a line starts at or left of it.
 */
function nestsTooDeep(text: string): boolean {
  const blocks: number[] = [];
  let flow = 0;
  let offset = 0;
  let lineStart = 0;
  let fresh = true;
  for (const token of new Lexer().lex(text)) {
    const type = CST.tokenType(token);
    // markers the lexer adds, which hold no text of the file
    if (type === 'doc-mode' || type === 'flow-error-end' || type === 'scalar') continue;
    const column = offset - lineStart;
    offset += token.length;
    const newline = token.lastIndexOf('\n');
    if (newline >= 0) lineStart = offset - token.length + newline + 1;
    if (type === 'space' || type === 'newline' || type === 'comment') {
      fresh ||= token.endsWith('\n');
      continue;
    }
    if (fresh && flow === 0) while (blocks.length > 0 && blocks.at(-1)! >= column) blocks.pop();
    fresh = false;
    if (flow === 0 && (type === 'seq-item-ind' || type === 'explicit-key-ind' || type === 'map-value-ind')) blocks.push(column);
    else if (type === 'flow-seq-start' || type === 'flow-map-start') flow += 1;
    else if ((type === 'flow-seq-end' || type === 'flow-map-end') && flow > 0) flow -= 1;
    if (blocks.length + flow > MAX_YAML_DEPTH) return true;
  }
  return false;
}

function parseYaml(text: string, file: string): Record<string, unknown> {
  // composing, visit and toJS recurse once per level, so the depth is bounded before they run
  if (nestsTooDeep(text)) throw new SchemeImportError('syntax', l('{0} is not a base16 scheme: it nests more than {1} levels deep.', verbatim(file), String(MAX_YAML_DEPTH)));
  // failsafe keeps every scalar a string, so an unquoted `base00: 000000` is not the number 0
  const doc = parseDocument(text, { schema: 'failsafe', stringKeys: true, uniqueKeys: true });
  const [error] = doc.errors;
  // yaml's messages quote the file, so the refusal names only the line and the error's code
  if (error) {
    const line = String(error.linePos?.[0]?.line ?? '?');
    throw new SchemeImportError('syntax', error.code === 'DUPLICATE_KEY'
      ? l('{0} is not a base16 scheme: line {1} repeats a key.', verbatim(file), line)
      : l('{0} is not a base16 scheme: line {1} is not valid YAML ({2}).', verbatim(file), line, verbatim(error.code)));
  }
  let alias = false;
  visit(doc, (_key, node) => {
    if (!isAlias(node)) return undefined;
    alias = true;
    return visit.BREAK;
  });
  if (alias) throw new SchemeImportError('syntax', l('{0} uses YAML aliases, which a base16 scheme does not need.', verbatim(file)));
  const json: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!isRecord(json)) throw new SchemeImportError('noColors', l('{0} is not a base16 scheme.', verbatim(file)));
  return json;
}

/** The scheme's baseXX colors as lowercase #rrggbb, base16's all required and base24's when `base24`. */
function colorsOf(palette: Record<string, unknown>, base24: boolean, file: string): Record<string, string> {
  const colors: Record<string, string> = {};
  const read = (key: string): string | undefined => {
    const value = palette[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !HEX.test(value.trim())) {
      throw new SchemeImportError('badColor', l('{0} is not a base16 scheme: {1} is not a #rrggbb color.', verbatim(file), key));
    }
    return `#${value.trim().replace(/^#/, '').toLowerCase()}`;
  };
  for (const key of BASE16_KEYS) {
    const color = read(key);
    if (color === undefined) throw new SchemeImportError('noColors', l('{0} is not a base16 scheme: it has no {1}.', verbatim(file), key));
    colors[key] = color;
  }
  if (base24) for (const [key, fallback] of Object.entries(BASE24_FALLBACKS)) colors[key] = read(key) ?? colors[fallback]!;
  return colors;
}

/** One look from a scheme's colors: docs/themes.md "Importing base16 and base24 schemes" has the table. */
function base16Look(c: Readonly<Record<string, string>>, kind: LookKind, base24: boolean): Look {
  const colors: LookColors = {
    background: c['base00']!, panel: c['base01']!, text: c['base05']!, accent: c['base0D']!,
    success: c['base0B']!, warning: c['base0A']!, danger: c['base08']!, info: c['base0C']!,
  };
  const normal = ['base08', 'base0B', 'base0A', 'base0D', 'base0E', 'base0C'].map((key) => c[key]!);
  const bright = base24 ? ['base12', 'base14', 'base13', 'base16', 'base17', 'base15'].map((key) => c[key]!) : normal;
  // base00 takes the slot contrast exempts as the background (BACKGROUND_ANSI), base07 the other end
  const [first, last] = BACKGROUND_ANSI[kind] === '--d-ansi-0' ? [c['base00']!, c['base07']!] : [c['base07']!, c['base00']!];
  const ansi = [first, ...normal, c['base05']!, c['base03']!, ...bright, last];
  const tokens: Partial<Record<TokenName, string>> = {
    '--s-kw': c['base0E']!, '--s-str': c['base0B']!, '--s-num': c['base09']!, '--s-com': c['base03']!, '--s-fn': c['base0D']!, '--s-type': c['base0A']!,
    ...Object.fromEntries(ansi.map((color, i) => [`--d-ansi-${i}`, color])),
  };
  return { colors, tokens };
}

/** A base16 or base24 scheme in either YAML layout as a one-look theme. */
export function importBase16Text(text: string, fileName: string): Converted {
  const json = parseYaml(text, fileName);
  const current = isRecord(json['palette']);
  const system = json['system'];
  if (current && system !== undefined && system !== 'base16' && system !== 'base24') {
    const named = typeof system === 'string' ? oneLine(system, MAX_THEME_NAME_CHARS) : undefined;
    throw new SchemeImportError('system', named === undefined
      ? l('{0} is not a base16 scheme.', verbatim(fileName))
      : l('{0} is a {1} scheme; Damocles reads base16 and base24.', verbatim(fileName), verbatim(named)));
  }
  const palette = current ? json['palette'] as Record<string, unknown> : json;
  const base24 = current && system !== undefined ? system === 'base24' : Object.keys(BASE24_FALLBACKS).some((key) => palette[key] !== undefined);
  const colors = colorsOf(palette, base24, fileName);
  const variant = json['variant'];
  const kind: LookKind = variant === 'light' || variant === 'dark' ? variant : kindOfBackground(colors['base00']!);
  const stem = path.basename(fileName).replace(/\.ya?ml$/i, '');
  const named = current ? json['name'] : json['scheme'];
  const name = (typeof named === 'string' ? oneLine(named, MAX_THEME_NAME_CHARS) : undefined) ?? oneLine(stem, MAX_THEME_NAME_CHARS);
  if (name === undefined) throw new SchemeImportError('noName', l('This base16 scheme has no name.'));
  const author = typeof json['author'] === 'string' ? oneLine(json['author'], MAX_THEME_AUTHOR_CHARS) : undefined;
  const description = typeof json['description'] === 'string' ? oneLine(json['description'], MAX_THEME_DESCRIPTION_CHARS) : undefined;
  return {
    theme: {
      schemaVersion: 1,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(author !== undefined ? { author } : {}),
      looks: { [kind]: base16Look(colors, kind, base24) },
    },
    warnings: [],
  };
}
