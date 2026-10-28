import type { FileRef } from '../../preload/shell-channels';
import { isAbsoluteOn, isInsideFolder, pathFor } from '../../../shared/project-location';
import { isRelativeFilePath } from '../../../shared/relative-path';
import type { RemoteProject } from './authorities';

// realPath: the folder's realpath on the target, as its core resolved it, which is the form its repository roots take
export type RemoteFileRoot = RemoteProject & { readonly realPath?: string };

/**
 * A path a remote core named, as the project file it is: inside one of `projects` (one authority's), at its realpath or as
 * registered, by the target's own path rules, with a relative path a renderer may name; undefined for anything else (another
 * root, a UNC or drive path, `..`). The match is lexical: the target confines the file again when it is read or written.
 */
export function remoteFileRef(projects: readonly RemoteFileRoot[], targetPath: string): FileRef | undefined {
  for (const project of projects) {
    const flavor = pathFor(project);
    if (!isAbsoluteOn(project, targetPath)) continue;
    for (const folder of project.realPath === undefined ? [project.fsPath] : [project.realPath, project.fsPath]) {
      const relative = flavor.relative(folder, targetPath);
      const relativePath = relative.split(flavor.sep).join('/');
      if (isRelativeFilePath(relativePath) && !flavor.isAbsolute(relative)) return { projectKey: project.key, relativePath };
    }
  }
  return undefined;
}

/**
 * The folder key of the project a terminal's start folder belongs to: the deepest of `roots` (one authority's projects and
 * chat worktrees, a worktree carrying its project's key) that holds cwd, so a project opened inside another keeps its own.
 */
export function projectOfCwd(roots: readonly RemoteProject[], cwd: string): string | undefined {
  const holding = roots.filter((root) => isInsideFolder(root, root.fsPath, cwd));
  return holding.sort((a, b) => b.fsPath.length - a.fsPath.length)[0]?.folderKey;
}
