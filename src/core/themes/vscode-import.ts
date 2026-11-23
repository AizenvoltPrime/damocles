// VS Code color themes as Damocles themes (docs/themes.md "Importing VS Code themes"): a .json or JSONC theme file, or the themes a
// .vsix contributes with their `include` chains inside it. Pure: it reads no file, and the caller assigns the id and the origin.
import * as path from 'node:path';
// The ESM build: the package's main is a UMD wrapper whose dynamic requires a bundle cannot follow.
import { createScanner, parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { formatHex, parseHex, type Rgba } from '../../shared/themes/color';
import { kindOfBackground } from '../../shared/themes/contrast';
import { MAX_THEME_AUTHOR_CHARS, MAX_THEME_DESCRIPTION_CHARS, MAX_THEME_LICENSE_CHARS, MAX_THEME_NAME_CHARS, MAX_THEME_VERSION_CHARS } from '../../shared/themes/limits';
import type { Look, LookColors } from '../../shared/themes/schema';
import { opaqueOver } from '../../shared/themes/schemes';
import { SEMANTIC_SCOPES, SYNTAX_SCOPES, type SyntaxToken } from '../../shared/themes/syntax-scopes';
import { ANSI_TOKENS, SYNTAX_TOKENS, type LookKind, type TokenName } from '../../shared/themes/tokens';
import { oneLine } from '../pi-session/untrusted-text';
import { l, verbatim } from '../l10n';
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_UNCOMPRESSED_BYTES, MAX_ENTRY_RATIO, type ArchiveLimits, type ZipReader } from './archive';

// A theme file or a .vsix's package.json is text; anything larger is refused before it parses.
export const MAX_VSCODE_THEME_BYTES: number = 4 * 1024 * 1024;
// A .vsix may carry a whole extension, so it may hold more entries than a theme file.
export const MAX_VSIX_ENTRIES = 8192;
export const MAX_INCLUDE_DEPTH = 16;
// The themes a warning names; a .vsix may list thousands.
const MAX_LISTED = 10;
// Objects and arrays nested deeper than this are refused before the text parses; a VS Code theme nests about 4 deep.
export const MAX_JSON_DEPTH = 64;
export const VSIX_LIMITS: ArchiveLimits = { archiveBytes: MAX_ARCHIVE_BYTES, uncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES, entries: MAX_VSIX_ENTRIES, ratio: MAX_ENTRY_RATIO };
const VSIX_ROOT = 'extension';

export type VscodeRefusal = 'notJson' | 'escape' | 'cycle' | 'depth' | 'missing' | 'include' | 'tmTheme' | 'noThemes' | 'noName' | 'notTheme';

export class VscodeImportError extends LocalizedError {
  readonly reason: VscodeRefusal;

  constructor(reason: VscodeRefusal, text: LocalizedText) {
    super(text);
    this.name = 'VscodeImportError';
    this.reason = reason;
  }
}

/** A theme without its id and origin, which the caller gives it, and what the card warns about. */
export interface VscodeImport {
  readonly theme: Readonly<Record<string, unknown>>;
  readonly warnings: readonly LocalizedText[];
}

// uiTheme in a .vsix's contributes.themes, or `type` in a theme file
type UiTheme = 'vs-dark' | 'vs' | 'hc-black' | 'hc-light';

interface Base {
  readonly kind: LookKind;
  readonly colors: LookColors;
  readonly syntax: Readonly<Record<SyntaxToken, string>>;
}

