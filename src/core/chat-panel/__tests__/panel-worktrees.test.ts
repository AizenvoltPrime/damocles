import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner, type GitRunner } from '../../scm/git-runner';
import { folder, git, GIT_PATH, HAS_GIT, MapMemento, makeRepo, useGitSandbox, watchers, write } from '../../scm/__tests__/git-harness';
import { WorktreeRegistry, type ChatWorktreeRecord } from '../../worktrees/registry';
import { folderKey } from '../../workspace-folders/folder-key';
import type { FolderTarget, WorkspaceFolderRegistry } from '../../workspace-folders/folder-registry';
import type { SetupStep, WorktreeHostServices } from '../../worktrees/host';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../shared/types/messages';
import type { StoredSession } from '../../../shared/types/session';
import type { PanelWorktreeBinding } from '../../pi-session/session-worktree';
import { createChatWorktree } from '../../worktrees/create';
import { WORKTREE_ENTRY } from '../../worktrees/hand-off';
import { ensurePiSessionDir } from '../../pi-session/session-store/session-dir';
import { isSessionHeldByPanelHere } from '../../pi-session/session-store/session-lease';
import { PanelWorktrees } from '../panel-worktrees';
import type { HostInstance } from '../types';

/** Rules 3 and 4: the opt-in, the held first prompt, setup and its review, with real git in a temp sandbox. */
useGitSandbox();

const registries: WorktreeRegistry[] = [];
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose();
});

function runner(): GitRunner {
  const v = git(['version'], process.cwd()).match(/(\d+)\.(\d+)\.(\d+)/)!;
  return createGitRunner({ git: { path: GIT_PATH!, version: { major: +v[1]!, minor: +v[2]!, patch: +v[3]! } }, log: { appendLine: () => undefined }, isTrusted: () => true });
}

const target = (fsPath: string, ownerKey?: string): FolderTarget => ({ key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope: true, ...(ownerKey ? { ownerKey } : {}) });

interface FakeWorktree {
  publish: ReturnType<typeof vi.fn>;
  readOnly: () => boolean;
  busy: () => boolean;
  inLiveWorktree: () => ChatWorktreeRecord | undefined;
  entry: () => { worktreeId: string; projectPath: string; place: 'worktree' | 'project' } | undefined;
  record: () => ChatWorktreeRecord | undefined;
  place: () => 'worktree' | 'project';
  firstPromptText: () => string;
  bindPanel: (binding: PanelWorktreeBinding) => void;
  setListener: () => void;
  appendPlace: ReturnType<typeof vi.fn>;
  binding?: PanelWorktreeBinding;
}

function fakeSession(conversation = false, sessionId: string | null = null) {
  const worktree: FakeWorktree = {
    publish: vi.fn(),
    readOnly: () => false,
    busy: () => false,
    inLiveWorktree: () => undefined,
    entry: () => undefined,
    record: () => undefined,
    place: () => 'project',
    firstPromptText: () => 'Fix the login page',
    bindPanel: (binding) => { worktree.binding = binding; },
    setListener: () => undefined,
    appendPlace: vi.fn(),
  };
  return {
    worktree,
    hasConversation: () => conversation,
    storedSessionId: sessionId,
    currentSessionId: sessionId,
    noteWorkingFolder: vi.fn(),
    chatReviewSnapshot: async () => ({ files: [], shellChangesNotListed: true }),
  };
}

interface HarnessOptions {
  setupResult?: (onStep: (step: SetupStep) => void) => Promise<{ exitCode: number }>;
  stored?: StoredSession[];
  // the rows once every session file is parsed; stored by default
  complete?: StoredSession[];
  trusted?: boolean;
  repository?: boolean;
}

