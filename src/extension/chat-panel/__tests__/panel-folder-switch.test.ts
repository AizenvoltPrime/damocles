import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({ log: logMock }));
vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import * as vscode from 'vscode';
import { __webviewPanels } from 'vscode';
import { createHarness, folderEntry, lastFolderUpdate, makeFakeHost, type FakeHost, type Harness } from './panel-manager-harness';
import { folderKey } from '../../workspace-folders/folder-key';
import type { FakeSession } from './panel-manager-harness';
import { restoredWorkspaceFolderKey } from '../panel-manager';
import { SidebarViewProvider } from '../sidebar-view-provider';

const ROOT = path.resolve(os.tmpdir(), 'pfs-root');
const A = path.join(ROOT, 'alpha');
const B = path.join(ROOT, 'beta');
const CONFIRM = 'Start new conversation';

let h: Harness;
let warning: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logMock.mockClear();
  __webviewPanels.length = 0;
  warning = vi.spyOn(vscode.window, 'showWarningMessage');
});

afterEach(() => {
  warning.mockRestore();
  h.dispose();
});

async function openPanel(host: FakeHost = makeFakeHost(), initialFolderKey?: string): Promise<{ host: FakeHost; panelId: string }> {
  const panelId = await h.manager.initializeHost(host, initialFolderKey !== undefined ? { initialFolderKey } : undefined);
  return { host, panelId };
}

const sessionOf = (panelId: string) => h.instance(panelId).session as unknown as FakeSession;

describe('initial folder of a panel', () => {
  it('opens a new panel in the default folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    await h.registry.setDefault(folderKey(B));

    const { panelId } = await openPanel();

    expect(h.instance(panelId).folder.fsPath).toBe(B);
    expect(sessionOf(panelId).cwd).toBe(B);
  });

  it('opens a restored panel in its persisted folder, through the serializer', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const panel = vscode.window.createWebviewPanel('damocles.chat', 'Damocles', 1);

    await h.manager.restorePanel(panel as unknown as vscode.WebviewPanel, folderKey(B));

    const [instance] = [...h.manager.getPanels().values()];
    expect(instance?.folder.fsPath).toBe(B);
    expect((instance?.session as unknown as FakeSession).cwd).toBe(B);
    expect(panel.title).toBe('Damocles · beta');
  });

  it('reads the folder key the webview persisted, and nothing else, from the serializer state', () => {
    h = createHarness([folderEntry(A)]);
    expect(restoredWorkspaceFolderKey({ workspaceFolderKey: folderKey(B), sessionId: 's' })).toBe(folderKey(B));
    expect(restoredWorkspaceFolderKey({ workspaceFolderKey: 42 })).toBeUndefined();
    expect(restoredWorkspaceFolderKey(null)).toBeUndefined();
    expect(restoredWorkspaceFolderKey(undefined)).toBeUndefined();
  });

  it('opens the sidebar view in the folder its webview state saved, so no session starts in the default', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const panel = vscode.window.createWebviewPanel('damocles.sidebarView', 'Damocles', 1);
    const view = {
      webview: panel.webview,
      visible: true,
      description: '',
      onDidDispose: panel.onDidDispose,
      onDidChangeVisibility: () => ({ dispose: () => undefined }),
      show: () => undefined,
    };

    await new SidebarViewProvider(h.manager).resolveWebviewView(
      view as unknown as vscode.WebviewView,
      { state: { sessionId: 's', workspaceFolderKey: folderKey(B) } },
      {} as vscode.CancellationToken,
    );

    expect(h.sessions.map((s) => s.cwd)).toEqual([B]);
    expect(h.initialMessageFolders).toEqual([folderKey(B)]);
  });

  it('ignores a persisted key that is not open and uses the default', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel(makeFakeHost(), folderKey(path.join(ROOT, 'gone')));
    expect(h.instance(panelId).folder.fsPath).toBe(A);
  });

  it("opens a fork in its source panel's folder, whatever the default", async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId: source } = await openPanel(makeFakeHost(), folderKey(B));

    const forked = await h.manager.showForked({ sourcePanelId: source, sourceSdkSessionId: 's1', forkAtUuid: 'u1' } as never);

    expect(forked?.folder.fsPath).toBe(B);
    expect((forked?.session as unknown as FakeSession).cwd).toBe(B);
  });

  it('points the permission handler at the panel folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel(makeFakeHost(), folderKey(B));
    expect((h.instance(panelId).permissionHandler as unknown as { state: { workspacePath: string | null } }).state.workspacePath).toBe(B);
  });
});

