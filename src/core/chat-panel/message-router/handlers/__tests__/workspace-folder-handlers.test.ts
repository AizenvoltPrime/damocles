import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../logger', () => ({ log: logMock }));
vi.mock('../../../ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import { createWorkspaceFolderHandlers } from '../workspace-folder-handlers';
import { createHarness, folderEntry, lastFolderUpdate, makeFakeHost, type FakeHost, type FakeSession, type Harness } from '../../../__tests__/panel-manager-harness';
import { folderKey } from '../../../../workspace-folders/folder-key';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { WebviewToExtensionMessage } from '../../../../../shared/types/messages';

const ROOT = path.resolve(os.tmpdir(), 'wfh-root');
const A = path.join(ROOT, 'alpha');
const B = path.join(ROOT, 'beta');

let h: Harness;
let host: FakeHost;
let panelId: string;
let handlers: ReturnType<typeof createWorkspaceFolderHandlers>;

function ctx(): HandlerContext {
  const instance = h.instance(panelId);
  return { host: instance.host, session: instance.session, permissionHandler: instance.permissionHandler, ideContextManager: instance.ideContextManager, panelId, folder: instance.folder };
}

beforeEach(async () => {
  logMock.mockClear();
  h = createHarness([folderEntry(A), folderEntry(B)]);
  host = makeFakeHost();
  panelId = await h.manager.initializeHost(host);
  const deps: Pick<HandlerDependencies, 'folderRegistry' | 'switchPanelFolder' | 'postWorkspaceFolderState'> = {
    folderRegistry: h.registry,
    switchPanelFolder: (id, key, reason) => h.manager.switchPanelFolder(id, key, reason),
    postWorkspaceFolderState: (id) => h.manager.postWorkspaceFolderState(id),
  };
  handlers = createWorkspaceFolderHandlers(deps as HandlerDependencies);
});

afterEach(() => {
  h.dispose();
});

const setPanel = (folderKeyValue: string) => ({ type: 'setPanelWorkspaceFolder', folderKey: folderKeyValue }) as WebviewToExtensionMessage;
const setDefault = (folderKeyValue: string) => ({ type: 'setDefaultWorkspaceFolder', folderKey: folderKeyValue }) as WebviewToExtensionMessage;

// The webview is untrusted input, so a key naming a folder that is not open does nothing.
describe('setPanelWorkspaceFolder with a forged key', () => {
  it.each([
    ['an unopened absolute path', path.join(ROOT, 'secret')],
    ['an unopened folder key', folderKey(path.join(ROOT, 'secret'))],
    ['the home directory of a window that has folders', folderKey(os.homedir())],
    ['a traversal from an open folder', path.join(A, '..', 'secret')],
  ])('changes nothing and logs it: %s', async (_label, forged) => {
    const before = h.instance(panelId).session as unknown as FakeSession;
    host.posted.length = 0;

    await handlers.setPanelWorkspaceFolder!(setPanel(forged), ctx());

    expect(h.instance(panelId).folder.fsPath).toBe(A);
    expect(h.instance(panelId).session).toBe(before);
    expect(before.dispose).not.toHaveBeenCalled();
    expect(h.sessions).toHaveLength(1);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('not open'), panelId, forged);
    const update = lastFolderUpdate(host);
    expect(update?.panelFolderKey).toBe(folderKey(A));
    expect(update).not.toHaveProperty('switched');
  });

  it('switches for the key of an open folder', async () => {
    await handlers.setPanelWorkspaceFolder!(setPanel(folderKey(B)), ctx());
    expect(h.instance(panelId).folder.fsPath).toBe(B);
    expect(lastFolderUpdate(host)).toMatchObject({ panelFolderKey: folderKey(B), switched: true });
  });
});

describe('setPanelWorkspaceFolder when the switch throws', () => {
  it('still answers with the current folder state, then rethrows for the router to report', async () => {
    const failing = createWorkspaceFolderHandlers({
      folderRegistry: h.registry,
      switchPanelFolder: () => Promise.reject(new Error('dispose failed')),
      postWorkspaceFolderState: (id: string) => h.manager.postWorkspaceFolderState(id),
    } as unknown as HandlerDependencies);
    host.posted.length = 0;

    await expect(failing.setPanelWorkspaceFolder!(setPanel(folderKey(B)), ctx())).rejects.toThrow('dispose failed');

    const update = lastFolderUpdate(host);
    expect(update?.panelFolderKey).toBe(folderKey(A));
    expect(update).not.toHaveProperty('switched');
  });
});

describe('setDefaultWorkspaceFolder', () => {
  it('stores an open folder as the default and tells every panel', async () => {
    const other = makeFakeHost();
    await h.manager.initializeHost(other);

    await handlers.setDefaultWorkspaceFolder!(setDefault(folderKey(B)), ctx());

    expect(h.registry.defaultTarget().fsPath).toBe(B);
    await vi.waitFor(() => expect(lastFolderUpdate(other)?.defaultFolderKey).toBe(folderKey(B)));
    expect(lastFolderUpdate(host)?.defaultFolderKey).toBe(folderKey(B));
    // The default is for new panels; this one stays where it is.
    expect(h.instance(panelId).folder.fsPath).toBe(A);
  });

  it('ignores and logs a forged key, stores nothing, and re-posts the current state', async () => {
    const forged = path.join(ROOT, 'secret');
    host.posted.length = 0;

    await handlers.setDefaultWorkspaceFolder!(setDefault(forged), ctx());

    expect(h.registry.defaultTarget().fsPath).toBe(A);
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('not open'), forged);
    expect(lastFolderUpdate(host)?.defaultFolderKey).toBe(folderKey(A));
  });
});
