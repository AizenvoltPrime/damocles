/**
 * ripgrep 15's ignore rules, ported from its `ignore` and `globset` crates (docs/invariants.md "Tool overrides"): a gitignore
 * line becomes a glob as `GitignoreBuilder::add_line` makes it, and a glob a regular expression as globset's parser builds it,
 * matched against a path's UTF-8 bytes. A path is relative to the rules' folder, `/`-separated, with no leading `./`.
 */

/** Whether a set of rules ignores a path, lets it through over lower rules (`!`), or says nothing about it. */
export type IgnoreMatch = 'ignore' | 'whitelist' | undefined;

interface IgnoreGlob {
  readonly whitelist: boolean;
  readonly onlyDir: boolean;
  readonly regex: RegExp;
}

/** The globs of one ignore file or one set of `--glob` overrides, in file order. */
export interface IgnoreRules {
  readonly globs: readonly IgnoreGlob[];
}

export const NO_RULES: IgnoreRules = { globs: [] };

/** A glob globset refuses; a gitignore file skips the line, an rg `--glob` fails the search. */
export class GlobSyntaxError extends Error {
  constructor(glob: string, reason: string) {
    super(`error parsing glob '${glob}': ${reason}`);
  }
}

type Token =
  | { readonly kind: 'literal'; readonly char: string }
  | { readonly kind: 'any' | 'zeroOrMore' | 'recursivePrefix' | 'recursiveSuffix' | 'recursiveZeroOrMore' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: Array<[string, string]> }
  | { readonly kind: 'alternates'; readonly branches: Token[][] };

const UNOPENED = 'unopened alternate group; missing \'{\' (maybe escape \'}\' with \'[}]\'?)';

// std::path::is_separator: on Windows `\` separates too, which globset's `**` detection reads.
const isSeparator = (char: string | undefined): boolean => char === '/' || (process.platform === 'win32' && char === '\\');

