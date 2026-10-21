/**
 * chat-review.ts — A chat's review (D60) on its live session: it recomputes chat-changes.ts's file set debounced and off pi's
 * handlers, on one ordered chain as checkpoint work runs, and serves the review tab's reads and the composed review message
 * from one snapshot per scope, read again only once its inputs changed.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../shared/types/messages';
import { log } from '../logger';
import { folderKey } from '../workspace-folders/folder-key';
import {
  agentInvocationsOnBranch,
  indexAgentFiles,
  indexTeamMemberFiles,
  readAgentFile,
  segmentForInvocation,
  subagentsDir,
  teamMembersDir,
  type PersistedAgentMessage,
} from './agent-records';
import {
  changeTotals,
  collectRecords,
  composeReviewMessage,
  diffLine,
  lineAnchor,
  nowPath,
  projectChatChanges,
  turnsOnBranch,
  unifiedDiff,
  worktreeChanges,
  type ChatChangeFile,
  type ChatChangesIo,
  type ChatScope,
  type DiskRead,
  type HandOff,
  type ReviewComment,
  type WorktreeGit,
} from './chat-changes';
import { getCheckpointEntries, getFolderRepoDir, type PendingBaseline } from './checkpoints';
import { classifyFileBytes, createBlobReaders, type BlobReaders } from './checkpoints/blob-reader';
import { repoDirOf } from './session-store/rewind';

// The counter recomputes this long after the last change that could move it.
export const CHAT_CHANGES_DEBOUNCE_MS = 500;

/** The live session as the review reads it; undefined while the chat has no session file. */
export interface ReviewSession {
  readonly branch: readonly SessionEntry[];
  readonly sessionId: string;
  readonly sessionFile: string;
  // the workspace pi session dir, which holds the agent files
  readonly sessionDir: string;
  // the chat's working folder now
  readonly cwd: string;
  // the chat takes file checkpoints (a project folder); a home-folder chat rebuilds every baseline from its patches
  readonly fileCheckpoints: boolean;
  // the folder the chat worked in before its first hand-off (D61), and each hand-off after it
  readonly initialFolder?: string;
  readonly handOffs?: readonly HandOff[];
  // a chat working in its live chat worktree: D60's worktree rule replaces its records
  readonly worktree?: { readonly root: string; readonly baseCommit: string; readonly git: WorktreeGit; readonly sharedWith: () => Promise<number> };
}

export interface ChatReviewDeps {
  // HostCapabilities.chatReview: nothing is computed without it
  readonly enabled: () => boolean;
  readonly session: () => ReviewSession | undefined;
  // the running turn's in-memory before-commit
  readonly pendingBaseline: () => Promise<PendingBaseline | undefined>;
  // the one publisher's sink (PiSession.publishChatChanges), with the generation the totals were computed at
  readonly publish: (totals: ChatChangeTotals, generation: number) => void;
  // watches the files of one folder (non-recursively); onChange fires for any of its entries
  readonly watchFolder: (folder: string, onChange: (fsPath: string) => void) => Disposable;
}

export interface ChatChangeTotals {
  readonly added: number;
  readonly removed: number;
  readonly files: number;
}

/** A scope's files, and whether shell commands' changes are left out (a project-folder chat). */
export interface ChatReviewSnapshot {
  readonly files: readonly ChatChangeFile[];
  readonly shellChangesNotListed: boolean;
  /** Other chats working in this chat's worktree, whose changes the worktree's list includes; absent when 0 or not a worktree chat. */
  readonly sharedWith?: number;
  // the review's input generation the files were read at: equal generations list the same files
  readonly generation: number;
}

/** A line comment as the review checks it: the renderer's fields, and the anchor main recorded when the comment arrived. */
export interface DraftComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'added' | 'removed' | 'context';
  readonly scope: ChatScope;
  readonly text: string;
  // lineAnchor of the commented line in core's diff the comment was made on; undefined when that diff was not the current one
  readonly anchor: string | undefined;
}

/** Where a comment was made: the line, and the revision core served with the diff the tab showed. */
export interface CommentPlace {
  readonly path: string;
  readonly line: number;
  readonly side: 'added' | 'removed' | 'context';
  readonly scope: ChatScope;
  readonly revision: string;
}

/** A file's diff in the review: the patch with the revision of the diff it prints, or why there is none. */
export type ReviewFileDiff = { readonly kind: 'patch'; readonly patch: string; readonly revision: string } | { readonly kind: 'binary' | 'tooLarge' | 'unreadable' | 'missing' };

export type ComposeResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'stale'; readonly stale: readonly DraftComment[] };

