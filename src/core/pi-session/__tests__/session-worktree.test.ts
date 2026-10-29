import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { SessionWorktree } from '../session-worktree';
import { WorktreeRegistry, type ChatWorktreeRecord } from '../../worktrees/registry';
import { worktreeFolderFor } from '../../worktrees/records';
import { WORKTREE_ENTRY } from '../../worktrees/hand-off';
import type { WorktreeEntryData } from '../../worktrees/worktree-entry';
import { markHandOffs, precedesHandOff } from '../session-store/rewind';
import type { WorktreeHostServices } from '../../worktrees/host';
import { installWorktreeProjectLookup } from '../../worktrees/personal-config';
import type { GitRunner } from '../../scm/git-runner';
import { worktreeIsolationBlock, WORKTREE_ISOLATION_REASON } from '../worktree-isolation';
import { DAMOCLES_ORIGINAL_INPUT_ENTRY } from '../session-store/constants';
import { formatIdeContextBlock } from '../../../shared/ide-context';

const inert = { dispose: () => undefined };
const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  watchWorkspace: () => ({ ready: Promise.resolve(), onDidCreate: () => inert, onDidChange: () => inert, onDidDelete: () => inert, dispose: () => undefined }),
  onDidRenameFiles: () => inert,
};

let base: string;
let registry: WorktreeRegistry;
let project: string;
let record: ChatWorktreeRecord;
let refsListeners: Array<(projectPath: string) => void> = [];
let repositoryListeners: Array<(projectPath: string) => void> = [];
let repositoryOpen = true;