describe('tab titles', () => {
  it('names the folder only in a multi-root window', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host: hostA } = await openPanel(makeFakeHost(), folderKey(A));
    const { host: hostB } = await openPanel(makeFakeHost(), folderKey(B));
    expect(hostA.title).toBe('Damocles · alpha');
    expect(hostB.title).toBe('Damocles · beta');
  });

  it('keeps the plain title in a single-folder window', async () => {
    h = createHarness([folderEntry(A)]);
    const { host } = await openPanel();
    expect(host.title).toBe('Damocles');
    expect(host.folderLabel).toBeUndefined();
  });

  it('retitles on a switch', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');
    expect(host.title).toBe('Damocles · beta');
  });

  it('follows a rename of the panel folder, which keeps its key', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel(makeFakeHost(), folderKey(B));
    const before = h.activePanelChanges.count;

    h.setFolders([folderEntry(A), folderEntry(B, 'Backend')]);

    await vi.waitFor(() => expect(host.title).toBe('Damocles · Backend'));
    expect(h.instance(panelId).folder.label).toBe('Backend');
    expect(h.manager.getActivePanelFolder()?.label).toBe('Backend');
    expect(h.activePanelChanges.count).toBe(before + 1);
  });

  it('disambiguates the panel label when a same-named folder is added', async () => {
    const client = path.join(ROOT, 'client', 'app');
    h = createHarness([folderEntry(client), folderEntry(A)]);
    const { host } = await openPanel(makeFakeHost(), folderKey(client));

    h.setFolders([folderEntry(client), folderEntry(A), folderEntry(path.join(ROOT, 'server', 'app'))]);

    await vi.waitFor(() => expect(host.title).toBe('Damocles · app (client)'));
  });

  it('turns every title back to Damocles when a second folder is added and then removed', async () => {
    h = createHarness([folderEntry(A)]);
    const { host } = await openPanel();
    h.setFolders([folderEntry(A), folderEntry(B)]);
    await vi.waitFor(() => expect(host.title).toBe('Damocles · alpha'));
    h.setFolders([folderEntry(A)]);
    await vi.waitFor(() => expect(host.title).toBe('Damocles'));
  });
});

