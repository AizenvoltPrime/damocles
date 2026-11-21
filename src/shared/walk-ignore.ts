/** rg's ignore switches; the `--glob` overrides apply under every one. */
export interface WalkIgnore {
  // false is `--no-ignore`: no ignore file of any kind, above the root or below it, and no global excludes
  readonly files: boolean;
  // false is `--no-ignore-global`: no global excludes
  readonly global: boolean;
  // false is `--no-ignore-parent`: no rules from the folders above the root, which still mark a repository
  readonly parents: boolean;
}
