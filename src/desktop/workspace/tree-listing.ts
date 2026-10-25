import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { FileEntry } from '../preload/shell-channels';
import { confineExisting, followsLocalLinksOnly, type ConfineFailure, type Project } from '../local-services/confine';

export type FolderListing = { readonly ok: true; readonly entries: FileEntry[] } | { readonly ok: false; readonly reason: ConfineFailure };

/** Whether one of the exclude globs hides relativePath or a folder above it. */
export type ExcludeTest = (relativePath: string) => boolean;

export function excludeTest(patterns: readonly string[]): ExcludeTest {
  if (patterns.length === 0) return () => false;
  const matcher = picomatch([...patterns], { dot: true });
  return (relativePath) => {
    const segments = relativePath.split('/');
    for (let index = 1; index <= segments.length; index++) {
      if (matcher(segments.slice(0, index).join('/'))) return true;
    }
    return false;
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

export interface TreeListing {
  // one folder's entries in directory order, without the excluded ones
  list(project: Project, relativeDir: string, excludes: readonly string[]): Promise<FolderListing>;
}

/** The Files section's folder reads, confined inside the project, links listed as what they point to. */
export function createTreeListing(log: (line: string) => void): TreeListing {
  let cached: { readonly key: string; readonly test: ExcludeTest } | undefined;
  const testFor = (excludes: readonly string[]): ExcludeTest => {
    const key = JSON.stringify(excludes);
    if (cached?.key !== key) cached = { key, test: excludeTest(excludes) };
    return cached.test;
  };

  // A link is listed as what it points to (a dangling one as a file); listing a folder link that leads outside the project
  // is refused by confinement, so it is never followed there.
  const kindOf = async (dir: string, dirent: Dirent): Promise<'file' | 'dir'> => {
    if (dirent.isDirectory()) return 'dir';
    if (!dirent.isSymbolicLink()) return 'file';
    try {
      if (!(await followsLocalLinksOnly(dir, [dirent.name]))) return 'file';
      const stat = await fs.stat(path.join(dir, dirent.name));
      return stat.isDirectory() ? 'dir' : 'file';
    } catch (err) {
      log(`[files] cannot follow the link ${dirent.name}: ${errorText(err)}`);
      return 'file';
    }
  };

  return {
    async list(project, relativeDir, excludes) {
      const confined = await confineExisting(project, relativeDir);
      if (!confined.ok) return confined;
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(confined.path, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' };
      }
      const excluded = testFor(excludes);
      const entries: FileEntry[] = [];
      for (const dirent of dirents) {
        if (excluded(joinRelative(relativeDir, dirent.name))) continue;
        entries.push({ name: dirent.name, kind: await kindOf(confined.path, dirent) });
      }
      return { ok: true, entries };
    },
  };
}