function harness(name: string, options: HarnessOptions = {}) {
  const project = makeRepo(folder(name));
  const registry = new WorktreeRegistry({ rootDir: folder(`${name}-wt`), watcherFactory: watchers, log: () => undefined });
  registries.push(registry);
  const owned = new Map<string, { target: FolderTarget; refs: number }>();
  const projectTarget = target(project);
  const folderRegistry = {
    resolve: (key: string) => (key === projectTarget.key ? projectTarget : owned.get(key)?.target),
    targets: () => [projectTarget],
    projectOf: () => projectTarget,
    acquireOwned: (fsPath: string, ownerKey: string) => {
      const key = folderKey(fsPath);
      const entry = owned.get(key) ?? { target: target(fsPath, ownerKey), refs: 0 };
      entry.refs++;
      owned.set(key, entry);
      let released = false;
      return {
        dispose: () => {
          if (released) return;
          released = true;
          if (--entry.refs === 0) owned.delete(key);
        },
      };
    },
  } as unknown as WorkspaceFolderRegistry;
  const setupResult = options.setupResult ?? (async () => ({ exitCode: 0 }));
  const host = {
    registry,
    git: () => runner(),
    branchPrefix: () => '',
    reviewSetup: vi.fn(async () => 'run' as const),
    runSetup: vi.fn((_req: unknown, onStep: (step: SetupStep) => void) => setupResult(onStep)),
    confirmHandOff: vi.fn(async () => true),
    showRefusal: vi.fn(async () => undefined),
    newChatInProject: vi.fn(),
    showSetupTerminal: vi.fn(),
    stopSetup: vi.fn(),
    showApplyConflicts: vi.fn(async () => undefined),
    newChatInWorktree: vi.fn(),
    onDidChangeRefs: () => ({ dispose: () => undefined }),
    onDidChangeProjectRepository: () => ({ dispose: () => undefined }),
    projectRepository: (projectPath: string) => (options.repository === false ? undefined : projectPath),
  } satisfies WorktreeHostServices;
  const state = new MapMemento();
  const session = fakeSession();
  const instance = { folder: projectTarget, session } as unknown as HostInstance;
  const panels = new Map([['p1', instance]]);
  const dispatched: WebviewToExtensionMessage[] = [];
  const posted: ExtensionToWebviewMessage[] = [];
  const releaseFolder = vi.fn(async () => undefined);
  let sessionsClosed: Promise<void> = Promise.resolve();
  const warn = vi.fn(async () => undefined);
  // As PanelManager.resumeInto: once the claim passes, the session gets what its start writes first, then it opens.
  const resumeInto = vi.fn(async (instance: HostInstance, _sessionId: string, beforeOpen?: (session: HostInstance['session']) => void) => {
    beforeOpen?.(instance.session);
    return true;
  });
  const moveTo = vi.fn(async (_panelId: string, key: string, afterSwitch?: (instance: HostInstance) => Promise<void>): Promise<HostInstance | undefined> => {
    instance.folder = folderRegistry.resolve(key)!;
    await afterSwitch?.(instance);
    return instance;
  });
  const trust = { trusted: options.trusted !== false };
  const worktrees = new PanelWorktrees({
    platform: { capabilities: { worktrees: true }, worktrees: host, trust: { isTrusted: () => trust.trusted }, state: { global: state }, notifications: { warn } } as never,
    folderRegistry,
    panels: () => panels,
    moveTo,
    post: (_panelId, message) => {
      posted.push(message);
    },
    dispatch: async (_panelId, message) => {
      dispatched.push(message);
    },
    resumeInto,
    releaseFolder,
    sessionsClosed: () => sessionsClosed,
    storedSessionsOf: async () => options.stored ?? [],
    completeStoredSessionsOf: async () => options.complete ?? options.stored ?? [],
  });
  return {
    project, projectTarget, registry, host, worktrees, instance, session, panels, dispatched, posted, releaseFolder, warn, resumeInto, folderRegistry, moveTo, trust,
    holdSessionsClosed: (until: Promise<void>) => { sessionsClosed = until; },
  };
}

const prompt: WebviewToExtensionMessage = { type: 'sendMessage', content: 'Fix the login page now', sessionId: 'sess-project' };
const second: WebviewToExtensionMessage = { type: 'sendMessage', content: [{ type: 'text', text: 'And the logout' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }], sessionId: 'sess-project' };
// The move to the worktree gives the chat a new session, so the held prompt names no conversation once it is sent there.
const promptInWorktree: WebviewToExtensionMessage = { ...prompt, sessionId: null };

async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

async function chatRecord(h: ReturnType<typeof harness>): Promise<ChatWorktreeRecord> {
  return (await createChatWorktree({ git: runner(), registry: h.registry, projectPath: h.project, startRef: 'refs/heads/main', bringChanges: false, slugSource: 'shared work', branchPrefix: '' })).record;
}

