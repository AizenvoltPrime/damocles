import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamMembersDir } from '../agent-records';
import { ChatReview, type ChatChangeTotals, type ChatReviewDeps, type ReviewSession } from '../chat-review';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_LAUNCH_ENTRY } from '../session-store/constants';
import { filePatch } from '../tools/file-patch';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../__mocks__/spawn-budget';
import { gitExecutable } from '../../git-executable';
import { installProcessLauncher, processLauncher, type Launcher } from '../../process-launcher';
import { folderIdFor, getFolderRepoDir } from '../checkpoints';

/** The review recomputes when a file the chat changed changes on disk, so a file back at its baseline drops out by itself. */

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
  const made = filePatch(file, before, after);
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
    ...deps,
  });
}

const lines = (count: number, at = 1): string[] => Array.from({ length: count }, (_, index) => `line ${index + at}`);
const text = (values: readonly string[]): string => `${values.join('\n')}\n`;

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

  it('computes and watches nothing while the host has no chat review', async () => {
    const watchFolder = vi.fn();
    const publish = vi.fn();
    const chat = new ChatReview({ enabled: () => false, session: () => undefined, pendingBaseline: () => Promise.resolve(undefined), publish, watchFolder });
    chat.schedule();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(publish).not.toHaveBeenCalled();
    expect(watchFolder).not.toHaveBeenCalled();
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
    expect(await chat.fileDiff('chat', 'a.txt')).toMatchObject({ kind: 'patch', revision });
    const anchor = await chat.anchorOf({ path: 'a.txt', line: 2, side: 'added', scope: 'chat', revision });
    expect(await chat.compose([{ path: 'a.txt', line: 2, side: 'added', scope: 'chat', text: 'why?', anchor }])).toMatchObject({ ok: true });
    expect((await chat.compute('chat')).generation).toBe(first.generation);
    expect(stat.mock.calls.length).toBe(reads);

    // an outside edit the watcher reported
    fs.writeFileSync(file, 'one\nTWO\nthree\n');
    chat.schedule();
    const edited = await chat.compute('chat');
    expect(edited.generation).toBeGreaterThan(first.generation);
    expect(edited.files[0]!.diff).toMatchObject({ after: 'one\nTWO\nthree\n' });
    // a new entry on the branch, which no watcher reports
    branch = [...branch, ...edit('c2', file, 'one\nTWO\nthree\n', 'one\nTWO\nTHREE\n')];
    fs.writeFileSync(file, 'one\nTWO\nTHREE\n');
    const appended = await chat.compute('chat');
    expect(appended.generation).toBeGreaterThan(edited.generation);
    expect(appended.files[0]!.diff).toMatchObject({ after: 'one\nTWO\nTHREE\n' });

    // a change no event reports is in a fresh read, as a user's open asks for
    fs.writeFileSync(file, 'one\nTWO\nTHREE\nfour\n');
    expect((await chat.compute('chat')).files[0]!.diff).toMatchObject({ after: 'one\nTWO\nTHREE\n' });
    expect((await chat.compute('chat', { fresh: true })).files[0]!.diff).toMatchObject({ after: 'one\nTWO\nTHREE\nfour\n' });
    chat.dispose();
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
    expect(changed).toMatchObject({ path: 'a.txt', status: 'M', outsideEdits: false, diff: { kind: 'texts', before: 'a\n', after: 'c\n' } });
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
