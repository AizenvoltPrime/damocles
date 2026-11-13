// Branch protection a server reports, as main hands it to a commit (docs/invariants.md "Source control", protected branches).
// Branch names and patterns are data, never translated.

/** The scm.commit field an older daemon's parser drops; its commit then asks only by damocles.desktop.git.branchProtection. */
export const SCM_COMMIT_PROTECTED_BRANCHES_FEATURE = 'scm.commit.protectedBranches';
/** The MainRequest forge.branchProtection of this computer's core. */
export const FORGE_BRANCH_PROTECTION_FEATURE = 'forge.branchProtection';

export const MAX_PROTECTED_REMOTES = 32;
export const MAX_PROTECTION_RULES = 200;
export const MAX_PROTECTION_PATTERNS = 50;
export const MAX_PROTECTION_PATTERN_CHARS = 255;

/**
 * A branch is protected when it matches a pattern of include and none of exclude. fnmatch: GitHub's, Ruby's File.fnmatch with
 * FNM_PATHNAME, where `*` and `?` stop at `/`, `**` followed by `/` is any folders and `[...]` is a set; gitlab: GitLab's
 * wildcard, where `*` matches any text, `/` included, and nothing else is special.
 */
export interface BranchProtectionRule {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly syntax: 'fnmatch' | 'gitlab';
}

/** The rules of the server one remote pushes to; a commit reads those of its branch's upstream remote. */
export interface RemoteBranchProtection {
  readonly remote: string;
  readonly rules: readonly BranchProtectionRule[];
}