describe.skipIf(!HAS_GIT)('panel worktrees: opt-in and first send', { timeout: 120_000 }, () => {
  it('creates nothing for an opt-in the user cancels before sending', async () => {
    const h = harness('cancel');
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    expect(h.worktrees.viewOf('p1')).toMatchObject({ phase: 'pending', branch: 'main' });
    await h.worktrees.action('p1', 'cancelOptIn');
    expect(h.worktrees.viewOf('p1')).toBeUndefined();
    expect(h.registry.records()).toEqual([]);
  });

  it('holds the first prompt through creation and an approved setup, sends it on exit 0, and asks again only when the commands change', async () => {
    const h = harness('first-send');
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['echo one'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    expect(h.worktrees.interceptSend('p1', prompt)).toBe(true);
    expect(h.posted).toEqual([{ type: 'processing', isProcessing: false }]);
    await settled(() => h.dispatched.length === 1);
    expect(h.dispatched[0]).toEqual(promptInWorktree);
    const record = h.registry.liveChatRecords(h.project)[0]!;
    expect(fs.existsSync(record.workingFolder)).toBe(true);
    expect(h.instance.folder.key).toBe(folderKey(record.workingFolder));
    expect(h.host.reviewSetup).toHaveBeenCalledTimes(1);
    expect(h.host.runSetup).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: record.id, commands: ['echo one'], env: { DAMOCLES_PROJECT_FOLDER: h.project, DAMOCLES_WORKTREE_INDEX: '1' } }), expect.any(Function));

    // A second new chat in the same project, with the commands unchanged.
    h.instance.folder = target(h.project);
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.dispatched.length === 2);
    expect(h.host.reviewSetup).toHaveBeenCalledTimes(1);
  });

  it('shows a failed setup with its exit code, and Send anyway sends the held prompt', async () => {
    const h = harness('setup-fail', { setupResult: async () => ({ exitCode: 3 }) });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['exit 3'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'setupFailed');
    expect(h.worktrees.viewOf('p1')).toMatchObject({ exitCode: 3, heldPrompt: { text: 'Fix the login page now', imageCount: 0 } });
    expect(h.dispatched).toEqual([]);
    await h.worktrees.action('p1', 'sendNow');
    expect(h.dispatched).toEqual([promptInWorktree]);
  });

  it('keeps the prompt when creation fails, and Run in project folder sends it there', async () => {
    const h = harness('create-fail');
    h.host.branchPrefix = () => 'bad..prefix/';
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'createFailed');
    expect(h.worktrees.viewOf('p1')?.error).toBeTruthy();
    expect(h.worktrees.viewOf('p1')?.heldPrompt).toEqual({ text: 'Fix the login page now', imageCount: 0 });
    expect(h.worktrees.heldPrompt('p1')).toEqual([{ type: 'text', text: 'Fix the login page now' }]);
    expect(h.registry.records()).toEqual([]);
    await h.worktrees.action('p1', 'runInProjectFolder');
    expect(h.dispatched).toEqual([prompt]);
    expect(h.worktrees.viewOf('p1')).toBeUndefined();
  });

  it('reads the setup commands before creating, so a malformed worktree.json leaves no worktree on any retry', async () => {
    const h = harness('bad-setup');
    write(path.join(h.project, '.damocles', 'worktree.json'), '{ not json');
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'createFailed');
    await h.worktrees.action('p1', 'retry');
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'createFailed');
    expect(h.registry.records()).toEqual([]);
  });

  it('discards a worktree whose chat could not move into it, so a Retry leaves none behind', async () => {
    const h = harness('move-throws');
    h.moveTo.mockRejectedValue(new Error('no session there'));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'createFailed');
    await h.worktrees.action('p1', 'retry');
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'createFailed');
    expect(h.registry.records()).toEqual([]);
    expect(git(['branch', '--list', 'damocles/*'], h.project).trim()).toBe('');
    expect(h.worktrees.viewOf('p1')?.heldPrompt).toEqual({ text: 'Fix the login page now', imageCount: 0 });
  });

  it('discards the worktree of a chat that closed while it was being created', async () => {
    const h = harness('closed-while-creating');
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    h.worktrees.panelClosed('p1');
    await settled(() => h.registry.records().length === 0 && fs.readdirSync(h.registry.rootDir).every((name) => name === 'registry.json' || fs.readdirSync(path.join(h.registry.rootDir, name)).length === 0));
    expect(git(['branch', '--list', 'damocles/*'], h.project).trim()).toBe('');
    expect(h.dispatched).toEqual([]);
  });

  it('returns a second send while the first prompt is held, text and images, to the composer', async () => {
    let finish!: (value: { exitCode: number }) => void;
    const h = harness('second-send', { setupResult: () => new Promise((resolve) => { finish = resolve; }) });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['echo one'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'settingUp');
    expect(h.worktrees.interceptSend('p1', second)).toBe(true);
    expect(h.posted.at(-1)).toEqual({ type: 'promptReturned', content: (second as { content: unknown }).content, reason: 'heldPromptWaiting' });
    finish({ exitCode: 0 });
    await settled(() => h.dispatched.length === 1);
    expect(h.dispatched).toEqual([promptInWorktree]);
  });

  it('shows the setup step as each command starts, and Restart reruns the setup after the prompt was sent', async () => {
    const steps: Array<SetupStep | undefined> = [];
    const h = harness('restart', {
      setupResult: async (onStep) => {
        onStep({ index: 1, total: 2, command: 'echo one' });
        steps.push(h.worktrees.viewOf('p1')?.setupStep);
        return { exitCode: 0 };
      },
    });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['echo one', 'echo two'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.dispatched.length === 1);
    expect(steps).toEqual([{ index: 1, total: 2, command: 'echo one' }]);
    const record = h.registry.liveChatRecords(h.project)[0]!;
    await h.worktrees.retrySetup(record.id);
    expect(h.host.runSetup).toHaveBeenCalledTimes(2);
    expect(h.dispatched).toHaveLength(1);
  });

  it('drops the opt-in and returns its held prompt when the panel moves to another folder', async () => {
    const h = harness('folder-change');
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    h.worktrees.folderChanged('p1');
    expect(h.worktrees.viewOf('p1')).toBeUndefined();
    expect(h.worktrees.heldPrompt('p1')).toBeUndefined();
    expect(h.posted.at(-1)).toEqual({ type: 'promptReturned', content: [{ type: 'text', text: 'Fix the login page now' }], reason: 'heldPromptKept' });
    await settled(() => h.registry.records().length === 0);
    expect(h.dispatched).toEqual([]);
  });

  it('stops the Setup terminal and waits for the chat\'s session to close before discarding a worktree its closed chat never used', async () => {
    const h = harness('closed-while-setting-up', { setupResult: () => new Promise(() => undefined) });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['npm ci'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'settingUp');
    const record = h.registry.liveChatRecords(h.project)[0]!;
    let closeSessions!: () => void;
    h.holdSessionsClosed(new Promise((resolve) => { closeSessions = resolve; }));
    h.worktrees.panelClosed('p1');
    expect(h.host.stopSetup).toHaveBeenCalledWith(record.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.registry.get(record.id)).toBeDefined();
    expect(fs.existsSync(record.workingFolder)).toBe(true);
    closeSessions();
    await settled(() => h.registry.records().length === 0);
    expect(fs.existsSync(record.workingFolder)).toBe(false);
  });

  it('settles whenDiscarded only once the worktree of a chat closed while it was being created is gone', async () => {
    const h = harness('discarded-while-creating');
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    h.worktrees.panelClosed('p1');
    await h.worktrees.whenDiscarded('p1');
    expect(h.registry.records()).toEqual([]);
    expect(git(['worktree', 'list', '--porcelain'], h.project).match(/^worktree /gm)).toHaveLength(1);
    expect(git(['branch', '--list', 'damocles/*'], h.project).trim()).toBe('');
    expect(h.dispatched).toEqual([]);
  });

  it('settles whenDiscarded for a chat closed during setup only after its session there closed and its worktree is gone', async () => {
    const h = harness('discarded-while-setting-up', { setupResult: () => new Promise(() => undefined) });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['npm ci'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'settingUp');
    const record = h.registry.liveChatRecords(h.project)[0]!;
    let closeSessions!: () => void;
    h.holdSessionsClosed(new Promise((resolve) => { closeSessions = resolve; }));
    h.worktrees.panelClosed('p1');
    let discarded = false;
    void h.worktrees.whenDiscarded('p1').then(() => { discarded = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(discarded).toBe(false);
    expect(h.host.stopSetup).toHaveBeenCalledWith(record.id);
    closeSessions();
    await h.worktrees.whenDiscarded('p1');
    expect(h.registry.records()).toEqual([]);
    expect(fs.existsSync(record.workingFolder)).toBe(false);
  });

  it('settles whenDiscarded at once for a closed chat that made no worktree', async () => {
    const h = harness('nothing-to-discard');
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.panelClosed('p1');
    await h.worktrees.whenDiscarded('p1');
    await h.worktrees.whenDiscarded('never-loaded');
    expect(h.registry.records()).toEqual([]);
  });

  it('refuses to rerun the setup of a project that is no longer trusted, and shows the setup as failed', async () => {
    const h = harness('untrusted-retry', { setupResult: async () => ({ exitCode: 2 }) });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['exit 2'] }));
    await h.worktrees.setOptIn('p1', { startRef: 'refs/heads/main', bringChanges: false });
    h.worktrees.interceptSend('p1', prompt);
    await settled(() => h.worktrees.viewOf('p1')?.phase === 'setupFailed');
    h.trust.trusted = false;
    const record = h.registry.liveChatRecords(h.project)[0]!;
    await h.worktrees.action('p1', 'retry');
    await h.worktrees.retrySetup(record.id);
    expect(h.host.runSetup).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('Trust this folder to use worktrees');
    expect(h.worktrees.viewOf('p1')).toMatchObject({ phase: 'setupFailed', heldPrompt: { text: 'Fix the login page now', imageCount: 0 } });
    expect(h.dispatched).toEqual([]);
  });
});

