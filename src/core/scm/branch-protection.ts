import type { BranchProtectionRule, RemoteBranchProtection } from '../../shared/forge/branch-protection';

// VS Code's Repository.isBranchProtected (extensions/git/src/repository.ts): the setting's globs for every branch, then the
// rules of the branch's upstream remote, any one of which protects a branch it includes and does not exclude.

const regexLiteral = (char: string): string => char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const classChar = (char: string): string => `\\u{${char.codePointAt(0)!.toString(16)}}`;

/** GitLab's RefMatcher: `*` is any text, `/` included; everything else matches itself. */
function gitlabSource(pattern: string): string {
  return pattern.split('*').map((part) => [...part].map(regexLiteral).join('')).join('.*');
}

/**
 * A bracket expression of Ruby's fnmatch from chars[start] ('['): `!` or `^` negates, `a-z` is a range, `\` escapes, and with
 * FNM_PATHNAME it never matches `/`. An unterminated one matches nothing, as Ruby's bracket() fails.
 */
function bracketSource(chars: readonly string[], start: number): { readonly source: string; readonly end: number } {
  let at = start + 1;
  const negated = chars[at] === '!' || chars[at] === '^';
  if (negated) at++;
  const items: string[] = [];
  while (at < chars.length && chars[at] !== ']') {
    let low = chars[at]!;
    if (low === '\\' && at + 1 < chars.length) low = chars[++at]!;
    let high = low;
    if (chars[at + 1] === '-' && at + 2 < chars.length && chars[at + 2] !== ']') {
      at += 2;
      high = chars[at]!;
      if (high === '\\' && at + 1 < chars.length) high = chars[++at]!;
    }
    // a reversed range matches nothing, as Ruby's c1 <= c && c <= c2 does
    if (low.codePointAt(0)! <= high.codePointAt(0)!) items.push(low === high ? classChar(low) : `${classChar(low)}-${classChar(high)}`);
    at++;
  }
  if (at >= chars.length) return { source: '(?!)', end: chars.length - 1 };
  const body = items.join('');
  if (negated) return { source: `[^/${body}]`, end: at };
  return { source: body === '' ? '(?!)' : `(?!/)[${body}]`, end: at };
}

/**
 * GitHub's branch patterns, Ruby's File.fnmatch with FNM_PATHNAME and no extglob or braces: `*` and `?` stop at `/`, a run of
 * `**` followed by `/` at a segment's start is any number of whole segments, any other `**` is `*`, `[...]` is a set, and `\`
 * escapes the next character.
 */
export function fnmatchSource(pattern: string): string {
  const chars = [...pattern];
  let out = '';
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    const segmentStart = at === 0 || chars[at - 1] === '/';
    if (segmentStart && char === '*' && chars[at + 1] === '*' && chars[at + 2] === '/') {
      while (chars[at] === '*' && chars[at + 1] === '*' && chars[at + 2] === '/') at += 3;
      at--;
      // one segment at a time, so a match backtracks over the name's slashes only
      out += '(?:[^/]*/)*';
    } else if (char === '*') {
      while (chars[at + 1] === '*') at++;
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const set = bracketSource(chars, at);
      out += set.source;
      at = set.end;
    } else if (char === '\\' && at + 1 < chars.length) {
      out += regexLiteral(chars[++at]!);
    } else {
      out += regexLiteral(char);
    }
  }
  return out;
}

function matcherOf(rule: BranchProtectionRule, patterns: readonly string[]): ((branch: string) => boolean) | undefined {
  if (patterns.length === 0) return undefined;
  const sources = patterns.map(rule.syntax === 'gitlab' ? gitlabSource : fnmatchSource);
  const regex = new RegExp(`^(?:${sources.join('|')})$`, 'u');
  return (branch) => regex.test(branch);
}

/** Whether a rule protects branch; a rule with no include protects nothing, as a GitHub ruleset targeting no ref does. */
export function ruleProtects(rule: BranchProtectionRule, branch: string): boolean {
  const include = matcherOf(rule, rule.include);
  if (!include || !include(branch)) return false;
  const exclude = matcherOf(rule, rule.exclude);
  return !exclude?.(branch);
}

/** The server rules of the upstream remote protect branch (as that remote names it); a branch with no upstream has none. */
export function serverProtects(rules: readonly RemoteBranchProtection[], branch: string, upstreamRemote: string | undefined): boolean {
  if (upstreamRemote === undefined) return false;
  return rules.some((remote) => remote.remote === upstreamRemote && remote.rules.some((rule) => ruleProtects(rule, branch)));
}
