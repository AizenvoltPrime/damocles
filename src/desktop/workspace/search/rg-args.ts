import type { WalkIgnore } from '../../../core/search-walk';
import { isMultilineRegexSource, MAX_CONTEXT_LINES, type SearchQuery } from '../../../shared/text-search';
import type { SearchRequest } from './search-runner';

// rg's --no-ignore: no ignore file of any kind, above the shown folder or below it, and no global excludes
const NO_IGNORE_FILES: WalkIgnore = { files: false, global: false, parents: false };

export type GlobsResult = { readonly ok: true; readonly globs: string[] } | { readonly ok: false; readonly glob: string };

// A glob reaching outside the shown folder: a '..' segment, a leading slash or backslash (UNC included), or a drive letter,
// in the glob or in any alternative of a brace group.
function escapesFolder(glob: string): boolean {
  const parts = glob.split(/[{,]/).map((part) => part.replace(/}/g, ''));
  return parts.some((part) => /^[\\/]/.test(part) || /^[a-zA-Z]:/.test(part) || part.split(/[\\/]/).includes('..'));
}

/**
 * A "files to include" or "files to exclude" list as ripgrep globs, by VS Code's rules: comma-separated, trailing slashes
 * dropped, `./folder` anchored at the shown folder, `.js` read as `*.js`, any other pattern without a slash matching at any
 * depth, and each pattern matching a folder's contents too. The first glob that reaches outside the shown folder refuses the list.
 */
export function parseGlobList(list: string): GlobsResult {
  const globs: string[] = [];
  for (const raw of splitGlobAware(list)) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (escapesFolder(trimmed)) return { ok: false, glob: trimmed };
    const slashed = trimmed.replace(/\\/g, '/');
    const anchored = slashed.startsWith('./');
    let glob = slashed.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (glob === '' || glob === '.') continue;
    if (!anchored && glob.startsWith('.')) glob = `*${glob}`;
    // ripgrep anchors a glob with a leading '/' at its working directory, as .gitignore does; matchesGlob drops it for picomatch.
    globs.push(...globWithContents(anchored ? `/${glob}` : glob.includes('/') ? glob : `**/${glob}`));
  }
  return { ok: true, globs };
}

// VS Code's splitGlobAware: a comma inside braces or brackets belongs to the glob, as in `*.{ts,js}`. A bracket class is
// literal up to its `]` (a `]` first in the class, after an optional `!` or `^`, is a member), so escapes like `[,]` and `[{]`
// never split or open a brace group.
function splitGlobAware(list: string): string[] {
  const parts: string[] = [];
  let braces = 0;
  let classStart = -1;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (classStart >= 0) {
      if (char === ']' && index > classStart) classStart = -1;
    } else if (char === '[') {
      classStart = list[index + 1] === '!' || list[index + 1] === '^' ? index + 2 : index + 1;
    } else if (char === '{') {
      braces++;
    } else if (char === '}' && braces > 0) {
      braces--;
    } else if (char === ',' && braces === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

// ripgrep matches a folder glob against the folder only, so its files need the `/**` form too.
function globWithContents(glob: string): string[] {
  return glob.endsWith('/**') ? [glob] : [glob, `${glob}/**`];
}

/** The true entries of a glob → boolean exclude setting. */
export function excludeSettingGlobs(setting: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(setting).filter(([, on]) => on === true).map(([glob]) => glob);
}

export interface SearchRequestArgs {
  // the pattern as matchingPattern gives it, case as smart case decided
  readonly query: SearchQuery;
  // parsed include and exclude lists (parseGlobList)
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  // the true entries of files.exclude and search.exclude
  readonly excludeSettings: readonly string[];
  // walkIgnoreOf: the search.use*IgnoreFiles switches
  readonly ignore: WalkIgnore;
  // a Search Editor's context lines, 0..MAX_CONTEXT_LINES
  readonly contextLines: number;
}

/**
 * A content search of the shown folder: rg's matching flags, the pattern, which the engine passes as the value of --regexp
 * (--fixed-strings reads it as a fixed string), and the walk that lists the files rg matches. The exclude settings and ignore
 * files apply only while the query's toggle is on; off, the walk reads no ignore file at all. `.git` is left to the excludes.
 */
export function searchRequest({ query, include, exclude, excludeSettings, ignore, contextLines }: SearchRequestArgs): SearchRequest {
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > MAX_CONTEXT_LINES) throw new Error('Context lines out of range');
  const match = ['--crlf'];
  if (contextLines > 0) match.push('--before-context', String(contextLines), '--after-context', String(contextLines));
  match.push(query.matchCase ? '--case-sensitive' : '--ignore-case');
  if (query.wholeWord) match.push('--word-regexp');
  if (query.isRegex) {
    match.push('--engine', 'auto');
    if (isMultilineRegexSource(query.pattern)) match.push('--multiline');
  } else {
    match.push('--fixed-strings');
  }
  const on = query.useExcludeSettingsAndIgnoreFiles;
  const overrides = [...include, ...exclude.map((glob) => `!${glob}`), ...(on ? excludeSettings.map((glob) => `!${glob}`) : [])];
  return { match, pattern: query.pattern, walk: { ignore: on ? ignore : NO_IGNORE_FILES, overrides } };
}
