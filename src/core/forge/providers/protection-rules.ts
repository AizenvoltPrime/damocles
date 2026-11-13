import { MAX_PROTECTION_PATTERN_CHARS, MAX_PROTECTION_PATTERNS, MAX_PROTECTION_RULES, type BranchProtectionRule } from '../../../shared/forge/branch-protection';

/** A branch name a server answered as an fnmatch pattern matching only itself. */
export function literalPattern(name: string): string {
  return name.replace(/[*?[\\]/g, '\\$&');
}

const fits = (pattern: string): boolean => pattern.length > 0 && pattern.length <= MAX_PROTECTION_PATTERN_CHARS;

/**
 * The rules within the wire's bounds: long includes split over rules of the same excludes, which match the same branches;
 * an empty or overlong include dropped, and rules past the bound left out. A rule whose excludes do not fit is left out
 * whole, since dropping an exclude would protect branches the server does not.
 */
export function boundedRules(rules: readonly BranchProtectionRule[], log: (line: string) => void): BranchProtectionRule[] {
  const out: BranchProtectionRule[] = [];
  for (const rule of rules) {
    const include = rule.include.filter(fits);
    const { exclude } = rule;
    if (exclude.length > MAX_PROTECTION_PATTERNS || !exclude.every(fits)) {
      log(`[forge] a branch rule with ${exclude.length} exclude patterns is past the wire's bounds and left out; its branches are not protected`);
      continue;
    }
    for (let at = 0; at < include.length; at += MAX_PROTECTION_PATTERNS) {
      out.push({ include: include.slice(at, at + MAX_PROTECTION_PATTERNS), exclude, syntax: rule.syntax });
    }
  }
  return out.slice(0, MAX_PROTECTION_RULES);
}
