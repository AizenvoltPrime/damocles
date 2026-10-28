import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { installLogSink } from '../../logger';
import { createHarness, folderEntry, type Harness } from './panel-manager-harness';
import { WebviewPrompts } from '../webview-prompts';
import { createPermissionHandlers } from '../message-router/handlers/permission-handlers';
import type { HandlerContext, HandlerDependencies } from '../message-router/types';
import type { AttachedView } from '../types';
import type { FakePanelHost } from '../../../__mocks__/fake-platform';
import type { PanelHost } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../shared/types/messages';
import { SETTINGS_VIEW_MESSAGES, SETTINGS_VIEW_PROMPTS, SETTINGS_VIEW_REQUESTS } from '../../../shared/settings-view-messages';

vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    refresh(): void {}
    dispose(): void {}
  },
}));

const A = path.join(path.resolve(os.tmpdir(), 'attach-root'), 'alpha');
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const SENTINEL_KEY = 'sk-attach-sentinel-9f3c';

interface FakeView extends AttachedView {
  posted: ExtensionToWebviewMessage[];
  detachCount: number;
}

function makeView(clientId?: string): FakeView {
  const view: FakeView = {
    posted: [],
    detachCount: 0,
    post: (message) => { view.posted.push(message); },
    detached: () => { view.detachCount++; },
    ...(clientId !== undefined ? { clientId } : {}),
  };
  return view;
}

let h: Harness | undefined;
let logged: string[];
beforeEach(() => {
  logged = [];
  installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
});
afterEach(() => {
  h?.dispose();
  h = undefined;
});

async function openPanel(): Promise<{ panelId: string; host: FakePanelHost }> {
  const panelId = await h!.manager.show();
  const host = h!.platform.window.panels.at(-1)!;
  host.fireMessage({ type: 'ready' });
  await tick();
  return { panelId, host };
}

describe('SETTINGS_VIEW lists', () => {
  it('keep host prompts out of the copied types and every chat-authority message out of the requests', () => {
    const copied: readonly string[] = SETTINGS_VIEW_MESSAGES;
    for (const prompt of SETTINGS_VIEW_PROMPTS) expect(copied).not.toContain(prompt);
    const requests: readonly string[] = SETTINGS_VIEW_REQUESTS;
    for (const forbidden of [
      'ready', 'log', 'sendMessage', 'queueMessage', 'resumeSession', 'clearSession', 'interrupt', 'cancelSession', 'rewindToMessage',
      'approveEdit', 'answerQuestion', 'answerForm', 'approvePlan', 'approveSkill', 'answerElicitation',
      'openFile', 'openRewindDiff', 'openSessionLog', 'openAgentLog', 'bindPlanToSession', 'requestPlanFileCandidates', 'compassNavigateToNode', 'openBrowser',
      'mentionDropped', 'setLanguagePreference', 'setProjectTrusted', 'deleteSession',
      'stopSubagent', 'cancelTeam',
    ]) expect(requests).not.toContain(forbidden);
    expect(new Set(copied).size).toBe(copied.length);
    expect(new Set(requests).size).toBe(requests.length);
  });
});

