/**
 * ripgrep 15's ignore rules, ported from its `ignore` and `globset` crates (docs/invariants.md "Tool overrides"): a gitignore
 * line becomes a glob as `GitignoreBuilder::add_line` makes it, and a glob a regular expression as globset's parser builds it,
 * matched against a path's UTF-8 bytes. A path is relative to the rules' folder, `/`-separated, with no leading `./`.
 */

/** Whether a set of rules ignores a path, lets it through over lower rules (`!`), or says nothing about it. */
export type IgnoreMatch = 'ignore' | 'whitelist' | undefined;

// globset's `MatchStrategy` for the forms ignore files mostly hold, each true exactly when the glob's regex matches, except that a
// path whose basename is `..` has none (globset's `file_name`), so its basename and extension strategies match nothing; any other
// glob is matched by its regex.
type Strategy =
  // `{literal}`: the whole path
  | { readonly kind: 'literal'; readonly bytes: string }
  // `**/{literal}`, no `/` in it: the path's basename
  | { readonly kind: 'basename'; readonly bytes: string }
  // `**/*.{literal}`, no `.` or `/` in it: the path's extension, from the basename's last `.`
  | { readonly kind: 'extension'; readonly bytes: string }
  | { readonly kind: 'regex' };

interface IgnoreGlob {
  readonly whitelist: boolean;
  readonly onlyDir: boolean;
  readonly regex: RegExp;
  readonly strategy: Strategy;
}

/** The globs of one ignore file or one set of `--glob` overrides, in file order, grouped as globset's `GlobSet` groups them. */
export interface IgnoreRules {
  readonly globs: readonly IgnoreGlob[];
  // each strategy's globs by the bytes they match, as indexes into globs in ascending order
  readonly literals: ReadonlyMap<string, readonly number[]>;
  readonly basenames: ReadonlyMap<string, readonly number[]>;
  readonly extensions: ReadonlyMap<string, readonly number[]>;
  // the regex strategy's indexes, descending
  readonly regexes: readonly number[];
}

function ruleSet(globs: readonly IgnoreGlob[]): IgnoreRules {
  const literals = new Map<string, number[]>();
  const basenames = new Map<string, number[]>();
  const extensions = new Map<string, number[]>();
  const regexes: number[] = [];
  globs.forEach(({ strategy }, index) => {
    if (strategy.kind === 'regex') return void regexes.push(index);
    const byBytes = strategy.kind === 'literal' ? literals : strategy.kind === 'basename' ? basenames : extensions;
    const hits = byBytes.get(strategy.bytes);
    if (hits) hits.push(index);
    else byBytes.set(strategy.bytes, [index]);
  });
  regexes.reverse();
  return { globs, literals, basenames, extensions, regexes };
}

export const NO_RULES: IgnoreRules = ruleSet([]);

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

