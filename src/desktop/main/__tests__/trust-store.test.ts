import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', async () => ({
  ...(await import('./fake-overlay-electron')).fakeOverlayElectron(),
  dialog: { showMessageBox: (...args: unknown[]) => H.showMessageBox(...args) },
}));

import { OVERLAY_CHANNELS, type OverlayRequest } from '../../preload/overlay-channels';
import { createMessageAsker, type MessageOverlay } from '../message-dialog';
import { OverlayHost } from '../overlay';
import { OVERLAY_PAGE_URL } from '../protocol';
import { TRUST_FILE, TrustStore } from '../trust-store';
import { localRecord, WorktreeRecords } from '../worktrees/records';
import { liveWorkingFolders, worktreeFolderFor } from '../../../core/worktrees/records';
import type { ChatWorktreeRecord } from '../../../core/worktrees/registry';
import type { TrustChange } from '../../../platform/trust-service';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';
import { fakeOverlayWindow, type FakeOverlayView } from './fake-overlay-electron';

// Button indexes of the OS fallback box: Trust Folder, then Don't Trust (Cancel).
const TRUST_BUTTON = 0;
const DONT_TRUST_BUTTON = 1;

let userData: string;
let project: string;
let overlay: MessageOverlay | undefined;
const showMessageBox = H.showMessageBox;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-trust-'));
  project = path.join(userData, 'workspace', 'project');
  fs.mkdirSync(path.join(project, 'packages', 'child'), { recursive: true });
  showMessageBox.mockReset();
  overlay = undefined;
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const ask = createMessageAsker({ overlay: () => overlay, window: () => undefined, focused: () => undefined, closing: () => false, log: () => undefined });
const store = (): TrustStore => new TrustStore(userData, ask, (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message), () => undefined);

function loadedOverlay(): { host: OverlayHost; view: FakeOverlayView } {
  const host = new OverlayHost({
    window: fakeOverlayWindow() as never,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32' }),
    focusOutside: () => undefined,
    awaitActivation: () => undefined,
    modeChanged: () => undefined,
    popupsClosed: () => undefined,
    canRasterize: () => undefined,
    log: () => undefined,
  });
  host.load();
  const view = host.view as unknown as FakeOverlayView;
  view.webContents.emit('did-finish-load');
  return { host, view };
}

describe('the trust question', () => {
  it('asks in the overlay dialog with Don\'t Trust as Cancel and focused first, and grants on Trust Folder', async () => {
    const { host, view } = loadedOverlay();
    overlay = host;
    const trust = store();
    const answer = trust.requestTrust(project);
    const [, sent] = view.webContents.send.mock.calls.find(([channel]) => channel === OVERLAY_CHANNELS.request) as [string, { requestId: string; request: OverlayRequest }];
    expect(sent.request).toEqual({
      kind: 'message',
      severity: 'warning',
      message: `Do you trust the authors of the files in ${project}?`,
      detail: expect.stringContaining('Trusting this folder does not trust its subfolders.'),
      actions: ['Trust Folder'],
      cancelLabel: 'Don\'t Trust',
    });
    // Only the overlay page answers it, and only for the id main issued.
    const own = { sender: view.webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } };
    view.webContents.ipc.emit(OVERLAY_CHANNELS.answer, { sender: { id: 99 }, senderFrame: own.senderFrame }, sent.requestId, { kind: 'message', action: 0 });
    view.webContents.ipc.emit(OVERLAY_CHANNELS.answer, own, 'forged', { kind: 'message', action: 0 });
    expect(trust.isTrusted(project)).toBe(false);
    view.webContents.ipc.emit(OVERLAY_CHANNELS.answer, own, sent.requestId, { kind: 'message', action: 0 });
    await expect(answer).resolves.toBe(true);
    expect(trust.isTrusted(project)).toBe(true);
    expect(showMessageBox).not.toHaveBeenCalled();
    host.dispose();
  });

  it('leaves the folder untrusted when the overlay dialog is cancelled', async () => {
    const { host, view } = loadedOverlay();
    overlay = host;
    const trust = store();
    const answer = trust.requestTrust(project);
    const [, sent] = view.webContents.send.mock.calls.find(([channel]) => channel === OVERLAY_CHANNELS.request) as [string, { requestId: string }];
    view.webContents.ipc.emit(OVERLAY_CHANNELS.answer, { sender: view.webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, sent.requestId, { kind: 'message', action: null });
    await expect(answer).resolves.toBe(false);
    expect(fs.existsSync(path.join(userData, TRUST_FILE))).toBe(false);
    host.dispose();
  });

  it('falls back to the OS message box with Don\'t Trust as the default and cancel button', async () => {
    showMessageBox.mockResolvedValue({ response: TRUST_BUTTON, checkboxChecked: false });
    expect(await store().requestTrust(project)).toBe(true);
    expect(showMessageBox.mock.calls[0]![0]).toMatchObject({ buttons: ['Trust Folder', 'Don\'t Trust'], defaultId: DONT_TRUST_BUTTON, cancelId: DONT_TRUST_BUTTON });
  });
});

