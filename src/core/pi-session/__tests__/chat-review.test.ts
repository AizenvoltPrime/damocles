import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamMembersDir } from '../agent-records';
import { ChatReview, readDiskText, type ChatChangeTotals, type ChatReviewDeps, type DraftComment, type ReviewSession } from '../chat-review';
import { EDITOR_CONFIRM_DOCUMENT_BYTES } from '../../../shared/types/messages';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_LAUNCH_ENTRY } from '../session-store/constants';
import { filePatch } from '../../diff/jobs';
import { FILE_PATCH_TIMEOUT_MS } from '../tools/file-patch';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { gitExecutable } from '../../git-executable';
import { installProcessLauncher, processLauncher, type Launcher } from '../../process-launcher';
import { folderIdFor, getFolderRepoDir } from '../checkpoints';
import { diffService, type DiffService, type LineDiff, type LineDiffJob } from '../../diff';
import { installLogSink } from '../../logger';
import { reviewDiffJob, type FileText, type WorktreeGit } from '../chat-changes';

/** The review recomputes when a file the chat changed changes on disk, so a file back at its baseline drops out by itself. */

// Each checkpoint reader set the review opens and closes, in order.
const readerEvents = vi.hoisted((): string[] => []);
vi.mock('../checkpoints/blob-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../checkpoints/blob-reader')>();
  return {
    ...actual,
    createBlobReaders: (...args: Parameters<typeof actual.createBlobReaders>) => {
      const readers = actual.createBlobReaders(...args);
      readerEvents.push('open');
      return {
        read: readers.read,
        close: async () => {
          readerEvents.push('close');
          await readers.close();
        },
      };
    },
  };
});

const logged: string[] = [];
installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function entry(id: string, message: Record<string, unknown>): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: new Date(0).toISOString(), message } as unknown as SessionEntry;
}

function tempFolder(prefix = 'dam-review-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const patchOf = (file: string, before: string, after: string): string => {
  const made = filePatch(file, before, after, FILE_PATCH_TIMEOUT_MS);
  if (!('patch' in made)) throw new Error('no patch');
  return made.patch;
};

// An Edit call and its result on the branch, ids from callId.
function edit(callId: string, file: string, before: string, after: string): SessionEntry[] {
  return [
    entry(`${callId}-call`, { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'Edit', arguments: { file_path: file } }] }),
    entry(`${callId}-result`, { role: 'toolResult', toolCallId: callId, toolName: 'Edit', content: [], details: { patch: patchOf(file, before, after) }, isError: false }),
  ];
}

const user = (id: string): SessionEntry => entry(id, { role: 'user', content: 'edit' });

function review(session: () => ReviewSession | undefined, deps: Partial<ChatReviewDeps> = {}): ChatReview {
  return new ChatReview({
    enabled: () => true,
    session,
    pendingBaseline: () => Promise.resolve(undefined),
    publish: () => undefined,
    watchFolder: () => ({ dispose: () => undefined }),
    watchTree: () => ({ dispose: () => undefined }),
    diff: diffService(),
    ...deps,
  });
}

const lines = (count: number, at = 1): string[] => Array.from({ length: count }, (_, index) => `line ${index + at}`);
const text = (values: readonly string[]): string => `${values.join('\n')}\n`;

// A worktree chat whose files changed against bases, read live from disk; baseReads names each base read, in order.
function worktreeChat(root: string, bases: Record<string, string>, deps: Partial<ChatReviewDeps> = {}, atBase?: (relative: string) => Promise<void>): { readonly chat: ChatReview; readonly baseReads: string[] } {
  const baseReads: string[] = [];
  const git: WorktreeGit = {
    changedSinceBase: async () => Object.keys(bases).map((file) => ({ status: 'M' as const, path: file })),
    untracked: async () => [],
    atBase: async (_base, relative): Promise<FileText> => {
      baseReads.push(relative);
      await atBase?.(relative);
      return { kind: 'text', text: bases[relative]! };
    },
  };
  const chat = review(() => ({ branch: [], sessionId: 's', sessionFile: path.join(root, 's.jsonl'), sessionDir: root, cwd: root, fileCheckpoints: false, worktree: { root, baseCommit: 'a'.repeat(40), git, sharedWith: async () => 0 } }), deps);
  return { chat, baseReads };
}