// VS Code's own defaults of each base theme (Dark+, Light+, Dark High Contrast, Light High Contrast) for the workbench colors the
// seeds read and the syntax scopes, for what a theme leaves out.
const BASES: Readonly<Record<UiTheme, Base>> = {
  'vs-dark': {
    kind: 'dark',
    colors: { background: '#1e1e1e', panel: '#252526', text: '#cccccc', accent: '#3794ff', success: '#0dbc79', warning: '#cca700', danger: '#f48771', info: '#3794ff' },
    syntax: { '--s-kw': '#569cd6', '--s-str': '#ce9178', '--s-num': '#b5cea8', '--s-com': '#6a9955', '--s-fn': '#dcdcaa', '--s-type': '#4ec9b0' },
  },
  vs: {
    kind: 'light',
    colors: { background: '#ffffff', panel: '#f3f3f3', text: '#616161', accent: '#006ab1', success: '#00bc00', warning: '#bf8803', danger: '#a1260d', info: '#1a85ff' },
    syntax: { '--s-kw': '#0000ff', '--s-str': '#a31515', '--s-num': '#098658', '--s-com': '#008000', '--s-fn': '#795e26', '--s-type': '#267f99' },
  },
  'hc-black': {
    kind: 'dark',
    colors: { background: '#000000', panel: '#000000', text: '#ffffff', accent: '#21a6ff', success: '#00cd00', warning: '#ffd700', danger: '#f48771', info: '#3794ff' },
    syntax: { '--s-kw': '#569cd6', '--s-str': '#ce9178', '--s-num': '#b5cea8', '--s-com': '#7ca668', '--s-fn': '#dcdcaa', '--s-type': '#4ec9b0' },
  },
  'hc-light': {
    kind: 'light',
    colors: { background: '#ffffff', panel: '#ffffff', text: '#292929', accent: '#0f4a85', success: '#007100', warning: '#895503', danger: '#b5200d', info: '#0f4a85' },
    syntax: { '--s-kw': '#0f4a85', '--s-str': '#0f4a85', '--s-num': '#096d48', '--s-com': '#515151', '--s-fn': '#5e2cbc', '--s-type': '#185e73' },
  },
};

// The workbench colors each seed reads, first found wins. Must match src/webview/styles/tokens.css, which reads these colors into
// the --d-* tokens in VS Code, so a theme looks in Damocles as Damocles looks under it (vscode-import.test.ts).
export const VSCODE_SEED_KEYS: Readonly<Record<keyof LookColors, readonly string[]>> = {
  background: ['editor.background'],
  panel: ['sideBar.background', 'editor.background'],
  text: ['foreground'],
  accent: ['textLink.foreground'],
  success: ['terminal.ansiGreen'],
  warning: ['editorWarning.foreground'],
  danger: ['errorForeground'],
  info: ['editorInfo.foreground'],
};

// The rest of tokens.css's pairs, as token overrides of the look; --d-on-accent is left to the derivation, which keeps it at AA.
export const VSCODE_TOKEN_KEYS: Readonly<Partial<Record<TokenName, readonly string[]>>> = {
  '--d-card': ['editorWidget.background'],
  '--d-hover': ['list.hoverBackground'],
  '--d-border': ['panel.border', 'widget.border'],
  '--d-border2': ['widget.border', 'editorWidget.border', 'panel.border'],
  '--d-muted': ['descriptionForeground'],
  '--d-faint': ['editorLineNumber.foreground'],
  '--d-design': ['charts.purple'],
  '--d-code': ['textCodeBlock.background', 'editorWidget.background'],
  '--d-input': ['input.background'],
  '--d-add': ['diffEditor.insertedTextBackground'],
  '--d-del': ['diffEditor.removedTextBackground'],
};

