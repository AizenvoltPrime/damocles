// A Chats row's worktree badge and read-only state (AD12 Listing): from core's state of a loaded chat, else from the
// stored session's latest worktree entry, else from the adopted record of the folder it was listed from.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatPlace, WorktreeStateData } from '../../../shared/types/messages';
import type { ChatWorktreeRecord } from '../../../core/worktrees/registry';
import type { WorktreeRecordReader } from './records';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { ShellChatWorktree, WorktreeFinishState } from '../../preload/shell-channels';

export interface ChatRowSources {
  // core's last worktree state of the loaded chat
  readonly live?: { readonly worktreeId?: string; readonly state: WorktreeStateData };
  // the stored session's latest worktree entry, and the folder whose session directory listed it when not the project's
  readonly stored?: { readonly worktree?: { readonly worktreeId: string; readonly place: ChatPlace }; readonly listedFrom?: string };
}

export interface ChatRowDeps {
  readonly registry: WorktreeRecordReader;
  readonly finish: (record: ChatWorktreeRecord) => WorktreeFinishState;
  // the branch checked out in the project folder; undefined while detached
  readonly baseBranch: (record: ChatWorktreeRecord) => string | undefined;
}

export function chatRowWorktree(sources: ChatRowSources, deps: ChatRowDeps): { readonly worktree?: ShellChatWorktree; readonly readOnly: boolean } {
  const { live, stored } = sources;
  if (live?.state.phase === 'pending') {
    const branch = live.state.branch ?? live.state.baseBranch;
    return { worktree: { status: 'pending', branch: branch ?? '' }, readOnly: false };
  }
  // core binds a loaded chat, so its read-only state decides over what the registry and the entry say
  const deletedLive = live?.state.phase === 'deleted';
  const worktreeId = live?.worktreeId ?? stored?.worktree?.worktreeId;
  if (worktreeId !== undefined) {
    const record = deps.registry.get(worktreeId);
    const place = live?.state.place ?? stored?.worktree?.place ?? 'worktree';
    // a chat handed back works in the project folder, so its worktree going leaves it a normal, writable chat
    if (!deletedLive && place === 'project' && (record?.kind !== 'chat' || record.deletedAt !== undefined)) return { readOnly: false };
    if (record?.kind === 'chat' && record.deletedAt === undefined && !deletedLive) {
      const baseBranch = live?.state.baseBranch ?? deps.baseBranch(record);
      return {
        worktree: { worktreeId, branch: record.branch, status: place === 'project' ? 'inProjectFolder' : 'live', ...(baseBranch !== undefined ? { baseBranch } : {}), finish: deps.finish(record) },
        readOnly: false,
      };
    }
    return { worktree: { worktreeId, branch: record?.branch ?? '', status: 'deleted' }, readOnly: true };
  }
  const listedFrom = stored?.listedFrom;
  const adopted = listedFrom === undefined ? undefined : deps.registry.records().find((record) => record.kind === 'adopted' && folderKey(record.workingFolder) === folderKey(listedFrom));
  if (!adopted || (adopted.deletedAt === undefined && fs.existsSync(adopted.workingFolder))) {
    return deletedLive ? { worktree: { branch: '', status: 'deleted' }, readOnly: true } : { readOnly: false };
  }
  return {
    worktree: { worktreeId: adopted.id, branch: adopted.branch ?? '', status: 'deleted', fromProject: path.basename(adopted.workingFolder) },
    readOnly: true,
  };
}
