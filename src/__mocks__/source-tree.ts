// Source-level guard tests read every backend file through this walker.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const REPO_ROOT: string = resolve(__dirname, '..', '..');

export interface SourceFile {
  /** Absolute path. */
  readonly path: string;
  /** Repo-relative, forward slashes (e.g. `src/core/permission-handler/state.ts`). */
  readonly rel: string;
}

// A tree that is missing or below its minimum means the walker points at the wrong root.
const BACKEND_TREES: readonly { readonly dir: string; readonly minFiles: number }[] = [
  { dir: 'src/core', minFiles: 100 },
  { dir: 'src/vscode', minFiles: 5 },
  { dir: 'src/desktop', minFiles: 5 },
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walk(full, out);
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
}

/** Every `.ts` file outside `__tests__` directories under each backend tree; throws when a tree is missing or too small. */
export function backendSourceFiles(repoRoot: string = REPO_ROOT): SourceFile[] {
  const files: SourceFile[] = [];
  for (const tree of BACKEND_TREES) {
    const dir = join(repoRoot, tree.dir);
    if (!existsSync(dir)) throw new Error(`source tree ${tree.dir} not found under ${repoRoot}`);
    const found: string[] = [];
    walk(dir, found);
    if (found.length < tree.minFiles) {
      throw new Error(`source tree ${tree.dir} has ${found.length} .ts files, expected at least ${tree.minFiles}`);
    }
    for (const f of found) files.push({ path: f, rel: relative(repoRoot, f).split('\\').join('/') });
  }
  return files;
}
