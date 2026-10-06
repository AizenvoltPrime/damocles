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

const ask = createMessageAsker({ overlay: () => overlay, window: () => undefined, focused: () => undefined, log: () => undefined });
const store = (): TrustStore => new TrustStore(userData, ask, (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message), () => undefined);

function loadedOverlay(): { host: OverlayHost; view: FakeOverlayView } {
  const host = new OverlayHost({
    window: fakeOverlayWindow() as never,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32' }),
    focusOutside: () => undefined,
    awaitActivation: () => undefined,
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

  it('grants through the dialog, fires onDidGrant with that folder, and asks once for concurrent requests', async () => {
    showMessageBox.mockResolvedValue({ response: TRUST_BUTTON, checkboxChecked: false });
    const trust = store();
    const granted: Array<readonly string[]> = [];
    trust.onDidGrant((folders) => granted.push(folders));
    const [first, second] = await Promise.all([trust.requestTrust(project), trust.requestTrust(project)]);
    expect([first, second]).toEqual([true, true]);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(granted).toEqual([[project]]);
    expect(await trust.requestTrust(project)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('leaves the folder untrusted when declined and persists nothing', async () => {
    showMessageBox.mockResolvedValue({ response: DONT_TRUST_BUTTON, checkboxChecked: false });
    const trust = store();
    const listener = vi.fn();
    trust.onDidGrant(listener);
    expect(await trust.requestTrust(project)).toBe(false);
    expect(trust.isTrusted(project)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userData, TRUST_FILE))).toBe(false);
  });
  // A folder trusted in memory but not on disk would never fire the grant and would be untrusted after a restart.
  it('leaves the folder untrusted and fires nothing when the allowlist write fails, so a retry grants it', async () => {
    const trust = store();
    const listener = vi.fn();
    trust.onDidGrant(listener);
    fs.mkdirSync(path.join(userData, TRUST_FILE));
    await expect(trust.grant(project)).rejects.toThrow();
    expect(trust.isTrusted(project)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    fs.rmdirSync(path.join(userData, TRUST_FILE));
    await trust.grant(project);
    expect(trust.isTrusted(project)).toBe(true);
    expect(listener).toHaveBeenCalledWith([project]);
    expect(store().isTrusted(project)).toBe(true);
  });
});
