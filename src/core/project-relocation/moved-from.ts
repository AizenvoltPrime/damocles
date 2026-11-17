// projects.movedFrom (docs/invariants.md "Project relocation"): the recorded project folders whose chats a newly opened folder
// may take over, because it is a clone or a move of their repository.
import { folderKey } from '../workspace-folders/folder-key';
import type { FolderIdentity } from './identity';
import type { RecordedIdentity } from './identity-store';
import type { PathPresence } from '../workspace-folders/folder-presence-probe';
import type { MovedFromCandidate } from './types';

export interface MovedFromDeps {
  readonly recorded: () => Promise<readonly RecordedIdentity[]>;
  /** The project folder of every pending relocation, another app version's included. */
  readonly relocationSources: () => readonly string[];
  /** Whether the folder lies in a chat worktree, which is never relocated on its own (chatWorktreeOwner). */
  readonly inChatWorktree: (folder: string) => boolean;
  /** The path's presence, its volume asked first (folder-presence-probe.ts), so `missing` is a folder gone from a volume that answers. */
  readonly presence: (target: string) => Promise<PathPresence>;
  readonly chatsOf: (from: string) => Promise<number>;
  /** The root commits of `to`; read only for a folder that can match by them alone, since git walks the history. */
  readonly rootsOfTarget: () => Promise<readonly string[]>;
}

/**
 * Recorded folders that are missing on a volume that is there, hold chats, are no pending relocation's source, lie at the same
 * place in their repository as `to` and share a remote or a root commit with it; neither side may lie in a chat worktree.
 */
export async function movedFromCandidates(to: string, identity: Omit<FolderIdentity, 'roots'>, deps: MovedFromDeps): Promise<MovedFromCandidate[]> {
  if (deps.inChatWorktree(to)) return [];
  const sources = new Set(deps.relocationSources().map(folderKey));
  let roots: Promise<readonly string[]> | undefined;
  const candidates: MovedFromCandidate[] = [];
  for (const entry of await deps.recorded()) {
    const key = folderKey(entry.path);
    if (key === folderKey(to) || sources.has(key) || entry.subpath !== identity.subpath || deps.inChatWorktree(entry.path)) continue;
    const sharesRemote = entry.remotes.some((remote) => identity.remotes.includes(remote));
    if (!sharesRemote && entry.roots.length === 0) continue;
    if ((await deps.presence(entry.path)) !== 'missing') continue;
    const chats = await deps.chatsOf(entry.path);
    if (chats === 0) continue;
    if (!sharesRemote) {
      const here = await (roots ??= deps.rootsOfTarget());
      if (!entry.roots.some((root) => here.includes(root))) continue;
    }
    candidates.push({ from: entry.path, chats });
  }
  return candidates;
}
