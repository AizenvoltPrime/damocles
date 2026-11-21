import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { MAX_PATH_CHARS } from '../core-protocol/messages';
import type { FileEntry } from '../preload/shell-channels';
import { confineExisting, followsLocalLinksOnly, type ConfineRefusal, type HostLinkRefusal, type LinkRefusal, type LinkRoot, type LinkRule, type Project } from '../local-services/confine';
import { errorTextOf } from '../../core/l10n';
import { isPartName } from './transfer-ops';
import { isMissing } from '../../core/local-links';

// via: the link root the folder was reached through, when its realpath leaves the project; refusal: the confinement's
export type FolderListing<R extends LinkRefusal = LinkRefusal> = { readonly ok: true; readonly entries: FileEntry[]; readonly via?: LinkRoot } | ConfineRefusal<R>;

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

// The link's own target text, control characters dropped and bounded for the wire; undefined when it cannot be read.
async function linkTextOf(linkPath: string): Promise<string | undefined> {
  try {
    return (await fs.readlink(linkPath)).replace(/\p{Cc}/gu, '').slice(0, MAX_PATH_CHARS);
  } catch {
    return undefined;
  }
}

function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

export interface TreeListing<R extends LinkRefusal = LinkRefusal> {
  // one folder's entries in directory order, without the excluded ones
  list(project: Project, relativeDir: string, excludes: readonly string[]): Promise<FolderListing<R>>;
}

// list confines under throughLinks; under: a listing confined under rule
export interface HostTreeListing extends TreeListing<HostLinkRefusal> {
  under(rule: LinkRule): TreeListing<HostLinkRefusal>;
}

/** The Files section's folder reads, links listed as what they point to. */
export function createTreeListing(log: (line: string) => void): HostTreeListing {
  let cached: { readonly key: string; readonly test: ExcludeTest } | undefined;
  const testFor = (excludes: readonly string[]): ExcludeTest => {
    const key = JSON.stringify(excludes);
    if (cached?.key !== key) cached = { key, test: excludeTest(excludes) };
    return cached.test;
  };

  // A link is listed as what it points to, carrying its readlink text, which reads no target. One onto another share or WSL
  // (D10) lists as a file and its target is never stat'ed; a dangling one (ENOENT, ENOTDIR, as VS Code's pfs.ts tells one, from
  // the walk or the stat alike) lists as a broken file link, and one whose target fails otherwise (EACCES, ELOOP) as a file link.
  const entryOf = async (dir: string, dirent: Dirent): Promise<FileEntry> => {
    const { name } = dirent;
    if (dirent.isDirectory()) return { name, kind: 'dir' };
    if (!dirent.isSymbolicLink()) return { name, kind: 'file' };
    const linkPath = path.join(dir, name);
    const target = await linkTextOf(linkPath);
    const entry = (kind: FileEntry['kind'], broken?: true): FileEntry => (target === undefined ? { name, kind } : { name, kind, link: broken ? { target, broken } : { target } });
    try {
      if (!(await followsLocalLinksOnly(dir, [name], { baseIsReal: true }))) return entry('file');
      return entry((await fs.stat(linkPath)).isDirectory() ? 'dir' : 'file');
    } catch (err) {
      log(`[files] cannot follow the link ${name}: ${errorText(err)}`);
      return isMissing(err) ? entry('file', true) : entry('file');
    }
  };

  const under = (rule: LinkRule): TreeListing<HostLinkRefusal> => ({
    async list(project, relativeDir, excludes) {
      const confined = await confineExisting(project, relativeDir, rule);
      if (!confined.ok) return confined;
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(confined.path, { withFileTypes: true });
      } catch (err) {
        return isMissing(err) ? { ok: false, reason: 'missing' } : { ok: false, reason: 'failed', error: errorTextOf(err) };
      }
      const excluded = testFor(excludes);
      const entries: FileEntry[] = [];
      for (const dirent of dirents) {
        if (isPartName(dirent.name) || excluded(joinRelative(relativeDir, dirent.name))) continue;
        entries.push(await entryOf(confined.path, dirent));
      }
      return { ok: true, entries, ...(confined.via ? { via: confined.via } : {}) };
    },
  });
  return { ...under('throughLinks'), under };
}
