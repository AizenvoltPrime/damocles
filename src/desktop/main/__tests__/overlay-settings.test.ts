import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('../../../core/chat-panel/ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import { createHarness, folderEntry, type Harness } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import type { FakePanelHost } from '../../../__mocks__/fake-platform';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { MAX_SETTINGS_MESSAGE_CHARS, OVERLAY_CHANNELS, type OverlayAnswer, type OverlayPrefs, type OverlayPrefWrite, type OverlayRequest } from '../../preload/overlay-channels';
import { OverlaySettings } from '../overlay-settings';
import { WebviewPrompts } from '../../../core/chat-panel/webview-prompts';
import type { OverlayHost } from '../overlay';

const A = path.join(path.resolve(os.tmpdir(), 'overlay-settings-root'), 'alpha');
const USER_FILE = '/home/me/.damocles/settings.json';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeOverlay() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const requests: OverlayRequest[] = [];
  let answer: ((value: OverlayAnswer) => void) | undefined;
  const overlay = {
    on: (channel: string, handler: (...args: unknown[]) => void) => { listeners.set(channel, handler); },
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    request: (request: OverlayRequest) => {
      requests.push(request);
      return new Promise<OverlayAnswer>((resolve) => { answer = resolve; });
    },
  };
  return {
    overlay: overlay as unknown as OverlayHost,
    sent,
    requests,
    fire: (channel: string, ...args: unknown[]) => listeners.get(channel)!(...args),
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
    close: () => answer!({ kind: 'settings', closed: true }),
  };
}

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

async function openPanel(harness: Harness): Promise<{ panelId: string; host: FakePanelHost }> {
  const panelId = await harness.manager.show();
  const host = harness.platform.window.panels.at(-1)!;
  host.fireMessage({ type: 'ready' });
  await tick();
  return { panelId, host };
}

async function setup() {
  h = createHarness([folderEntry(A)]);
  const first = await openPanel(h);
  const second = await openPanel(h);
  const fake = fakeOverlay();
  const settingsPlatform = createFakePlatform({ settings: { scopeFiles: { user: USER_FILE } } });
  let target = first.panelId;
  const relaunch = vi.fn();
  const resetLayout = vi.fn();
  const harness = h;
  const settings = new OverlaySettings({
    overlay: fake.overlay,
    settings: settingsPlatform.settings,
    panelManager: () => harness.manager,
    targetPanel: async () => target,
    focused: () => undefined,
    relaunch,
    resetLayout,
    log: () => undefined,
    languageAtLaunch: 'el',
  });
  harness.routed.length = 0;
  return {
    harness, fake, settings, first, second, settingsPlatform, relaunch, resetLayout,
    select: (panelId: string) => { target = panelId; },
  };
}