// terminal.ansi* in --d-ansi-0..15 order
const ANSI_COLORS = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
const ANSI_KEYS = [...ANSI_COLORS.map((color) => `terminal.ansi${color}`), ...ANSI_COLORS.map((color) => `terminal.ansiBright${color}`)];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A VS Code color (#rgb, #rgba, #rrggbb, #rrggbbaa) as lowercase #rrggbb or #rrggbbaa; undefined for anything else. */
function colorOf(value: unknown): Rgba | undefined {
  if (typeof value !== 'string') return undefined;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(value);
  return parseHex(short ? `#${short[1]!.repeat(2)}${short[2]!.repeat(2)}${short[3]!.repeat(2)}${short[4] !== undefined ? short[4].repeat(2) : ''}` : value);
}

/** A VS Code color as Damocles' opaque lowercase hex, a translucent one painted over `under`. */
const opaque = (value: unknown, under: string): string | undefined => opaqueOver(colorOf(value), under);

interface TokenRule {
  readonly selectors: readonly string[];
  readonly foreground: unknown;
}

/** The tokenColors rules with a foreground; a descendant selector ("source.js keyword") is language-specific and left out. */
function tokenRules(tokenColors: unknown): TokenRule[] {
  if (!Array.isArray(tokenColors)) return [];
  return tokenColors.flatMap((rule): TokenRule[] => {
    if (!isRecord(rule) || !isRecord(rule['settings']) || rule['settings']['foreground'] === undefined) return [];
    const scope = rule['scope'];
    const selectors = (Array.isArray(scope) ? scope : typeof scope === 'string' ? scope.split(',') : [])
      .filter((selector): selector is string => typeof selector === 'string')
      .map((selector) => selector.trim())
      .filter((selector) => selector !== '' && !selector.includes(' '));
    return selectors.length > 0 ? [{ selectors, foreground: rule['settings']['foreground'] }] : [];
  });
}

/** The foreground TextMate gives `scope`: the rule with the longest matching selector, the later rule on a tie. */
function scopeColor(rules: readonly TokenRule[], scope: string): unknown {
  let best: { readonly length: number; readonly color: unknown } | undefined;
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (selector !== scope && !scope.startsWith(`${selector}.`)) continue;
      if (!best || selector.length >= best.length) best = { length: selector.length, color: rule.foreground };
    }
  }
  return best?.color;
}

function semanticColor(semantic: unknown, types: readonly string[]): unknown {
  if (!isRecord(semantic)) return undefined;
  for (const type of types) {
    const value = semantic[type];
    if (typeof value === 'string') return value;
    if (isRecord(value) && value['foreground'] !== undefined) return value['foreground'];
  }
  return undefined;
}

/** The theme's syntax colors as the six --s-* tokens: semanticTokenColors first, then tokenColors, then the base's. */
export function syntaxTokens(theme: { readonly tokenColors?: unknown; readonly semanticTokenColors?: unknown }, base: Base, background: string): Record<SyntaxToken, string> {
  const rules = tokenRules(theme.tokenColors);
  return Object.fromEntries(SYNTAX_TOKENS.map((token) => {
    const semantic = opaque(semanticColor(theme.semanticTokenColors, SEMANTIC_SCOPES[token]), background);
    if (semantic !== undefined) return [token, semantic];
    for (const scope of SYNTAX_SCOPES[token]) {
      const color = opaque(scopeColor(rules, scope), background);
      if (color !== undefined) return [token, color];
    }
    return [token, base.syntax[token]];
  })) as Record<SyntaxToken, string>;
}

/** The merged theme JSON after its include chain: the included first, the including file's colors and rules over them. */
interface MergedTheme {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly colors: Record<string, unknown>;
  readonly tokenColors: unknown[];
  readonly semanticTokenColors: Record<string, unknown>;
  readonly tmTheme: boolean;
}

// jsonc-parser's scanner token kinds (its SyntaxKind): the four brackets and the end of the text.
const OPEN_BRACE = 1;
const CLOSE_BRACE = 2;
const OPEN_BRACKET = 3;
const CLOSE_BRACKET = 4;
const STRING_LITERAL = 10;
const NUMBER_LITERAL = 11;
const END_OF_TEXT = 17;

/** Whether `text`, past whitespace and comments, opens an object or an array of JSON values; an INI group such as [ColorScheme] opens with a bracket too. */
export function opensJson(text: string): boolean {
  const scanner = createScanner(text, true);
  const first = scanner.scan();
  if (first !== OPEN_BRACKET) return first === OPEN_BRACE;
  return [OPEN_BRACE, OPEN_BRACKET, CLOSE_BRACKET, STRING_LITERAL, NUMBER_LITERAL].includes(scanner.scan());
}