describe.skipIf(!HAS_GIT)('panel worktrees: a new chat in a worktree, sharing and finishing', { timeout: 120_000 }, () => {
  it('binds a new panel to a live chat worktree of its project and refuses any other', async () => {
    const h = harness('new-in-worktree');
    const record = await chatRecord(h);
    const bound = h.worktrees.bindNewPanel('p2', h.projectTarget.key, record.id);
    expect(bound).toMatchObject({ key: folderKey(record.workingFolder), ownerKey: h.projectTarget.key });
    expect(() => h.worktrees.bindNewPanel('p3', folderKey(path.join(h.project, 'elsewhere')), record.id)).toThrow();
    await h.registry.markDeleted(record.id);
    expect(() => h.worktrees.bindNewPanel('p4', h.projectTarget.key, record.id)).toThrow();
    expect(h.registry.liveChatRecords(h.project)).toEqual([]);
  });

  it('counts the other chats of the project in the same worktree, loaded or stored, never the chat itself', async () => {
    const h = harness('shared', {
      stored: [
        { id: 's-stored', worktree: { worktreeId: 'aaaaaaaa', place: 'worktree' } },
        { id: 's-moved-back', worktree: { worktreeId: 'aaaaaaaa', place: 'project' } },
        { id: 's-loaded', worktree: { worktreeId: 'aaaaaaaa', place: 'project' } },
        { id: 's-self', worktree: { worktreeId: 'aaaaaaaa', place: 'worktree' } },
      ] as unknown as StoredSession[],
    });
    const loaded = fakeSession(true, 's-loaded');
    loaded.worktree.entry = () => ({ worktreeId: 'aaaaaaaa', projectPath: h.project, place: 'worktree' });
    h.panels.set('p2', { folder: h.projectTarget, session: loaded } as unknown as HostInstance);
    h.worktrees.bind('p1', h.instance);
    const binding = h.session.worktree.binding!;
    expect(await binding.sharedWith('aaaaaaaa', h.project, 's-self')).toBe(2);
    h.panels.delete('p2');
    h.worktrees.panelClosed('p2');
    expect(loaded.worktree.publish).not.toHaveBeenCalled();
    expect(h.session.worktree.publish).toHaveBeenCalled();
    expect(await binding.sharedWith('aaaaaaaa', h.project, 's-self')).toBe(1);
  });

  it('drops a deleted worktree record once no chat lists from its folder or names it, and keeps a live one', async () => {
    const stored: StoredSession[] = [];
    const h = harness('tombstones', { stored });
    const named = await chatRecord(h);
    const listed = await chatRecord(h);
    const unused = await chatRecord(h);
    const live = await chatRecord(h);
    for (const record of [named, listed, unused]) await h.registry.markDeleted(record.id);
    stored.push({ id: 's-named', worktree: { worktreeId: named.id, projectPath: h.project, place: 'worktree' } } as unknown as StoredSession);
    const listedDir = ensurePiSessionDir(listed.workingFolder);
    const listedFile = path.join(listedDir, '2025-01-01T00-00-00-000Z_s-listed.jsonl');
    fs.writeFileSync(listedFile, `${JSON.stringify({ type: 'session', id: 's-listed', cwd: listed.workingFolder })}\n`);
    const loaded = fakeSession(true, 's-loaded');
    const loadedRecord = await chatRecord(h);
    await h.registry.markDeleted(loadedRecord.id);
    loaded.worktree.entry = () => ({ worktreeId: loadedRecord.id, projectPath: h.project, place: 'worktree' });
    h.panels.set('p2', { folder: h.projectTarget, session: loaded } as unknown as HostInstance);
    try {
      await h.worktrees.storedSessionsChanged();
      expect(h.registry.records().map((r) => r.id).sort()).toEqual([named.id, listed.id, live.id, loadedRecord.id].sort());
      stored.splice(0);
      fs.rmSync(listedFile);
      h.panels.delete('p2');
      await h.worktrees.storedSessionsChanged();
      expect(h.registry.records().map((r) => r.id)).toEqual([live.id]);
    } finally {
      fs.rmSync(listedDir, { recursive: true, force: true });
    }
  });

  it('keeps a deleted record a stored chat names while that chat\'s file is still being parsed', async () => {
    const complete: StoredSession[] = [];
    const h = harness('tombstones-parsing', { stored: [], complete });
    const named = await chatRecord(h);
    await h.registry.markDeleted(named.id);
    complete.push({ id: 's-named', worktree: { worktreeId: named.id, projectPath: h.project, place: 'worktree' } } as unknown as StoredSession);
    await h.worktrees.storedSessionsChanged();
    expect(h.registry.records().map((r) => r.id)).toEqual([named.id]);
  });

  it('holds a worktree for a finish action only while its chats are idle, and its chats see the action', async () => {
    const h = harness('finishing');
    const record = await chatRecord(h);
    h.session.worktree.inLiveWorktree = () => record;
    h.session.worktree.record = () => record;
    let busy = true;
    h.session.worktree.busy = () => busy;
    expect(h.worktrees.beginFinish(record.id, 'delete')).toBeUndefined();
    busy = false;
    const hold = h.worktrees.beginFinish(record.id, 'apply')!;
    h.worktrees.bind('p1', h.instance);
    expect(h.session.worktree.binding!.finishing(record.id)).toBe('apply');
    // No new chat joins and no hand-off starts while the action runs.
    expect(() => h.worktrees.bindNewPanel('p2', h.projectTarget.key, record.id)).toThrow();
    const moving = fakeSession(true, 'moving');
    moving.worktree.record = () => record;
    moving.worktree.inLiveWorktree = () => record;
    moving.worktree.place = () => 'worktree';
    h.panels.set('p3', { folder: target(record.workingFolder, h.projectTarget.key), session: moving } as unknown as HostInstance);
    await h.worktrees.chatMove('p3', 'project');
    expect(h.host.confirmHandOff).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('Apply, Merge, Update or Delete is running on this worktree. Try again when it ends.');
    hold.dispose();
    expect(h.session.worktree.binding!.finishing(record.id)).toBeUndefined();
  });

  it('tells the other chats when a chat joins or leaves a worktree, never when it only turns busy', async () => {
    const h = harness('publish-others');
    const record = await chatRecord(h);
    const other = fakeSession(true, 'other');
    h.panels.set('p2', { folder: h.projectTarget, session: other } as unknown as HostInstance);
    let listener!: (event: unknown) => void;
    h.session.worktree.setListener = ((l: (event: unknown) => void) => { listener = l; }) as never;
    h.worktrees.bind('p1', h.instance);
    const event = (busy: boolean) => ({ state: { phase: 'ready', place: 'worktree', canHandOff: !busy }, projectPath: h.project, worktreeId: record.id, workingFolder: record.workingFolder, busy });
    listener(event(false));
    expect(other.worktree.publish).toHaveBeenCalledTimes(1);
    listener(event(true));
    listener(event(false));
    expect(other.worktree.publish).toHaveBeenCalledTimes(1);
    listener({ ...event(false), state: { phase: 'none', place: 'project', canHandOff: true } });
    expect(other.worktree.publish).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending release of a working folder a chat binds to again', async () => {
    const h = harness('release');
    const record = await chatRecord(h);
    h.worktrees.bindNewPanel('p1', h.projectTarget.key, record.id);
    let closeSessions!: () => void;
    h.holdSessionsClosed(new Promise((resolve) => { closeSessions = resolve; }));
    h.worktrees.dropHold('p1');
    h.worktrees.bindNewPanel('p2', h.projectTarget.key, record.id);
    closeSessions();
    await h.worktrees.whenFolderReleased(record.workingFolder);
    expect(h.releaseFolder).not.toHaveBeenCalled();
    h.worktrees.dropHold('p2');
    await h.worktrees.whenFolderReleased(record.workingFolder);
    expect(h.releaseFolder).toHaveBeenCalledWith(folderKey(record.workingFolder));
  });
});

