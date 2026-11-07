// ExtractTokens (PD-46): the app's design tokens, breakpoints and fonts, read without running repo code. It writes
// tokens.css and the inventory's `tokens` and `breakpoints`, and copies @font-face sources into assets/.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ExtractTokensDetails } from '../../shared/types/design';
import { AssetRefusedError, importAsset } from './assets';
import type { ProjectFiles } from './citations';
import { cssUrls, scanCss, type CssDeclaration } from './css-scan';
import { TOKENS_FILE } from './design-paths';
import { writeTextAtomic } from './design-state';
import { updateInventory, type InventoryBreakpoints } from './inventory';

/** Tailwind's default breakpoints, used when the app imports Tailwind and overrides none. */
export const TAILWIND_DEFAULT_BREAKPOINTS: Readonly<Record<string, number>> = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };
const ROOT_FONT_PX = 16;
export const MAX_TOKEN_FILES = 16;
export const MAX_DECLARED = 512;

export interface DeclaredValue {
  /** A custom property (`--color-brand`) or a breakpoint name (`md`). */
  readonly name: string;
  readonly value: string;
  /** `file:line` whose text holds `value`. */
  readonly cite: string;
}

export interface ExtractTokensInput {
  /** CSS files to scan, relative to the working folder. */
  readonly files: readonly string[];
  /** Tokens the scan cannot read (SCSS, theme files), each cited. */
  readonly declared?: readonly DeclaredValue[];
  /** Breakpoints the scan cannot read (Tailwind 3 `theme.screens`, SCSS maps), each cited. */
  readonly breakpoints?: readonly DeclaredValue[];
}

/** Thrown when ExtractTokens refuses its input; the message lists every problem. */
export class TokensRefusedError extends Error {}

/** A CSS length as px at a 16 px root; undefined for anything else. */
export function lengthPx(value: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?|-?\.\d+)(px|rem|em)?$/i.exec(value.trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  const unit = (match[2] ?? 'px').toLowerCase();
  return unit === 'px' ? number : number * ROOT_FONT_PX;
}

const UNSAFE_VALUE = /[{};<>\\]|\/\*/;
const NAME = /^--[A-Za-z0-9_-]{1,120}$/;
const CLOSING: Readonly<Record<string, string>> = { '(': ')', '[': ']' };

/**
 * Whether tokens.css can hold `value` without it reaching past its own declaration: no brace, `;`, angle bracket, backslash or
 * comment, every quote closed and every bracket closed in order. One unclosed one would make the browser's error recovery
 * swallow every later declaration.
 */