// Line diffs held until the test answers each one; a job queued at dispose answers too large when its signal aborts.
function heldDiffs(): { readonly diff: Pick<DiffService, 'lineDiff'>; readonly jobs: Array<{ readonly job: LineDiffJob; readonly answer: () => Promise<void> }>; readonly sent: () => string[] } {
  const jobs: Array<{ readonly job: LineDiffJob; readonly answer: () => Promise<void> }> = [];
  return {
    jobs,
    sent: () => jobs.map((held) => held.job.after),
    diff: {
      lineDiff: (job, options) =>
        new Promise<LineDiff>((resolve) => {
          jobs.push({ job, answer: async () => resolve(await diffService().lineDiff(job)) });
          options?.signal?.addEventListener('abort', () => resolve({ kind: 'tooLarge' }));
        }),
    },
  };
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the chat review', () => {
  it('watches the folders of the files the chat changed and recomputes when one changes on disk', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'src', 'a.txt');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, 'one\nTWO\n');
    const branch = [user('t1'), ...edit('c1', file, 'one\ntwo\n', 'one\nTWO\n')];
    const published: ChatChangeTotals[] = [];
    const watchers = new Map<string, (fsPath: string) => void>();
    const disposed: string[] = [];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }), {
      publish: (totals) => published.push(totals),
      watchFolder: (folder, onChange) => {
        watchers.set(folder, onChange);
        return { dispose: () => disposed.push(folder) };
      },
    });
    chat.schedule();
    await vi.waitFor(() => expect(published).toEqual([{ added: 1, removed: 1, files: 1 }]), { timeout: 5000 });
    expect([...watchers.keys()]).toEqual([path.dirname(file)]);
    // an unrelated file in the folder recomputes nothing
    watchers.get(path.dirname(file))!(path.join(cwd, 'src', 'other.txt'));
    fs.writeFileSync(file, 'one\ntwo\n');
    watchers.get(path.dirname(file))!(file);
    await vi.waitFor(() => expect(published.at(-1)).toEqual({ added: 0, removed: 0, files: 0 }), { timeout: 5000 });
    expect(published).toHaveLength(2);
    chat.dispose();
    expect(disposed).toEqual([path.dirname(file)]);
  }, 20_000);

  it('lists the whole worktree against its base commit and says how many other chats share it (A5, D60)', async () => {
    const root = tempFolder('dam-review-wt-');
    fs.writeFileSync(path.join(root, 'theirs.txt'), 'other chat\n');
    let others = 2;
    const git = {
      changedSinceBase: async () => [{ status: 'A' as const, path: 'theirs.txt' }],
      untracked: async () => [],
      atBase: async () => ({ kind: 'absent' as const }),
    };
    const chat = review(() => ({ branch: [], sessionId: 's', sessionFile: path.join(root, 's.jsonl'), sessionDir: root, cwd: root, fileCheckpoints: false, worktree: { root, baseCommit: 'a'.repeat(40), git, sharedWith: async () => others } }));
    const shared = await chat.compute('chat');
    expect(shared.files.map((file) => file.path)).toEqual(['theirs.txt']);
    expect(shared.sharedWith).toBe(2);
    others = 0;
    expect(await chat.compute('chat')).not.toHaveProperty('sharedWith');
    const turn = await chat.compute('turn');
    expect(turn).not.toHaveProperty('sharedWith');
    // Last turn lists tool records only, so it leaves shell commands' changes out
    expect(turn.shellChangesNotListed).toBe(true);
    chat.dispose();
  });

  it('watches a worktree chat\'s whole working folder, so a change from outside the chat recomputes it, but not git\'s own folders', async () => {
    const root = tempFolder('dam-review-wt-');
    const changed: string[] = [];
    const git: WorktreeGit = {
      changedSinceBase: async () => changed.map((file) => ({ status: 'A' as const, path: file })),
      untracked: async () => [],
      atBase: async () => ({ kind: 'absent' as const }),
    };
    const published: ChatChangeTotals[] = [];
    const trees: Array<{ readonly root: string; readonly onChange: (fsPath: string) => void }> = [];
    const disposed: string[] = [];
    const watchFolder = vi.fn(() => ({ dispose: () => undefined }));
    const chat = review(() => ({ branch: [], sessionId: 's', sessionFile: path.join(root, 's.jsonl'), sessionDir: root, cwd: root, fileCheckpoints: false, worktree: { root, baseCommit: 'a'.repeat(40), git, sharedWith: async () => 0 } }), {
      publish: (totals) => published.push(totals),
      watchFolder,
      watchTree: (tree, onChange) => {
        trees.push({ root: tree, onChange });
        return { dispose: () => disposed.push(tree) };
      },
    });
    chat.schedule();
    await vi.waitFor(() => expect(published).toEqual([{ added: 0, removed: 0, files: 0 }]), { timeout: 5000 });
    expect(trees.map((tree) => tree.root)).toEqual([root]);
    // a terminal's file, which no tool record holds
    fs.writeFileSync(path.join(root, 'outside.txt'), 'x\n');
    changed.push('outside.txt');
    trees[0]!.onChange(path.join(root, '.git'));
    trees[0]!.onChange(path.join(root, 'nested', '.git', 'index'));
    await tick(700);
    expect(published).toHaveLength(1);
    trees[0]!.onChange(path.join(root, 'outside.txt'));
    await vi.waitFor(() => expect(published.at(-1)).toEqual({ added: 1, removed: 0, files: 1 }), { timeout: 5000 });
    expect(trees).toHaveLength(1);
    expect(watchFolder).not.toHaveBeenCalled();
    chat.dispose();
    expect(disposed).toEqual([root]);
  }, 20_000);

  it('computes and watches nothing while the host has no chat review', async () => {
    const watchFolder = vi.fn();
    const watchTree = vi.fn();
    const publish = vi.fn();
    const chat = new ChatReview({ enabled: () => false, session: () => undefined, pendingBaseline: () => Promise.resolve(undefined), publish, watchFolder, watchTree, diff: diffService() });
    chat.schedule();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(publish).not.toHaveBeenCalled();
    expect(watchFolder).not.toHaveBeenCalled();
    expect(watchTree).not.toHaveBeenCalled();
    chat.dispose();
  });
});

