import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { authorityKeyOfProject } from '../../../shared/project-location';

/** An authority main holds no connection to; the message is localized and names the host. */
export class NotConnectedError extends Error {
  override readonly name = 'NotConnectedError';
}

/** The workspace of each authority, by project. */
export interface Workspaces {
  // this computer's: the home folder, files core names by path, and every local project
  readonly local: ProjectWorkspace;
  // the workspace serving a project's root key; null names the home folder
  forProject(projectKey: string | null): ProjectWorkspace;
  // the workspace of an authority key, for its host's own files outside every project
  forAuthority(authorityKey: string): ProjectWorkspace;
  dispose(): void;
}

// remote: the connected workspace of an authority key other than local; it throws NotConnectedError while that authority is not
// connected
export function createWorkspaces(local: ProjectWorkspace, remote: (authorityKey: string) => ProjectWorkspace): Workspaces {
  const forAuthority = (authorityKey: string): ProjectWorkspace => (authorityKey === 'local' ? local : remote(authorityKey));
  return {
    local,
    forProject: (projectKey) => forAuthority(projectKey === null ? 'local' : authorityKeyOfProject(projectKey)),
    forAuthority,
    dispose: () => local.format.dispose(),
  };
}
