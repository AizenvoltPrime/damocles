import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));
vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import { createHarness, folderEntry, makeFakeHost, type FakeSession, type Harness } from './panel-manager-harness';

const A = path.join(path.resolve(os.tmpdir(), 'pml-root'), 'alpha');
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let h: Harness;
afterEach(() => h.dispose());

describe('PanelManager panel lifecycle', () => {
  it('tears down a panel whose host closed while its session was being created', async () => {
    h = createHarness([folderEntry(A)]);
    let release!: () => void;
    h.holdCreation.gate = new Promise<void>((resolve) => { release = resolve; });
    const host = makeFakeHost();
    const opening = h.manager.initializeHost(host);
    await tick();

    host.closeFromUser();
    h.holdCreation.gate = null;
    release();
    const panelId = await opening;

    expect(h.manager.getPanels().has(panelId)).toBe(false);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() awaits the session disposal of a panel closed before it', async () => {
    h = createHarness([folderEntry(A)]);
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    const session = h.instance(panelId).session as unknown as FakeSession;
    let finish!: () => void;
    session.dispose.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

    host.closeFromUser();
    let disposed = false;
    const disposing = h.manager.dispose().then(() => { disposed = true; });
    await tick();
    expect(disposed).toBe(false);

    finish();
    await disposing;
    expect(disposed).toBe(true);
  });

  it('dispose() still resolves when a session disposal of a closed panel failed', async () => {
    h = createHarness([folderEntry(A)]);
    const host = makeFakeHost();
    const panelId = await h.manager.initializeHost(host);
    (h.instance(panelId).session as unknown as FakeSession).dispose.mockRejectedValue(new Error('teardown failed'));

    host.closeFromUser();

    await expect(h.manager.dispose()).resolves.toBeUndefined();
  });

  // The desktop host records a chat core opens itself as it creates its view, before core starts setting it up.
  it('whenSetUp, asked for as the host is created, settles only once core finished setting that chat up, registered or not', async () => {
    h = createHarness([folderEntry(A)]);
    const window = h.platform.window;
    const create = window.createPanelInOwnColumn.bind(window);
    const setUps: Array<Promise<void>> = [];
    window.createPanelInOwnColumn = async (options) => {
      const host = await create(options);
      setUps.push(h.manager.whenSetUp(host));
      return host;
    };
    let release!: () => void;
    h.holdCreation.gate = new Promise<void>((resolve) => { release = resolve; });
    const opening = h.manager.show();
    await tick();
    let settled = false;
    void setUps[0]!.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    h.holdCreation.gate = null;
    release();
    const panelId = await opening;
    await setUps[0];
    expect(h.manager.getPanels().has(panelId)).toBe(true);

    h.failCreation.errors.push(new Error('no session'));
    await expect(h.manager.show()).rejects.toThrow('no session');
    await expect(setUps[1]).resolves.toBeUndefined();
  });
});

// A message routed beside a restoring `ready` starts a fresh conversation, or lands in the restored one before its replay clears the transcript.
describe('PanelManager routes nothing a webview sent after its ready until the ready is handled', () => {
  const PANEL_TOKEN = '00000000-0000-4000-8000-000000000000';
  const routedTypes = (): string[] => h.routed.map((r) => r.message.type);

  it('holds a message the webview sent while the session was created until the queued ready settles', async () => {
    h = createHarness([folderEntry(A)]);
    let created!: () => void;
    h.holdCreation.gate = new Promise<void>((resolve) => { created = resolve; });
    let readied!: () => void;
    h.holdReady.gate = new Promise<void>((resolve) => { readied = resolve; });
    const host = makeFakeHost();
    const opening = h.manager.initializeHost(host);
    await tick();
    host.send({ type: 'ready', panelToken: PANEL_TOKEN, savedSessionId: 'saved' });
    host.send({ type: 'sendMessage', content: 'typed during the restore' });

    h.holdCreation.gate = null;
    created();
    await opening;
    await tick();
    expect(routedTypes()).toEqual(['ready']);

    readied();
    await tick();
    expect(routedTypes()).toEqual(['ready', 'sendMessage']);
  });

  it('holds a message that arrives while a ready on an open gate is handled, and every message after it in order', async () => {
    h = createHarness([folderEntry(A)]);
    const host = makeFakeHost();
    await h.manager.initializeHost(host);
    let readied!: () => void;
    h.holdReady.gate = new Promise<void>((resolve) => { readied = resolve; });

    host.send({ type: 'ready', panelToken: PANEL_TOKEN });
    host.send({ type: 'sendMessage', content: 'first' });
    host.send({ type: 'cancelSession' });
    await tick();
    expect(routedTypes()).toEqual(['ready']);

    readied();
    await tick();
    expect(routedTypes()).toEqual(['ready', 'sendMessage', 'cancelSession']);
  });
});
