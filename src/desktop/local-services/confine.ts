import { promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { canonicalPath } from '../../core/canonical-path';
import { errorTextOf } from '../../core/l10n';
import { followsLocalLinksOnly, realpathOnOwnShare } from '../../core/local-links';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { isInsideRealRoot, linkRootOf } from '../../core/workspace-folders/real-root';
import type { HostLinkRefusal, LinkRefusal, LinkRoot, LinkRule } from '../../platform/file-confinement';
import type { LocalizedText } from '../../shared/localized-text';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';

export interface Project {
  // folderKey(fsPath), the key the shell names it by
  readonly key: string;
  readonly fsPath: string;
  readonly name: string;
}

export { followsLocalLinksOnly, isInsideRealRoot };

export type ConfineFailure = 'outside' | 'missing' | 'failed';

export type { HostLinkRefusal, LinkRefusal, LinkRoot, LinkRule };

// R: the refusals the answer may carry, HostLinkRefusal on a host and the wire; error: a failed walk's or stat's own words
export type ConfineRefusal<R extends LinkRefusal = LinkRefusal> = { readonly ok: false; readonly reason: ConfineFailure; readonly refusal?: R; readonly error?: LocalizedText };

// spelling: the relative path as its folders list it, on a host whose names ignore case, set only when asked (ConfineOptions)
// and where the caller's differs
export type Confined<R extends LinkRefusal = LinkRefusal> = { readonly ok: true; readonly path: string; readonly via?: LinkRoot; readonly spelling?: string } | ConfineRefusal<R>;

type HostRefusal = ConfineRefusal<HostLinkRefusal>;

const SHARE_REFUSAL: HostRefusal = { ok: false, reason: 'outside', refusal: 'share' };

// '' names the project folder; anything else must be a relative path a renderer may name.
export function isRelativeOrRoot(value: unknown): value is string {
  return value === '' || isRelativeFilePath(value);
}

function lexicalJoin(root: string, relativePath: string): string | undefined {
  if (!isRelativeOrRoot(relativePath)) return undefined;
  if (relativePath === '') return root;
  if (process.platform === 'win32' && hasUnsafeWindowsSegment(relativePath)) return undefined;
  return path.join(root, ...relativePath.split('/'));
}

function segmentsOf(relativePath: string): string[] {
  return relativePath === '' ? [] : relativePath.split('/');
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// A file system error as a refusal: missing, or failed with its own words (a drive that did not answer, a loop).
function refusalOf(err: unknown): HostRefusal {
  return isMissing(err) ? { ok: false, reason: 'missing' } : { ok: false, reason: 'failed', error: errorTextOf(err) };
}

async function realRootOf(project: Project): Promise<string> {
  return fs.realpath(project.fsPath);
}

type RealUnder = { readonly ok: true; readonly path: string; readonly base: string; readonly via?: LinkRoot } | HostRefusal;

// The realpath of lexical, which segments name under the project, confined under rule; base is the folder resolvedPath is
// measured from. The walk comes first, so nothing is stat'ed through a link to a share. Throws a file system error.
async function realUnder(project: Project, segments: readonly string[], lexical: string, rule: LinkRule): Promise<RealUnder> {
  if (!(await followsLocalLinksOnly(project.fsPath, segments))) return SHARE_REFUSAL;
  const [realRoot, realTarget] = await Promise.all([realRootOf(project), fs.realpath(lexical)]);
  // via.realRoot holds realTarget, so this one check covers the link root too
  if (!realpathOnOwnShare(project.fsPath, realRoot, realTarget)) return SHARE_REFUSAL;
  if (isInsideRealRoot(realRoot, realTarget)) return { ok: true, path: realTarget, base: realRoot };
  const via = rule === 'throughLinks' ? await linkRootOf(project.fsPath, segments, realTarget) : undefined;
  return via ? { ok: true, path: realTarget, base: via.realRoot, via } : { ok: false, reason: 'outside' };
}

const slashed = (base: string, target: string): string => path.relative(base, target).split(path.sep).join('/');

/**
 * An existing path, following every link: its native realpath must lie under the project's, or under the link root with
 * throughLinks, and no link on the way may lead to a UNC or device path. resolvedPath is the realpath relative to the project's
 * realpath, or to via.realRoot, '/' separated.
 */
export async function confineResolved(project: Project, relativePath: string, rule: LinkRule): Promise<{ readonly ok: true; readonly path: string; readonly resolvedPath: string; readonly via?: LinkRoot } | HostRefusal> {
  const lexical = lexicalJoin(project.fsPath, relativePath);
  if (lexical === undefined) return { ok: false, reason: 'outside' };
  try {
    const real = await realUnder(project, segmentsOf(relativePath), lexical, rule);
    if (!real.ok) return real;
    return { ok: true, path: real.path, resolvedPath: slashed(real.base, real.path), ...(real.via ? { via: real.via } : {}) };
  } catch (err) {
    return refusalOf(err);
  }
}

/**
 * confineResolved without resolvedPath. Opens, reads, writes and listings use it; a document's open asks for spelling too,
 * answered where it differs from relativePath.
 */
export async function confineExisting(project: Project, relativePath: string, rule: LinkRule, opts: ConfineOptions = {}): Promise<Confined<HostLinkRefusal>> {
  const confined = await confineResolved(project, relativePath, rule);
  if (!confined.ok) return confined;
  let spelling = relativePath;
  if (opts.spell && CASE_BLIND) {
    try {
      spelling = await listedSpelling(project, relativePath, confined);
    } catch (err) {
      return refusalOf(err);
    }
  }
  return { ok: true, path: confined.path, ...(confined.via ? { via: confined.via } : {}), ...(spelling !== relativePath ? { spelling } : {}) };
}

// spell: also answer the path as its folders list it (Confined.spelling), which costs a read per segment the realpath cannot spell
export interface ConfineOptions {
  readonly spell?: true;
}

// The hosts whose file names ignore case, where a typed path may name an entry in another case than its folder lists it.
const CASE_BLIND = process.platform === 'win32' || process.platform === 'darwin';

/**
 * relativePath as its folders list each segment, a link by its own name, never its target's. With no link on the way the
 * realpath spells it; otherwise each segment is read on its own: a realpath's last name for an entry, the folder's listing for a
 * link. Only the paths confineResolved already walked are read.
 */
async function listedSpelling(project: Project, relativePath: string, confined: { readonly resolvedPath: string; readonly via?: LinkRoot }): Promise<string> {
  if (relativePath === '') return relativePath;
  if (!confined.via && confined.resolvedPath.toLowerCase() === relativePath.toLowerCase()) return confined.resolvedPath;
  const spelled: string[] = [];
  for (const segment of segmentsOf(relativePath)) {
    const at = path.join(project.fsPath, ...spelled, segment);
    spelled.push((await fs.lstat(at)).isSymbolicLink() ? await listedName(path.dirname(at), segment) : path.basename(await fs.realpath(at)));
  }
  return spelled.join('/');
}

// The name folder lists for segment: itself, else the one entry that differs from it only in case.
async function listedName(folder: string, segment: string): Promise<string> {
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch (err) {
    // a folder that can be passed through but not listed names nothing, so the segment keeps the spelling it was given
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return segment;
    throw err;
  }
  if (names.includes(segment)) return segment;
  const matches = names.filter((name) => name.toLowerCase() === segment.toLowerCase());
  return matches.length === 1 ? matches[0]! : segment;
}

/**
 * A path that does not exist (a file deleted on disk): its deepest existing folder is confined as confineExisting confines,
 * and the result is that folder's realpath plus the missing segments.
 */
export async function confineMissing(project: Project, relativePath: string, rule: LinkRule): Promise<Confined<HostLinkRefusal>> {
  if (!isRelativeFilePath(relativePath) || lexicalJoin(project.fsPath, relativePath) === undefined) return { ok: false, reason: 'outside' };
  const segments = segmentsOf(relativePath);
  for (let depth = segments.length; depth >= 0; depth--) {
    const ancestor = await confineExisting(project, segments.slice(0, depth).join('/'), rule);
    if (ancestor.ok) return { ok: true, path: path.join(ancestor.path, ...segments.slice(depth)), ...(ancestor.via ? { via: ancestor.via } : {}) };
    if (ancestor.reason !== 'missing') return ancestor;
  }
  return { ok: false, reason: 'missing' };
}

/**
 * The confined folder at relativeDir, creating each missing folder on the way one at a time; every folder is confined again
 * after its mkdir, so a link swapped in never leads a write anywhere rule refuses.
 */
export async function confineOrCreateFolder(project: Project, relativeDir: string, rule: LinkRule): Promise<Confined<HostLinkRefusal>> {
  let current = await confineExisting(project, '', rule);
  const segments = segmentsOf(relativeDir);
  for (let depth = 1; depth <= segments.length && current.ok; depth++) {
    const sub = segments.slice(0, depth).join('/');
    const parent = current.path;
    current = await confineExisting(project, sub, rule);
    if (current.ok || current.reason !== 'missing') continue;
    try {
      await fs.mkdir(path.join(parent, segments[depth - 1]!));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return refusalOf(err);
    }
    current = await confineExisting(project, sub, rule);
  }
  return current;
}

/**
 * The entry itself, never followed: its parent is confined as confineResolved confines it under rule, and the result is that
 * parent plus the last segment, so a rename, trash or reveal of a link acts on the link and never on what it points to.
 * resolvedPath is that result relative to the project's realpath, or to via.realRoot, '/' separated.
 */
export async function confineEntry(project: Project, relativePath: string, rule: LinkRule): Promise<{ readonly ok: true; readonly path: string; readonly resolvedPath: string; readonly stat: BigIntStats; readonly via?: LinkRoot } | HostRefusal> {
  if (!isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
  const lexical = lexicalJoin(project.fsPath, relativePath);
  if (lexical === undefined) return { ok: false, reason: 'outside' };
  try {
    const parent = await realUnder(project, segmentsOf(relativePath).slice(0, -1), path.dirname(lexical), rule);
    if (!parent.ok) return parent;
    const entry = path.join(parent.path, path.basename(lexical));
    const stat = await fs.lstat(entry, { bigint: true });
    return { ok: true, path: entry, resolvedPath: slashed(parent.base, entry), stat, ...(parent.via ? { via: parent.via } : {}) };
  } catch (err) {
    return refusalOf(err);
  }
}

/**
 * A path inside some open root, for a target that may not exist yet (Save As): its canonical path must lie under one. The
 * deepest root holding it wins, so a chat worktree inside a project folder names its own files.
 */
export async function projectOfPath(projects: readonly Project[], target: string): Promise<{ project: Project; relativePath: string; path: string } | undefined> {
  if (!path.isAbsolute(target)) return undefined;
  const canonical = canonicalPath(target);
  let found: { project: Project; relativePath: string; path: string; depth: number } | undefined;
  for (const project of projects) {
    let realRoot: string;
    try {
      realRoot = await realRootOf(project);
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    if (!isInsideRealRoot(realRoot, canonical) || folderKey(realRoot) === folderKey(canonical)) continue;
    const relativePath = path.relative(realRoot, canonical).split(path.sep).join('/');
    if (!isRelativeFilePath(relativePath)) continue;
    const depth = realRoot.length;
    if (!found || depth > found.depth) found = { project, relativePath, path: canonical, depth };
  }
  return found && { project: found.project, relativePath: found.relativePath, path: found.path };
}