function storedSession(project: string, sessionId: string, entries: unknown[]): void {
  const dir = ensurePiSessionDir(project);
  const lines = [{ type: 'session', id: sessionId, cwd: project }, ...entries].map((line) => JSON.stringify(line));
  fs.writeFileSync(path.join(dir, `2025-01-01T00-00-00-000Z_${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

const worktreeEntry = (record: ChatWorktreeRecord, place: 'worktree' | 'project') => ({ type: 'custom', customType: WORKTREE_ENTRY, id: `e-${place}`, data: { worktreeId: record.id, projectPath: record.projectPath, place } });

describe.skipIf(!HAS_GIT)('panel worktrees: resuming a stored chat', { timeout: 120_000 }, () => {
  it('binds to the live worktree and gives the stored place before the session starts', async () => {
    const h = harness('resume-live');
    const record = await chatRecord(h);
    storedSession(h.project, 'resume-live-1', [worktreeEntry(record, 'worktree')]);
    const binding = await h.worktrees.resumeFolder('p1', 'resume-live-1', h.projectTarget);
    expect(binding.folder.key).toBe(folderKey(record.workingFolder));
    expect(binding.state).toEqual({ phase: 'ready', place: 'worktree', canHandOff: false, projectName: h.projectTarget.label, branch: record.branch });
  });

  it('reads a working folder removed outside Damocles as deleted and binds read-only to the project', async () => {
    const h = harness('resume-vanished');
    const record = await chatRecord(h);
    git(['worktree', 'remove', '--force', record.worktreeRoot], h.project);
    storedSession(h.project, 'resume-vanished-1', [worktreeEntry(record, 'worktree')]);
    const binding = await h.worktrees.resumeFolder('p1', 'resume-vanished-1', h.projectTarget);
    expect(binding.folder).toBe(h.projectTarget);
    expect(binding.state).toMatchObject({ phase: 'deleted', place: 'worktree' });
  });

  it('gives no early state where the live publisher shows none: an untrusted or non-git project', async () => {
    for (const options of [{ trusted: false }, { repository: false }]) {
      const h = harness(`resume-hidden-${options.trusted === false ? 'untrusted' : 'nogit'}`, options);
      const record = await chatRecord(h);
      storedSession(h.project, `hidden-project-${record.id}`, []);
      storedSession(h.project, `hidden-worktree-${record.id}`, [worktreeEntry(record, 'worktree')]);
      expect((await h.worktrees.resumeFolder('p1', `hidden-project-${record.id}`, h.projectTarget)).state).toBeNull();
      expect((await h.worktrees.resumeFolder('p1', `hidden-worktree-${record.id}`, h.projectTarget)).state).toBeNull();
      expect(h.worktrees.placeOf('p1')).toBeNull();
      // A read-only chat is shown whatever its project.
      await h.registry.markDeleted(record.id);
      expect((await h.worktrees.resumeFolder('p1', `hidden-worktree-${record.id}`, h.projectTarget)).state).toMatchObject({ phase: 'deleted' });
    }
  });

  it('keeps the panel\'s working folder until the switch lands in the resumed chat\'s, and lets go of one it never reached', async () => {
    const h = harness('resume-hold');
    const first = await chatRecord(h);
    const second = (await createChatWorktree({ git: runner(), registry: h.registry, projectPath: h.project, startRef: 'refs/heads/main', bringChanges: false, slugSource: 'second work', branchPrefix: '' })).record;
    const registered = (record: ChatWorktreeRecord): boolean => h.folderRegistry.resolve(folderKey(record.workingFolder)) !== undefined;
    h.worktrees.bindNewPanel('p1', h.projectTarget.key, first.id);
    storedSession(h.project, 'resume-hold-1', [worktreeEntry(second, 'worktree')]);
    const failed = await h.worktrees.resumeFolder('p1', 'resume-hold-1', h.projectTarget);
    expect([registered(first), registered(second)]).toEqual([true, true]);
    failed.settle(h.instance);
    expect([registered(first), registered(second)]).toEqual([true, false]);
    const landed = await h.worktrees.resumeFolder('p1', 'resume-hold-1', h.projectTarget);
    h.instance.folder = landed.folder;
    landed.settle(h.instance);
    expect([registered(first), registered(second)]).toEqual([false, true]);
  });

  it('gives a project-folder chat an explicit project place', async () => {
    const h = harness('resume-project');
    storedSession(h.project, 'resume-project-1', []);
    expect((await h.worktrees.resumeFolder('p1', 'resume-project-1', h.projectTarget)).state).toEqual({ phase: 'none', place: 'project', canHandOff: false });
  });
});

describe.skipIf(!HAS_GIT)('panel worktrees: hand-off', { timeout: 120_000 }, () => {
  it('refuses a hand-off while the chat is busy', async () => {
    const h = harness('busy');
    h.session.worktree.busy = () => true;
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.host.confirmHandOff).not.toHaveBeenCalled();
  });

  it('hands a chat on a detached HEAD off to a worktree started from HEAD\'s commit', async () => {
    const h = harness('detached');
    const head = git(['rev-parse', 'HEAD'], h.project).trim();
    git(['checkout', '--quiet', '--detach', 'HEAD'], h.project);
    const session = fakeSession(true, 'detached-session');
    h.instance.session = session as never;
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.host.showRefusal).not.toHaveBeenCalled();
    const record = h.registry.liveChatRecords(h.project)[0]!;
    expect(record.baseCommit).toBe(head);
    expect(h.resumeInto).toHaveBeenCalledWith(h.instance, 'detached-session', expect.any(Function));
    expect(session.noteWorkingFolder).toHaveBeenCalledWith(record.workingFolder);
  });

  it('puts the conversation back in its folder and tells the user when the resume in the worktree fails', async () => {
    const h = harness('resume-fails');
    const session = fakeSession(true, 'resume-fails');
    h.instance.session = session as never;
    h.resumeInto.mockImplementationOnce(async () => false);
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.instance.folder.key).toBe(h.projectTarget.key);
    expect(h.resumeInto).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('stays in the project folder'));
    expect(session.noteWorkingFolder).not.toHaveBeenCalled();
    // The worktree holds the moved files, so the leftover scan must never offer it as unused.
    await settled(() => h.registry.liveChatRecords(h.project)[0]?.usedAt !== undefined);
  });

  it('keeps a new worktree, marks it used and says where the files are when the move fails after the project folder changed', async () => {
    const h = harness('move-fails-late');
    const session = fakeSession(true, 'move-fails-late');
    session.chatReviewSnapshot = async () => ({ files: [{ absolute: path.join(h.project, 'a.txt'), outsideEdits: false }, { absolute: path.join(h.project, 'new.txt'), outsideEdits: false }], shellChangesNotListed: true }) as never;
    h.instance.session = session as never;
    write(path.join(h.project, 'a.txt'), 'chat edit\n');
    write(path.join(h.project, 'new.txt'), 'chat created\n');
    const lock = path.join(h.project, '.git', 'index.lock');
    // Another git client takes the index once the move has copied a file, so only its restore meets the lock.
    const copyFile = fs.promises.copyFile;
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copyFile(from, to, mode);
      fs.writeFileSync(lock, '');
    });
    try {
      await h.worktrees.chatMove('p1', 'worktree');
    } finally {
      copy.mockRestore();
      fs.rmSync(lock, { force: true });
    }
    await settled(() => h.registry.liveChatRecords(h.project)[0]?.usedAt !== undefined);
    const record = h.registry.liveChatRecords(h.project)[0]!;
    expect(h.resumeInto).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining(record.workingFolder));
    for (const dir of [h.project, record.workingFolder]) expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('chat created\n');
  });

  it('shows git\'s error and the folders of a move that failed with control and bidi characters escaped', async () => {
    const h = harness('move-fails-\u202Ebidi');
    const session = fakeSession(true, 'move-fails-bidi');
    session.chatReviewSnapshot = async () => ({ files: [{ absolute: path.join(h.project, 'a.txt'), outsideEdits: false }], shellChangesNotListed: true }) as never;
    h.instance.session = session as never;
    write(path.join(h.project, 'a.txt'), 'chat edit\n');
    const lock = path.join(h.project, '.git', 'index.lock');
    const copyFile = fs.promises.copyFile;
    const copy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      await copyFile(from, to, mode);
      fs.writeFileSync(lock, '');
    });
    try {
      await h.worktrees.chatMove('p1', 'worktree');
    } finally {
      copy.mockRestore();
      fs.rmSync(lock, { force: true });
    }
    const notices = h.warn.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(notices.some((notice) => notice.includes('move-fails-\\u{202E}bidi'))).toBe(true);
    expect(notices.join('\n')).not.toContain('\u202E');
  });

  it('discards a new worktree when the move fails before the project folder changed', async () => {
    const h = harness('move-fails-early');
    const session = fakeSession(true, 'move-fails-early');
    session.chatReviewSnapshot = async () => ({ files: [{ absolute: path.join(h.project, 'a.txt'), outsideEdits: false }], shellChangesNotListed: true }) as never;
    h.instance.session = session as never;
    write(path.join(h.project, 'a.txt'), 'chat edit\n');
    const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }));
    try {
      await expect(h.worktrees.chatMove('p1', 'worktree')).rejects.toThrow('resource busy or locked');
    } finally {
      copy.mockRestore();
    }
    expect(h.registry.records()).toEqual([]);
    expect(git(['branch', '--list', 'damocles/*'], h.project).trim()).toBe('');
    expect(fs.readFileSync(path.join(h.project, 'a.txt'), 'utf8')).toBe('chat edit\n');
  });

  it('re-checks that the chat is idle after the confirmation, and changes nothing when a turn started', async () => {
    const h = harness('busy-after-confirm');
    const session = fakeSession(true, 'busy-after-confirm');
    h.instance.session = session as never;
    h.host.confirmHandOff.mockImplementation(async () => {
      session.worktree.busy = () => true;
      return true;
    });
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.registry.records()).toEqual([]);
    expect(h.resumeInto).not.toHaveBeenCalled();
  });

  it('refuses a second hand-off and a finish action while one is in flight, and offers none meanwhile', async () => {
    const h = harness('moving');
    const record = await chatRecord(h);
    const session = fakeSession(true, 'moving');
    session.worktree.record = () => record;
    h.instance.session = session as never;
    h.worktrees.bind('p1', h.instance);
    let confirm!: (move: boolean) => void;
    h.host.confirmHandOff.mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    const first = h.worktrees.chatMove('p1', 'worktree');
    await settled(() => h.host.confirmHandOff.mock.calls.length === 1);
    expect(session.worktree.binding!.moving()).toBe(true);
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.host.confirmHandOff).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith('This chat is already moving. Try again when the move ends.');
    expect(h.worktrees.beginFinish(record.id, 'delete')).toBeUndefined();
    confirm(true);
    await first;
    expect(h.resumeInto).toHaveBeenCalledTimes(1);
    expect(session.worktree.binding!.moving()).toBe(false);
    h.worktrees.beginFinish(record.id, 'delete')!.dispose();
  });

  it('lets go of the conversation once it runs in the new worktree, before the worktree\'s setup', async () => {
    let finish!: (value: { exitCode: number }) => void;
    const h = harness('claim-before-setup', { setupResult: () => new Promise((resolve) => { finish = resolve; }) });
    write(path.join(h.project, '.damocles', 'worktree.json'), JSON.stringify({ setup: ['npm ci'] }));
    h.instance.session = fakeSession(true, 'claim-before-setup') as never;
    const moving = h.worktrees.chatMove('p1', 'worktree');
    await settled(() => h.host.runSetup.mock.calls.length === 1);
    expect(isSessionHeldByPanelHere('claim-before-setup')).toBe(false);
    finish({ exitCode: 0 });
    await moving;
  });

  it('tells the user why a confirmed hand-off did not run', async () => {
    const h = harness('refusals');
    const session = fakeSession(true, 'refusals');
    h.instance.session = session as never;
    h.host.confirmHandOff.mockImplementationOnce(async () => {
      session.worktree.busy = () => true;
      return true;
    });
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.warn).toHaveBeenLastCalledWith('The chat can move only while it is idle and has a conversation, so it was not moved.');
    session.worktree.busy = () => false;
    h.trust.trusted = false;
    await h.worktrees.chatMove('p1', 'worktree');
    expect(h.warn).toHaveBeenLastCalledWith('Trust this folder to use worktrees');
    h.trust.trusted = true;
    session.worktree.place = () => 'worktree';
    await h.worktrees.chatMove('p1', 'project');
    expect(h.warn).toHaveBeenLastCalledWith("This chat's worktree was deleted");
    expect(h.registry.records()).toEqual([]);
    expect(h.resumeInto).not.toHaveBeenCalled();
  });

  it('still moves the chat to the project folder when Apply leaves conflicts there, and tells the user as the Apply command does', async () => {
    const h = harness('to-project-conflicts');
    const record = await chatRecord(h);
    write(path.join(record.workingFolder, 'a.txt'), 'worktree\n');
    git(['commit', '--quiet', '-am', 'worktree edit'], record.workingFolder);
    write(path.join(h.project, 'a.txt'), 'project\n');
    git(['commit', '--quiet', '-am', 'project edit'], h.project);
    const session = fakeSession(true, 'to-project-conflicts');
    session.worktree.record = () => record;
    session.worktree.inLiveWorktree = () => record;
    session.worktree.place = () => 'worktree';
    h.instance.session = session as never;
    h.instance.folder = target(record.workingFolder, h.projectTarget.key);
    await h.worktrees.chatMove('p1', 'project');
    expect(h.instance.folder.key).toBe(h.projectTarget.key);
    expect(h.host.showApplyConflicts).toHaveBeenCalledWith(record, ['a.txt']);
  });

  it('moves a chat with a new binary file back to the project folder, copying the file whole', async () => {
    const h = harness('to-project-binary');
    const record = await chatRecord(h);
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256));
    fs.writeFileSync(path.join(record.workingFolder, 'image.bin'), bytes);
    const session = fakeSession(true, 'to-project-binary');
    session.worktree.record = () => record;
    session.worktree.inLiveWorktree = () => record;
    session.worktree.place = () => 'worktree';
    h.instance.session = session as never;
    h.instance.folder = target(record.workingFolder, h.projectTarget.key);
    await h.worktrees.chatMove('p1', 'project');
    expect(h.instance.folder.key).toBe(h.projectTarget.key);
    expect(fs.readFileSync(path.join(h.project, 'image.bin')).equals(bytes)).toBe(true);
    expect(git(['status', '--porcelain', '--', 'image.bin'], h.project).trim()).toBe('?? image.bin');
  });

  it('writes the project place only in the session that resumed in the project folder', async () => {
    const h = harness('to-project');
    const record = await chatRecord(h);
    const session = fakeSession(true, 'to-project');
    session.worktree.record = () => record;
    session.worktree.inLiveWorktree = () => record;
    session.worktree.place = () => 'worktree';
    h.instance.session = session as never;
    h.instance.folder = { ...target(record.workingFolder, h.projectTarget.key) };
    const resumed = fakeSession(true, 'to-project');
    h.resumeInto.mockImplementation(async (instance: HostInstance, _sessionId: string, beforeOpen?: (session: HostInstance['session']) => void) => {
      instance.session = resumed as never;
      beforeOpen?.(instance.session);
      return true;
    });
    await h.worktrees.chatMove('p1', 'project');
    expect(session.worktree.appendPlace).not.toHaveBeenCalled();
    expect(resumed.worktree.appendPlace).toHaveBeenCalledWith('project', record);
    expect(h.instance.folder.key).toBe(h.projectTarget.key);
  });
});