/** Whether `text` opens more than MAX_JSON_DEPTH objects and arrays inside each other. A flat scan: a closer that does not match the innermost opener closes nothing. */
function nestsTooDeep(text: string): boolean {
  const scanner = createScanner(text, true);
  const closers: number[] = [];
  for (let kind: number = scanner.scan(); kind !== END_OF_TEXT; kind = scanner.scan()) {
    if (kind === OPEN_BRACE || kind === OPEN_BRACKET) {
      closers.push(kind === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET);
      if (closers.length > MAX_JSON_DEPTH) return true;
    } else if (kind === closers.at(-1)) {
      closers.pop();
    }
  }
  return false;
}

function parseThemeText(text: string, file: string): Record<string, unknown> {
  // the parser recurses once per level, so the depth is bounded before it runs
  if (nestsTooDeep(text)) throw new VscodeImportError('notJson', l('{0} is not a VS Code theme: it nests more than {1} levels deep.', verbatim(file), String(MAX_JSON_DEPTH)));
  const errors: ParseError[] = [];
  const json: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isRecord(json)) {
    const first = errors[0];
    throw new VscodeImportError('notJson', first ? l('{0} is not a VS Code theme: {1} at offset {2}.', verbatim(file), printParseErrorCode(first.error), String(first.offset)) : l('{0} is not a VS Code theme.', verbatim(file)));
  }
  return json;
}

function merge(base: MergedTheme | undefined, own: Record<string, unknown>): MergedTheme {
  const tokenColors = Array.isArray(own['tokenColors']) ? own['tokenColors'] : [];
  return {
    name: own['name'] ?? base?.name,
    type: own['type'] ?? base?.type,
    colors: { ...(base?.colors ?? {}), ...(isRecord(own['colors']) ? own['colors'] : {}) },
    tokenColors: [...(base?.tokenColors ?? []), ...tokenColors],
    semanticTokenColors: { ...(base?.semanticTokenColors ?? {}), ...(isRecord(own['semanticTokenColors']) ? own['semanticTokenColors'] : {}) },
    tmTheme: (base?.tmTheme ?? false) || typeof own['tokenColors'] === 'string',
  };
}

const decode = (bytes: Uint8Array, file: string): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new VscodeImportError('notJson', l('{0} is not UTF-8 text.', verbatim(file)));
  }
};

/** A path a .vsix names, resolved against `dir` inside its extension folder; refused when it leaves that folder. */
export function vsixPath(dir: string, relative: string): string {
  const posix = relative.replace(/\\/g, '/');
  const resolved = path.posix.normalize(path.posix.join(dir, posix));
  if (posix.includes('\0') || posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || !resolved.startsWith(`${VSIX_ROOT}/`)) {
    throw new VscodeImportError('escape', l('This .vsix names {0}, which is outside the extension.', verbatim(relative.slice(0, 200))));
  }
  return resolved;
}

/** A theme file inside a .vsix with its include chain followed inside the .vsix; a cycle or a path leaving it is refused. */
async function vsixTheme(zip: ZipReader, file: string, chain: readonly string[] = []): Promise<MergedTheme> {
  if (chain.includes(file)) throw new VscodeImportError('cycle', l('This .vsix theme includes itself through {0}.', verbatim(file)));
  if (chain.length >= MAX_INCLUDE_DEPTH) throw new VscodeImportError('depth', l('The includes of this .vsix theme are nested more than {0} files deep.', String(MAX_INCLUDE_DEPTH)));
  if (/\.tmtheme$/i.test(file)) throw new VscodeImportError('tmTheme', l('{0} is a TextMate .tmTheme file, which Damocles does not import.', verbatim(file)));
  const bytes = await zip.read(file, MAX_VSCODE_THEME_BYTES);
  if (bytes === undefined) throw new VscodeImportError('missing', l('This .vsix names {0}, which it does not hold.', verbatim(file)));
  const own = parseThemeText(decode(bytes, file), file);
  const include = own['include'];
  const base = typeof include === 'string' ? await vsixTheme(zip, vsixPath(path.posix.dirname(file), include), [...chain, file]) : undefined;
  return merge(base, own);
}

