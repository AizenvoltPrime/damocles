import type { WorktreeRecord } from '../../core/worktrees/registry';
import type { FolderTargetEntry } from '../core-protocol';
import type { CoreClient } from './core-client';

export interface SavedChatProjectDeps {
  // main's project list
  readonly listed: (key: string) => boolean;
  // this computer's worktree registry as core published it, which core sends before it is ready
  readonly records: readonly WorktreeRecord[];
  readonly keyOf: (fsPath: string) => string;
  // the listed project a finished move left for this key, while the move's host part has not changed the list yet
  readonly movedFrom: (key: string) => string | undefined;
  // chatProjectKey of the key, else the key
  readonly resolve: (key: string) => string;
}

/**
 * Whether a project key keeps its per-project state through a list change: it is listed, or a finished move whose source is
 * still listed re-keyed it there (movedProjects: destination key to source key) before the move's host part changed the list.
 */
export function projectStays(key: string, listed: (key: string) => boolean, movedProjects: ReadonlyMap<string, string>): boolean {
  const from = movedProjects.get(key);
  return listed(key) || (from !== undefined && listed(from));
}

/**
 * The project a saved chat reopens in, read before core bound any chat: a chat worktree's working folder that is no listed
 * project is its record's project (live first, else deleted), since core reports no owner for a folder no chat holds yet; a
 * move's destination whose host part is pending is the project it left, whose chats that part reopens.
 */
export function savedChatProjectKey(folder: string, deps: SavedChatProjectDeps): string {
  const worktree = (live: boolean): WorktreeRecord | undefined => deps.records.find((record) => record.kind === 'chat' && (record.deletedAt === undefined) === live && deps.keyOf(record.workingFolder) === folder);
  const record = deps.listed(folder) ? undefined : worktree(true) ?? worktree(false);
  const project = record?.kind === 'chat' ? deps.keyOf(record.projectPath) : folder;
  return deps.resolve(deps.movedFrom(project) ?? project);
}

/**
 * The project of a chat working in `folder`: for a chat core reported (its `ChatEntry.folder`), the owner of a working folder it
 * holds, else that folder as a project (docs/invariants.md "Worktree chats", Ownership); for a bare folder key, the project core
 * reports holding it. Then that project as core reports it, else as main lists it before core reports it, else core's default
 * target, where core sets up or moves a chat whose folder left the project list (PanelManager.setUpHost,
 * movePanelOffRemovedFolders).
 */
export function chatProjectKey(folder: Pick<FolderTargetEntry, 'key' | 'ownerKey'> | string, client: Pick<CoreClient, 'project' | 'projectOf' | 'defaultTarget'>, listed: (key: string) => boolean): string | undefined {
  const key = typeof folder === 'string' ? client.projectOf(folder)?.key ?? folder : folder.ownerKey ?? folder.key;
  return client.project(key)?.key ?? (listed(key) ? key : client.defaultTarget()?.key);
}

/**
 * The project a kept remote chat is tracked under until its core binds it: the project its record names while that project
 * is listed, else the listed project a finished move left for it while the move's host part has not changed the list, else
 * core's default target, where core places a chat whose folder left the list.
 */
export function keptRemoteChatProjectKey(record: { readonly projectKey?: string }, deps: Pick<SavedChatProjectDeps, 'listed' | 'movedFrom'> & { readonly defaultKey: string }): string {
  if (record.projectKey === undefined) return deps.defaultKey;
  return deps.listed(record.projectKey) ? record.projectKey : deps.movedFrom(record.projectKey) ?? deps.defaultKey;
}
