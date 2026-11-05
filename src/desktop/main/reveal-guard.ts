// The Reveal check in main's one reveal sink (docs/invariants.md "Desktop host", Confinement): Explorer contacts a UNC or
// device path it is shown, which sends the user's NTLM credentials to its server.
import * as path from 'node:path';
import type { Project } from '../local-services/confine';
import { authorityKeyOfProject, isUncOrDevicePath } from '../../shared/project-location';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { isReservedWindowsName, isUnsafeWindowsName } from '../../shared/relative-path';
import { outsideSegments, type OutsideResolution } from '../workspace/file-system';
import { wslUncToLinux } from './remote/wsl/wsl-paths';
import type { RootSpellings } from './workspace/root-spellings';

export interface RevealGuardDeps {
  // this computer's OS
  readonly os: NodeJS.Platform;
  // the roots main lists, of every authority; only this computer's count
  readonly roots: readonly Project[];
  readonly spellings: Pick<RootSpellings, 'holding' | 'match' | 'contains'>;
  // the distro of each saved WSL host
  readonly wslDistros: readonly string[];
  // this computer's outside rule (WorkspaceFileSystem.resolveOutside), which walks a drive path from its root
  readonly resolveOutside: (target: string) => Promise<OutsideResolution>;
  // whether the '/'-separated path below a root's folder, in a spelling of it, follows no link to a share or device
  // (followsLocalLinksOnly); a missing part has nothing left to follow
  readonly walksBelow: (root: string, relativePath: string) => Promise<boolean>;
}

// A part of below, the path after its root, that Windows rewrites, refuses or reads as something else before Explorer opens
// it (isUnsafeWindowsName), but for a device name, which a root may hold, or an empty part but the last.
function hasRewrittenPart(below: string): boolean {
  const parts = below.split(/[\\/]/);
  return parts.some((part, index) => (part === '' ? index < parts.length - 1 : isUnsafeWindowsName(part) && !isReservedWindowsName(part)));
}

// true when Explorer may show a path, else the refusal's reason: 'name' when its own spelling decided it, else 'share'
export type RevealVerdict = true | 'share' | 'name';

/**
 * Whether Explorer may show or open target, the entry itself included (docs/invariants.md "Desktop host", Confinement).
 * Always off win32. Rejects when a walk fails.
 */
export async function revealAllowed(target: string, deps: RevealGuardDeps): Promise<RevealVerdict> {
  if (deps.os !== 'win32') return true;
  if (target.includes('\0')) return 'name';
  if (isUncOrDevicePath(target)) return uncAllowed(target, deps, true);
  if (!/^[A-Za-z]:[\\/]/.test(target) || hasRewrittenPart(target.slice(3))) return 'name';
  const holders = localRoots(deps).flatMap((root) => {
    const parts = partsBelow(root.fsPath, target);
    return parts === undefined ? [] : [{ root, parts }];
  });
  // a root's own folder may be a link to a share the user opened as a project, so only the part below it is walked
  if (holders.some((holder) => holder.parts.length === 0)) return true;
  // the deepest root holding target by its open path, which a deeper root's realpath spelling never shadows
  const held = holders.sort((a, b) => a.parts.length - b.parts.length)[0];
  if (held) return (await deps.walksBelow(held.root.fsPath, held.parts.join('/'))) || 'share';
  // outsideSegments follows process.platform's path rules, which deps.os must name
  const lexical = outsideSegments(target);
  if (typeof lexical === 'string') return lexical;
  const resolved = await deps.resolveOutside(target);
  // resolveOutside walked the path from its drive, links on the share included
  if (resolved.kind === 'share') return uncAllowed(resolved.path, deps, false);
  return resolved.kind === 'outside' ? resolved.reason : true;
}

/** RevealGuardDeps.walksBelow through follows (followsLocalLinksOnly), where a missing part has nothing left to follow. */
export function walkingBelow(follows: (base: string, segments: readonly string[]) => Promise<boolean>): RevealGuardDeps['walksBelow'] {
  return async (root, relativePath) => {
    try {
      return await follows(root, relativePath === '' ? [] : relativePath.split('/'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return true;
      throw err;
    }
  };
}

/** The Reveal check's rejection, whose message is shown as it is: a LocalizedError's becomes its text rendered by render. */
export function withRenderedMessage(err: unknown, render: (text: LocalizedText) => string): unknown {
  return err instanceof LocalizedError ? Object.assign(err, { message: render(err.text) }) : err;
}

// The parts of a drive path below root's folder, compared as spelled but for the drive letter, since an NTFS folder can be
// case-sensitive and hold a sibling that differs from a root only in case; undefined when root does not hold it.
function partsBelow(root: string, target: string): string[] | undefined {
  const exact = (file: string): string => {
    const resolved = path.win32.resolve(file);
    return /^[a-z]:/.test(resolved) ? resolved[0]!.toUpperCase() + resolved.slice(1) : resolved;
  };
  const folder = exact(root);
  const file = exact(target);
  if (file === folder) return [];
  const prefix = folder.endsWith('\\') ? folder : `${folder}\\`;
  return file.startsWith(prefix) ? file.slice(prefix.length).split('\\').filter(Boolean) : undefined;
}

function localRoots(deps: RevealGuardDeps): Project[] {
  return deps.roots.filter((root) => authorityKeyOfProject(root.key) === 'local');
}

async function uncAllowed(target: string, deps: RevealGuardDeps, walk: boolean): Promise<RevealVerdict> {
  const wsl = wslUncToLinux(target);
  // Windows names a share case-insensitively, the distro's included
  if (wsl !== undefined && deps.wslDistros.some((distro) => distro.toLowerCase() === wsl.distro.toLowerCase())) return true;
  if (hasRewrittenPart(target.slice(path.win32.parse(target).root.length))) return 'name';
  const location = { authority: 'local', os: deps.os } as const;
  const local = localRoots(deps);
  // a root's own folder in a spelling passes without waiting on another root's realpath
  if (!deps.spellings.holding(location, local, target) && deps.spellings.contains(location, local, target)) return true;
  const held = await deps.spellings.match(location, local, target);
  if (held) return !walk || (await deps.walksBelow(held.spelling, held.relativePath)) || 'share';
  return deps.spellings.contains(location, local, target) || 'share';
}
