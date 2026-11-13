import { describe, expect, it } from 'vitest';
import type { BranchProtectionRule } from '../../../shared/forge/branch-protection';
import { ruleProtects, serverProtects } from '../branch-protection';

const fnmatch = (include: string[], exclude: string[] = []): BranchProtectionRule => ({ include, exclude, syntax: 'fnmatch' });
const gitlab = (include: string[], exclude: string[] = []): BranchProtectionRule => ({ include, exclude, syntax: 'gitlab' });

describe('server branch protection rules', () => {
  it('matches GitHub patterns as Ruby fnmatch with FNM_PATHNAME: * stops at /, **/ is any folders, a trailing ** is *', () => {
    expect(ruleProtects(fnmatch(['release/*']), 'release/1.0')).toBe(true);
    expect(ruleProtects(fnmatch(['release/*']), 'release/1.0/hotfix')).toBe(false);
    expect(ruleProtects(fnmatch(['**/*']), 'main')).toBe(true);
    expect(ruleProtects(fnmatch(['**/*']), 'feature/a/b')).toBe(true);
    // a trailing ** reads as *, so feature/** excludes one level only
    expect(ruleProtects(fnmatch(['**/*'], ['feature/**']), 'feature/a')).toBe(false);
    expect(ruleProtects(fnmatch(['**/*'], ['feature/**']), 'feature/a/b')).toBe(true);
    expect(ruleProtects(fnmatch(['**/*'], ['feature/**/*']), 'feature/a/b')).toBe(false);
    expect(ruleProtects(fnmatch(['**/*'], ['feature/**']), 'main')).toBe(true);
    expect(ruleProtects(fnmatch(['**/hotfix']), 'hotfix')).toBe(true);
    expect(ruleProtects(fnmatch(['**/hotfix']), 'a/b/hotfix')).toBe(true);
    expect(ruleProtects(fnmatch(['a**/b']), 'a/x/b')).toBe(false);
  });

  it('reads ?, sets, ranges, negated sets and escapes as fnmatch does, none of them matching /', () => {
    expect(ruleProtects(fnmatch(['v1.?']), 'v1.x')).toBe(true);
    expect(ruleProtects(fnmatch(['v1?x']), 'v1/x')).toBe(false);
    expect(ruleProtects(fnmatch(['release-[0-9]']), 'release-7')).toBe(true);
    expect(ruleProtects(fnmatch(['release-[0-9]']), 'release-x')).toBe(false);
    expect(ruleProtects(fnmatch(['release-[!0-9]']), 'release-x')).toBe(true);
    expect(ruleProtects(fnmatch(['release-[^0-9]']), 'release-7')).toBe(false);
    expect(ruleProtects(fnmatch(['a[!x]b']), 'a/b')).toBe(false);
    expect(ruleProtects(fnmatch(['a[/]b']), 'a/b')).toBe(false);
    expect(ruleProtects(fnmatch(['[ab]-x']), 'b-x')).toBe(true);
    expect(ruleProtects(fnmatch(['a\\*']), 'a*')).toBe(true);
    expect(ruleProtects(fnmatch(['a\\*']), 'ab')).toBe(false);
    // an unterminated set matches nothing, as Ruby's bracket() fails
    expect(ruleProtects(fnmatch(['main[']), 'main[')).toBe(false);
  });

  it('reads no negation, braces or extglob: !, {a,b}, +(...) and @(...) are themselves', () => {
    expect(ruleProtects(fnmatch(['!legacy']), 'main')).toBe(false);
    expect(ruleProtects(fnmatch(['!legacy']), '!legacy')).toBe(true);
    expect(ruleProtects(fnmatch(['{main,dev}']), 'main')).toBe(false);
    expect(ruleProtects(fnmatch(['+(a)']), 'a')).toBe(false);
    expect(ruleProtects(fnmatch(['@(a)']), '@(a)')).toBe(true);
    expect(ruleProtects(fnmatch(['fix(a)+{b}!@']), 'fix(a)+{b}!@')).toBe(true);
  });

  it('matches GitLab wildcards: * is any text, slashes included, and every other character is itself', () => {
    expect(ruleProtects(gitlab(['*-stable']), 'team/production-stable')).toBe(true);
    expect(ruleProtects(gitlab(['release/*']), 'release/1.0/hotfix')).toBe(true);
    expect(ruleProtects(gitlab(['main']), 'main2')).toBe(false);
    expect(ruleProtects(gitlab(['v1.?']), 'v1.x')).toBe(false);
    expect(ruleProtects(gitlab(['v1.?']), 'v1.?')).toBe(true);
    expect(ruleProtects(gitlab(['{a,b}']), 'a')).toBe(false);
  });

  it('protects nothing by a rule with no include, as a ruleset targeting no ref', () => {
    expect(ruleProtects(fnmatch([], ['main']), 'feature')).toBe(false);
  });

  it('reads only the rules of the branch\'s upstream remote, and none without an upstream', () => {
    const rules = [{ remote: 'origin', rules: [fnmatch(['main'])] }, { remote: 'fork', rules: [gitlab(['dev'])] }];
    expect(serverProtects(rules, 'main', 'origin')).toBe(true);
    expect(serverProtects(rules, 'main', 'fork')).toBe(false);
    expect(serverProtects(rules, 'dev', 'fork')).toBe(true);
    expect(serverProtects(rules, 'main', undefined)).toBe(false);
  });
});
