import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));
vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    refresh(): void {}
    dispose(): void {}
  },
}));

import { createHarness, folderEntry, makeFakeHost, type FakeSession, type Harness } from './panel-manager-harness';
import { DAMOCLES_DESIGNS_DIR } from '../../paths';

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
    host.send({ type: 'sendMessage', content: 'typed during the restore', sessionId: null });

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
    host.send({ type: 'sendMessage', content: 'first', sessionId: null });
    host.send({ type: 'cancelSession' });
    await tick();
    expect(routedTypes()).toEqual(['ready']);

    readied();
    await tick();
    expect(routedTypes()).toEqual(['ready', 'sendMessage', 'cancelSession']);
  });
});

describe('design chats (PD-1, PD-50)', () => {
  const seed = { designId: 'contacts-abcd1234', title: 'Contacts', parentSessionId: 'parent-1', ruleSet: 'full' as const };

  it('opens a design chat beside its parent, in the parent\'s folder, with its model but none of its permissions', async () => {
    h = createHarness([folderEntry(A)]);
    const parentHost = makeFakeHost();
    const parentId = await h.manager.initializeHost(parentHost);
    h.instance(parentId).permissionHandler.setPermissionMode('plan');
    h.instance(parentId).permissionHandler.setDangerouslySkipPermissions(true);

    const sessionId = await h.manager.showDesign({ sourcePanelId: parentId, seed });

    const created = h.platform.window.panels.at(-1)!;
    // a host lists the chat under this title until its stored name is listed
    expect(created.options).toMatchObject({ kind: 'chat', parent: parentHost, title: 'Design · Contacts' });
    const designPanelId = [...h.manager.getPanels().keys()].find((id) => id !== parentId)!;
    const design = h.instance(designPanelId);
    const session = design.session as unknown as FakeSession;
    expect(session.designSeed).toEqual(seed);
    expect(session.initializeEarly).toHaveBeenCalled();
    expect(sessionId).toBe(session.currentSessionId);
    expect(design.folder.key).toBe(h.instance(parentId).folder.key);
    expect(design.permissionHandler.getPermissions()).toEqual({ permissionMode: 'default', dangerouslySkipPermissions: false });
  });

  it('publishes each design chat\'s state again when the stored chats change, so its header shows the main chat\'s current title', async () => {
    h = createHarness([folderEntry(A)]);
    const parentId = await h.manager.initializeHost(makeFakeHost());
    await h.manager.showDesign({ sourcePanelId: parentId, seed });
    const designPanelId = [...h.manager.getPanels().keys()].find((id) => id !== parentId)!;
    const design = h.instance(designPanelId).session as unknown as FakeSession;
    design.design = { role: () => undefined, ownLink: () => undefined, isDesignChat: () => true } as unknown as FakeSession['design'];
    h.manager.republishDesignChats();
    expect(design.publishDesignState).toHaveBeenCalledTimes(1);
    expect((h.instance(parentId).session as unknown as FakeSession).publishDesignState).not.toHaveBeenCalled();
  });

  it('refuses a design chat for a parent that is not loaded', async () => {
    h = createHarness([folderEntry(A)]);
    await expect(h.manager.showDesign({ sourcePanelId: 'host-404', seed })).rejects.toThrow(/not loaded/);
  });

  it('shows the panel holding a session, else reopens it through the resume a session list click runs', async () => {
    h = createHarness([folderEntry(A)]);
    const host = makeFakeHost();
    const reveal = vi.spyOn(host, 'reveal');
    const panelId = await h.manager.initializeHost(host);
    (h.instance(panelId).session as unknown as FakeSession).storedId = 'held-1';
    expect(await h.manager.showSession('held-1', A)).toBe('shown');
    expect(reveal).toHaveBeenCalledTimes(1);
    // a host whose reveal says the panel could not be shown to the device that asked
    reveal.mockResolvedValueOnce(false);
    expect(await h.manager.showSession('held-1', A)).toBe('notShown');
    reveal.mockResolvedValueOnce(true);
    expect(await h.manager.showSession('held-1', A)).toBe('shown');
    expect(await h.manager.showSession('gone-1', A)).toBe('missing');

    const opening = h.manager.openStored('stored-1');
    await tick();
    const opened = h.platform.window.panels.at(-1)!;
    opened.fireMessage({ type: 'ready', panelToken: 'tok' });
    const openedId = await opening;
    expect(h.routed.filter((r) => r.panelId === openedId).map((r) => r.message)).toContainEqual({ type: 'resumeSession', sessionId: 'stored-1' });
  });

  it("answers a shown session, and opens a screen's preview, only once the holding panel's reveal settled, so the preview opens where the chat shows", async () => {
    h = createHarness([folderEntry(A)]);
    const screen = path.join(DAMOCLES_DESIGNS_DIR, 'd-1234', 'screens', 'S1.html');
    const order: string[] = [];
    const reveals: Array<() => void> = [];
    const host = makeFakeHost();
    vi.spyOn(host, 'reveal').mockImplementation(() => new Promise<boolean>((resolve) => reveals.push(() => {
      order.push('revealed');
      resolve(true);
    })));
    const panelId = await h.manager.initializeHost(host);
    const session = h.instance(panelId).session as unknown as FakeSession;
    session.storedId = 'design-1';
    session.design = {
      role: () => ({ designId: 'd-1234' }),
      ownLink: () => undefined,
      standing: () => ({ kind: 'current' }),
      openPreview: vi.fn(async () => {
        order.push('preview');
        return { opened: true };
      }),
    } as unknown as FakeSession['design'];
    const shown = h.manager.showSession('design-1', A).then((result) => order.push(`showSession ${result}`));
    const previewed = h.manager.previewDesignScreen(screen).then(() => order.push('previewDesignScreen'));
    await tick();
    expect(order).toEqual([]);
    reveals[0]!();
    await shown;
    expect(order).toEqual(['revealed', 'showSession shown']);
    reveals[1]!();
    await previewed;
    expect(order).toEqual(['revealed', 'showSession shown', 'revealed', 'preview', 'previewDesignScreen']);
  });

  it("opens a design screen's preview in the panel holding its current design chat, shown first, else through its main chat's panel", async () => {
    h = createHarness([folderEntry(A)]);
    const screen = path.join(DAMOCLES_DESIGNS_DIR, 'd-1234', 'screens', 'S1.html');
    const order: string[] = [];
    type Opening = { opened: true } | { refused: { message: string } };
    const designOf = (kind: 'main' | 'current' | 'superseded', openPreview: () => Promise<Opening>) => ({
      role: () => (kind === 'main' ? undefined : { designId: 'd-1234' }),
      ownLink: () => (kind === 'main' ? { designId: 'd-1234' } : undefined),
      standing: () => (kind === 'superseded' ? { kind: 'superseded', by: 'design-2' } : { kind: 'current' }),
      openPreview,
    }) as unknown as FakeSession['design'];
    const opens = (name: string, result: Opening = { opened: true }) => vi.fn(async () => {
      order.push(name);
      return result;
    });
    expect(await h.manager.previewDesignScreen(screen)).toEqual({ refused: expect.objectContaining({ message: 'Open the design chat of {0} to preview it.' }) });

    // a chat a rewind took the design from comes first in the panels, and is passed over
    const supersededHost = makeFakeHost();
    const supersededReveal = vi.spyOn(supersededHost, 'reveal');
    const supersededId = await h.manager.initializeHost(supersededHost);
    const supersededOpen = opens('superseded');
    (h.instance(supersededId).session as unknown as FakeSession).design = designOf('superseded', supersededOpen);
    const parentId = await h.manager.initializeHost(makeFakeHost());
    const parentOpen = opens('parent');
    (h.instance(parentId).session as unknown as FakeSession).design = designOf('main', parentOpen);
    expect(await h.manager.previewDesignScreen(screen)).toEqual({ opened: true });
    expect(parentOpen).toHaveBeenCalledWith('d-1234', 'screens/S1.html');

    const designHost = makeFakeHost();
    vi.spyOn(designHost, 'reveal').mockImplementation(() => void order.push('reveal'));
    const designChatId = await h.manager.initializeHost(designHost);
    const designOpen = opens('design');
    (h.instance(designChatId).session as unknown as FakeSession).design = designOf('current', designOpen);
    expect(await h.manager.previewDesignScreen(screen)).toEqual({ opened: true });
    expect(order).toEqual(['parent', 'reveal', 'design']);
    expect(designOpen).toHaveBeenCalledWith('d-1234', 'screens/S1.html');
    expect([supersededOpen, supersededReveal].map((fn) => fn.mock.calls.length)).toEqual([0, 0]);

    // a design chat that could not be shown to the device that asked opens no preview anywhere
    order.length = 0;
    vi.spyOn(designHost, 'reveal').mockImplementationOnce(async () => {
      order.push('reveal');
      return false;
    });
    expect(await h.manager.previewDesignScreen(screen)).toEqual({ refused: { message: 'The design chat could not be shown on this device, so {0} did not open.', args: ['S1.html'] } });
    expect(order).toEqual(['reveal']);

    // the design chat's own reason, and a failure, reach the user
    designOpen.mockResolvedValueOnce({ refused: { message: 'This design continues in another chat.' } });
    expect(await h.manager.previewDesignScreen(screen)).toEqual({ refused: { message: 'This design continues in another chat.' } });
    designOpen.mockRejectedValueOnce(new Error('The design chat is not loaded'));
    expect(await h.manager.previewDesignScreen(screen)).toEqual({ refused: expect.objectContaining({ message: 'Could not preview {0}: {1}', args: ['S1.html', expect.anything()] }) });
    expect(await h.manager.previewDesignScreen(path.join(DAMOCLES_DESIGNS_DIR, 'd-1234', 'design.md'))).toEqual({ refused: expect.objectContaining({ message: '{0} is not a screen of a design.' }) });
  });

  // New Session runs `newSession`; Reload runs `resetConversations` with `authFailureCleared`.
  const resets: Array<[string, (manager: Harness['manager']) => Promise<void>, string]> = [
    ['New Session', (manager) => manager.newSession(), 'sessionCleared'],
    ['Reload', (manager) => manager.resetConversations({ type: 'authFailureCleared' }), 'authFailureCleared'],
  ];

  it.each(resets)('%s leaves a seeded design chat and a panel restored onto a stored design chat alone before either started, and resets a plain panel', async (_name, reset, cleared) => {
    h = createHarness([folderEntry(A)]);
    const plainHost = makeFakeHost();
    const plainId = await h.manager.initializeHost(plainHost);
    await h.manager.showDesign({ sourcePanelId: plainId, seed });
    const restoredId = await h.manager.initializeHost(makeFakeHost());
    const restored = h.instance(restoredId).session as unknown as FakeSession;
    restored.storedId = 'stored-design';
    restored.isDesignConversation.mockImplementation(async () => restored.storedId === 'stored-design');
    const seeded = h.sessions.find((s) => s.designSeed !== undefined)!;
    const plain = h.instance(plainId).session as unknown as FakeSession;

    await reset(h.manager);

    expect(seeded.reset).not.toHaveBeenCalled();
    expect(restored.reset).not.toHaveBeenCalled();
    expect(plain.reset).toHaveBeenCalledTimes(1);
    expect(plainHost.posted).toContainEqual({ type: cleared });
  });

  it('New Session leaves a panel alone that started on a design chat, or closed, while its check read the file', async () => {
    h = createHarness([folderEntry(A)]);
    const startedHost = makeFakeHost();
    const started = h.instance(await h.manager.initializeHost(startedHost)).session as unknown as FakeSession;
    started.isDesignConversation.mockImplementation(async () => {
      started.design = { ...started.design, isDesignChat: () => true } as FakeSession['design'];
      return false;
    });
    const closingHost = makeFakeHost();
    const closing = h.instance(await h.manager.initializeHost(closingHost)).session as unknown as FakeSession;
    closing.isDesignConversation.mockImplementation(async () => {
      closingHost.closeFromUser();
      return false;
    });

    await h.manager.newSession();

    expect(started.reset).not.toHaveBeenCalled();
    expect(closing.reset).not.toHaveBeenCalled();
    expect(startedHost.posted).not.toContainEqual({ type: 'sessionCleared' });
  });

  it('fixes a design chat\'s mode: no plan mode, whatever asks for it', async () => {
    h = createHarness([folderEntry(A)]);
    const panelId = await h.manager.initializeHost(makeFakeHost());
    const instance = h.instance(panelId);
    (instance.session as unknown as { design: unknown }).design = { role: () => ({ designId: 'x' }) };
    await instance.permissionHandler.activatePlanMode();
    expect(instance.permissionHandler.getPermissionMode()).toBe('default');
    expect(instance.permissionHandler.modeFixed()).toBe(true);
  });
});
