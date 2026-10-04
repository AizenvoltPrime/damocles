import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakePanelHost } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PanelHost } from '../../../platform/window-service';
import { WebviewPrompts, type PromptTarget } from '../webview-prompts';
import { createHarness, folderEntry, type Harness } from './panel-manager-harness';
import { createPermissionHandlers } from '../message-router/handlers/permission-handlers';
import type { HandlerDependencies } from '../message-router/types';

type UiRequest = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;

function setup(): { prompts: WebviewPrompts; host: FakePanelHost; other: FakePanelHost; target: ReturnType<typeof vi.fn> } {
  const platform = createFakePlatform();
  platform.window.createPanel({ kind: 'chat', title: 'a', localResourceRoots: [] });
  platform.window.createPanel({ kind: 'chat', title: 'b', localResourceRoots: [] });
  const [host, other] = platform.window.panels as [FakePanelHost, FakePanelHost];
  const target = vi.fn(async (): Promise<PromptTarget | undefined> => ({ panelId: 'p1', host }));
  const prompts = new WebviewPrompts({ target, attachedView: () => undefined }, (h: PanelHost, m) => { void h.postMessage(m); });
  return { prompts, host, other, target };
}

const lastRequest = (host: FakePanelHost): UiRequest => {
  const found = [...host.posted].reverse().find((m) => (m as { type: string }).type === 'extensionUiRequest');
  if (!found) throw new Error('no extensionUiRequest posted');
  return found as UiRequest;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('WebviewPrompts', () => {
  it('posts a masked input request and resolves the typed text from the asked panel', async () => {
    const { prompts, host } = setup();
    const answer = prompts.inputBox({ prompt: 'API key', placeholder: 'sk-...', password: true });
    await flush();
    const request = lastRequest(host);
    expect(request).toStrictEqual({ type: 'extensionUiRequest', requestId: request.requestId, kind: 'input', title: 'API key', placeholder: 'sk-...', password: true });
    expect(request.requestId.startsWith('host-prompt:')).toBe(true);
    expect(host.reveals).toEqual([undefined]);
    expect(prompts.handleResponse('p1', request.requestId, 'sk-secret')).toBe(true);
    await expect(answer).resolves.toBe('sk-secret');
  });

  it('leaves password off a plain input request', async () => {
    const { prompts, host } = setup();
    void prompts.inputBox({ prompt: 'Code' });
    await flush();
    expect('password' in lastRequest(host)).toBe(false);
  });

  it('posts a quick pick with items and resolves the picked id; an id it did not offer resolves undefined', async () => {
    const { prompts, host } = setup();
    const items = [{ id: 'oauth', label: 'Sign in', detail: 'browser' }, { id: 'key', label: 'API key' }];
    const first = prompts.quickPick(items, { title: 'Method', placeholder: 'Choose' });
    await flush();
    const request = lastRequest(host);
    expect(request).toMatchObject({ kind: 'select', title: 'Method', placeholder: 'Choose', options: ['Sign in', 'API key'], items });
    prompts.handleResponse('p1', request.requestId, 'key');
    await expect(first).resolves.toBe('key');

    const second = prompts.quickPick(items, {});
    await flush();
    prompts.handleResponse('p1', lastRequest(host).requestId, 'forged');
    await expect(second).resolves.toBeUndefined();
  });

  it('ignores an answer from another panel and leaves the prompt pending', async () => {
    const { prompts, host } = setup();
    let settled = false;
    const answer = prompts.inputBox({ prompt: 'Code' }).then((value) => { settled = true; return value; });
    await flush();
    const { requestId } = lastRequest(host);
    expect(prompts.handleResponse('p2', requestId, 'stolen')).toBe(true);
    await flush();
    expect(settled).toBe(false);
    prompts.handleResponse('p1', requestId, null);
    await expect(answer).resolves.toBeUndefined();
  });

  it('passes PiSession dialog answers through untouched', () => {
    const { prompts } = setup();
    expect(prompts.handleResponse('p1', 'session-1:ui:1', 'x')).toBe(false);
  });

  it('withdraws the webview prompt on abort and resolves undefined', async () => {
    const { prompts, host } = setup();
    const abort = new AbortController();
    const answer = prompts.inputBox({ prompt: 'Code' }, abort.signal);
    await flush();
    const { requestId } = lastRequest(host);
    abort.abort();
    await expect(answer).resolves.toBeUndefined();
    expect(host.posted.at(-1)).toStrictEqual({ type: 'extensionUiCancel', requestId });
    expect(prompts.handleResponse('p1', requestId, 'late')).toBe(true);
  });

  it('posts nothing for an already aborted signal', async () => {
    const { prompts, host, target } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(prompts.inputBox({ prompt: 'Code' }, abort.signal)).resolves.toBeUndefined();
    expect(target).not.toHaveBeenCalled();
    expect(host.posted).toEqual([]);
  });

  it('resolves undefined when the asked panel closes', async () => {
    const { prompts, host } = setup();
    const answer = prompts.inputBox({ prompt: 'Code' });
    await flush();
    host.close();
    await expect(answer).resolves.toBeUndefined();
  });

  it('re-posts pending prompts to a panel whose webview reloaded, and only to it', async () => {
    const { prompts, host, other } = setup();
    void prompts.inputBox({ prompt: 'Code' });
    await flush();
    const request = lastRequest(host);
    host.posted.length = 0;
    prompts.repost('p2');
    expect(host.posted).toEqual([]);
    prompts.repost('p1');
    expect(host.posted).toEqual([request]);
    expect(other.posted).toEqual([]);
  });

  it('resolves undefined when no panel could be had', async () => {
    const { prompts, target } = setup();
    target.mockResolvedValueOnce(undefined);
    await expect(prompts.quickPick([{ id: 'a', label: 'A' }], {})).resolves.toBeUndefined();
  });
  it('withdraws and settles every pending prompt on dispose, and asks nothing afterwards', async () => {
    const { prompts, host, target } = setup();
    const answer = prompts.inputBox({ prompt: 'Code' });
    await flush();
    const { requestId } = lastRequest(host);

    prompts.dispose();

    await expect(answer).resolves.toBeUndefined();
    expect(host.posted.at(-1)).toStrictEqual({ type: 'extensionUiCancel', requestId });
    target.mockClear();
    await expect(prompts.inputBox({ prompt: 'Later' })).resolves.toBeUndefined();
    expect(target).not.toHaveBeenCalled();
  });

  it('settles a prompt whose panel was still being found when it was disposed', async () => {
    const { prompts, host, target } = setup();
    let found!: (t: PromptTarget) => void;
    target.mockImplementationOnce(() => new Promise<PromptTarget>((resolve) => { found = resolve; }));
    const answer = prompts.inputBox({ prompt: 'Code' });
    await flush();

    prompts.dispose();
    found({ panelId: 'p1', host });

    await expect(answer).resolves.toBeUndefined();
    expect(host.posted).toEqual([]);
  });
});

describe('extensionUiResponse routing', () => {
  it('settles a host prompt from the panel that sent the answer, and hands every other id to the session', async () => {
    const { prompts, host } = setup();
    const handlers = createPermissionHandlers({ webviewPrompts: prompts } as unknown as HandlerDependencies);
    const resolveExtensionUiResponse = vi.fn();
    const ctx = (panelId: string) => ({ panelId, session: { resolveExtensionUiResponse } }) as never;
    const answer = prompts.inputBox({ prompt: 'Code' });
    await flush();
    const { requestId } = lastRequest(host);
    await handlers.extensionUiResponse!({ type: 'extensionUiResponse', requestId, value: 'from-other' }, ctx('p2'));
    await handlers.extensionUiResponse!({ type: 'extensionUiResponse', requestId, value: 'abc' }, ctx('p1'));
    await expect(answer).resolves.toBe('abc');
    await handlers.extensionUiResponse!({ type: 'extensionUiResponse', requestId: 's:ui:1', value: true }, ctx('p1'));
    expect(resolveExtensionUiResponse.mock.calls).toEqual([['s:ui:1', true]]);
  });
});

describe('PanelManager.promptTarget', () => {
  let h: Harness | undefined;
  afterEach(() => h?.dispose());

  it('opens a chat panel when none is open and answers once its webview is ready', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    const pending = h.manager.promptTarget(undefined);
    await flush();
    await flush();
    const opened = h.platform.window.panels.at(-1)!;
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await flush();
    expect(resolved).toBe(false);
    opened.fireMessage({ type: 'ready' });
    const target = await pending;
    expect(target?.host).toBe(opened);
    expect(h.manager.getPanels().has(target!.panelId)).toBe(true);
  });

  it('answers undefined when the signal aborts before the webview is ready', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    const abort = new AbortController();
    const pending = h.manager.promptTarget(abort.signal);
    await flush();
    await flush();
    abort.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('answers undefined when the new panel closes before its webview is ready', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    const pending = h.manager.promptTarget(undefined);
    await flush();
    await flush();
    h.platform.window.panels.at(-1)!.close();
    await expect(pending).resolves.toBeUndefined();
  });

  it('opens one panel for prompts asked at once with none open', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    const first = h.manager.promptTarget(undefined);
    const second = h.manager.promptTarget(undefined);
    await flush();
    await flush();
    expect(h.platform.window.panels).toHaveLength(1);
    h.platform.window.panels[0]!.fireMessage({ type: 'ready' });
    expect((await second)?.panelId).toBe((await first)?.panelId);
  });

  it('waits for a panel whose session is still being created rather than opening another', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });
    const opening = h.manager.show();
    await flush();
    const opened = h.platform.window.panels.at(-1)!;
    opened.fireMessage({ type: 'ready' });

    const pending = h.manager.promptTarget(undefined);
    await flush();
    expect(h.platform.window.panels).toHaveLength(1);
    h.holdCreation.gate = null;
    release();
    const target = await pending;
    expect(target?.host).toBe(opened);
    expect(target?.panelId).toBe(await opening);
    expect(h.platform.window.panels).toHaveLength(1);
  });

  it('opens a panel when the one being set up closes before it registers', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    let release!: () => void;
    h.holdCreation.gate = new Promise((resolve) => { release = resolve; });
    void h.manager.show();
    await flush();
    const pending = h.manager.promptTarget(undefined);
    await flush();
    h.platform.window.panels[0]!.close();
    h.holdCreation.gate = null;
    release();
    await flush();
    await flush();
    expect(h.platform.window.panels).toHaveLength(2);
    const replacement = h.platform.window.panels[1]!;
    replacement.fireMessage({ type: 'ready' });
    expect((await pending)?.host).toBe(replacement);
  });

  it('answers undefined when the signal aborts while a panel is still being set up', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    h.holdCreation.gate = new Promise(() => undefined);
    void h.manager.show();
    await flush();
    const abort = new AbortController();
    const pending = h.manager.promptTarget(abort.signal);
    await flush();
    abort.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(h.platform.window.panels).toHaveLength(1);
  });

  it('reuses an open panel rather than opening another', async () => {
    h = createHarness([folderEntry('/ws/a')]);
    const pending = h.manager.promptTarget(undefined);
    await flush();
    await flush();
    const opened = h.platform.window.panels.at(-1)!;
    opened.fireMessage({ type: 'ready' });
    const first = await pending;
    const second = await h.manager.promptTarget(undefined);
    expect(h.platform.window.panels).toHaveLength(1);
    expect(second).toStrictEqual(first);
  });
});