describe('switching folder', () => {
  it('switches freely before the first message: no modal, a fresh session in the new folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);

    const result = await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect(warning).not.toHaveBeenCalled();
    expect(result).toBe(h.instance(panelId));
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(sessionOf(panelId)).not.toBe(old);
    expect(sessionOf(panelId).cwd).toBe(B);
    expect(sessionOf(panelId).initializeEarly).toHaveBeenCalledTimes(1);
    expect(lastFolderUpdate(host)).toMatchObject({ panelFolderKey: folderKey(B), switched: true });
    expect(h.folderStatePushes).toContain(h.instance(panelId));
  });

  it('disposes the old session before the new one exists', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    const old = sessionOf(panelId);
    const createdBeforeDispose: number[] = [];
    old.dispose.mockImplementation(async () => { createdBeforeDispose.push(h.sessions.length); });

    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect(createdBeforeDispose).toEqual([1]);
    expect(h.sessions).toHaveLength(2);
  });

  it('asks first once the conversation started, and cancel keeps it and re-posts the current folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);
    old.conversation = true;
    warning.mockResolvedValueOnce(undefined);
    host.posted.length = 0;

    const result = await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[1]).toEqual({ modal: true });
    expect(warning.mock.calls[0]?.[2]).toBe(CONFIRM);
    expect(result).toBeUndefined();
    expect(old.dispose).not.toHaveBeenCalled();
    expect(sessionOf(panelId)).toBe(old);
    const update = lastFolderUpdate(host);
    expect(update?.panelFolderKey).toBe(folderKey(A));
    expect(update).not.toHaveProperty('switched');
  });

  it('confirm replaces the conversation with a fresh one in the new folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    sessionOf(panelId).conversation = true;
    warning.mockResolvedValueOnce(CONFIRM as never);

    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect(sessionOf(panelId).cwd).toBe(B);
    expect(lastFolderUpdate(host)).toMatchObject({ panelFolderKey: folderKey(B), switched: true });
  });

  it('never asks for a resume, a restore or a folder removal', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    sessionOf(panelId).conversation = true;
    await h.manager.switchPanelFolder(panelId, folderKey(B), 'resume');
    sessionOf(panelId).conversation = true;
    await h.manager.switchPanelFolder(panelId, folderKey(A), 'restore');
    expect(warning).not.toHaveBeenCalled();
    expect(sessionOf(panelId).cwd).toBe(A);
  });

  it('does not start a session the caller claimed for a stored conversation, whatever the reason', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    await h.manager.switchPanelFolder(panelId, folderKey(B), 'resume', async () => true);
    expect(sessionOf(panelId).initializeEarly).not.toHaveBeenCalled();
    await h.manager.switchPanelFolder(panelId, folderKey(A), 'restore', async () => true);
    expect(sessionOf(panelId).initializeEarly).not.toHaveBeenCalled();
  });

  it('starts the session when the caller claimed nothing, as a restore in the same folder does', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    await h.manager.switchPanelFolder(panelId, folderKey(B), 'restore', async () => false);
    expect(sessionOf(panelId).initializeEarly).toHaveBeenCalledTimes(1);
  });

  it('marks a restore as state only, since the reloaded webview has no conversation to clear', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    await h.manager.switchPanelFolder(panelId, folderKey(B), 'restore');
    expect(lastFolderUpdate(host)?.panelFolderKey).toBe(folderKey(B));
    expect(lastFolderUpdate(host)).not.toHaveProperty('switched');
    expect(sessionOf(panelId).initializeEarly).toHaveBeenCalledTimes(1);
  });

  it('re-posts without switching when the panel is already on that folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);
    await h.manager.switchPanelFolder(panelId, folderKey(A), 'user');
    expect(sessionOf(panelId)).toBe(old);
    expect(lastFolderUpdate(host)).not.toHaveProperty('switched');
  });

  it('ignores and logs a key that is not an open folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);
    const forged = path.join(ROOT, 'elsewhere');

    const result = await h.manager.switchPanelFolder(panelId, forged, 'user');

    expect(result).toBeUndefined();
    expect(sessionOf(panelId)).toBe(old);
    expect(old.dispose).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('not open'), panelId, forged);
    expect(lastFolderUpdate(host)?.panelFolderKey).toBe(folderKey(A));
  });

  it('queues webview messages during a switch and delivers them to the new session', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });

    const switching = h.manager.switchPanelFolder(panelId, folderKey(B), 'user');
    await vi.waitFor(() => expect(sessionOf(panelId).dispose).toHaveBeenCalled());
    host.send({ type: 'sendMessage', content: 'first' });
    host.send({ type: 'sendMessage', content: 'second' });
    expect(h.routed.filter((r) => r.message.type === 'sendMessage')).toHaveLength(0);

    h.holdCreation.gate = null;
    release();
    await switching;

    const delivered = h.routed.filter((r) => r.message.type === 'sendMessage');
    expect(delivered.map((r) => (r.message as { content: string }).content)).toEqual(['first', 'second']);
    expect(delivered.every((r) => (r.session as unknown as FakeSession).cwd === B)).toBe(true);
  });

  it('serializes switches on one panel, so the last one requested wins', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();

    await Promise.all([
      h.manager.switchPanelFolder(panelId, folderKey(B), 'user'),
      h.manager.switchPanelFolder(panelId, folderKey(A), 'user'),
    ]);

    expect(h.sessions.map((s) => s.cwd)).toEqual([A, B, A]);
    expect(h.sessions.slice(0, 2).every((s) => s.dispose.mock.calls.length === 1)).toBe(true);
    expect(sessionOf(panelId)).toBe(h.sessions[2]);
  });

  it('disposes the new session when the panel closed while it was being created', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });

    const switching = h.manager.switchPanelFolder(panelId, folderKey(B), 'user');
    await vi.waitFor(() => expect(h.sessions[0]!.dispose).toHaveBeenCalled());
    host.closeFromUser();
    h.holdCreation.gate = null;
    release();

    expect(await switching).toBeUndefined();
    expect(h.sessions[1]?.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('permission resets on a confirmed switch', () => {
  it('resets skip-permissions and subagent approvals like clear, and keeps the permission mode', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    const handler = h.instance(panelId).permissionHandler;
    handler.setPermissionMode('acceptEdits');
    handler.setDangerouslySkipPermissions(true);
    handler.autoApproveSubagent('tool-1');
    sessionOf(panelId).conversation = true;
    warning.mockResolvedValueOnce(CONFIRM as never);

    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect(handler.getDangerouslySkipPermissions()).toBe(false);
    expect((handler as unknown as { state: { autoApprovedSubagents: Set<string> } }).state.autoApprovedSubagents.size).toBe(0);
    expect(handler.getPermissionMode()).toBe('acceptEdits');
    expect((handler as unknown as { state: { workspacePath: string | null } }).state.workspacePath).toBe(B);
  });

  it('drops session skill approvals, so a same-named skill in the new folder asks again', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    const handler = h.instance(panelId).permissionHandler;
    handler.preApproveSkill('deploy');

    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect((handler as unknown as { state: { autoApprovedSkills: Set<string> } }).state.autoApprovedSkills.size).toBe(0);
  });

  it('re-binds plan mode to the new session', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    const old = sessionOf(panelId);
    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    await h.instance(panelId).permissionHandler.activatePlanMode();

    expect(sessionOf(panelId).setPermissionMode).toHaveBeenCalledWith('plan');
    expect(old.setPermissionMode).not.toHaveBeenCalled();
  });
});

