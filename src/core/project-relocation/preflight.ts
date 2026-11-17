// Relocation preflight (docs/invariants.md "Project relocation"): every check, changing nothing. Each refusal and notice is
// a code; the host renders it.
import * as path from 'node:path';
import { authorityKeyOfProject } from '../../shared/project-location';
import { folderKey } from '../workspace-folders/folder-key';
import { chatRecordHolding, folderContains, relocatedRepositoryRoot } from '../worktrees/records';
import type { ChatWorktreeRecord, WorktreeRecord } from '../worktrees/registry';
import type { PathPresence } from '../workspace-folders/folder-presence-probe';
import type { AliasSource } from './aliases';
import { pendingRefusal } from './engine';
import type { Coded, PreflightAnswer, PreflightRequest, RelocationFolder, RelocationMode, RelocationRecord, RelocationRefusalCode } from './types';
import type { RepositoryDirs } from './worktree-links';

/** Who holds a chat, and by what: its own lease or panel, or a run that holds a part of the agent data moving with it. */
export interface ChatHold {
  readonly holder: 'otherProcess' | 'thisProcess';
  readonly by: 'chat' | 'agentRun';
}

export interface PreflightDeps {
  readonly records: () => readonly RelocationRecord[];
  /** Another app version's pending relocations, which this version cannot run but must not cross. */
  readonly foreignPending: () => readonly AliasSource[];
  /** The ids of `from`'s chats: the session files the sessions step would move, and its chats working in its chat worktrees. */
  readonly chatsOf: (from: string) => Promise<readonly string[]>;
  readonly titleOf: (sessionId: string) => Promise<string>;
  /**
   * Who holds the chat now, by its lease or the lease of an agent file in the agent data the sessions step moves with it:
   * another process, a panel, writer or run of this one, or nobody.
   */
  readonly holderOf: (sessionId: string) => Promise<ChatHold | undefined>;
  /** The path's presence, its volume asked first (folder-presence-probe.ts). */
  readonly presence: (target: string) => Promise<PathPresence>;
  /** The drive, share, WSL distro or mount point the path's presence hangs on; undefined on the system root. */
  readonly volumeOf: (target: string) => Promise<string | undefined>;
  /**
   * The chat worktree records of the project, live or deleted, and whether registry.json does not parse; none without a registry.
   * known: the records are the ones last parsed (a host's own registry), not the empty ones a registry opened unparsable reads.
   */
  readonly worktrees: (from: string) => { readonly records: readonly ChatWorktreeRecord[]; readonly unreadable: boolean; readonly known: boolean };
  /** The chat worktree a folder lies in (chatWorktreeOwner); undefined outside every one. */
  readonly chatWorktreeOf: (folder: string) => { readonly projectPath?: string } | undefined;
  /** The git dirs of the repository whose top level is the path, by plain reads. */
  readonly repositoryDirs: (root: string) => Promise<RepositoryDirs | undefined>;
  /** Whether an admin dir under <commonDir>/worktrees/ has a gitdir file naming dotGit, by plain reads. */
  readonly relinkable: (commonDir: string, dotGit: string) => Promise<boolean>;
  /** A finish action holding one of the worktrees, or a hand-off moving a chat into or out of one; none on a host without worktree chats. */
  readonly worktreeActivity?: (worktreeIds: readonly string[]) => { readonly worktreeId: string; readonly kind: 'finishing' | 'handOff' } | undefined;
  readonly damoclesHome: string;
}

/** The project's chat worktrees a relocation names, and its repository root; a broken layout is a refusal. */
export type WorktreePlan =
  | { readonly folders: readonly RelocationFolder[]; readonly repository: string | undefined }
  | { readonly refusal: Coded };

/**
 * One worktree folder per chat record, live or deleted, by its working folder, which stays where it is (its record keeps the
 * path its folder was named for); the repository root is the new folder with the project's old path in its repository stripped.
 */
export function planWorktrees(records: readonly ChatWorktreeRecord[], to: string): WorktreePlan {
  let repository: string | undefined;
  const folders: RelocationFolder[] = [];
  for (const record of records) {
    const root = relocatedRepositoryRoot(record.repositoryRoot, record.projectPath, to);
    if (root === undefined || (repository !== undefined && folderKey(repository) !== folderKey(root))) return { refusal: { code: 'repositoryLayout', params: { path: record.repositoryRoot } } };
    repository = root;
    folders.push({ kind: 'worktree', worktreeId: record.id, from: record.workingFolder, to: record.workingFolder });
  }
  return { folders, repository };
}

/**
 * The chat worktree `folder` lies in, by the record, live or deleted, whose worktree holds it: that record's project, where it is
 * now. A folder in the worktrees root no readable record names is one too, of no known project. The worktrees step re-points a
 * record, so only a pending relocation's (`pendingPairs`) can still name the old path.
 */