/** What a review send did: `stale` names every comment that kept the whole send from going. */
export type ReviewSubmitOutcome = 'sent' | 'queued' | 'empty' | 'unsent' | { readonly stale: readonly DraftComment[] };

// The one staleness rule (D60): no hunk of the comment's scope shows its line now, or the line or one either side of it
// differs from the anchor recorded when the comment was made, which is undefined for a comment made on an older diff.
function isStale(file: ChatChangeFile | undefined, draft: DraftComment): boolean {
  return file === undefined || diffLine(file, draft.side, draft.line) === undefined || lineAnchor(file, draft.side, draft.line) !== draft.anchor;
}

/** The file on disk now, as the review compares it: an unsaved buffer is not now. A read that fails lists the file unread. */
export async function readDiskText(absolute: string): Promise<DiskRead> {
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return { kind: 'absent' };
    if (stat.size > EDITOR_MAX_DOCUMENT_BYTES) return { kind: 'tooLarge' };
    return classifyFileBytes(await fs.readFile(absolute));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    log('[ChatReview] reading %s failed: %s', absolute, code ?? String(err));
    return { kind: 'unreadable' };
  }
}

// Each agent invocation's messages by the parent's tool call id: a subagent's segment for that launch or resume; a team's
// members' messages in time order under its first invocation, since member attempts are not tied to one call.
async function agentMessagesOf(session: ReviewSession): Promise<Map<string, readonly PersistedAgentMessage[]>> {
  const out = new Map<string, readonly PersistedAgentMessage[]>();
  const invocations = agentInvocationsOnBranch(session.branch);
  if (invocations.length === 0) return out;
  const subagents = invocations.some((invocation) => invocation.kind === 'subagent') ? (await indexAgentFiles(subagentsDir(session.sessionDir, session.sessionId))).paths : new Map<string, string>();
  const teamsSeen = new Set<string>();
  for (const invocation of invocations) {
    if (invocation.kind === 'subagent') {
      const file = subagents.get(invocation.id);
      const parsed = file ? await readAgentFile(file) : null;
      const segment = parsed ? segmentForInvocation(parsed, invocation) : undefined;
      if (segment) out.set(invocation.toolCallId, segment.messages);
      continue;
    }
    if (teamsSeen.has(invocation.id)) continue;
    teamsSeen.add(invocation.id);
    const members = await indexTeamMemberFiles(teamMembersDir(session.sessionDir, session.sessionId, invocation.id));
    const messages: PersistedAgentMessage[] = [];
    for (const attempts of members.values()) {
      for (const attempt of attempts) messages.push(...((await readAgentFile(attempt.path))?.messages ?? []));
    }
    // a stable sort: one member's messages keep their order, and two members' patches to one file apply in time order
    out.set(invocation.toolCallId, messages.sort((a, b) => timestampOf(a) - timestampOf(b)));
  }
  return out;
}

const timestampOf = (message: PersistedAgentMessage): number => (typeof message['timestamp'] === 'number' ? message['timestamp'] : 0);

// A worktree read failed because the worktree folder is gone (removed outside Damocles while the chat works in it).
class WorktreeGoneError extends Error {
  readonly root: string;

  constructor(root: string, cause: unknown) {
    super(`${root} no longer exists`, { cause });
    this.name = 'WorktreeGoneError';
    this.root = root;
  }
}

