/**
 * The part of a branch name a chip shows: the segment after the last '/'. Worktree branches share their prefix
 * (`damocles/` or the branch prefix), so the slug is what tells two apart; the full name goes in the tooltip.
 */
export function branchLeaf(branch: string): string {
  const leaf = branch.slice(branch.lastIndexOf('/') + 1);
  return leaf === '' ? branch : leaf;
}