describe('the snapshot each scope keeps', () => {
  it('serves a file click and a send from the snapshot, and reads again once something changed', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'one\nTWO\n');
    let branch = [user('t1'), ...edit('c1', file, 'one\ntwo\n', 'one\nTWO\n')];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }));
    const stat = vi.spyOn(fs.promises, 'stat');
    const first = await chat.compute('chat');
    const reads = stat.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    const revision = first.files[0]!.revision;
    // the list carries no texts or hunks; they stay in core for the file's diff, anchors and Send
    expect(first.files[0]).toEqual({ path: 'a.txt', absolute: file, status: 'M', added: 1, removed: 1, binary: false, outsideEdits: false, revision, commentable: true });
    expect(await chat.fileDiff('chat', 'a.txt')).toMatchObject({ kind: 'patch', revision });
    const patchNow = async (): Promise<string> => {
      const diff = await chat.fileDiff('chat', 'a.txt');
      return diff.kind === 'patch' ? diff.patch : '';
    };
    const anchor = await chat.anchorOf({ path: 'a.txt', line: 2, side: 'added', scope: 'chat', revision });
    expect(await chat.compose([{ path: 'a.txt', line: 2, side: 'added', scope: 'chat', text: 'why?', anchor }])).toMatchObject({ ok: true });
    expect((await chat.compute('chat')).generation).toBe(first.generation);
    expect(stat.mock.calls.length).toBe(reads);

    // an outside edit the watcher reported
    fs.writeFileSync(file, 'one\nTWO\nthree\n');
    chat.schedule();
    const edited = await chat.compute('chat');
    expect(edited.generation).toBeGreaterThan(first.generation);
    expect(await patchNow()).toMatch(/^[ +]three$/m);
    // a new entry on the branch, which no watcher reports
    branch = [...branch, ...edit('c2', file, 'one\nTWO\nthree\n', 'one\nTWO\nTHREE\n')];
    fs.writeFileSync(file, 'one\nTWO\nTHREE\n');
    const appended = await chat.compute('chat');
    expect(appended.generation).toBeGreaterThan(edited.generation);
    expect(await patchNow()).toMatch(/^\+THREE$/m);

    // a change no event reports is in a fresh read, as a user's open asks for
    fs.writeFileSync(file, 'one\nTWO\nTHREE\nfour\n');
    await chat.compute('chat');
    expect(await patchNow()).not.toContain('four');
    await chat.compute('chat', { fresh: true });
    expect(await patchNow()).toMatch(/^[ +]four$/m);
    chat.dispose();
  });

  it('diffs texts once while they stay unchanged, and keeps only the diffs the newest reads used', async () => {
    const root = tempFolder('dam-review-wt-');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
    fs.writeFileSync(b, 'B\n');
    const git = {
      changedSinceBase: async () => [{ status: 'M' as const, path: 'a.txt' }, { status: 'M' as const, path: 'b.txt' }],
      untracked: async () => [],
      atBase: async (_base: string, relative: string) => ({ kind: 'text' as const, text: relative === 'a.txt' ? 'a\n' : 'b\n' }),
    };
    const diffed: string[] = [];
    const counting: Pick<DiffService, 'lineDiff'> = {
      lineDiff: (job, options) => {
        diffed.push(job.after);
        return diffService().lineDiff(job, options);
      },
    };
    const chat = review(() => ({ branch: [], sessionId: 's', sessionFile: path.join(root, 's.jsonl'), sessionDir: root, cwd: root, fileCheckpoints: false, worktree: { root, baseCommit: 'a'.repeat(40), git, sharedWith: async () => 0 } }), { diff: counting });
    await chat.compute('chat', { fresh: true });
    await chat.compute('chat', { fresh: true });
    expect(diffed).toEqual(['A\n', 'B\n']);
    // b's new texts are diffed; a's are not
    fs.writeFileSync(b, 'BB\n');
    await chat.compute('chat', { fresh: true });
    expect(diffed).toEqual(['A\n', 'B\n', 'BB\n']);
    // b's old texts were dropped with the read that used them, so going back diffs them again
    fs.writeFileSync(b, 'B\n');
    await chat.compute('chat', { fresh: true });
    expect(diffed).toEqual(['A\n', 'B\n', 'BB\n', 'B\n']);
    await chat.dispose();
  });

  it('answers a disposed review\'s queued diffs too large without running them', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'A\n');
    const branch = [user('t1'), ...edit('c1', file, 'a\n', 'A\n')];
    const signals: AbortSignal[] = [];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }), {
      diff: {
        lineDiff: (_job, options) => {
          signals.push(options!.signal!);
          return new Promise((resolve) => options!.signal!.addEventListener('abort', () => resolve({ kind: 'tooLarge' })));
        },
      },
    });
    const reading = chat.compute('chat');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await chat.dispose();
    const { files } = await reading;
    expect(signals[0]!.aborted).toBe(true);
    expect(files.map((listed) => [listed.commentable, listed.added, listed.removed])).toEqual([[false, 0, 0]]);
  });

  it('closes the checkpoint readers once the reads are done, before a slow diff settles', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'A\n');
    const branch = [user('t1'), ...edit('c1', file, 'a\n', 'A\n')];
    const held = heldDiffs();
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }), { diff: held.diff });
    readerEvents.length = 0;
    const reading = chat.compute('chat');
    await vi.waitFor(() => expect(held.jobs).toHaveLength(1));
    await vi.waitFor(() => expect(readerEvents).toEqual(['open', 'close']));
    await held.jobs[0]!.answer();
    expect((await reading).files.map((listed) => [listed.path, listed.added, listed.removed])).toEqual([['a.txt', 1, 1]]);
    await chat.dispose();
  });

  it('lists a file whose diff job threw as too large, keeps the other files\' counts, and asks for it again on the next read', async () => {
    const root = tempFolder('dam-review-wt-');
    fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B\n');
    let releaseB: () => void = () => undefined;
    const bRead = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const sent: string[] = [];
    const { chat } = worktreeChat(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, {
      diff: {
        lineDiff: (job, options) => {
          sent.push(job.after);
          return job.after === 'A\n' ? Promise.reject(new Error('the job threw')) : diffService().lineDiff(job, options);
        },
      },
    }, (relative) => (relative === 'b.txt' ? bRead : Promise.resolve()));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      logged.length = 0;
      const reading = chat.compute('chat');
      await vi.waitFor(() => expect(sent).toEqual(['A\n']));
      // a's job rejects while b's base read is still pending
      await tick(50);
      releaseB();
      const { files } = await reading;
      expect(files.map((listed) => [listed.path, listed.commentable, listed.added, listed.removed])).toEqual([['a.txt', false, 0, 0], ['b.txt', true, 1, 1]]);
      expect(await chat.fileDiff('chat', 'a.txt')).toEqual({ kind: 'tooLarge' });
      expect(logged.filter((line) => line.includes('[ChatReview] a line diff failed') && line.includes('the job threw'))).toHaveLength(1);
      await chat.compute('chat', { fresh: true });
      expect(sent).toEqual(['A\n', 'B\n', 'A\n']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await chat.dispose();
    }
  });

  it('runs one recompute for every change made while another waits, never one per change', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'b\n');
    const branch = [user('t1'), ...edit('c1', file, 'a\n', 'b\n')];
    let release: () => void = () => undefined;
    const gate = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    const published: number[] = [];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: true }), {
      pendingBaseline: () => gate,
      publish: (_totals, generation) => published.push(generation),
    });
    chat.schedule();
    await new Promise((resolve) => setTimeout(resolve, 700));
    // the first recompute waits on the running turn's baseline; three more changes settle meanwhile
    for (let change = 0; change < 3; change++) {
      chat.schedule();
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    expect(published).toEqual([]);
    release();
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(published).toHaveLength(2);
    expect(published[1]).toBeGreaterThan(published[0]!);
    chat.dispose();
  }, 20_000);

  it('asks for the running turn\'s baseline only for a file the latest turn first changed', async () => {
    const cwd = tempFolder();
    const old = path.join(cwd, 'old.txt');
    const fresh = path.join(cwd, 'fresh.txt');
    fs.writeFileSync(old, 'B\n');
    fs.writeFileSync(fresh, 'D\n');
    const pendingBaseline = vi.fn(() => Promise.resolve(undefined));
    const latestOnly = [user('t1'), ...edit('c1', old, 'b\n', 'B\n'), user('t2')];
    const chat = review(() => ({ branch: latestOnly, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: true }), { pendingBaseline });
    await chat.compute('chat');
    expect(pendingBaseline).not.toHaveBeenCalled();
    const both = [...latestOnly, ...edit('c2', fresh, 'd\n', 'D\n')];
    const second = review(() => ({ branch: both, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: true }), { pendingBaseline });
    await second.compute('chat');
    expect(pendingBaseline).toHaveBeenCalledTimes(1);
    chat.dispose();
    second.dispose();
  });
});

