import { promises as fs, type Stats } from 'node:fs';
import * as path from 'node:path';
import { canonicalPath } from '../../../core/canonical-path';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../../shared/relative-path';

export interface Project {
  // folderKey(fsPath), the key the shell names it by
  readonly key: string;
  readonly fsPath: string;
  readonly name: string;
}

export type ConfineFailure = 'outside' | 'missing' | 'failed';

export type Confined = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: ConfineFailure };

// '' names the project folder; anything else must be a relative path a renderer may name.
export function isRelativeOrRoot(value: unknown): value is string {
  return value === '' || isRelativeFilePath(value);
}

/** Whether realTarget is realRoot or lies under it; both must already be native realpaths. */
export function isInsideRealRoot(realRoot: string, realTarget: string): boolean {
  const relative = path.relative(folderKey(realRoot), folderKey(realTarget));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

async function realRootOf(project: Project): Promise<string> {
  return fs.realpath(project.fsPath);
}

// Above every OS's own limit (Windows 63, Linux 40, macOS 32), so the walk never refuses a chain realpath would follow.
const MAX_LINK_HOPS = 64;

// A link target as a local Windows path: \??\C:\ is how a junction names a drive; any other \??\ path, and a drive-relative
// C:x, which resolves against a per-drive cwd the OS keeps, is undefined.
function localLinkTarget(target: string): string | undefined {
  const spelled = target.replace(/\//g, '\\');
  if (!spelled.startsWith('\\??\\')) return /^[a-z]:(?!\\)/i.test(spelled) ? undefined : spelled;
  return /^\\\?\?\\[a-z]:\\/i.test(spelled) ? spelled.slice(4) : undefined;
}

function isUnder(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether following every link along segments under base stays off UNC and device roots other than base's own, decided by
 * lstat and readlink alone, so a refused target is never opened (opening \\server\share sends the user's NTLM credentials).
 * Windows resolves a relative target lexically against the link's folder, and so does the walk. POSIX has no such roots.
 */
export async function followsLocalLinksOnly(base: string, segments: readonly string[]): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const baseRoot = path.parse(base).root.toLowerCase();
  let current = base;
  let pending = [...segments];
  for (let hops = 0; pending.length > 0; ) {
    const next = path.join(current, pending.shift()!);
    if (!(await fs.lstat(next)).isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) throw Object.assign(new Error(`Too many links under ${base}`), { code: 'ELOOP' });
    const target = localLinkTarget(await fs.readlink(next));
    if (target === undefined) return false;
    const resolved = path.resolve(current, target, ...pending);
    if (resolved.startsWith('\\\\') && path.parse(resolved).root.toLowerCase() !== baseRoot) return false;
    // current and everything above it up to base hold no link, so the walk resumes from the deepest of them it can.
    current = isUnder(current, resolved) ? current : isUnder(base, resolved) ? base : path.parse(resolved).root;
    pending = path.relative(current, resolved).split(path.sep).filter(Boolean);
  }
  return true;
}

/**
 * An existing path inside the project, following every link: its native realpath must lie under the project's, and no link
 * on the way may lead to a UNC or device path. Opens, reads, writes and listings use it.
 */
export async function confineExisting(project: Project, relativePath: string): Promise<Confined> {
  const lexical = lexicalJoin(project.fsPath, relativePath);
  if (lexical === undefined) return { ok: false, reason: 'outside' };
  try {
    if (!(await followsLocalLinksOnly(project.fsPath, segmentsOf(relativePath)))) return { ok: false, reason: 'outside' };
    const [realRoot, realTarget] = await Promise.all([realRootOf(project), fs.realpath(lexical)]);
    return isInsideRealRoot(realRoot, realTarget) ? { ok: true, path: realTarget } : { ok: false, reason: 'outside' };
  } catch (err) {
    return { ok: false, reason: isMissing(err) ? 'missing' : 'failed' };
  }
}

/**
 * A path that does not exist (a file deleted on disk): its deepest existing folder is confined as confineExisting confines,
 * and the result is that folder's realpath plus the missing segments.
 */
export async function confineMissing(project: Project, relativePath: string): Promise<Confined> {
  if (!isRelativeFilePath(relativePath) || lexicalJoin(project.fsPath, relativePath) === undefined) return { ok: false, reason: 'outside' };
  const segments = segmentsOf(relativePath);
  for (let depth = segments.length; depth >= 0; depth--) {
    const ancestor = await confineExisting(project, segments.slice(0, depth).join('/'));
    if (ancestor.ok) return { ok: true, path: path.join(ancestor.path, ...segments.slice(depth)) };
    if (ancestor.reason !== 'missing') return ancestor;
  }
  return { ok: false, reason: 'missing' };
}

/**
 * The confined folder at relativeDir, creating each missing folder on the way one at a time; every folder is confined again
 * after its mkdir, so a link swapped in never leads a write outside the project.
 */
export async function confineOrCreateFolder(project: Project, relativeDir: string): Promise<Confined> {
  let current = await confineExisting(project, '');
  const segments = segmentsOf(relativeDir);
  for (let depth = 1; depth <= segments.length && current.ok; depth++) {
    const sub = segments.slice(0, depth).join('/');
    const parent = current.path;
    current = await confineExisting(project, sub);
    if (current.ok || current.reason !== 'missing') continue;
    try {
      await fs.mkdir(path.join(parent, segments[depth - 1]!));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, reason: isMissing(err) ? 'missing' : 'failed' };
    }
    current = await confineExisting(project, sub);
  }
  return current;
}

/**
 * The entry itself, never followed: its parent's realpath must lie under the project's, no link on the way to that parent may
 * lead to a UNC or device path, and the result is that parent plus the last segment, so a rename, trash or reveal of a link
 * acts on the link and never on what it points to.
 */
export async function confineEntry(project: Project, relativePath: string): Promise<Confined & { readonly stat?: Stats }> {
  if (!isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
  const lexical = lexicalJoin(project.fsPath, relativePath);
  if (lexical === undefined) return { ok: false, reason: 'outside' };
  try {
    if (!(await followsLocalLinksOnly(project.fsPath, segmentsOf(relativePath).slice(0, -1)))) return { ok: false, reason: 'outside' };
    const [realRoot, realParent] = await Promise.all([realRootOf(project), fs.realpath(path.dirname(lexical))]);
    if (!isInsideRealRoot(realRoot, realParent)) return { ok: false, reason: 'outside' };
    const entry = path.join(realParent, path.basename(lexical));
    const stat = await fs.lstat(entry);
    return { ok: true, path: entry, stat };
  } catch (err) {
    return { ok: false, reason: isMissing(err) ? 'missing' : 'failed' };
  }
}

/** A path inside some open project, for a target that may not exist yet (Save As): its canonical path must lie under one. */
export async function projectOfPath(projects: readonly Project[], target: string): Promise<{ project: Project; relativePath: string; path: string } | undefined> {
  if (!path.isAbsolute(target)) return undefined;
  const canonical = canonicalPath(target);
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
    if (isRelativeFilePath(relativePath)) return { project, relativePath, path: canonical };
  }
  return undefined;
}