describe('a workspace folder is removed', () => {
  it('moves its panels to the default with a warning naming both folders, then releases it', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host: hostA, panelId: onA } = await openPanel(makeFakeHost(), folderKey(A));
    const { host: hostB, panelId: onB } = await openPanel(makeFakeHost(), folderKey(B));
    const oldB = sessionOf(onB);
    const oldA = sessionOf(onA);
    oldB.conversation = true;
    const releasedAtDispose: number[] = [];
    oldB.dispose.mockImplementation(async () => { releasedAtDispose.push(h.released.length); });

    h.setFolders([folderEntry(A)]);

    await vi.waitFor(() => expect(h.released).toEqual([folderKey(B)]));
    // The folder runtime goes only after the sessions running on it are gone.
    expect(releasedAtDispose).toEqual([0]);
    expect(h.instance(onB).folder.fsPath).toBe(A);
    expect(sessionOf(onB).cwd).toBe(A);
    expect(sessionOf(onA)).toBe(oldA);
    expect(warning).toHaveBeenCalledTimes(1);
    const text = String(warning.mock.calls[0]?.[0]);
    expect(text).toContain('beta');
    expect(text).toContain('alpha');
    expect(warning.mock.calls[0]?.[1]).toBeUndefined();
    expect(lastFolderUpdate(hostB)).toMatchObject({ panelFolderKey: folderKey(A) });
    expect(lastFolderUpdate(hostA)?.folders.map((f) => f.path)).toEqual([A]);
    expect(hostA.title).toBe('Damocles');
    expect(hostB.title).toBe('Damocles');
  });

  it('waits for a switch in flight and moves the panel if it landed on the removed folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });

    const switching = h.manager.switchPanelFolder(panelId, folderKey(B), 'user');
    await vi.waitFor(() => expect(h.sessions[0]!.dispose).toHaveBeenCalled());
    h.setFolders([folderEntry(A)]);
    h.holdCreation.gate = null;
    release();
    await switching;

    await vi.waitFor(() => expect(h.released).toEqual([folderKey(B)]));
    expect(h.instance(panelId).folder.fsPath).toBe(A);
    expect(sessionOf(panelId).cwd).toBe(A);
  });

  it('recovers on the default, never on the removed folder, when the move fails once', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel(makeFakeHost(), folderKey(B));
    h.failCreation.errors.push(new Error('unreadable'));

    h.setFolders([folderEntry(A)]);

    await vi.waitFor(() => expect(h.released).toEqual([folderKey(B)]));
    expect(h.sessions.map((s) => s.cwd)).toEqual([B, A]);
    expect(h.instance(panelId).folder.fsPath).toBe(A);
    expect(sessionOf(panelId).cwd).toBe(A);
    expect(lastFolderUpdate(host)).toMatchObject({ panelFolderKey: folderKey(A) });
  });

  it('releases every removed folder and refreshes every panel when one release fails', async () => {
    const C = path.join(ROOT, 'gamma');
    h = createHarness([folderEntry(A), folderEntry(B), folderEntry(C)]);
    const { host: onB } = await openPanel(makeFakeHost(), folderKey(B));
    const { host: onC } = await openPanel(makeFakeHost(), folderKey(C));
    h.releaseErrors.set(folderKey(B), new Error('compass dispose failed'));

    h.setFolders([folderEntry(A)]);

    await vi.waitFor(() => expect(lastFolderUpdate(onC)?.folders.map((f) => f.path)).toEqual([A]));
    expect([...h.released].sort()).toEqual([folderKey(B), folderKey(C)].sort());
    expect(lastFolderUpdate(onB)?.folders.map((f) => f.path)).toEqual([A]);
    expect(onB.title).toBe('Damocles');
    expect(onC.title).toBe('Damocles');
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('releasing a removed folder failed'), expect.any(Error));
  });

  it('refreshes every panel when a folder is only added', async () => {
    h = createHarness([folderEntry(A)]);
    const { host } = await openPanel();
    h.setFolders([folderEntry(A), folderEntry(B)]);
    await vi.waitFor(() => expect(lastFolderUpdate(host)?.folders).toHaveLength(2));
    expect(h.released).toEqual([]);
  });

  it('broadcasts a new default to every panel', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host: first } = await openPanel();
    const { host: second } = await openPanel();
    await h.registry.setDefault(folderKey(B));
    await vi.waitFor(() => expect(lastFolderUpdate(first)?.defaultFolderKey).toBe(folderKey(B)));
    expect(lastFolderUpdate(second)?.defaultFolderKey).toBe(folderKey(B));
    expect(lastFolderUpdate(first)?.panelFolderKey).toBe(folderKey(A));
  });
});

