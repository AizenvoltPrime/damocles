import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { LinkRoot } from '../../platform/file-confinement';
import { folderKey } from './folder-key';

/** Whether realTarget is realRoot or lies under it; both must already be native realpaths. */
export function isInsideRealRoot(realRoot: string, realTarget: string): boolean {
  const relative = path.relative(folderKey(realRoot), folderKey(realTarget));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The link root realTarget lies under: the realpath of the deepest link among segments below folder, each prefix told apart by
 * lstat. undefined when no prefix is a link or realTarget is not under that link's realpath, as when a link was swapped meanwhile.
 */
export async function linkRootOf(folder: string, segments: readonly string[], realTarget: string): Promise<LinkRoot | undefined> {
  for (let depth = segments.length; depth > 0; depth--) {
    const prefix = path.join(folder, ...segments.slice(0, depth));
    if (!(await fs.lstat(prefix)).isSymbolicLink()) continue;
    const realRoot = await fs.realpath(prefix);
    return isInsideRealRoot(realRoot, realTarget) ? { link: segments.slice(0, depth).join('/'), realRoot } : undefined;
  }
  return undefined;
}