// Only lstat's own answer that nothing is there; any other failure (a denied folder) proves nothing is gone.
async function isMissing(absolute: string): Promise<boolean> {
  try {
    await fs.lstat(absolute);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

// What a snapshot was read from on the session itself; any change of it is a new generation.
function sessionKeyOf(session: ReviewSession | undefined): string {
  if (!session) return '';
  return [session.sessionId, session.branch.at(-1)?.id ?? '', session.cwd, session.worktree?.root ?? '', session.worktree?.baseCommit ?? ''].join('\0');
}

interface Read {
  readonly files: readonly ChatChangeFile[];
  readonly shellChangesNotListed: boolean;
  readonly generation: number;
  // every file the records changed (listed or back at its baseline), where it is now
  readonly watched: readonly string[];
}

/** One chat's review state on its live session. */
export class ChatReview {
  private readonly deps: ChatReviewDeps;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  // a debounced run waits on the chain and has not started; another is never queued behind it
  private runQueued = false;
  private disposed = false;
  // bumped by schedule() and by a new session key; a cached read of an older generation is read again
  private generation = 0;
  private sessionKey = '';
  private readonly reads = new Map<ChatScope, { readonly generation: number; readonly read: Promise<Read> }>();
  // the folders of every file the chat's records changed, watched so an edit on disk (back to the baseline, or from outside
  // the chat) recomputes the review; keyed by folder, holding the files it watches for
  private readonly watched = new Map<string, { files: ReadonlySet<string>; readonly watcher: Disposable }>();
  // the blob readers of the reads in flight, closed when their read ends or the review is disposed
  private readonly readers = new Set<BlobReaders>();

  constructor(deps: ChatReviewDeps) {
    this.deps = deps;
  }

  /** Something that may move the counter happened: later reads see it, and the counter recomputes once things settle. */
  schedule(): void {
    if (this.disposed) return;
    this.generation++;
    if (!this.deps.enabled()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.runQueued) return;
      this.runQueued = true;
      this.enqueue(async () => {
        this.runQueued = false;
        if (this.disposed) return;
        let read: Read;
        try {
          read = await this.read('chat');
        } catch (err) {
          if (!(err instanceof WorktreeGoneError)) throw err;
          log('[ChatReview] %s no longer exists, so the chat changes were not recomputed', err.root);
          return;
        }
        if (this.disposed) return;
        this.watch(read.watched);
        this.deps.publish(changeTotals(read.files), read.generation);
      });
    }, CHAT_CHANGES_DEBOUNCE_MS);
  }

  /**
   * A scope's changed files, from the snapshot of the current generation; fresh (a user's open or hand-off) first starts a
   * new one, as a change no event reports (a terminal's file in a worktree) would not be in the snapshot.
   */
  async compute(scope: ChatScope, opts: { readonly fresh?: boolean } = {}): Promise<ChatReviewSnapshot> {
    if (opts.fresh) this.schedule();
    const read = await this.read(scope);
    const worktree = scope === 'chat' ? this.deps.session()?.worktree : undefined;
    // D60 lists the whole worktree, so the changes of the other chats working in it are in the list too.
    const sharedWith = worktree ? await worktree.sharedWith() : 0;
    return { files: read.files, shellChangesNotListed: read.shellChangesNotListed, generation: read.generation, ...(sharedWith > 0 ? { sharedWith } : {}) };
  }

  // The scope's read at the current generation: the cached one, the one in flight, or a new one.
  private read(scope: ChatScope): Promise<Read> {
    const session = this.deps.session();
    const key = sessionKeyOf(session);
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.generation++;
    }
    const cached = this.reads.get(scope);
    if (cached?.generation === this.generation) return cached.read;
    const generation = this.generation;
    const read = this.readNow(session, scope, generation);
    this.reads.set(scope, { generation, read });
    // a failed read is not kept, so the next one reads again; its caller gets the failure
    read.catch(() => {
      if (this.reads.get(scope)?.read === read) this.reads.delete(scope);
    });
    return read;
  }

  private async readNow(session: ReviewSession | undefined, scope: ChatScope, generation: number): Promise<Read> {
    if (!session) return { files: [], shellChangesNotListed: true, generation, watched: [] };
    if (session.worktree && scope === 'chat') {
      const { root } = session.worktree;
      let files: ChatChangeFile[];
      try {
        files = await worktreeChanges(root, session.worktree.baseCommit, session.worktree.git, readDiskText);
      } catch (err) {
        // git cannot start in a removed folder, which Node reports as an ENOENT naming git
        if (await isMissing(root)) throw new WorktreeGoneError(root, err);
        throw err;
      }
      return { files, shellChangesNotListed: false, generation, watched: files.map((file) => file.absolute) };
    }
    const records = collectRecords({ branch: session.branch, folder: session.initialFolder ?? session.cwd, handOffs: session.handOffs ?? [], agentMessages: await agentMessagesOf(session) });
    const latestTurn = turnsOnBranch(session.branch).at(-1);
    const readers = createBlobReaders();
    this.readers.add(readers);
    try {
      const files = await projectChatChanges(records, scope, latestTurn, session.cwd, this.io(session, latestTurn, readers));
      // tool records leave shell commands' changes out, in a worktree chat's Last turn too
      return { files, shellChangesNotListed: true, generation, watched: records.map((record) => nowPath(record, session.cwd)) };
    } finally {
      this.readers.delete(readers);
      await readers.close();
    }
  }

  // Watches the folders of these files, and stops watching folders none of them is in.
  private watch(files: readonly string[]): void {
    const byFolder = new Map<string, Set<string>>();
    for (const file of files) {
      const folder = path.dirname(file);
      const key = folderKey(folder);
      const entry = byFolder.get(key) ?? new Set<string>();
      entry.add(folderKey(file));
      byFolder.set(key, entry);
      if (!this.watched.has(key)) {
        const watcher = this.deps.watchFolder(folder, (changed) => {
          if (this.watched.get(key)?.files.has(folderKey(changed))) this.schedule();
        });
        this.watched.set(key, { files: entry, watcher });
      }
    }
    for (const [key, held] of this.watched) {
      const files = byFolder.get(key);
      if (files) {
        held.files = files;
        continue;
      }
      held.watcher.dispose();
      this.watched.delete(key);
    }
  }

  /** One file's diff in a scope, as git prints it, with the revision it shows; missing when the file is not in that scope's list. */
  async fileDiff(scope: ChatScope, filePath: string): Promise<ReviewFileDiff> {
    const file = (await this.read(scope)).files.find((candidate) => candidate.path === filePath);
    if (!file) return { kind: 'missing' };
    const diff = unifiedDiff(file);
    return diff.kind === 'patch' ? { ...diff, revision: file.revision } : diff;
  }

  /** The anchor of a comment made on the diff of revision; undefined when the current diff is another or does not show the line. */
  async anchorOf(place: CommentPlace): Promise<string | undefined> {
    const file = (await this.read(place.scope)).files.find((candidate) => candidate.path === place.path);
    return file?.revision === place.revision ? lineAnchor(file, place.side, place.line) : undefined;
  }

  /** The drafts whose line changed or left its scope's diff since they were made; the tab marks them and Send refuses them. */
  async staleDrafts(drafts: readonly DraftComment[]): Promise<DraftComment[]> {
    const stale: DraftComment[] = [];
    for (const draft of drafts) {
      const file = (await this.read(draft.scope)).files.find((candidate) => candidate.path === draft.path);
      if (isStale(file, draft)) stale.push(draft);
    }
    return stale;
  }

  /** The review message of the drafts: each line quoted from core's own diff of its scope; stale, naming each, when one moved or left it. */
  async compose(drafts: readonly DraftComment[]): Promise<ComposeResult> {
    if (drafts.length === 0) return { ok: false, reason: 'empty' };
    const comments: ReviewComment[] = [];
    const stale: DraftComment[] = [];
    for (const draft of drafts) {
      const file = (await this.read(draft.scope)).files.find((candidate) => candidate.path === draft.path);
      if (isStale(file, draft)) {
        stale.push(draft);
        continue;
      }
      comments.push({ path: draft.path, line: draft.line, removed: draft.side === 'removed', quoted: diffLine(file!, draft.side, draft.line)!, text: draft.text });
    }
    if (stale.length > 0) return { ok: false, reason: 'stale', stale };
    return { ok: true, message: composeReviewMessage(comments) };
  }

  /** Starts no further run; settles once the run in flight, which may still read the working folder, has ended. */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const held of this.watched.values()) held.watcher.dispose();
    this.watched.clear();
    this.reads.clear();
    const readers = [...this.readers].map((held) => held.close());
    return Promise.all([this.chain, ...readers]).then(() => undefined);
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((err: unknown) => log('[ChatReview] recomputing the chat changes failed: %O', err));
  }

  // Baselines from the checkpoint repo of the folder each turn ran in: a persisted entry first, and only for the latest
  // turn's before state the producer's in-memory before-commit, which waits while its baseline is still being taken.
  private io(session: ReviewSession, latestTurn: string | undefined, readers: BlobReaders): ChatChangesIo {
    return {
      checkpoint: async (turn, relativePath, side) => {
        if (!session.fileCheckpoints) return { kind: 'unavailable' };
        const persisted = checkpointCommitOf(session.branch, session.sessionFile, turn, side, undefined);
        const pending = persisted || side !== 'before' || turn !== latestTurn ? undefined : await this.deps.pendingBaseline();
        const source = persisted ?? checkpointCommitOf(session.branch, session.sessionFile, turn, side, pending);
        return source ? readers.read(source.repoDir, source.commit, relativePath) : { kind: 'unavailable' };
      },
      disk: readDiskText,
    };
  }
}

/**
 * The checkpoint commit holding a turn's before (or after) state and the repo it lives in: the turn's persisted entry (the
 * last one wins, as the rewind reads it), else, for the running turn's before state, the producer's in-memory commit.
 * undefined when nothing holds it (a turn that is not rewindable has no entry).
 */
export function checkpointCommitOf(branch: readonly SessionEntry[], sessionFile: string, turn: string, side: 'before' | 'after', pending: PendingBaseline | undefined): { readonly repoDir: string; readonly commit: string } | undefined {
  const entry = [...getCheckpointEntries(branch)].reverse().find((candidate) => candidate.userEntryId === turn);
  if (entry) return { repoDir: repoDirOf(entry, sessionFile), commit: side === 'before' ? entry.beforeCommit : entry.afterCommit };
  return side === 'before' && pending?.userEntryId === turn ? { repoDir: getFolderRepoDir(pending.folderId), commit: pending.beforeCommit } : undefined;
}