describe('OverlaySettings', () => {
  it('attaches the modal to the selected chat, runs its requests there and copies the chat\'s settings messages to it', async () => {
    const { harness, fake, settings, first } = await setup();
    const shown = settings.show('workspace');
    await tick();
    expect(fake.requests).toEqual([{ kind: 'settings', section: 'workspace', generation: 1 }]);
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 1, message: { type: 'setBudgetLimit', budgetUsd: 5 } });
    await tick();
    expect(harness.routed.map((r) => [r.message.type, r.panelId])).toEqual([['setBudgetLimit', first.panelId]]);
    harness.manager.postMessage(first.host, { type: 'projectTrust', trusted: true });
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsMessage, payload: { type: 'projectTrust', trusted: true } });

    fake.close();
    await shown;
    expect(harness.manager.attachedView(first.panelId)).toBeUndefined();
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 1, message: { type: 'setBudgetLimit', budgetUsd: 6 } });
    await tick();
    expect(harness.routed).toHaveLength(1);
  });

  it('follows a selection change and drops a message sent for the previous chat', async () => {
    const { harness, fake, settings, first, second, select } = await setup();
    void settings.show(undefined);
    await tick();
    select(second.panelId);
    settings.selectionChanged();
    await tick();
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2 } });
    expect(harness.manager.attachedView(first.panelId)).toBeUndefined();
    expect(harness.manager.attachedView(second.panelId)).toBeDefined();

    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 1, message: { type: 'setPermissionMode', mode: 'plan' } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setPermissionMode', mode: 'acceptEdits' } });
    await tick();
    expect(harness.routed.map((r) => [r.message, r.panelId])).toEqual([[{ type: 'setPermissionMode', mode: 'acceptEdits' }, second.panelId]]);
  });

  it('delivers the host prompt a re-attach moves into the modal after telling it the new attachment, with no requestSettingsState', async () => {
    const { harness, fake, settings, first, second, select } = await setup();
    const prompts = new WebviewPrompts(
      { target: (signal) => harness.manager.promptTarget(signal), attachedView: (id) => harness.manager.attachedView(id) },
      (host, message) => harness.manager.postMessage(host, message),
    );
    harness.manager.onDidChangeAttachment((id) => prompts.resurface(id));
    void prompts.inputBox({ prompt: 'Paste the code' });
    await tick();
    const asked = [first, second].find((chat) => chat.host.posted.some((m) => (m as { type: string }).type === 'extensionUiRequest'))!;
    select(asked === first ? second.panelId : first.panelId);
    void settings.show(undefined);
    await tick();
    fake.sent.length = 0;

    select(asked.panelId);
    settings.selectionChanged();
    await tick();

    expect(fake.sent.map(({ channel, payload }) => [channel, (payload as { type?: string; title?: string; generation?: number })])).toEqual([
      [OVERLAY_CHANNELS.settingsAttached, { generation: 2 }],
      [OVERLAY_CHANNELS.settingsMessage, expect.objectContaining({ type: 'extensionUiRequest', title: 'Paste the code' })],
    ]);
    expect(harness.routed.map((r) => r.message.type)).not.toContain('requestSettingsState');
  });

  it('refuses a request type outside SETTINGS_VIEW_REQUESTS, a malformed envelope and an oversized one', async () => {
    const { harness, fake, settings } = await setup();
    void settings.show(undefined);
    await tick();
    for (const raw of [
      { generation: 1, message: { type: 'ready' } },
      { generation: 1, message: { type: 'sendMessage', content: 'hi' } },
      { generation: 1, message: { type: '__proto__' } },
      { generation: 1, message: 'setBudgetLimit' },
      { generation: '1', message: { type: 'setBudgetLimit', budgetUsd: 5 } },
      { generation: 1, message: { type: 'setOpenAIApiKey', key: 'x'.repeat(MAX_SETTINGS_MESSAGE_CHARS), requestId: 'r' } },
      null,
    ]) fake.fire(OVERLAY_CHANNELS.settingsSend, raw);
    await tick();
    expect(harness.routed).toEqual([]);
  });

  it('rejects an unknown section before anything opens', async () => {
    const { fake, settings } = await setup();
    await expect(settings.show('nope' as never)).rejects.toThrow(/Unknown settings section/);
    await expect(settings.show('accounts', 'nope' as never)).rejects.toThrow(/Unknown settings account/);
    expect(fake.requests).toEqual([]);
  });

  it('sends a section and account asked for while the modal shows to that modal, and opens no second one', async () => {
    const { fake, settings } = await setup();
    void settings.show(undefined);
    await tick();
    await settings.show('accounts', 'openai');
    expect(fake.requests).toEqual([{ kind: 'settings', generation: 1 }]);
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsTarget, payload: { section: 'accounts', account: 'openai' } });
  });

  it('pushes the desktop settings to the open modal when one changes, and only while it shows', async () => {
    const { fake, settings, settingsPlatform } = await setup();
    const pushed = () => fake.sent.filter(({ channel }) => channel === OVERLAY_CHANNELS.prefsChanged).map(({ payload }) => payload as { values: Record<string, unknown> });
    await settingsPlatform.settings.update('damocles.desktop.theme', 'light', 'user');
    expect(pushed()).toEqual([]);

    void settings.show(undefined);
    await tick();
    await settingsPlatform.settings.update('damocles.desktop.theme', 'dark', 'user');
    await settingsPlatform.settings.update('damocles.maxBudgetUsd', 5, 'user');
    expect(pushed()).toHaveLength(1);
    expect(pushed()[0]).toMatchObject({ values: { 'damocles.desktop.theme': 'dark' }, languageAtLaunch: 'el' });

    settings.dispose();
    await settingsPlatform.settings.update('damocles.desktop.theme', 'light', 'user');
    expect(pushed()).toHaveLength(1);
  });

  it('writes only declared desktop settings, at user scope, with values their schema allows', async () => {
    const { fake, settings, settingsPlatform } = await setup();
    void settings.show(undefined);
    await tick();
    const set = (key: unknown, value: unknown) => fake.invoke(OVERLAY_CHANNELS.prefsSet, { key, value }) as Promise<OverlayPrefWrite>;
    for (const [key, value] of [
      ['damocles.desktop.language', 'de'],
      ['damocles.desktop.language', 1],
      ['damocles.desktop.restoreLayout', 'false'],
      ['damocles.maxBudgetUsd', 5],
      ['__proto__', true],
      ['constructor', 'x'],
      [7, true],
    ] as const) {
      expect(await set(key, value), `${String(key)}=${String(value)}`).toMatchObject({ ok: false });
    }
    expect(await set('damocles.desktop.language', 'el')).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.notifications.enabled', false)).toEqual({ ok: true, file: USER_FILE });
    expect(settingsPlatform.settings.inspect('damocles.desktop.language')).toStrictEqual({ userValue: 'el' });
    const prefs = (await fake.invoke(OVERLAY_CHANNELS.prefsGet)) as OverlayPrefs;
    expect(prefs.languageAtLaunch).toBe('el');
    expect(Object.keys(prefs.values).sort()).toEqual([
      'damocles.desktop.language',
      'damocles.desktop.notifications.enabled',
      'damocles.desktop.reduceMotion',
      'damocles.desktop.restoreLayout',
      'damocles.desktop.theme',
    ]);
  });

  it('restarts, restores the default layout and writes desktop settings only while the modal is open', async () => {
    const { fake, settings, relaunch, resetLayout } = await setup();
    expect(() => fake.invoke(OVERLAY_CHANNELS.prefsSet, { key: 'damocles.desktop.language', value: 'el' })).toThrow();
    expect(() => fake.invoke(OVERLAY_CHANNELS.relaunch)).toThrow();
    expect(() => fake.invoke(OVERLAY_CHANNELS.layoutReset)).toThrow();
    void settings.show(undefined);
    await tick();
    fake.invoke(OVERLAY_CHANNELS.relaunch);
    fake.invoke(OVERLAY_CHANNELS.layoutReset);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(resetLayout).toHaveBeenCalledOnce();
  });
});