/** The base a manifest's uiTheme or a theme file's type names; undefined for any other value. */
function namedUiTheme(value: unknown): UiTheme | undefined {
  if (value === 'vs-dark' || value === 'dark') return 'vs-dark';
  if (value === 'vs' || value === 'light') return 'vs';
  if (value === 'hc-black' || value === 'hc') return 'hc-black';
  if (value === 'hc-light' || value === 'hcLight') return 'hc-light';
  return undefined;
}

function uiThemeOf(value: unknown, colors: Record<string, unknown>): UiTheme {
  const named = namedUiTheme(value);
  if (named !== undefined) return named;
  const background = opaque(colors['editor.background'], '#000000');
  return background !== undefined && kindOfBackground(background) === 'light' ? 'vs' : 'vs-dark';
}

/** One look from a merged theme, every seed and syntax color it leaves out taken from its base. */
function lookOf(theme: MergedTheme, uiTheme: UiTheme, label: string, warnings: LocalizedText[]): { readonly kind: LookKind; readonly look: Look } {
  const base = BASES[uiTheme];
  const background = opaque(theme.colors['editor.background'], base.colors.background) ?? base.colors.background;
  const colors = Object.fromEntries(Object.entries(VSCODE_SEED_KEYS).map(([seed, keys]) => {
    if (seed === 'background') return [seed, background];
    const found = keys.map((key) => opaque(theme.colors[key], background)).find((value) => value !== undefined);
    return [seed, found ?? base.colors[seed as keyof LookColors]];
  })) as unknown as LookColors;
  const tokens: Partial<Record<TokenName, string>> = { ...syntaxTokens(theme, base, background) };
  for (const [token, keys] of Object.entries(VSCODE_TOKEN_KEYS) as [TokenName, readonly string[]][]) {
    const found = keys.map((key) => colorOf(theme.colors[key])).find((value) => value !== undefined);
    if (found) tokens[token] = formatHex(found);
  }
  ANSI_KEYS.forEach((key, i) => {
    const value = opaque(theme.colors[key], background);
    if (value !== undefined) tokens[ANSI_TOKENS[i]!] = value;
  });
  if (theme.tmTheme) warnings.push(l('{0} keeps its syntax colors in a .tmTheme file, which Damocles does not read; they come from VS Code\'s defaults.', verbatim(label)));
  if (uiTheme === 'hc-black') warnings.push(l('{0} is a high contrast theme. Damocles has no high contrast looks, so it becomes a dark look; Windows contrast themes keep high contrast everywhere.', verbatim(label)));
  if (uiTheme === 'hc-light') warnings.push(l('{0} is a high contrast theme. Damocles has no high contrast looks, so it becomes a light look; Windows contrast themes keep high contrast everywhere.', verbatim(label)));
  return { kind: base.kind, look: { colors, tokens } };
}

const cleanName = (value: unknown): string | undefined => (typeof value === 'string' ? oneLine(value, MAX_THEME_NAME_CHARS) : undefined);
const SPDX = /^(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.+-]*)$/;

/** A .json or JSONC VS Code theme file; one that names `include` is refused, since its files are outside what was picked. */
export function importVscodeThemeText(text: string, fileName: string): VscodeImport {
  const json = parseThemeText(text, fileName);
  if (json['include'] !== undefined) throw new VscodeImportError('include', l('{0} includes another file. Damocles follows include only inside a .vsix; import the .vsix instead.', verbatim(fileName)));
  if (json['colors'] === undefined && json['tokenColors'] === undefined && json['semanticTokenColors'] === undefined) {
    throw new VscodeImportError('notTheme', l('{0} has no colors, tokenColors or semanticTokenColors, so it is not a VS Code color theme.', verbatim(fileName)));
  }
  const merged = merge(undefined, json);
  const name = cleanName(merged.name) ?? cleanName(path.basename(fileName).replace(/\.(?:jsonc?|json5)$/i, ''));
  if (name === undefined) throw new VscodeImportError('noName', l('This VS Code theme has no name.'));
  const warnings: LocalizedText[] = [];
  const { kind, look } = lookOf(merged, uiThemeOf(merged.type, merged.colors), name, warnings);
  return { theme: { schemaVersion: 1, name, looks: { [kind]: look } }, warnings };
}

