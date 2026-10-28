// Opening a folder as a project of its own on an authority: the folder browser's pick and Files' Open as project.
import { authorityKeyOfProject, isInsideFolder, pathFor } from '../../shared/project-location';
import { hasUnsafeWindowsSegment } from '../../shared/relative-path';
import type { OpenAsProjectRequest, OpenAsProjectResult } from '../preload/shell-channels';
import type { RootProject } from './worktrees/roots';

export interface OpenAsProjectDeps {
  // the project folder or live chat worktree a root key names, with the OS its paths are on; undefined for any other key
  readonly resolve: (rootKey: string) => (RootProject & { readonly os: NodeJS.Platform }) | undefined;
  // whether this build serves the authority's projects (the remote gate, the loopback flag)
  readonly served: (authorityKey: string) => boolean;
  readonly isDirectory: (authorityKey: string, folder: string) => Promise<boolean>;
  // the key the folder has as a project of the authority, computed by the folder's own OS
  readonly projectKeyOf: (authorityKey: string, folder: string) => Promise<string>;
  readonly isProject: (projectKey: string) => boolean;
  // writes the folder into the project stores, right after `after` in the sidebar order, else last
  readonly add: (authorityKey: string, folder: string, projectKey: string, after: string | undefined) => Promise<void>;
  // the new-project trust question, asked only while the project is untrusted
  readonly requestTrust: (projectKey: string) => Promise<void>;
  readonly select: (projectKey: string) => Promise<void>;
  // the localized refusal of a folder that is not a directory on the authority
  readonly notFolder: (authorityKey: string, folder: string) => Error;
}

/**
 * Adds the authority's folder as a project right after `after`, asks the trust question as any new project does and selects
 * it; a folder that is a project already is selected instead.
 */
export async function openFolderAsProject(deps: OpenAsProjectDeps, authorityKey: string, folder: string, after?: string): Promise<OpenAsProjectResult> {
  if (!(await deps.isDirectory(authorityKey, folder))) throw deps.notFolder(authorityKey, folder);
  const projectKey = await deps.projectKeyOf(authorityKey, folder);
  if (deps.isProject(projectKey)) {
    await deps.select(projectKey);
    return { projectKey, added: false };
  }
  await deps.add(authorityKey, folder, projectKey, after);
  await deps.requestTrust(projectKey);
  await deps.select(projectKey);
  return { projectKey, added: true };
}

/** Files' Open as project: a folder inside a shown project or worktree, opened on that project's authority after it. */
export async function openAsProject(deps: OpenAsProjectDeps, request: OpenAsProjectRequest): Promise<OpenAsProjectResult> {
  const root = deps.resolve(request.projectKey);
  if (!root) throw new Error('The project is no longer in the project list');
  const source = root.root.projectKey;
  const authorityKey = authorityKeyOfProject(source);
  if (!deps.served(authorityKey)) throw new Error(`${authorityKey} projects are not enabled in this build`);
  // Win32 path normalization strips a trailing dot or space, so '.. ' would name the parent
  if (root.os === 'win32' && hasUnsafeWindowsSegment(request.relativePath)) throw new Error('The folder name is not one Windows can open');
  const flavor = pathFor(root);
  const folder = flavor.join(root.fsPath, ...request.relativePath.split('/'));
  if (!isInsideFolder(root, root.fsPath, folder)) throw new Error('The folder is not inside the project');
  return openFolderAsProject(deps, authorityKey, folder, source);
}