beforeEach(async () => {
  refsListeners = [];
  repositoryListeners = [];
  repositoryOpen = true;
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-sw-')));
  project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const rootDir = path.join(base, 'worktrees');
  registry = new WorktreeRegistry({ rootDir, watcherFactory: watchers, log: () => undefined });
  const worktreeRoot = worktreeFolderFor(rootDir, project, 'aaaaaaaa');
  record = await registry.addChat({ id: 'aaaaaaaa', kind: 'chat', projectPath: project, repositoryRoot: project, worktreeRoot, workingFolder: worktreeRoot, branch: 'damocles/x', baseCommit: 'a'.repeat(40), createdAt: 1 });
});
afterEach(() => {
  registry.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

function sessionAt(cwd: string, opts: { host?: boolean; enabled?: boolean; entries?: unknown[]; started?: boolean; sessionId?: string; repository?: boolean; git?: GitRunner } = {}) {
  const entries: unknown[] = opts.entries ?? [];
  let started = opts.started ?? true;
  const emitted: ExtensionToWebviewMessage[] = [];
  const host = {
    registry,
    git: () => opts.git,
    projectRepository: (projectPath: string) => (opts.repository === false || !repositoryOpen ? undefined : projectPath),
    onDidChangeProjectRepository: (listener: (projectPath: string) => void) => {
      repositoryListeners.push(listener);
      return { dispose: () => { repositoryListeners = repositoryListeners.filter((l) => l !== listener); } };
    },
    onDidChangeRefs: (listener: (projectPath: string) => void) => {
      refsListeners.push(listener);
      return { dispose: () => { refsListeners = refsListeners.filter((l) => l !== listener); } };
    },
  } as unknown as WorktreeHostServices;
  const worktree = new SessionWorktree({
    cwd,
    host: () => (opts.host === false ? undefined : host),
    enabled: () => opts.enabled ?? true,
    isTrusted: () => true,
    entries: () => (started ? entries : undefined),
    sessionId: () => (started ? opts.sessionId ?? 's-self' : undefined),
    sessionFile: () => undefined,
    append: (data: WorktreeEntryData) => entries.push({ type: 'custom', customType: WORKTREE_ENTRY, data, id: `e${entries.length}` }),
    emit: (m) => emitted.push(m),
    busy: () => false,
    hasConversation: () => true,
  });
  return { worktree, entries, emitted, start: () => { started = true; } };
}

const entry = (place: 'worktree' | 'project', id = 'x') => ({ type: 'custom', customType: WORKTREE_ENTRY, data: { worktreeId: 'aaaaaaaa', projectPath: project, place }, id });

describe('a session\'s worktree facts', () => {
  it('records the worktree entry for a new session in the worktree, once, as a /clear and a fork do', () => {
    const s = sessionAt(record.workingFolder);
    s.worktree.ensureEntry();
    s.worktree.ensureEntry();
    expect(s.entries).toHaveLength(1);
    expect(s.worktree.place()).toBe('worktree');
    expect(s.worktree.readOnly()).toBe(false);
    expect(s.worktree.shellEnvironment()).toEqual({ DAMOCLES_PROJECT_FOLDER: project, DAMOCLES_WORKTREE_INDEX: '1' });
    expect(s.worktree.isolation()?.projectPath).toBe(project);
    expect(sessionAt(project).worktree.shellEnvironment()).toBeUndefined();
  });

  it('is read-only when its latest entry places it in a worktree this host cannot bind to: deleted, or the VS Code host', async () => {
    expect(sessionAt(project, { host: false, entries: [entry('worktree')] }).worktree.readOnly()).toBe(true);
    await registry.markDeleted(record.id);
    const deleted = sessionAt(project, { entries: [entry('worktree')] });
    expect(deleted.worktree.readOnly()).toBe(true);
    expect(deleted.worktree.isolation()).toBeUndefined();
    expect(sessionAt(project, { entries: [entry('worktree'), entry('project')] }).worktree.readOnly()).toBe(false);
  });

  it('says why a chat is read-only: its worktree was deleted, or this host has no worktrees', async () => {
    expect(sessionAt(project, { host: false, entries: [entry('worktree')] }).worktree.readOnlyReason()).toBe('hostWithoutWorktrees');
    await registry.markDeleted(record.id);
    expect(sessionAt(project, { entries: [entry('worktree')] }).worktree.readOnlyReason()).toBe('deleted');
    expect(sessionAt(project, { entries: [entry('worktree'), entry('project')] }).worktree.readOnlyReason()).toBeUndefined();
  });

  it('keeps a running turn isolated when its worktree\'s record disappears under it', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    expect(s.worktree.isolation()).toBeDefined();
    await registry.remove(record.id);
    const isolation = s.worktree.isolation();
    expect(isolation).toMatchObject({ workingFolder: record.workingFolder, projectPath: project, repositoryRoot: project });
    expect(worktreeIsolationBlock('Edit', { file_path: path.join(project, 'a.ts') }, { ...isolation!, environment: {} })).toContain(WORKTREE_ISOLATION_REASON);
    expect(s.worktree.readOnly()).toBe(true);
  });

  it('isolates a chat working in a worktree it never saw a record of from the project its entry names', () => {
    const unknown = path.join(base, 'worktrees', 'unknown');
    const s = sessionAt(unknown, { entries: [{ ...entry('worktree'), data: { worktreeId: 'zzzzzzzz', projectPath: project, place: 'worktree' } }] });
    expect(s.worktree.isolation()).toMatchObject({ workingFolder: unknown, projectPath: project, repositoryRoot: project, otherWorktrees: [record.worktreeRoot] });
    expect(sessionAt(project, { entries: [entry('worktree')] }).worktree.isolation()).toBeUndefined();
  });

  it('takes a hand-off\'s branch slug from what the user typed, never from an attached block', () => {
    const ide = `${formatIdeContextBlock({ type: 'opened_file', filePath: '/p/a.ts' })}\nFix the login bug`;
    const typed = { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: ide }] } };
    expect(sessionAt(project, { entries: [typed] }).worktree.firstPromptText()).toBe('Fix the login bug');
    const expanded = { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Review the parser. Step one...' }] } };
    const original = { type: 'custom', id: 'o1', customType: DAMOCLES_ORIGINAL_INPUT_ENTRY, data: { userEntryId: 'u1', original: '/review the parser' } };
    expect(sessionAt(project, { entries: [expanded, original] }).worktree.firstPromptText()).toBe('/review the parser');
  });

  it('drops the git facts a refresh read for a worktree deleted while it read them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const git = {
      git: { path: 'git', version: { major: 2, minor: 45, patch: 0 } },
      run: async (call: { args: readonly string[] }) => {
        await gate;
        const [command] = call.args;
        const out = command === 'rev-parse'
          ? call.args.filter((arg) => arg !== '--git-path').slice(1).map((name) => path.join(base, 'no-git-dir', name)).join('\n')
          : command === 'symbolic-ref' ? 'refs/heads/main' : command === 'rev-list' ? '0\t3' : '';
        return { exitCode: 0, stdout: Buffer.from(out), stderr: '' };
      },
    } as unknown as GitRunner;
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')], git });
    s.worktree.refreshGit();
    await registry.markDeleted(record.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((s.worktree as unknown as { git: object }).git).toEqual({});
    s.worktree.dispose();
  });

  it('tells a newly bound panel once that its chat has no state, so the previous chat\'s state never lingers', async () => {
    const s = sessionAt(project, { entries: [], repository: false });
    const listener = vi.fn();
    s.worktree.setListener(listener);
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toEqual([{ type: 'noWorktreeState' }]));
    s.worktree.publish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes worktreeState only with HostCapabilities.worktrees, as the one publisher', async () => {
    const off = sessionAt(record.workingFolder, { enabled: false, entries: [entry('worktree')] });
    off.worktree.publish();
    const on = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    const listener = vi.fn();
    on.worktree.setListener(listener);
    on.worktree.publish();
    await vi.waitFor(() => expect(on.emitted).toHaveLength(1));
    expect(off.emitted).toEqual([]);
    expect(on.emitted[0]).toMatchObject({ type: 'worktreeState', phase: 'ready', place: 'worktree', canHandOff: true, branch: 'damocles/x' });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ projectPath: project, worktreeId: 'aaaaaaaa', busy: false }));
    // an unchanged state goes out again to a webview that (re)started
    on.worktree.publish();
    on.worktree.republish();
    await vi.waitFor(() => expect(on.emitted).toHaveLength(2));
  });

  it('publishes nothing before the session starts, so a reloading read-only chat never reads as a project-folder chat', async () => {
    await registry.markDeleted(record.id);
    const s = sessionAt(project, { entries: [entry('worktree')], started: false });
    const listener = vi.fn();
    s.worktree.setListener(listener);
    s.worktree.publish();
    s.worktree.republish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    s.start();
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    expect(s.emitted[0]).toMatchObject({ type: 'worktreeState', phase: 'deleted', place: 'worktree' });
  });

  it('publishes the share count, the project name and a finish action, and publishes again when the share count changes', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')], sessionId: 's-self' });
    let others = 2;
    const asked: Array<[string, string, string | undefined]> = [];
    const finish: { action?: 'apply' } = {};
    s.worktree.bindPanel({
      view: () => undefined,
      sharedWith: async (worktreeId, projectPath, sessionId) => {
        asked.push([worktreeId, projectPath, sessionId]);
        return others;
      },
      finishing: () => finish.action,
      moving: () => false, projectName: () => 'project',
    });
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    expect(s.emitted[0]).toMatchObject({ phase: 'ready', place: 'worktree', sharedWith: 2, projectName: 'project' });
    expect(asked[0]).toEqual(['aaaaaaaa', project, 's-self']);
    others = 0;
    finish.action = 'apply';
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(2));
    expect(s.emitted[1]).toMatchObject({ finishing: 'apply' });
    expect(s.emitted[1]).not.toHaveProperty('sharedWith');
    expect(await s.worktree.sharedWith()).toBe(0);
  });

  it('counts no sharing for a chat that moved back to the project folder', async () => {
    const s = sessionAt(project, { entries: [entry('worktree', 'w0'), entry('project', 'w1')] });
    s.worktree.bindPanel({ view: () => undefined, sharedWith: async () => 3, finishing: () => undefined, moving: () => false, projectName: () => 'project' });
    expect(await s.worktree.sharedWith()).toBe(0);
  });

  it('carries the held prompt and the setup step of the panel view into the state', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    s.worktree.bindPanel({
      view: () => ({ phase: 'settingUp', branch: 'damocles/x', setupStep: { command: 'npm ci', index: 1, total: 2 }, heldPrompt: { text: 'Fix it', imageCount: 1 } }),
      sharedWith: async () => 0,
      finishing: () => undefined,
      moving: () => false, projectName: () => 'project',
    });
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    expect(s.emitted[0]).toMatchObject({ phase: 'settingUp', setupStep: { command: 'npm ci', index: 1, total: 2 }, heldPrompt: { text: 'Fix it', imageCount: 1 } });
  });

  it('publishes nothing for a project source control has no repository open for (D9)', async () => {
    const s = sessionAt(project, { entries: [], repository: false });
    s.worktree.publish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toEqual([]);
  });

  it('writes a place recorded before the session started first thing when it starts', () => {
    const s = sessionAt(project, { entries: [entry('worktree', 'w0')], started: false });
    s.worktree.appendPlace('project', record);
    expect(s.entries).toHaveLength(1);
    s.start();
    s.worktree.ensureEntry();
    expect(s.entries).toHaveLength(2);
    expect(s.worktree.place()).toBe('project');
    expect(s.worktree.readOnly()).toBe(false);
  });

  it('publishes once source control opens the project\'s repository, for a chat with no worktree too', async () => {
    repositoryOpen = false;
    const s = sessionAt(project, { entries: [] });
    s.worktree.publish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toEqual([]);
    repositoryOpen = true;
    for (const listener of repositoryListeners) listener(path.join(base, 'other-project'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toEqual([]);
    for (const listener of repositoryListeners) listener(project);
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    expect(s.emitted[0]).toMatchObject({ type: 'worktreeState', phase: 'none', place: 'project', canHandOff: true });
  });

  it('says once that a chat no longer has a state when its repository closes', async () => {
    const s = sessionAt(project, { entries: [] });
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    repositoryOpen = false;
    for (const listener of repositoryListeners) listener(project);
    await vi.waitFor(() => expect(s.emitted).toHaveLength(2));
    expect(s.emitted[1]).toEqual({ type: 'noWorktreeState' });
    s.worktree.publish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toHaveLength(2);
    repositoryOpen = true;
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(3));
    expect(s.emitted[2]).toMatchObject({ type: 'worktreeState', phase: 'none' });
  });

  it('emits only the latest of overlapping publishes, never an older state last', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    const answers: Array<(n: number) => void> = [];
    s.worktree.bindPanel({ view: () => undefined, sharedWith: () => new Promise<number>((resolve) => answers.push(resolve)), finishing: () => undefined, moving: () => false, projectName: () => 'project' });
    s.worktree.publish();
    s.worktree.publish();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!(1);
    answers[0]!(5);
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0]).toMatchObject({ sharedWith: 1 });
  });

  it('offers no hand-off while a finish action runs on the worktree', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    s.worktree.bindPanel({ view: () => undefined, sharedWith: async () => 0, finishing: () => 'merge', moving: () => false, projectName: () => 'project' });
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    expect(s.emitted[0]).toMatchObject({ finishing: 'merge', canHandOff: false });
  });

  it('offers no hand-off while one is in flight, and names the finish action holding the live worktree', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    let moving = true;
    s.worktree.bindPanel({ view: () => undefined, sharedWith: async () => 0, finishing: (id) => (id === record.id ? 'apply' : undefined), moving: () => moving, projectName: () => 'project' });
    expect(s.worktree.finishing()).toBe('apply');
    expect(sessionAt(project, { entries: [entry('worktree'), entry('project')] }).worktree.finishing()).toBeUndefined();
    s.worktree.bindPanel({ view: () => undefined, sharedWith: async () => 0, finishing: () => undefined, moving: () => moving, projectName: () => 'project' });
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    expect(s.emitted[0]).toMatchObject({ canHandOff: false });
    moving = false;
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(2));
    expect(s.emitted[1]).toMatchObject({ canHandOff: true });
  });

  it('sends a stored file\'s place before the session starts, and the live state over it once it starts', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')], started: false });
    s.worktree.setListener(() => undefined);
    const stored = { phase: 'ready' as const, place: 'worktree' as const, canHandOff: false, branch: record.branch };
    s.worktree.publishStored(stored);
    expect(s.emitted).toEqual([{ type: 'worktreeState', ...stored }]);
    s.start();
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(2));
    expect(s.emitted[1]).toMatchObject({ type: 'worktreeState', canHandOff: true });
  });

  it('answers a stored place for the session already running it with its live state, as a reloaded webview needs', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')], sessionId: 's-live' });
    s.worktree.setListener(() => undefined);
    s.worktree.publish();
    await vi.waitFor(() => expect(s.emitted).toHaveLength(1));
    s.worktree.publishStored({ phase: 'ready', place: 'worktree', canHandOff: false }, 's-live');
    await vi.waitFor(() => expect(s.emitted).toHaveLength(2));
    expect(s.emitted[1]).toEqual(s.emitted[0]);
    expect(s.emitted[1]).toMatchObject({ canHandOff: true });
    // A running session about to switch to another stored conversation shows that conversation's place.
    const other = { phase: 'deleted' as const, place: 'worktree' as const, canHandOff: false };
    s.worktree.publishStored(other, 's-other');
    expect(s.emitted[2]).toEqual({ type: 'worktreeState', ...other });
  });

  it('reads the git facts again on a registry write only when it changes a fact they come from', async () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    s.worktree.refreshGit();
    const refresh = vi.spyOn(s.worktree, 'refreshGit');
    await registry.markUsed(record.id);
    await registry.update(record.id, { lastAppliedTree: 'c'.repeat(40) });
    expect(refresh).not.toHaveBeenCalled();
    await registry.update(record.id, { baseCommit: 'b'.repeat(40) });
    expect(refresh).toHaveBeenCalledTimes(1);
    s.worktree.dispose();
  });

  it('reads the git facts again when the project repository\'s refs change', () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')] });
    const refresh = vi.spyOn(s.worktree, 'refreshGit');
    for (const listener of refsListeners) listener(path.join(base, 'elsewhere'));
    expect(refresh).not.toHaveBeenCalled();
    for (const listener of refsListeners) listener(record.projectPath);
    expect(refresh).toHaveBeenCalledTimes(1);
    s.worktree.dispose();
    expect(refsListeners).toHaveLength(0);
  });

  it('matches a refs change by the project path as listed, never by the repository root, which source control spells as its realpath', async () => {
    // A project in a subfolder of its repository: the root and the project path never compare equal.
    const repositoryRoot = path.dirname(project);
    const worktreeRoot = worktreeFolderFor(registry.rootDir, project, 'bbbbbbbb');
    const nested = await registry.addChat({ id: 'bbbbbbbb', kind: 'chat', projectPath: project, repositoryRoot, worktreeRoot, workingFolder: path.join(worktreeRoot, path.basename(project)), branch: 'damocles/y', baseCommit: 'a'.repeat(40), createdAt: 1 });
    const s = sessionAt(nested.workingFolder, { entries: [{ type: 'custom', customType: WORKTREE_ENTRY, data: { worktreeId: 'bbbbbbbb', projectPath: project, place: 'worktree' }, id: 'x' }] });
    const refresh = vi.spyOn(s.worktree, 'refreshGit');
    for (const listener of refsListeners) listener(repositoryRoot);
    expect(refresh).not.toHaveBeenCalled();
    for (const listener of refsListeners) listener(project);
    expect(refresh).toHaveBeenCalledTimes(1);
    s.worktree.dispose();
  });

  it('takes a finished operation\'s pending base in when the project repository\'s refs change', async () => {
    await registry.update(record.id, { pendingBase: { commit: 'b'.repeat(40), side: 'worktree' } });
    // No operation marker exists, and every merge-base --is-ancestor answers yes: the merge was committed.
    const git = {
      git: { path: 'git', version: { major: 2, minor: 45, patch: 0 } },
      run: async (call: { args: readonly string[] }) => {
        const [command] = call.args;
        const out = command === 'rev-parse'
          ? call.args.filter((arg) => arg !== '--git-path').slice(1).map((name) => path.join(base, 'no-git-dir', name)).join('\n')
          : command === 'symbolic-ref' ? 'refs/heads/main' : command === 'rev-list' ? '0' : '';
        return { exitCode: 0, stdout: Buffer.from(out), stderr: '' };
      },
    } as unknown as GitRunner;
    const s = sessionAt(record.workingFolder, { entries: [entry('worktree')], git });
    for (const listener of refsListeners) listener(record.repositoryRoot);
    await vi.waitFor(() => expect((registry.get(record.id) as ChatWorktreeRecord).baseCommit).toBe('b'.repeat(40)));
    expect((registry.get(record.id) as ChatWorktreeRecord).pendingBase).toBeUndefined();
    s.worktree.dispose();
  });

  it('marks the rewind points before the latest hand-off as conversation only', () => {
    const entries = [{ id: 'u1' }, entry('project', 'w0'), { id: 'u2' }, entry('worktree', 'w1'), { id: 'u3' }];
    const items = markHandOffs([{ messageId: 'u1' }, { messageId: 'u2' }, { messageId: 'u3' }] as never, entries);
    expect(items.map((i) => i.crossesHandOff === true)).toEqual([true, true, false]);
  });

  it('treats the first entry after a project-folder conversation as a hand-off, and shows the files of that turn in the project folder', () => {
    const installed = installWorktreeProjectLookup(registry);
    try {
      const entries = [{ id: 'u1', type: 'message' }, entry('worktree', 'w1'), { id: 'u2', type: 'message' }];
      const items = markHandOffs([
        { messageId: 'u1', files: [{ path: path.join(record.workingFolder, 'a.ts'), displayName: 'a.ts' }] },
        { messageId: 'u2' },
      ] as never, entries, record.workingFolder);
      expect(items[0]).toMatchObject({ crossesHandOff: true, files: [{ path: path.join(project, 'a.ts') }] });
      expect(items[1]!.crossesHandOff).toBeUndefined();
      expect([precedesHandOff(entries, 'u1'), precedesHandOff(entries, 'u2')]).toEqual([true, false]);
      const s = sessionAt(record.workingFolder, { entries });
      expect(s.worktree.handOffs()).toEqual({ initialFolder: project, handOffs: [{ entryId: 'w1', folder: record.workingFolder }] });
    } finally {
      installed.dispose();
    }
  });

  it('shows the files of each turn before the latest hand-off in the folder the chat worked in then, across several hand-offs', () => {
    const installed = installWorktreeProjectLookup(registry);
    try {
      const turn = (id: string) => ({ id, type: 'message' });
      const entries = [turn('u1'), entry('worktree', 'w1'), turn('u2'), entry('project', 'w2'), turn('u3')];
      const fileIn = (folder: string) => [{ path: path.join(folder, 'a.ts'), displayName: 'a.ts' }];
      const items = markHandOffs([
        { messageId: 'u1', files: fileIn(project) },
        { messageId: 'u2', files: fileIn(project) },
        { messageId: 'u3', files: fileIn(project) },
      ] as never, entries, project);
      expect(items.map((i) => i.files?.[0]?.path)).toEqual([path.join(project, 'a.ts'), path.join(record.workingFolder, 'a.ts'), path.join(project, 'a.ts')]);
      expect(items.map((i) => i.crossesHandOff === true)).toEqual([true, true, false]);
    } finally {
      installed.dispose();
    }
  });

  it('maps records across a hand-off to the folder each was made in', () => {
    const s = sessionAt(record.workingFolder, { entries: [entry('project', 'w0'), entry('worktree', 'w1')] });
    expect(s.worktree.handOffs()).toEqual({ initialFolder: project, handOffs: [{ entryId: 'w1', folder: record.workingFolder }] });
  });
});