/**
 * The color themes a .vsix contributes: its first dark theme and its first light one become the looks of one theme (a high
 * contrast theme counts as its nearest kind). A theme is read only while its kind is still open, so the others are named in a
 * warning unread, and one that cannot be read is left out with a warning unless no theme converts.
 */
export async function importVsix(zip: ZipReader): Promise<VscodeImport> {
  const manifestFile = `${VSIX_ROOT}/package.json`;
  const manifestBytes = await zip.read(manifestFile, MAX_VSCODE_THEME_BYTES);
  if (manifestBytes === undefined) throw new VscodeImportError('noThemes', l('This .vsix holds no extension/package.json, so it is not a VS Code extension.'));
  const manifest = parseThemeText(decode(manifestBytes, manifestFile), manifestFile);
  const contributes = isRecord(manifest['contributes']) ? manifest['contributes'] : {};
  const listed = Array.isArray(contributes['themes']) ? contributes['themes'].filter(isRecord) : [];
  if (listed.length === 0) throw new VscodeImportError('noThemes', l('This .vsix contributes no color theme.'));
  const warnings: LocalizedText[] = [];
  const looks: Partial<Record<LookKind, Look>> = {};
  const labels: string[] = [];
  const skipped: string[] = [];
  const unread: Array<{ readonly label: string; readonly error: VscodeImportError }> = [];
  for (const entry of listed) {
    const named = entry['path'];
    if (typeof named !== 'string') continue;
    const listedAs = cleanName(entry['label']) ?? cleanName(path.posix.basename(named.replace(/\\/g, '/'))) ?? '?';
    const declared = namedUiTheme(entry['uiTheme']);
    if ((looks.dark !== undefined && looks.light !== undefined) || (declared !== undefined && looks[BASES[declared].kind] !== undefined)) {
      skipped.push(listedAs);
      continue;
    }
    let theme: MergedTheme;
    try {
      theme = await vsixTheme(zip, vsixPath(VSIX_ROOT, named));
    } catch (err) {
      if (!(err instanceof VscodeImportError)) throw err;
      unread.push({ label: listedAs, error: err });
      continue;
    }
    const label = cleanName(entry['label']) ?? cleanName(theme.name) ?? listedAs;
    const uiTheme = declared ?? uiThemeOf(theme.type, theme.colors);
    if (looks[BASES[uiTheme].kind] !== undefined) {
      skipped.push(label);
      continue;
    }
    const { kind, look } = lookOf(theme, uiTheme, label, warnings);
    looks[kind] = look;
    labels.push(label);
  }
  if (labels.length === 0) throw unread[0]?.error ?? new VscodeImportError('noThemes', l('This .vsix contributes no color theme.'));
  for (const { label, error } of unread.slice(0, MAX_LISTED)) warnings.push(l('The theme {0} in this .vsix was left out: {1}', verbatim(label), error.text));
  if (skipped.length > 0) warnings.push(l('This .vsix has more themes than a dark and a light look; these were left out: {0}', verbatim(skipped.slice(0, MAX_LISTED).join(', ') + (skipped.length > MAX_LISTED ? ', ...' : ''))));
  const name = (labels.length === 1 ? labels[0] : cleanName(manifest['displayName'])) ?? labels[0]!;
  const description = typeof manifest['description'] === 'string' ? oneLine(manifest['description'], MAX_THEME_DESCRIPTION_CHARS) : undefined;
  const author = typeof manifest['publisher'] === 'string' ? oneLine(manifest['publisher'], MAX_THEME_AUTHOR_CHARS) : undefined;
  const version = typeof manifest['version'] === 'string' ? oneLine(manifest['version'], MAX_THEME_VERSION_CHARS) : undefined;
  const license = typeof manifest['license'] === 'string' && SPDX.test(manifest['license']) && manifest['license'].length <= MAX_THEME_LICENSE_CHARS ? manifest['license'] : undefined;
  return {
    theme: {
      schemaVersion: 1,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? { license } : {}),
      looks,
    },
    warnings,
  };
}