describe('switch races and failures', () => {
  it('gives up when the panel closes while folder state is re-pushed, without starting or claiming', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    let release!: () => void;
    h.holdFolderState.gate = new Promise((resolve) => { release = resolve; });
    const afterSwitch = vi.fn(async () => false);

    const switching = h.manager.switchPanelFolder(panelId, folderKey(B), 'user', afterSwitch);
    await vi.waitFor(() => expect(h.folderStatePushes).toHaveLength(1));
    const replacement = h.sessions[1]!;
    host.closeFromUser();
    h.holdFolderState.gate = null;
    release();

    expect(await switching).toBeUndefined();
    expect(afterSwitch).not.toHaveBeenCalled();
    expect(replacement.initializeEarly).not.toHaveBeenCalled();
    expect(replacement.dispose).toHaveBeenCalled();
  });

  it('runs the caller\'s claim before a message queued during a resume switch reaches the new session', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });
    const claimed: FakeSession[] = [];
    const deliveredBeforeClaim: number[] = [];

    const switching = h.manager.switchPanelFolder(panelId, folderKey(B), 'resume', async (instance) => {
      deliveredBeforeClaim.push(h.routed.filter((r) => r.message.type === 'sendMessage').length);
      claimed.push(instance.session as unknown as FakeSession);
      return true;
    });
    await vi.waitFor(() => expect(h.sessions[0]!.dispose).toHaveBeenCalled());
    host.send({ type: 'sendMessage', content: 'during the resume' });
    h.holdCreation.gate = null;
    release();
    await switching;

    expect(deliveredBeforeClaim).toEqual([0]);
    const delivered = h.routed.filter((r) => r.message.type === 'sendMessage');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.session).toBe(claimed[0]);
    expect(claimed[0]!.cwd).toBe(B);
  });

  it('runs the caller\'s claim on the current instance when no switch is needed', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    const afterSwitch = vi.fn(async () => true);
    await h.manager.switchPanelFolder(panelId, folderKey(A), 'resume', afterSwitch);
    expect(afterSwitch).toHaveBeenCalledWith(h.instance(panelId));
  });

  it('releases a removed folder again when a panel still being created there is moved off it', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });

    const opening = h.manager.initializeHost(makeFakeHost(), { initialFolderKey: folderKey(B) });
    // No panel is registered yet, so the removal releases B at once.
    h.setFolders([folderEntry(A)]);
    await vi.waitFor(() => expect(h.released).toEqual([folderKey(B)]));
    h.holdCreation.gate = null;
    release();
    const panelId = await opening;

    await vi.waitFor(() => expect(h.released).toEqual([folderKey(B), folderKey(B)]));
    expect(h.instance(panelId).folder.fsPath).toBe(A);
    expect(sessionOf(panelId).cwd).toBe(A);
  });

  it('reports a failed session in the new folder once, then resumes the conversation on screen in the old folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);
    old.conversation = true;
    old.storedId = 'sess-a';
    // A disposed session no longer reports the conversation it was on.
    old.dispose.mockImplementation(async () => { old.storedId = null; });
    warning.mockResolvedValueOnce(CONFIRM as never);
    h.failCreation.errors.push(new Error('mcp config unreadable'));
    host.posted.length = 0;

    expect(await h.manager.switchPanelFolder(panelId, folderKey(B), 'user')).toBeUndefined();

    const errors = host.posted.filter((m) => m.type === 'error') as Array<{ message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('beta');
    expect(errors[0]!.message).toContain('mcp config unreadable');
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Could not create a session'), panelId, B, 'mcp config unreadable');

    const recovered = sessionOf(panelId);
    expect(recovered).not.toBe(old);
    expect(recovered.cwd).toBe(A);
    expect(recovered.setResumeSession).toHaveBeenCalledWith('sess-a');
    expect(recovered.initializeEarly).not.toHaveBeenCalled();
    // The transcript on screen is the resumed conversation, so the webview keeps it and only ends the aborted turn.
    const update = lastFolderUpdate(host);
    expect(update?.panelFolderKey).toBe(folderKey(A));
    expect(update).not.toHaveProperty('switched');
    expect(host.posted).toContainEqual({ type: 'sessionCancelled' });
    expect(host.posted).toContainEqual({ type: 'processing', isProcessing: false });
    await h.instance(panelId).permissionHandler.activatePlanMode();
    expect(recovered.setPermissionMode).toHaveBeenCalledWith('plan');
  });

  it('recovers an empty conversation with a fresh session in the old folder and resets the webview', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);
    h.failCreation.errors.push(new Error('mcp config unreadable'));
    host.posted.length = 0;

    expect(await h.manager.switchPanelFolder(panelId, folderKey(B), 'user')).toBeUndefined();

    expect(host.posted.filter((m) => m.type === 'error')).toHaveLength(1);
    expect(lastFolderUpdate(host)).toMatchObject({ panelFolderKey: folderKey(A), switched: true });

    const recovered = sessionOf(panelId);
    expect(recovered).not.toBe(old);
    expect(recovered.cwd).toBe(A);
    expect(recovered.dispose).not.toHaveBeenCalled();
    expect(h.instance(panelId).folder.fsPath).toBe(A);
    expect((h.instance(panelId).permissionHandler as unknown as { state: { workspacePath: string | null } }).state.workspacePath).toBe(A);
    await h.instance(panelId).permissionHandler.activatePlanMode();
    expect(recovered.setPermissionMode).toHaveBeenCalledWith('plan');

    host.send({ type: 'sendMessage', content: 'after the failure' });
    const delivered = h.routed.filter((r) => r.message.type === 'sendMessage');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.session).toBe(recovered);
  });

  it('starts fresh and resets the webview when another panel took the conversation during a failed resume', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const { panelId: otherId } = await openPanel();
    const old = sessionOf(panelId);
    old.storedId = 'sess-a';
    old.conversation = true;
    old.dispose.mockImplementation(async () => { old.storedId = null; });
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });
    h.failCreation.errors.push(new Error('unreadable'));

    const switching = h.manager.switchPanelFolder(panelId, folderKey(B), 'resume');
    await vi.waitFor(() => expect(old.dispose).toHaveBeenCalled());
    sessionOf(otherId).storedId = 'sess-a';
    h.holdCreation.gate = null;
    release();
    await switching;

    const recovered = sessionOf(panelId);
    expect(recovered.cwd).toBe(A);
    expect(recovered.setResumeSession).not.toHaveBeenCalled();
    expect(lastFolderUpdate(host)).toMatchObject({ panelFolderKey: folderKey(A), switched: true });
  });

  it('reports both failures and leaves the panel as it is when recovery also fails', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host, panelId } = await openPanel();
    const old = sessionOf(panelId);
    h.failCreation.errors.push(new Error('first failure'), new Error('second failure'));
    host.posted.length = 0;

    expect(await h.manager.switchPanelFolder(panelId, folderKey(B), 'user')).toBeUndefined();

    const errors = host.posted.filter((m) => m.type === 'error') as Array<{ message: string }>;
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining('first failure'),
      expect.stringContaining('second failure'),
    ]);
    expect(errors[1]!.message).toContain('alpha');
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('Could not create a session'), panelId, A, 'second failure');
    expect(sessionOf(panelId)).toBe(old);
    expect(h.instance(panelId).folder.fsPath).toBe(A);
    expect(lastFolderUpdate(host)?.panelFolderKey).toBe(folderKey(A));
    expect(lastFolderUpdate(host)).not.toHaveProperty('switched');
    // The gate still reopened, so the panel keeps hearing the webview.
    host.send({ type: 'requestToolStatus' });
    expect(h.routed.some((r) => r.message.type === 'requestToolStatus')).toBe(true);
  });
});