describe('the line diffs the review keeps', () => {
  it('runs the review\'s line diff with 3 lines of context, the 20,000-edit bound and a 3 s budget', () => {
    expect(reviewDiffJob('a\n', 'b\n')).toMatchObject({ kind: 'lineDiff', context: 3, maxEditLength: 20_000, timeoutMs: 3_000 });
  });

  it('joins a diff in flight for the same texts instead of sending another job', async () => {
    const root = tempFolder('dam-review-wt-');
    fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
    const held = heldDiffs();
    const { chat, baseReads } = worktreeChat(root, { 'a.txt': 'a\n' }, { diff: held.diff });
    const first = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(held.jobs).toHaveLength(1));
    const second = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(baseReads).toHaveLength(2));
    await tick();
    expect(held.jobs).toHaveLength(1);
    await held.jobs[0]!.answer();
    const [older, newer] = await Promise.all([first, second]);
    expect(newer.generation).toBeGreaterThan(older.generation);
    expect(newer.files.map((listed) => [listed.path, listed.added, listed.removed])).toEqual([['a.txt', 1, 1]]);
    await chat.dispose();
  });

  it('keeps the newest read\'s diffs when an older read of the scope settles after it', async () => {
    const root = tempFolder('dam-review-wt-');
    const write = (name: string, content: string): void => fs.writeFileSync(path.join(root, name), content);
    write('a.txt', 'A\n');
    write('b.txt', 'B1\n');
    write('c.txt', 'C1\n');
    const held = heldDiffs();
    const { chat } = worktreeChat(root, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, { diff: held.diff });
    const older = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(held.sent()).toEqual(['A\n', 'B1\n', 'C1\n']));
    write('b.txt', 'B2\n');
    write('c.txt', 'C2\n');
    const newer = chat.compute('chat', { fresh: true });
    // a's texts are unchanged, so the newer read joins its job
    await vi.waitFor(() => expect(held.sent()).toEqual(['A\n', 'B1\n', 'C1\n', 'B2\n', 'C2\n']));
    for (const index of [0, 3, 4]) await held.jobs[index]!.answer();
    await newer;
    for (const index of [1, 2]) await held.jobs[index]!.answer();
    await older;
    // b as the newer read had it is reused; c as only the older read had it was dropped
    write('c.txt', 'C1\n');
    const third = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(held.sent()).toHaveLength(6));
    expect(held.sent()[5]).toBe('C1\n');
    await held.jobs[5]!.answer();
    expect((await third).files.map((listed) => [listed.path, listed.added])).toEqual([['a.txt', 1], ['b.txt', 1], ['c.txt', 1]]);
    expect(held.jobs).toHaveLength(6);
    await chat.dispose();
  });

  it('keeps the diffs of a read in flight while another read settles', async () => {
    const root = tempFolder('dam-review-wt-');
    const write = (name: string, content: string): void => fs.writeFileSync(path.join(root, name), content);
    write('a.txt', 'A\n');
    write('b.txt', 'B1\n');
    const held = heldDiffs();
    const { chat, baseReads } = worktreeChat(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { diff: held.diff });
    const older = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(held.sent()).toEqual(['A\n', 'B1\n']));
    write('b.txt', 'B2\n');
    const newer = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(held.sent()).toEqual(['A\n', 'B1\n', 'B2\n']));
    for (const index of [0, 2]) await held.jobs[index]!.answer();
    await newer;
    // the older read's b is still in flight, so a read of the same texts joins it
    write('b.txt', 'B1\n');
    const third = chat.compute('chat', { fresh: true });
    await vi.waitFor(() => expect(baseReads.filter((read) => read === 'b.txt')).toHaveLength(3));
    await tick();
    expect(held.jobs).toHaveLength(3);
    await held.jobs[1]!.answer();
    await Promise.all([older, third]);
    expect(held.jobs).toHaveLength(3);
    await chat.dispose();
  });
});