describe('PanelManager view attachment', () => {
  it('copies only settings view message types posted to the attached panel', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const { host: other } = await openPanel();
    const view = makeView();
    h!.manager.attachView(panelId, view);

    h!.manager.postMessage(host, { type: 'projectTrust', trusted: true });
    h!.manager.postMessage(host, { type: 'processing', isProcessing: true });
    h!.manager.postMessage(host, { type: 'extensionUiRequest', requestId: 's:ui:1', kind: 'input', title: 'pi dialog' });
    h!.manager.postMessage(other, { type: 'projectTrust', trusted: false });

    expect(view.posted).toEqual([{ type: 'projectTrust', trusted: true }]);
    expect(host.posted).toContainEqual({ type: 'processing', isProcessing: true });
  });

  it('on a panel several devices show, copies a post to one device\'s views only to that device\'s settings view', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const viewOf = (clientId: string | undefined): PanelHost => Object.assign(Object.create(host) as PanelHost, { panelHost: host, clientId, postMessage: async () => true });
    const view: FakeView = makeView('laptop');
    h!.manager.attachView(panelId, view);

    h!.manager.postMessage(viewOf('desktop'), { type: 'projectTrust', trusted: false });
    h!.manager.postMessage(viewOf(undefined), { type: 'projectTrust', trusted: false });
    h!.manager.postMessage(viewOf('laptop'), { type: 'projectTrust', trusted: true });
    h!.manager.postMessage(host, { type: 'projectTrust', trusted: false });

    // a post to every view is the chat's shared state
    expect(view.posted).toEqual([{ type: 'projectTrust', trusted: true }, { type: 'projectTrust', trusted: false }]);
  });

  it('keeps one settings view per device on a chat several devices show, each with its own device\'s posts and requests', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const viewOf = (clientId: string): PanelHost => Object.assign(Object.create(host) as PanelHost, { panelHost: host, clientId, postMessage: async () => true });
    const laptop: FakeView = makeView('laptop');
    const desktop: FakeView = makeView('desktop');
    h!.manager.attachView(panelId, laptop);
    h!.manager.attachView(panelId, desktop);

    expect([laptop.detachCount, desktop.detachCount]).toEqual([0, 0]);
    expect([h!.manager.attachedView(panelId, 'laptop'), h!.manager.attachedView(panelId, 'desktop')]).toEqual([laptop, desktop]);
    h!.manager.postMessage(viewOf('laptop'), { type: 'projectTrust', trusted: true });
    h!.manager.postMessage(viewOf('desktop'), { type: 'projectTrust', trusted: false });
    const shared: ExtensionToWebviewMessage = { type: 'toolStatus', data: { groups: [] } as never };
    h!.manager.postMessage(host, shared);
    expect(laptop.posted).toEqual([{ type: 'projectTrust', trusted: true }, shared]);
    expect(desktop.posted).toEqual([{ type: 'projectTrust', trusted: false }, shared]);

    h!.routed.length = 0;
    await h!.manager.dispatchFromView(panelId, desktop, { type: 'setBudgetLimit', budgetUsd: 5 });
    await h!.manager.dispatchFromView(panelId, laptop, { type: 'setBudgetLimit', budgetUsd: 7 });
    expect(h!.routed.map((r) => r.view)).toEqual([desktop, laptop]);

    // a device opening its settings again replaces only its own view
    const laptopAgain: FakeView = makeView('laptop');
    h!.manager.attachView(panelId, laptopAgain);
    expect([laptop.detachCount, desktop.detachCount]).toEqual([1, 0]);
    expect(h!.manager.attachedView(panelId, 'laptop')).toBe(laptopAgain);
  });

  it('refuses to attach to a panel that is not open', () => {
    h = createHarness([folderEntry(A)]);
    expect(() => h!.manager.attachView('host-404', makeView())).toThrow(/No open chat panel/);
  });

  it('runs an allowed view message with the panel id and the view, and drops every other type', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId } = await openPanel();
    const view = makeView();
    h!.manager.attachView(panelId, view);
    h!.routed.length = 0;

    await h!.manager.dispatchFromView(panelId, view, { type: 'setBudgetLimit', budgetUsd: 5 });
    await h!.manager.dispatchFromView(panelId, view, { type: 'ready', panelToken: '00000000-0000-4000-8000-000000000000' });
    await h!.manager.dispatchFromView(panelId, view, { type: 'sendMessage', content: SENTINEL_KEY, sessionId: null });
    await h!.manager.dispatchFromView(panelId, view, { type: '__proto__' } as unknown as WebviewToExtensionMessage);

    expect(h!.routed.map((r) => [r.message.type, r.panelId, r.view])).toEqual([['setBudgetLimit', panelId, view]]);
  });

  it('drops a view message from a view not attached to the panel', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId } = await openPanel();
    const { panelId: other } = await openPanel();
    const view = makeView();
    h!.manager.attachView(other, view);
    h!.routed.length = 0;
    await h!.manager.dispatchFromView(panelId, makeView(), { type: 'setBudgetLimit', budgetUsd: 5 });
    await h!.manager.dispatchFromView(panelId, view, { type: 'setBudgetLimit', budgetUsd: 5 });
    expect(h!.routed).toEqual([]);
  });

  it('detaches the view when its panel closes, and copies nothing afterwards', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const view = makeView();
    const changes: string[] = [];
    h!.manager.onDidChangeAttachment((id) => changes.push(id));
    h!.manager.attachView(panelId, view);

    host.close();

    expect(view.detachCount).toBe(1);
    expect(h!.manager.attachedView(panelId)).toBeUndefined();
    expect(changes).toEqual([panelId, panelId]);
    h!.manager.postMessage(host, { type: 'projectTrust', trusted: true });
    expect(view.posted).toEqual([]);
  });

  it('replaces an attached view, and a stale handle no longer detaches the new one', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId } = await openPanel();
    const first = makeView();
    const second = makeView();
    const firstHandle = h!.manager.attachView(panelId, first);
    const secondHandle = h!.manager.attachView(panelId, second);

    expect(first.detachCount).toBe(1);
    firstHandle.dispose();
    expect(h!.manager.attachedView(panelId)).toBe(second);
    secondHandle.dispose();
    expect(second.detachCount).toBe(1);
    expect(h!.manager.attachedView(panelId)).toBeUndefined();
  });

  it('neither detaches nor reports a change when the attached view is attached again', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId } = await openPanel();
    const view = makeView();
    const changes: string[] = [];
    h!.manager.onDidChangeAttachment((id) => changes.push(id));
    h!.manager.attachView(panelId, view);
    h!.manager.attachView(panelId, view);

    expect(view.detachCount).toBe(0);
    expect(changes).toEqual([panelId]);
    expect(h!.manager.attachedView(panelId)).toBe(view);
  });

  it('detaches every view on dispose', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId } = await openPanel();
    const view = makeView();
    h!.manager.attachView(panelId, view);
    h!.dispose();
    h = undefined;
    expect(view.detachCount).toBe(1);
  });
});

