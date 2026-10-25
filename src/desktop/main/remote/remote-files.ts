import type { FileRef } from '../../preload/shell-channels';
import { pathFor } from '../../../shared/project-location';
import { isRelativeFilePath } from '../../../shared/relative-path';
import type { RemoteProject } from './authorities';

/**
 * A path a remote core named, as the project file it is: inside one of `projects` (one authority's) by the target's own path
 * rules, with a relative path a renderer may name; undefined for anything else (another root, a UNC or drive path, `..`).
 */
export function remoteFileRef(projects: readonly RemoteProject[], targetPath: string): FileRef | undefined {
  for (const project of projects) {
    const flavor = pathFor(project);
    if (!flavor.isAbsolute(targetPath)) continue;
    const relative = flavor.relative(project.fsPath, targetPath);
    const relativePath = relative.split(flavor.sep).join('/');
    if (isRelativeFilePath(relativePath) && !flavor.isAbsolute(relative)) return { projectKey: project.key, relativePath };
  }
  return undefined;
}
