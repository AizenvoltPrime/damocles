import type { CoreClient } from './core-client';

/**
 * The project of a chat working in `folderKey`: the project core reports holding the folder (a worktree's own project,
 * AD12), else a listed project core has not reported yet, else core's default target, where core sets up or moves a chat
 * whose folder left the project list (PanelManager.setUpHost, movePanelOffRemovedFolders).
 */
export function chatProjectKey(folderKey: string, client: Pick<CoreClient, 'projectOf' | 'defaultTarget'>, listed: (key: string) => boolean): string | undefined {
  return client.projectOf(folderKey)?.key ?? (listed(folderKey) ? folderKey : client.defaultTarget()?.key);
}