describe('a disposed review', () => {
  const projectChat = (deps: Partial<ChatReviewDeps> = {}, session?: (held: ReviewSession) => ReviewSession): ChatReview => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'one\nTWO\n');
    const held: ReviewSession = { branch: [user('t1'), ...edit('c1', file, 'one\ntwo\n', 'one\nTWO\n')], sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false };
    return review(() => (session ? session(held) : held), deps);
  };

  it('fails every read asked after dispose', async () => {
    const chat = projectChat();
    const { files } = await chat.compute('chat');
    const place = { path: 'a.txt', line: 2, side: 'added' as const, scope: 'chat' as const, revision: files[0]!.revision };
    const draft: DraftComment = { ...place, text: 'why?', anchor: await chat.anchorOf(place) };
    await chat.dispose();
    await expect(chat.compute('chat')).rejects.toThrow('disposed');
    await expect(chat.fileDiff('chat', 'a.txt')).rejects.toThrow('disposed');
    await expect(chat.anchorOf(place)).rejects.toThrow('disposed');
    await expect(chat.staleDrafts([draft])).rejects.toThrow('disposed');
    await expect(chat.compose([draft])).rejects.toThrow('disposed');
  });

  it('opens no checkpoint readers for a read that reaches them after dispose', async () => {
    const chat = projectChat();
    readerEvents.length = 0;
    const reading = chat.compute('chat');
    await chat.dispose();
    await expect(reading).rejects.toThrow('disposed');
    expect(readerEvents).toEqual([]);
  });

  it('ends a debounced recompute quietly when the review is disposed under it', async () => {
    const published: ChatChangeTotals[] = [];
    let disposeOnRead = false;
    const chat: ChatReview = projectChat({ publish: (totals) => published.push(totals) }, (held) => {
      if (disposeOnRead) {
        disposeOnRead = false;
        void chat.dispose();
      }
      return held;
    });
    logged.length = 0;
    disposeOnRead = true;
    chat.schedule();
    await vi.waitFor(() => expect(disposeOnRead).toBe(false), { timeout: 5000 });
    await chat.dispose();
    expect(published).toEqual([]);
    expect(logged.filter((line) => line.includes('[ChatReview]'))).toEqual([]);
  });

  it('keeps no diff of a read that settles after dispose, and sends none it asks for then', async () => {
    const root = tempFolder('dam-review-wt-');
    fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B\n');
    let releaseB: () => void = () => undefined;
    const bRead = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const held = heldDiffs();
    const { chat } = worktreeChat(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { diff: held.diff }, (relative) => (relative === 'b.txt' ? bRead : Promise.resolve()));
    const reading = chat.compute('chat');
    await vi.waitFor(() => expect(held.jobs).toHaveLength(1));
    const disposing = chat.dispose();
    releaseB();
    const { files } = await reading;
    await disposing;
    expect(files.map((listed) => [listed.path, listed.commentable, listed.added])).toEqual([['a.txt', false, 0], ['b.txt', false, 0]]);
    expect(held.jobs).toHaveLength(1);
    const caches = chat as unknown as { readonly lineDiffs: ReadonlyMap<string, unknown>; readonly keptDiffs: ReadonlyMap<string, unknown> };
    expect([caches.lineDiffs.size, caches.keptDiffs.size]).toEqual([0, 0]);
  });
});