/** globset's `Parser` with literal_separator and backslash_escape on; allowUnclosedClass is GitignoreBuilder's default. */
function parseGlob(glob: string, allowUnclosedClass: boolean, original: string): Token[] {
  const chars = [...glob];
  let index = 0;
  let prev: string | undefined;
  let cur: string | undefined;
  let foundUnclosedClass = false;
  const alternatesStack: number[] = [];
  const branches: Token[][] = [[]];
  const bump = (): string | undefined => {
    prev = cur;
    cur = chars[index++];
    return cur;
  };
  const peek = (): string | undefined => chars[index];
  const last = (): Token[] => {
    const branch = branches[branches.length - 1];
    if (branch === undefined) throw new GlobSyntaxError(original, UNOPENED);
    return branch;
  };
  const push = (token: Token): void => {
    last().push(token);
  };
  const parseStar = (): void => {
    const before = prev;
    if (peek() !== '*') return push({ kind: 'zeroOrMore' });
    bump();
    if (last().length === 0) {
      if (peek() !== undefined && !isSeparator(peek())) {
        push({ kind: 'zeroOrMore' });
        return push({ kind: 'zeroOrMore' });
      }
      push({ kind: 'recursivePrefix' });
      bump();
      return;
    }
    if (!isSeparator(before) && (branches.length <= 1 || (before !== ',' && before !== '{'))) {
      push({ kind: 'zeroOrMore' });
      return push({ kind: 'zeroOrMore' });
    }
    let isSuffix: boolean;
    const next = peek();
    if (next === undefined) {
      bump();
      isSuffix = true;
    } else if ((next === ',' || next === '}') && branches.length >= 2) {
      isSuffix = true;
    } else if (isSeparator(next)) {
      bump();
      isSuffix = false;
    } else {
      push({ kind: 'zeroOrMore' });
      return push({ kind: 'zeroOrMore' });
    }
    const popped = last().pop()!;
    if (popped.kind === 'recursivePrefix' || popped.kind === 'recursiveSuffix') return push(popped);
    push({ kind: isSuffix ? 'recursiveSuffix' : 'recursiveZeroOrMore' });
  };
  const parseClass = (): void => {
    const saved = { index, prev, cur };
    const ranges: Array<[string, string]> = [];
    const extend = (range: [string, string], to: string): void => {
      range[1] = to;
      if (range[1].codePointAt(0)! < range[0].codePointAt(0)!) throw new GlobSyntaxError(original, `invalid range; '${range[0]}' > '${range[1]}'`);
    };
    let negated = false;
    if (peek() === '!' || peek() === '^') {
      bump();
      negated = true;
    }
    let first = true;
    let inRange = false;
    for (;;) {
      const char = bump();
      if (char === undefined) {
        if (!allowUnclosedClass) throw new GlobSyntaxError(original, 'unclosed character class; missing \']\'');
        ({ index, prev, cur } = saved);
        foundUnclosedClass = true;
        return push({ kind: 'literal', char: '[' });
      }
      if (char === ']') {
        if (!first) break;
        ranges.push([']', ']']);
      } else if (char === '-') {
        if (first) ranges.push(['-', '-']);
        else if (inRange) {
          extend(ranges[ranges.length - 1]!, '-');
          inRange = false;
        } else inRange = true;
      } else {
        if (inRange) extend(ranges[ranges.length - 1]!, char);
        else ranges.push([char, char]);
        inRange = false;
      }
      first = false;
    }
    if (inRange) ranges.push(['-', '-']);
    push({ kind: 'class', negated, ranges });
  };
  for (let char = bump(); char !== undefined; char = bump()) {
    if (char === '?') push({ kind: 'any' });
    else if (char === '*') parseStar();
    else if (char === '[' && !foundUnclosedClass) parseClass();
    else if (char === '{') {
      alternatesStack.push(branches.length);
      branches.push([]);
    } else if (char === '}') {
      const start = alternatesStack.pop();
      if (start === undefined) throw new GlobSyntaxError(original, UNOPENED);
      push({ kind: 'alternates', branches: branches.splice(start) });
    } else if (char === ',') {
      if (alternatesStack.length === 0) push({ kind: 'literal', char });
      else branches.push([]);
    } else if (char === '\\') {
      const escaped = bump();
      if (escaped === undefined) throw new GlobSyntaxError(original, 'dangling \'\\\'');
      push({ kind: 'literal', char: escaped });
    } else push({ kind: 'literal', char });
  }
  if (branches.length > 1) throw new GlobSyntaxError(original, 'unclosed alternate group; missing \'}\' (maybe escape \'{\' with \'[{]\'?)');
  return branches[0]!;
}

// A character as its UTF-8 bytes, each escaped, since the regex runs over a path's bytes (globset's `(?-u)` regex).
const byteLiteral = (char: string): string => [...Buffer.from(char, 'utf8')].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('');

// globset's `Tokens::tokens_to_regex`; Rust's `.` is every byte but `\n`.
function tokensToRegex(tokens: readonly Token[]): string {
  let regex = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'literal': regex += byteLiteral(token.char); break;
      case 'any': regex += '[^/]'; break;
      case 'zeroOrMore': regex += '[^/]*'; break;
      case 'recursivePrefix': regex += '(?:/?|[^\\n]*/)'; break;
      case 'recursiveSuffix': regex += '/[^\\n]*'; break;
      case 'recursiveZeroOrMore': regex += '(?:/|/[^\\n]*/)'; break;
      case 'class':
        regex += `[${token.negated ? '^' : ''}${token.ranges.map(([from, to]) => (from === to ? byteLiteral(from) : `${byteLiteral(from)}-${byteLiteral(to)}`)).join('')}]`;
        break;
      case 'alternates': {
        const parts = token.branches.map(tokensToRegex).filter((part) => part !== '');
        if (parts.length > 0) regex += `(?:${parts.join('|')})`;
        break;
      }
    }
  }
  return regex;
}

function globRegex(glob: string, allowUnclosedClass: boolean, original: string): RegExp {
  const tokens = parseGlob(glob, allowUnclosedClass, original);
  // globset matches everything for a lone `**`
  if (tokens.length === 1 && tokens[0]!.kind === 'recursivePrefix') return /^[^\n]*$/;
  return new RegExp(`^${tokensToRegex(tokens)}$`);
}

// Rust's `str::trim_end`: Unicode White_Space, which differs from JavaScript's trimEnd at U+0085 and U+FEFF.
const TRAILING_WHITE_SPACE = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/u;