export function chatWorktreeOwner(folder: string, records: readonly WorktreeRecord[], worktreesRoot: string, pendingPairs: ReadonlyArray<{ readonly from: string; readonly to: string }>): { readonly projectPath?: string } | undefined {
  const record = chatRecordHolding(records, folder);
  if (record) return { projectPath: pendingPairs.find((pair) => folderKey(pair.from) === folderKey(record.projectPath))?.to ?? record.projectPath };
  return folderContains(worktreesRoot, folder) ? {} : undefined;
}

export async function runPreflight(request: PreflightRequest, deps: PreflightDeps): Promise<PreflightAnswer> {
  const refuse = (code: RelocationRefusalCode, params?: Coded['params']): PreflightAnswer => ({ ok: false, refusal: params ? { code, params } : { code } });
  const { from, to } = request;
  const notices: Coded[] = [];
  if (!path.isAbsolute(from) || !path.isAbsolute(to) || authorityKeyOfProject(folderKey(from)) !== authorityKeyOfProject(folderKey(to))) return refuse('otherAuthority');
  if (folderKey(from) === folderKey(to)) return refuse('sameFolder');
  if (folderContains(deps.damoclesHome, to)) return refuse('insideDamocles');
  // A chat worktree's place is its record's (worktreeFolderFor), and its project's relocation re-points it.
  const owner = deps.chatWorktreeOf(from);
  if (owner) return refuse('chatWorktree', owner.projectPath !== undefined ? { projectPath: owner.projectPath } : undefined);

  // Copying a folder is not moving it, so the old folder must be gone; a volume that does not answer cannot say so.
  const fromPresence = await deps.presence(from);
  if (fromPresence === 'directory' || fromPresence === 'other') return refuse('fromExists');
  if (fromPresence === 'unreachable') notices.push({ code: 'unreachable', params: { root: (await deps.volumeOf(from)) ?? path.parse(path.resolve(from)).root } });

  const toPresence = await deps.presence(to);
  if (toPresence === 'missing' || toPresence === 'unreachable') return refuse('toMissing');
  if (toPresence !== 'directory') return refuse('toNotDirectory');

  const pending = pendingRefusal(deps.records(), [{ kind: 'project', from, to }], deps.foreignPending());
  if (pending) return { ok: false, refusal: pending };

  const chats = await deps.chatsOf(from);
  for (const sessionId of chats) {
    const hold = await deps.holderOf(sessionId);
    // the host closes its own chats before the move, which ends no agent run
    if (hold === undefined || (hold.by === 'chat' && hold.holder === 'thisProcess' && request.heldHere === 'ignore')) continue;
    return refuse(hold.by === 'chat' ? 'chatHeld' : 'agentRunHeld', { sessionId, title: await deps.titleOf(sessionId), holder: hold.holder });
  }

  const worktrees = deps.worktrees(from);
  if (worktrees.unreadable && (worktrees.records.length > 0 || !worktrees.known)) return refuse('registryUnreadable');
  const busy = deps.worktreeActivity?.(worktrees.records.map((record) => record.id));
  if (busy) return refuse(busy.kind === 'finishing' ? 'worktreeFinishing' : 'worktreeHandOff', { branch: worktrees.records.find((record) => record.id === busy.worktreeId)?.branch ?? busy.worktreeId });
  const plan = planWorktrees(worktrees.records, to);
  if ('refusal' in plan) return { ok: false, refusal: plan.refusal };
  const live = worktrees.records.filter((record) => record.deletedAt === undefined);
  if (live.length > 0 && plan.repository !== undefined) {
    const dirs = await deps.repositoryDirs(plan.repository);
    if (!dirs) return refuse('noRepository', { path: plan.repository });
    // A clone of the repository has no admin dir naming the old worktrees, so git cannot link them to it.
    const unlinkable: string[] = [];
    for (const record of live) if (!(await deps.relinkable(dirs.commonDir, path.join(record.worktreeRoot, '.git')))) unlinkable.push(record.branch);
    if (unlinkable.length > 0) notices.push({ code: 'worktreesNotRelinkable', params: { count: unlinkable.length, branches: unlinkable.join(', ') } });
  }

  const listedTarget = request.listed.find((listed) => folderKey(listed) === folderKey(to));
  const mode: RelocationMode = listedTarget !== undefined ? 'merge' : 'locate';
  if (listedTarget !== undefined) notices.push({ code: 'merge', params: { projectPath: listedTarget } });
  const holding = request.listed.find((listed) => folderKey(listed) !== folderKey(to) && folderKey(listed) !== folderKey(from) && folderContains(listed, to));
  if (holding !== undefined) notices.push({ code: 'insideProject', params: { projectPath: holding } });
  return { ok: true, mode, chats: chats.length, worktrees: worktrees.records.length, notices };
}