describe('review comments at send', () => {
  it('refuses a comment on an added line once the chat inserted lines above it, and one made on an older diff', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    const base = lines(40);
    const edited = base.map((line, index) => (index === 29 ? 'line 30 edited' : line));
    fs.writeFileSync(file, text(edited));
    let branch = [user('t1'), ...edit('c1', file, text(base), text(edited))];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }));
    const before = await chat.compute('chat');
    const place = { path: 'a.txt', line: 30, side: 'added' as const, scope: 'chat' as const, revision: before.files[0]!.revision };
    const anchor = await chat.anchorOf(place);
    expect(anchor).toBe('line 29\nline 30 edited\nline 31');
    const sent = await chat.compose([{ ...place, text: 'Why edit it?', anchor }]);
    expect(sent.ok && sent.message).toContain('a.txt:30\n```text\nline 30 edited\n```\nWhy edit it?');

    // the chat inserts ten lines at the top: line 30 is now an unchanged line the hunk no longer shows
    const inserted = [...lines(10, 100), ...edited];
    branch = [...branch, ...edit('c2', file, text(edited), text(inserted))];
    fs.writeFileSync(file, text(inserted));
    expect(await chat.compose([{ ...place, text: 'Why edit it?', anchor }])).toEqual({ ok: false, reason: 'stale', stale: [{ ...place, text: 'Why edit it?', anchor }] });
    // a comment the tab made on the diff before the insertion gets no anchor from the current one
    expect(await chat.anchorOf(place)).toBeUndefined();
    chat.dispose();
  });
});