/** `GitignoreBuilder::add_line`: the glob of one line, or undefined for a blank line or a comment. */
function ignoreGlobOf(text: string, allowUnclosedClass: boolean): IgnoreGlob | undefined {
  if (text.startsWith('#')) return undefined;
  let line = text.endsWith('\\ ') ? text : text.replace(TRAILING_WHITE_SPACE, '');
  if (line === '') return undefined;
  // a glob globset refuses is named as its line reads
  const original = line;
  let whitelist = false;
  let onlyDir = false;
  let absolute = false;
  if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
    absolute = line.startsWith('/');
  } else {
    if (line.startsWith('!')) {
      whitelist = true;
      line = line.slice(1);
    }
    if (line.startsWith('/')) {
      line = line.slice(1);
      absolute = true;
    }
  }
  if (line.endsWith('/')) {
    onlyDir = true;
    line = line.slice(0, -1);
    if (line.endsWith('\\')) line = line.slice(0, -1);
  }
  let actual = line;
  if (!absolute && !line.includes('/') && !(actual.startsWith('**/') || actual === '**')) actual = `**/${actual}`;
  if (actual.endsWith('/**')) actual = `${actual}/*`;
  return { whitelist, onlyDir, regex: globRegex(actual, allowUnclosedClass, original) };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A file's lines as Rust's `BufRead::lines` gives them: split at LF, a CR before an LF dropped, ending before the first line that is not UTF-8. */
export function textLines(bytes: Buffer): string[] {
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline < 0 ? bytes.length : newline;
    let line: string;
    try {
      line = UTF8.decode(bytes.subarray(start, end));
    } catch (err) {
      if (err instanceof TypeError) break;
      throw err;
    }
    lines.push(newline >= 0 && line.endsWith('\r') ? line.slice(0, -1) : line);
    start = end + 1;
  }
  return lines;
}

/** The rules of an ignore file, read as the ignore crate reads one: a line globset refuses is left out. */
export function ignoreFileRules(bytes: Buffer): IgnoreRules {
  const globs: IgnoreGlob[] = [];
  textLines(bytes).forEach((text, index) => {
    const line = index === 0 ? text.replace(/^\uFEFF+/, '') : text;
    try {
      const glob = ignoreGlobOf(line, true);
      if (glob) globs.push(glob);
    } catch (err) {
      // the ignore crate reports such a line and keeps the file's other lines
      if (!(err instanceof GlobSyntaxError)) throw err;
    }
  });
  return { globs };
}

/** rg's `--glob` overrides (`OverrideBuilder`): each line as a gitignore line, inverted; throws GlobSyntaxError as rg fails. */
export function overrideRules(lines: readonly string[]): IgnoreRules & { readonly includes: boolean } {
  const globs = lines.map((line) => ignoreGlobOf(line, false)).filter((glob): glob is IgnoreGlob => glob !== undefined);
  return { globs, includes: globs.some((glob) => !glob.whitelist) };
}

/** A path's UTF-8 bytes, one character each, as the rules' regular expressions read it. */
export const pathBytes = (path: string): string => Buffer.from(path, 'utf8').toString('latin1');

/** `Gitignore::matched_stripped` of a path's bytes (`pathBytes`): the last glob that matches decides, a directory-only glob only for a directory. */
export function matchRules(rules: IgnoreRules, bytes: string, isDir: boolean): IgnoreMatch {
  for (let index = rules.globs.length - 1; index >= 0; index--) {
    const glob = rules.globs[index]!;
    if ((!glob.onlyDir || isDir) && glob.regex.test(bytes)) return glob.whitelist ? 'whitelist' : 'ignore';
  }
  return undefined;
}

/** `Override::matched`: an include glob lets a path through, an exclude glob ignores it, and with any include a file no glob names is ignored. */
export function matchOverrides(rules: IgnoreRules & { readonly includes: boolean }, bytes: string, isDir: boolean): IgnoreMatch {
  if (rules.globs.length === 0) return undefined;
  const matched = matchRules(rules, bytes, isDir);
  if (matched === undefined) return rules.includes && !isDir ? 'ignore' : undefined;
  return matched === 'ignore' ? 'whitelist' : 'ignore';
}