function isSafeValue(value: string): boolean {
  if (UNSAFE_VALUE.test(value)) return false;
  const open: string[] = [];
  let quote = '';
  for (const ch of value) {
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') open.push(CLOSING[ch]!);
    else if ((ch === ')' || ch === ']') && open.pop() !== ch) return false;
  }
  return quote === '' && open.length === 0;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** A token's group: the first word of its name (`--color-primary` is `color`). */
export function tokenGroup(name: string): string {
  const word = name.slice(2).split('-')[0];
  return word === '' || word === undefined ? 'other' : word;
}

async function citeHolds(files: ProjectFiles, declared: DeclaredValue): Promise<string | undefined> {
  const line = await files.lineText(declared.cite);
  if ('reason' in line) return line.reason;
  return line.text.includes(declared.value) ? undefined : `${declared.cite} does not contain ${declared.value}`;
}

/** `url` without its query and fragment. */
function withoutQuery(url: string): string {
  const cut = [url.indexOf('?'), url.indexOf('#')].filter((index) => index !== -1);
  return cut.length === 0 ? url : url.slice(0, Math.min(...cut));
}

function isRemote(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

/** The token names a tokens.css declares, read with the same scan. */
export function tokenNamesOf(tokensCss: string): string[] {
  return [...new Set(scanCss(tokensCss).tokens.map((token) => token.name))];
}

/** Reads the folder's tokens.css token names; none before ExtractTokens ran. */
export async function readTokenNames(folder: string): Promise<string[]> {
  try {
    return tokenNamesOf(await fs.readFile(path.join(folder, TOKENS_FILE), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Reads the folder's tokens.css tokens and their values; none before ExtractTokens ran. */
export async function readTokenValues(folder: string): Promise<Map<string, string>> {
  let css: string;
  try {
    css = await fs.readFile(path.join(folder, TOKENS_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  return new Map(scanCss(css).tokens.map((token) => [token.name, oneLine(token.value)]));
}

/** What ExtractTokens did, and the @font-face sources it could not import, which the model is told about. */
export interface ExtractTokensOutcome {
  readonly details: ExtractTokensDetails;
  readonly skippedFonts: readonly string[];
}

/** Runs ExtractTokens for design folder `folder`. */
export async function extractTokens(input: ExtractTokensInput, files: ProjectFiles, folder: string): Promise<ExtractTokensOutcome> {
  const problems: string[] = [];
  if (input.files.length === 0 && (input.declared ?? []).length === 0 && (input.breakpoints ?? []).length === 0) {
    throw new TokensRefusedError('Name at least one CSS file to scan, or declare tokens or breakpoints with citations.');
  }
  if (input.files.length > MAX_TOKEN_FILES) problems.push(`At most ${MAX_TOKEN_FILES} CSS files are scanned at once`);
  if ((input.declared ?? []).length + (input.breakpoints ?? []).length > MAX_DECLARED) problems.push(`At most ${MAX_DECLARED} values are declared at once`);
  if (problems.length > 0) throw new TokensRefusedError(problems.join('\n'));

  const tokens = new Map<string, string>();
  const breakpointOverrides = new Map<string, number>();
  let breakpointReset = false;
  let tailwind = false;
  const fontFaces: { file: string; declarations: readonly CssDeclaration[]; urls: readonly string[] }[] = [];
  for (const file of input.files) {
    const lines = await files.readLines(file);
    if (typeof lines === 'string') {
      problems.push(lines);
      continue;
    }
    const scan = scanCss(lines.join('\n'));
    tailwind ||= scan.tailwind;
    for (const token of scan.tokens) {
      if (token.name === '--breakpoint-*') {
        if (token.value.trim() === 'initial') breakpointReset = true;
        continue;
      }
      if (token.name.startsWith('--breakpoint-')) {
        const px = lengthPx(token.value);
        if (px === undefined || px <= 0) problems.push(`${file}:${token.line}: ${token.name} is ${token.value}, not a px, rem or em width`);
        else breakpointOverrides.set(token.name.slice('--breakpoint-'.length), px);
        continue;
      }
      if (NAME.test(token.name) && isSafeValue(token.value)) tokens.set(token.name, oneLine(token.value));
    }
    for (const face of scan.fontFaces) fontFaces.push({ file, declarations: face.declarations, urls: face.urls });
  }

  for (const declared of input.declared ?? []) {
    if (!NAME.test(declared.name)) problems.push(`${declared.name} is not a custom property name`);
    else if (!isSafeValue(declared.value) || declared.value.trim() === '') problems.push(`${declared.name}: ${JSON.stringify(declared.value)} is not a value tokens.css can hold`);
    else {
      const broken = await citeHolds(files, declared);
      if (broken) problems.push(broken);
      else tokens.set(declared.name, oneLine(declared.value));
    }
  }
  const declaredBreakpoints = new Map<string, number>();
  for (const declared of input.breakpoints ?? []) {
    const px = lengthPx(declared.value);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(declared.name)) problems.push(`${declared.name} is not a breakpoint name`);
    else if (px === undefined || px <= 0) problems.push(`${declared.name}: ${declared.value} is not a px, rem or em width`);
    else {
      const broken = await citeHolds(files, declared);
      if (broken) problems.push(broken);
      else declaredBreakpoints.set(declared.name, px);
    }
  }
  if (problems.length > 0) throw new TokensRefusedError(problems.join('\n'));

  const breakpoints = breakpointsOf(input.files, tailwind, breakpointReset, breakpointOverrides, declaredBreakpoints);

  const fonts: string[] = [];
  const skippedFonts: string[] = [];
  const faces: string[] = [];
  for (const face of fontFaces) {
    const rewritten = new Map<string, string>();
    for (const url of face.urls) {
      if (isRemote(url)) {
        skippedFonts.push(`${face.file}: ${url} is not a project file`);
        continue;
      }
      const source = path.posix.normalize(path.posix.join(path.posix.dirname(face.file.replace(/\\/g, '/')), withoutQuery(url)));
      try {
        const imported = await importAsset(files, source, folder);
        rewritten.set(url, imported.asset);
        if (!fonts.includes(imported.asset)) fonts.push(imported.asset);
      } catch (err) {
        if (!(err instanceof AssetRefusedError)) throw err;
        skippedFonts.push(`${face.file}: ${url}: ${err.message}`);
      }
    }
    const body = face.declarations
      .map((declaration) => {
        if (declaration.name.toLowerCase() !== 'src') return `  ${declaration.name}: ${oneLine(declaration.value)};`;
        const kept = cssUrls(declaration.value).filter((url) => rewritten.has(url)).map((url) => `url("${rewritten.get(url)!}")`);
        return kept.length > 0 ? `  src: ${kept.join(', ')};` : '';
      })
      .filter((line) => line !== '' && isSafeValue(line.slice(0, -1)));
    if (body.some((line) => line.startsWith('  src:'))) faces.push(`@font-face {\n${body.join('\n')}\n}`);
  }

  const names = [...tokens.keys()].sort();
  const groups: Record<string, number> = {};
  for (const name of names) groups[tokenGroup(name)] = (groups[tokenGroup(name)] ?? 0) + 1;
  const sources = [...input.files, ...(input.declared ?? []).map((d) => d.cite)];
  const css = [
    `/* Generated by Damocles ExtractTokens from ${sources.length > 0 ? sources.join(', ').replace(/\*\//g, '* /') : 'declared values'}. Edits here are overwritten. */`,
    ...faces,
    `:root {\n${names.map((name) => `  ${name}: ${tokens.get(name)!};`).join('\n')}\n}`,
    '',
  ].join('\n\n');
  await writeTextAtomic(path.join(folder, TOKENS_FILE), css);
  await updateInventory(folder, (current) => ({
    ...current,
    tokens: { source: sources.join(', '), extractor: 'damocles-css-scan', count: names.length, groups },
    breakpoints,
  }));
  return { details: { count: names.length, groups, breakpoints: { source: breakpoints.source, values: { ...breakpoints.values } }, fonts }, skippedFonts };
}

function breakpointsOf(
  files: readonly string[],
  tailwind: boolean,
  reset: boolean,
  overrides: ReadonlyMap<string, number>,
  declared: ReadonlyMap<string, number>,
): InventoryBreakpoints {
  const values: Record<string, number> = {};
  const sources: string[] = [];
  if (tailwind && !reset) {
    Object.assign(values, TAILWIND_DEFAULT_BREAKPOINTS);
    sources.push(overrides.size > 0 ? 'Tailwind defaults with --breakpoint-* overrides' : 'Tailwind defaults');
  } else if (overrides.size > 0) {
    sources.push('--breakpoint-* custom properties');
  }
  for (const [name, px] of overrides) values[name] = px;
  if (declared.size > 0) sources.push('declared with citations');
  for (const [name, px] of declared) values[name] = px;
  if (Object.keys(values).length === 0) {
    return { source: 'None found or declared: one band, with the presets base and primary', values: {} };
  }
  const sorted = Object.fromEntries(Object.entries(values).sort((a, b) => a[1] - b[1]));
  return { source: `${sources.join('; ')} (${files.join(', ') || 'declared'})`, values: sorted };
}