describe('stale review comments', () => {
  it('names only the comments whose line the chat changed, by the same rule Send refuses with', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'c.ts');
    const base = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', 'const g = 7;', 'const h = 8;'];
    const edited = base.map((line, index) => (index === 1 ? 'const b = 20;' : index === 6 ? 'const g = 70;' : line));
    fs.writeFileSync(file, text(edited));
    let branch = [user('t1'), ...edit('c1', file, text(base), text(edited))];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }));
    const before = await chat.compute('chat');
    const at = (line: number) => ({ path: 'c.ts', line, side: 'added' as const, scope: 'chat' as const, revision: before.files[0]!.revision });
    const second = { ...at(2), text: 'why 20?', anchor: await chat.anchorOf(at(2)) };
    const seventh = { ...at(7), text: 'why 70?', anchor: await chat.anchorOf(at(7)) };
    expect(await chat.staleDrafts([second, seventh])).toEqual([]);

    // the chat changes line 2 again; line 7 and the lines around it stay as they were
    const again = edited.map((line, index) => (index === 1 ? 'const b = 200;' : line));
    branch = [...branch, ...edit('c2', file, text(edited), text(again))];
    fs.writeFileSync(file, text(again));
    expect(await chat.staleDrafts([second, seventh])).toEqual([second]);
    expect(await chat.compose([second, seventh])).toEqual({ ok: false, reason: 'stale', stale: [second] });
    chat.dispose();
  });

  it('checks every draft of a scope against one snapshot, though a change is scheduled while the check runs', async () => {
    const root = tempFolder('dam-review-wt-');
    const file = path.join(root, 'c.ts');
    const base = lines(8);
    const edited = base.map((line, index) => (index === 1 || index === 6 ? `${line} edited` : line));
    fs.writeFileSync(file, text(edited));
    const { chat } = worktreeChat(root, { 'c.ts': text(base) });
    const before = await chat.compute('chat');
    const at = (line: number) => ({ path: 'c.ts', line, side: 'added' as const, scope: 'chat' as const, revision: before.files[0]!.revision });
    const second: DraftComment = { ...at(2), text: 'why?', anchor: await chat.anchorOf(at(2)) };
    const seventh: DraftComment = { ...at(7), text: 'why?', anchor: await chat.anchorOf(at(7)) };
    const checking = chat.staleDrafts([second, seventh]);
    const composing = chat.compose([second, seventh]);
    // the chat changes line 7 again after both calls began
    fs.writeFileSync(file, text(edited.map((line, index) => (index === 6 ? 'line 7 again' : line))));
    chat.schedule();
    expect(await checking).toEqual([]);
    expect(await composing).toMatchObject({ ok: true });
    expect(await chat.staleDrafts([second, seventh])).toEqual([seventh]);
    await chat.dispose();
  });
});

describe('records across a hand-off and a team', () => {
  it('watches where the chat\'s files are now after a hand-off, not the folder they were changed in', async () => {
    const project = tempFolder();
    const worktree = tempFolder('dam-review-moved-');
    fs.mkdirSync(path.join(worktree, 'src'));
    fs.writeFileSync(path.join(worktree, 'src', 'x.ts'), 'X\n');
    const branch = [user('t1'), ...edit('c1', path.join(project, 'src', 'x.ts'), 'x\n', 'X\n'), user('t2')];
    const watched: string[] = [];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(worktree, 's.jsonl'), sessionDir: worktree, cwd: worktree, fileCheckpoints: false, initialFolder: project, handOffs: [{ entryId: 't2', folder: worktree }] }), {
      watchFolder: (folder) => {
        watched.push(folder);
        return { dispose: () => undefined };
      },
    });
    chat.schedule();
    await vi.waitFor(() => expect(watched).toEqual([path.join(worktree, 'src')]), { timeout: 5000 });
    chat.dispose();
  }, 20_000);

  it('applies two team members\' edits of one file in the order they were made', async () => {
    const cwd = tempFolder();
    const file = path.join(cwd, 'a.txt');
    fs.writeFileSync(file, 'c\n');
    const sessionId = 'parent';
    const members = teamMembersDir(cwd, sessionId, 'team-1');
    fs.mkdirSync(members, { recursive: true });
    // the member listed first made the later edit
    const member = (id: string, callId: string, before: string, after: string, at: number): void => {
      const sm = SessionManager.create(members, members, { id });
      sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, { agentId: id, kind: 'team-member', teamId: 'team-1', attempt: 0, memberName: id, role: 'specialist', task: 'edit' });
      sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'edit' }], timestamp: at - 2 } as never);
      sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'Edit', arguments: { file_path: file } }], timestamp: at - 1 } as never);
      sm.appendMessage({ role: 'toolResult', toolCallId: callId, toolName: 'Edit', content: [{ type: 'text', text: 'ok' }], details: { patch: patchOf(file, before, after) }, isError: false, timestamp: at } as never);
    };
    member('a-late', 'm2', 'b\n', 'c\n', 2_000);
    member('b-early', 'm1', 'a\n', 'b\n', 1_000);
    const branch = [
      user('t1'),
      entry('team-call', { role: 'assistant', content: [{ type: 'toolCall', id: 'team1', name: 'create_team', arguments: {} }] }),
      { type: 'custom', id: 'inv', parentId: null, timestamp: new Date(0).toISOString(), customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'team', id: 'team-1', toolCallId: 'team1', resume: false } } as unknown as SessionEntry,
    ];
    const chat = review(() => ({ branch, sessionId, sessionFile: path.join(cwd, 'parent.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: false }));
    const [changed] = (await chat.compute('chat')).files;
    expect(changed).toMatchObject({ path: 'a.txt', status: 'M', outsideEdits: false, commentable: true, added: 1, removed: 1 });
    expect(await chat.fileDiff('chat', 'a.txt')).toMatchObject({ kind: 'patch', patch: expect.stringContaining('\n-a\n+c\n') });
    chat.dispose();
  });
});