describe('Compass views target the focused panel folder', () => {
  it('asks for the initial messages of the folder the panel opens in', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    await h.registry.setDefault(folderKey(B));

    await openPanel();

    expect(h.initialMessageFolders).toEqual([folderKey(B)]);
  });

  it('reports the focused panel\'s folder, and a change when a panel takes focus', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    expect(h.manager.getActivePanelFolder()).toBeUndefined();

    await openPanel(makeFakeHost(), folderKey(B));

    expect(h.manager.getActivePanelFolder()?.key).toBe(folderKey(B));
    expect(h.activePanelChanges.count).toBe(1);
  });

  it('reports a change when the focused panel switches folder', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { panelId } = await openPanel();
    const before = h.activePanelChanges.count;

    await h.manager.switchPanelFolder(panelId, folderKey(B), 'user');

    expect(h.manager.getActivePanelFolder()?.key).toBe(folderKey(B));
    expect(h.activePanelChanges.count).toBe(before + 1);
  });

  it('falls back to no folder once the focused panel closes and no other is open', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const { host } = await openPanel();
    const before = h.activePanelChanges.count;

    host.closeFromUser();

    expect(h.manager.getActivePanelFolder()).toBeUndefined();
    expect(h.activePanelChanges.count).toBe(before + 1);
  });
});
