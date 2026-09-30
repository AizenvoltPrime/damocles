import type { WorkspaceFolders } from '../../../platform/workspace-folders';
import type { ProjectList } from '../projects';

// The project list is the desktop's set of open folders; an empty list yields the registry's home target.
export function createDesktopWorkspaceFolders(projects: ProjectList): WorkspaceFolders {
  return {
    folders: () => projects.folders(),
    onDidChange: (cb) => projects.onDidChange(cb),
  };
}