describe('host prompt redirect', () => {
  type UiRequest = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;
  const requestIn = (posted: readonly unknown[]): UiRequest | undefined =>
    [...posted].reverse().find((m): m is UiRequest => (m as { type: string }).type === 'extensionUiRequest');

  // asking: the device a daemon's core asks the prompt of
  function wire(asking?: string): { prompts: WebviewPrompts; answer: (msg: WebviewToExtensionMessage, ctx: Partial<HandlerContext>) => Promise<void> } {
    const prompts = new WebviewPrompts(
      {
        target: async (signal) => {
          const target = await h!.manager.promptTarget(signal);
          return target && asking !== undefined ? { ...target, clientId: asking } : target;
        },
        attachedView: (id, clientId) => h!.manager.attachedView(id, clientId),
      },
      (host, message) => h!.manager.postMessage(host, message),
    );
    h!.manager.onDidChangeAttachment((id) => prompts.resurface(id));
    const handlers = createPermissionHandlers({ webviewPrompts: prompts } as unknown as HandlerDependencies);
    return { prompts, answer: async (msg, ctx) => { await handlers.extensionUiResponse!(msg, ctx as HandlerContext); } };
  }

  it('renders a host prompt in the attached view, takes its answer as the chat panel, and keeps it out of the logs', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const view = makeView();
    h!.manager.attachView(panelId, view);
    const { prompts, answer } = wire();

    const pending = prompts.inputBox({ prompt: 'API key', password: true });
    await tick();
    const request = requestIn(view.posted);
    expect(request).toMatchObject({ kind: 'input', password: true });
    expect(requestIn(host.posted)).toBeUndefined();

    const resolveExtensionUiResponse = vi.fn();
    await answer({ type: 'extensionUiResponse', requestId: request!.requestId, value: 'from-chat' }, { panelId, session: { resolveExtensionUiResponse } as never });
    await answer({ type: 'extensionUiResponse', requestId: request!.requestId, value: SENTINEL_KEY }, { panelId, view, session: { resolveExtensionUiResponse } as never });

    await expect(pending).resolves.toBe(SENTINEL_KEY);
    expect(resolveExtensionUiResponse).not.toHaveBeenCalled();
    expect(logged.join('\n')).not.toContain(SENTINEL_KEY);
    expect(logged.join('\n')).not.toContain('from-chat');
  });

  it('shows a prompt only in the settings view of the device it asks, and takes its answer only from there', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const desktop: FakeView = makeView('desktop');
    h!.manager.attachView(panelId, desktop);
    const { prompts, answer } = wire('laptop');
    const pending = prompts.inputBox({ prompt: 'Code' });
    await tick();
    const request = requestIn(host.posted)!;
    expect(request).toMatchObject({ kind: 'input', title: 'Code' });

    const laptop: FakeView = makeView('laptop');
    h!.manager.attachView(panelId, laptop);
    expect(laptop.posted).toEqual([request]);
    expect(requestIn(desktop.posted)).toBeUndefined();

    await answer({ type: 'extensionUiResponse', requestId: request.requestId, value: 'from-desktop' }, { panelId, view: desktop });
    await answer({ type: 'extensionUiResponse', requestId: request.requestId, value: '42' }, { panelId, view: laptop });
    await expect(pending).resolves.toBe('42');
  });

  it('never hands a view answer to a PiSession dialog', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId } = await openPanel();
    const view = makeView();
    h!.manager.attachView(panelId, view);
    const { answer } = wire();
    const resolveExtensionUiResponse = vi.fn();
    await answer({ type: 'extensionUiResponse', requestId: 'session-1:ui:1', value: 'x' }, { panelId, view, session: { resolveExtensionUiResponse } as never });
    expect(resolveExtensionUiResponse).not.toHaveBeenCalled();
  });

  it('moves a pending prompt back to the chat when the view detaches, and into a view that attaches', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const { prompts, answer } = wire();
    const pending = prompts.inputBox({ prompt: 'Code' });
    await tick();
    const request = requestIn(host.posted)!;

    const view = makeView();
    const handle = h!.manager.attachView(panelId, view);
    expect(host.posted.at(-1)).toEqual({ type: 'extensionUiCancel', requestId: request.requestId });
    expect(view.posted).toEqual([request]);

    handle.dispose();
    expect(view.posted.at(-1)).toEqual({ type: 'extensionUiCancel', requestId: request.requestId });
    expect(host.posted.at(-1)).toEqual(request);

    await answer({ type: 'extensionUiResponse', requestId: request.requestId, value: 'stale' }, { panelId, view });
    await answer({ type: 'extensionUiResponse', requestId: request.requestId, value: '42' }, { panelId });
    await expect(pending).resolves.toBe('42');
  });

  it('counts a view answer only for the panel the view is attached to', async () => {
    h = createHarness([folderEntry(A)]);
    const first = await openPanel();
    const second = await openPanel();
    const { prompts, answer } = wire();
    const view = makeView();
    h!.manager.attachView(second.panelId, view);
    let settled = false;
    const pending = prompts.inputBox({ prompt: 'Code' }).then((v) => { settled = true; return v; });
    await tick();
    const request = requestIn(view.posted)!;

    await answer({ type: 'extensionUiResponse', requestId: request.requestId, value: 'wrong' }, { panelId: first.panelId, view });
    await tick();
    expect(settled).toBe(false);
    await answer({ type: 'extensionUiResponse', requestId: request.requestId, value: null }, { panelId: second.panelId, view });
    await expect(pending).resolves.toBeUndefined();
  });

  it('posts a view its prompts again when it asks for its state, and the chat only its own on ready', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const { prompts } = wire();
    void prompts.inputBox({ prompt: 'Code' });
    await tick();
    const view = makeView();
    h!.manager.attachView(panelId, view);
    const request = requestIn(view.posted)!;
    view.posted.length = 0;
    host.posted.length = 0;

    prompts.repost(panelId);
    expect(host.posted).toEqual([]);
    prompts.repost(panelId, makeView());
    expect(view.posted).toEqual([]);
    prompts.repost(panelId, view);
    expect(view.posted).toEqual([request]);
  });

  it('withdraws a prompt from the view when the chat panel closes', async () => {
    h = createHarness([folderEntry(A)]);
    const { panelId, host } = await openPanel();
    const view = makeView();
    h!.manager.attachView(panelId, view);
    const { prompts } = wire();
    const pending = prompts.inputBox({ prompt: 'Code' });
    await tick();
    const request = requestIn(view.posted)!;
    host.close();
    await expect(pending).resolves.toBeUndefined();
    expect(view.posted).toContainEqual({ type: 'extensionUiCancel', requestId: request.requestId });
  });
});