describe('checkpoint baselines', () => {
  const launchers: Array<Launcher | undefined> = [];
  afterEach(() => {
    for (const previous of launchers.splice(0)) if (previous) installProcessLauncher(previous);
  });

  it('reads a recompute\'s baselines through one git per checkpoint repo, ended before the recompute publishes', { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, async () => {
    const cwd = tempFolder();
    const folderId = folderIdFor(cwd);
    const repoDir = getFolderRepoDir(folderId);
    fs.mkdirSync(repoDir, { recursive: true });
    dirs.push(repoDir);
    const names = Array.from({ length: 50 }, (_, index) => `src/file-${index}.txt`);
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(repoDir, name)), { recursive: true });
      fs.writeFileSync(path.join(repoDir, name), `before ${name}\n`);
      fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
      fs.writeFileSync(path.join(cwd, name), `after ${name}\n`);
    }
    // no system, global or XDG config (a gpgsign, an init.templateDir with hooks) and no inherited GIT_DIR reaches the setup
    const emptyConfig = path.join(tempFolder(), 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
    const git = (...args: string[]): string => execFileSync(gitExecutable(), ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: repoDir, encoding: 'utf8', env });
    git('init', '--quiet');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'baseline');
    const commit = git('rev-parse', 'HEAD').trim();
    const checkpoint = {
      type: 'custom',
      id: 'cp',
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: 'damocles-checkpoint',
      data: { v: 3, kind: 'checkpoint', turnId: 'turn', userEntryId: 't1', beforeCommit: commit, afterCommit: commit, prompt: 'edit', fileCount: 50, fileChanges: [], createdAt: new Date(0).toISOString(), repo: 'folder', folderId, skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null } },
    } as unknown as SessionEntry;
    const branch = [user('t1'), checkpoint, ...names.flatMap((name, index) => edit(`c${index}`, path.join(cwd, name), `before ${name}\n`, `after ${name}\n`))];

    const starts: Array<{ readonly args: readonly string[]; closed: boolean; output: string }> = [];
    const inner = processLauncher();
    launchers.push(installProcessLauncher({
      launch: (spec, options) => {
        const launched = inner.launch(spec, options);
        const start = { args: spec.args, closed: false, output: '' };
        starts.push(start);
        launched.onData('stdout', (chunk) => (start.output += chunk.toString('utf8')));
        void launched.closed.finally(() => (start.closed = true)).catch(() => undefined);
        return launched;
      },
      createSessionJob: () => inner.createSessionJob(),
      dispose: () => inner.dispose(),
    }));

    const published: ChatChangeTotals[] = [];
    const chat = review(() => ({ branch, sessionId: 's', sessionFile: path.join(cwd, 's.jsonl'), sessionDir: cwd, cwd, fileCheckpoints: true }), {
      publish: (totals) => published.push(totals),
    });
    chat.schedule();
    await vi.waitFor(() => expect(published).toEqual([{ added: 50, removed: 50, files: 50 }]), { timeout: SPAWN_TEST_TIMEOUT_MS });
    expect(starts.map((start) => start.args.slice(-2))).toEqual([['cat-file', '--batch']]);
    expect(starts.every((start) => start.closed)).toBe(true);
    // every baseline came from the checkpoint
    expect(starts[0]!.output.split('\n').filter((line) => / blob \d+$/.test(line))).toHaveLength(50);
    await chat.dispose();
  });
});

describe('the file on disk now', () => {
  /** stat answers for `file` with what it found, after which `change` runs once: a racer changing the file before its read. */
  function changeAfterStat(file: string, change: () => void): void {
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementationOnce((async (target: fs.PathLike) => {
      const stats = await stat(target);
      if (String(target) === file) change();
      return stats;
    }) as typeof fs.promises.stat);
  }

  it('reads a file grown past the review\'s bound after its stat as too large, never whole', async () => {
    const file = path.join(tempFolder(), 'grown.txt');
    fs.writeFileSync(file, 'small\n');
    changeAfterStat(file, () => fs.truncateSync(file, EDITOR_CONFIRM_DOCUMENT_BYTES + 1));

    expect(await readDiskText(file)).toEqual({ kind: 'tooLarge' });
  });

  it.runIf(process.platform !== 'win32')('reads a FIFO swapped in after its stat as no file, never waiting for a writer', async () => {
    const file = path.join(tempFolder(), 'swapped');
    fs.writeFileSync(file, 'regular\n');
    changeAfterStat(file, () => {
      fs.rmSync(file);
      execFileSync('mkfifo', [file]);
    });

    try {
      const read = await Promise.race([readDiskText(file), new Promise((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2000))]);
      expect(read).toEqual({ kind: 'absent' });
    } finally {
      releaseFifo(file);
    }
  });
});

/** Lets a read open that waits on the FIFO at `fifo` go on, so a failing run leaves no thread blocked. */
function releaseFifo(fifo: string): void {
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch (err) {
    // ENXIO: nothing waits on it
    if ((err as NodeJS.ErrnoException).code !== 'ENXIO') throw err;
  }
}