describe('TrustStore', () => {
  it('trusts a folder only by exact match: not its parent, not its children', async () => {
    const trust = store();
    await trust.grant(project);
    expect(trust.isTrusted(project)).toBe(true);
    expect(trust.isTrusted(`${project}${path.sep}`)).toBe(true);
    expect(trust.isTrusted(path.join(project, 'packages', 'child'))).toBe(false);
    expect(trust.isTrusted(path.dirname(project))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('matches case-insensitively on Windows, as folderKey does', async () => {
    const trust = store();
    await trust.grant(project);
    expect(trust.isTrusted(project.toUpperCase())).toBe(true);
  });

  it('persists grants across instances under userData with a schema version', async () => {
    await store().grant(project);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, TRUST_FILE), 'utf8'));
    expect(saved).toEqual({ version: 1, folders: [project] });
    expect(store().isTrusted(project)).toBe(true);
  });

  it('trusts nothing from an unreadable or foreign allowlist', () => {
    fs.writeFileSync(path.join(userData, TRUST_FILE), '{ nope');
    expect(store().isTrusted(project)).toBe(false);
    fs.writeFileSync(path.join(userData, TRUST_FILE), JSON.stringify({ version: 99, folders: [project] }));
    expect(store().isTrusted(project)).toBe(false);
    fs.writeFileSync(path.join(userData, TRUST_FILE), JSON.stringify({ version: 1, folders: ['relative/path', 7] }));
    expect(store().isTrusted('relative/path')).toBe(false);
  });

  it('grants through the dialog, fires onDidChange granting that folder, and asks once for concurrent requests', async () => {
    showMessageBox.mockResolvedValue({ response: TRUST_BUTTON, checkboxChecked: false });
    const trust = store();
    const changes: TrustChange[] = [];
    trust.onDidChange((change) => changes.push(change));
    const [first, second] = await Promise.all([trust.requestTrust(project), trust.requestTrust(project)]);
    expect([first, second]).toEqual([true, true]);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([{ granted: [project], revoked: [] }]);
    expect(await trust.requestTrust(project)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('leaves the folder untrusted when declined and persists nothing', async () => {
    showMessageBox.mockResolvedValue({ response: DONT_TRUST_BUTTON, checkboxChecked: false });
    const trust = store();
    const listener = vi.fn();
    trust.onDidChange(listener);
    expect(await trust.requestTrust(project)).toBe(false);
    expect(trust.isTrusted(project)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, TRUST_FILE))).toBe(false);
  });
  // A folder trusted in memory but not on disk would never fire the grant and would be untrusted after a restart.
  it('leaves the folder untrusted and fires nothing when the allowlist write fails, so a retry grants it', async () => {
    const trust = store();
    const listener = vi.fn();
    trust.onDidChange(listener);
    fs.mkdirSync(path.join(userData, TRUST_FILE));
    await expect(trust.grant(project)).rejects.toThrow();
    expect(trust.isTrusted(project)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    fs.rmdirSync(path.join(userData, TRUST_FILE));
    await trust.grant(project);
    expect(trust.isTrusted(project)).toBe(true);
    expect(listener).toHaveBeenCalledWith({ granted: [project], revoked: [] });
    expect(store().isTrusted(project)).toBe(true);
  });

  it('flush waits for a write in flight and for one queued while it waits', async () => {
    const trust = store();
    const child = path.join(project, 'packages', 'child');
    const onDisk = await flushAcrossHeldRename(path.join(userData, TRUST_FILE), {
      first: () => trust.grant(project),
      flush: () => trust.flush(),
      second: () => trust.grant(child),
      onDisk: () => [store().isTrusted(project), store().isTrusted(child)],
    });
    expect(onDisk).toEqual([true, true]);
  });
});

describe('TrustStore.askTrust', () => {
  // the question stays open until the test answers it: 0 is Trust Folder, undefined Don't Trust
  function asking() {
    const answers: Array<(choice: number | undefined) => void> = [];
    const ask = vi.fn(() => new Promise<number | undefined>((resolve) => { answers.push(resolve); }));
    const trust = new TrustStore(userData, ask, (message) => message, () => undefined);
    return { trust, ask, answer: (choice: number | undefined) => answers.shift()!(choice) };
  }

  it('gives the call whose question granted the folder an undo, which revokes that grant on disk and tells core', async () => {
    const { trust, ask, answer } = asking();
    const changes: TrustChange[] = [];
    trust.onDidChange((change) => changes.push(change));
    const asked = trust.askTrust(project);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(0);
    const granted = await asked;
    expect(granted.trusted).toBe(true);
    expect(store().isTrusted(project)).toBe(true);
    await granted.undo!();
    expect(trust.isTrusted(project)).toBe(false);
    expect(store().isTrusted(project)).toBe(false);
    expect(changes).toEqual([{ granted: [project], revoked: [] }, { granted: [], revoked: [project] }]);
  });

  it('gives no undo to a call that found the folder trusted, and asks nothing', async () => {
    const { trust, ask } = asking();
    await trust.grant(project);
    expect(await trust.askTrust(project)).toEqual({ trusted: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it('gives no undo when the question is declined', async () => {
    const { trust, ask, answer } = asking();
    const asked = trust.askTrust(project);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(undefined);
    expect(await asked).toEqual({ trusted: false });
  });

  it('gives no undo to a call that joined another call\'s pending question, nor to that call, so the joiner keeps its trust', async () => {
    const { trust, ask, answer } = asking();
    const first = trust.askTrust(project);
    const joined = trust.askTrust(project);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(0);
    expect(await joined).toEqual({ trusted: true });
    await (await first).undo?.();
    expect(trust.isTrusted(project)).toBe(true);
    expect(store().isTrusted(project)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('gives no undo when the folder was granted elsewhere while its question was open', async () => {
    const { trust, ask, answer } = asking();
    const asked = trust.askTrust(project);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await trust.grant(project);
    answer(0);
    expect(await asked).toEqual({ trusted: true });
  });

  it('answers requestTrust from the same question', async () => {
    const { trust, ask, answer } = asking();
    const requested = trust.requestTrust(project);
    const asked = trust.askTrust(project);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(0);
    expect(await requested).toBe(true);
    expect(await asked).toEqual({ trusted: true });
  });
});

describe('TrustStore.revoke', () => {
  it('untrusts the folder on disk and in memory, tells its listeners once, and leaves a child\'s own grant', async () => {
    const child = path.join(project, 'packages', 'child');
    const trust = store();
    await trust.grant(project);
    await trust.grant(child);
    const revoked = vi.fn();
    trust.onDidChange(revoked);
    await trust.revoke(`${project}${path.sep}`);
    await trust.revoke(project);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith({ granted: [], revoked: [project] });
    expect(trust.isTrusted(project)).toBe(false);
    expect(store().isTrusted(project)).toBe(false);
    expect(store().isTrusted(child)).toBe(true);
  });
});

describe('TrustStore and the worktree records core publishes', () => {
  function chatRecord(root: string, id: string, projectPath: string): ChatWorktreeRecord {
    const worktreeRoot = worktreeFolderFor(root, projectPath, id);
    return { id, kind: 'chat', index: 1, projectPath, repositoryRoot: projectPath, worktreeRoot, workingFolder: worktreeRoot, branch: `damocles/${id}`, baseCommit: 'a'.repeat(40), createdAt: 1 };
  }

  it('fires a change naming a working folder whose answer a records change moved, and none for a change that moves no answer', async () => {
    const root = path.join(userData, 'worktrees');
    const other = path.join(userData, 'other');
    const trust = store();
    await trust.grant(project);
    const records = new WorktreeRecords(localRecord(root), () => undefined);
    trust.setWorktrees({
      projectOf: (folder) => records.liveChatRecordAt(folder)?.projectPath,
      liveWorkingFolders: () => liveWorkingFolders(records.records()),
      onDidChange: (listener) => records.onDidChange(listener),
    });
    const changes: TrustChange[] = [];
    trust.onDidChange((change) => changes.push(change));
    const live = chatRecord(root, 'aaaaaaaa', project);

    records.apply([live]);
    expect(trust.isTrusted(live.workingFolder)).toBe(true);
    expect(changes).toEqual([{ granted: [live.workingFolder], revoked: [] }]);

    // the records change, no answer does: a record marked used, a record of an untrusted project
    changes.length = 0;
    const untrusted = chatRecord(root, 'bbbbbbbb', other);
    records.apply([{ ...live, usedAt: 5 }, untrusted]);
    expect(records.records()).toHaveLength(2);
    expect(changes).toEqual([]);

    records.apply([{ ...live, usedAt: 5, deletedAt: 9 }, untrusted]);
    expect(trust.isTrusted(live.workingFolder)).toBe(false);
    expect(changes).toEqual([{ granted: [], revoked: [live.workingFolder] }]);

    // a grant names the working folders whose answer it moved
    changes.length = 0;
    await trust.grant(other);
    expect(changes).toEqual([{ granted: [other, untrusted.workingFolder], revoked: [] }]);
  });
});