// globset's `Tokens::tokens_to_regex`, compiled with the `s` flag: globset's `new_regex` sets `dot_matches_new_line`.
function tokensToRegex(tokens: readonly Token[]): string {
  let regex = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'literal': regex += byteLiteral(token.char); break;
      case 'any': regex += '[^/]'; break;
      case 'zeroOrMore': regex += '[^/]*'; break;
      case 'recursivePrefix': regex += '(?:/?|.*/)'; break;
      case 'recursiveSuffix': regex += '/.*'; break;
      case 'recursiveZeroOrMore': regex += '(?:/|/.*/)'; break;
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

// The literal tokens' text, or undefined when a token is no literal or one is in `refused`.
function literalText(tokens: readonly Token[], refused: string): string | undefined {
  let text = '';
  for (const token of tokens) {
    if (token.kind !== 'literal' || refused.includes(token.char)) return undefined;
    text += token.char;
  }
  return text;
}

/** globset's `MatchStrategy::new` for its literal, basename literal and extension forms, with `literal_separator` on. */
function strategyOf(tokens: readonly Token[]): Strategy {
  const prefixed = tokens[0]?.kind === 'recursivePrefix';
  const basename = prefixed && tokens.length > 1 ? literalText(tokens.slice(1), '/') : undefined;
  if (basename !== undefined) return { kind: 'basename', bytes: pathBytes(basename) };
  const literal = tokens.length > 0 ? literalText(tokens, '') : undefined;
  if (literal !== undefined) return { kind: 'literal', bytes: pathBytes(literal) };
  // `*` without `**/` before it cannot cross a `/`, so it matches no extension alone
  const dot = tokens[2];
  const extension = prefixed && tokens[1]?.kind === 'zeroOrMore' && dot?.kind === 'literal' && dot.char === '.' ? literalText(tokens.slice(3), './') : undefined;
  return extension === undefined ? { kind: 'regex' } : { kind: 'extension', bytes: pathBytes(`.${extension}`) };
}

function compiledGlob(glob: string, allowUnclosedClass: boolean, original: string): { regex: RegExp; strategy: Strategy } {
  const tokens = parseGlob(glob, allowUnclosedClass, original);
  // globset matches everything for a lone `**`
  if (tokens.length === 1 && tokens[0]!.kind === 'recursivePrefix') return { regex: /^.*$/s, strategy: { kind: 'regex' } };
  return { regex: new RegExp(`^${tokensToRegex(tokens)}$`, 's'), strategy: strategyOf(tokens) };
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
  return { whitelist, onlyDir, ...compiledGlob(actual, allowUnclosedClass, original) };
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
  return ruleSet(globs);
}

/** rg's `--glob` overrides (`OverrideBuilder`): each line as a gitignore line, inverted; throws GlobSyntaxError as rg fails. */
export function overrideRules(lines: readonly string[]): IgnoreRules & { readonly includes: boolean } {
  const globs = lines.map((line) => ignoreGlobOf(line, false)).filter((glob): glob is IgnoreGlob => glob !== undefined);
  return { ...ruleSet(globs), includes: globs.some((glob) => !glob.whitelist) };
}

/** A path's UTF-8 bytes, one character each, as the rules' regular expressions read it; an ASCII path is its own. */
export const pathBytes = (path: string): string => (Buffer.byteLength(path, 'utf8') === path.length ? path : Buffer.from(path, 'utf8').toString('latin1'));

/** globset's `Candidate`: a path's bytes (`pathBytes`) and its basename's and extension's, which the strategies read. */
export interface Candidate {
  readonly path: string;
  readonly basename: string;
  // from the basename's last `.`, the `.` included; '' without one
  readonly extension: string;
}

/** globset's `Candidate::new` of a path's bytes: a basename of `..` is none. */
export function candidateOf(path: string): Candidate {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const basename = last === '..' ? '' : last;
  const dot = basename.lastIndexOf('.');
  return { path, basename, extension: dot < 0 ? '' : basename.slice(dot) };
}

// The highest index of hits above best whose glob applies to the entry's type, else best.
function highest(globs: readonly IgnoreGlob[], hits: readonly number[] | undefined, isDir: boolean, best: number): number {
  if (hits === undefined) return best;
  for (let at = hits.length - 1; at >= 0 && hits[at]! > best; at--) {
    if (isDir || !globs[hits[at]!]!.onlyDir) return hits[at]!;
  }
  return best;
}

/** `Gitignore::matched_stripped`: the last glob that matches decides, a directory-only glob only for a directory. */
export function matchRules(rules: IgnoreRules, candidate: Candidate, isDir: boolean): IgnoreMatch {
  const { globs } = rules;
  if (globs.length === 0) return undefined;
  let best = highest(globs, rules.literals.get(candidate.path), isDir, -1);
  best = highest(globs, rules.basenames.get(candidate.basename), isDir, best);
  best = highest(globs, rules.extensions.get(candidate.extension), isDir, best);
  for (const index of rules.regexes) {
    if (index <= best) break;
    const glob = globs[index]!;
    if ((isDir || !glob.onlyDir) && glob.regex.test(candidate.path)) {
      best = index;
      break;
    }
  }
  return best < 0 ? undefined : globs[best]!.whitelist ? 'whitelist' : 'ignore';
}

/** `Override::matched`: an include glob lets a path through, an exclude glob ignores it, and with any include a file no glob names is ignored. */
export function matchOverrides(rules: IgnoreRules & { readonly includes: boolean }, candidate: Candidate, isDir: boolean): IgnoreMatch {
  if (rules.globs.length === 0) return undefined;
  const matched = matchRules(rules, candidate, isDir);
  if (matched === undefined) return rules.includes && !isDir ? 'ignore' : undefined;
  return matched === 'ignore' ? 'whitelist' : 'ignore';
}
