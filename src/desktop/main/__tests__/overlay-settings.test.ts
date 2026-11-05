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
import { MAX_SETTINGS_MESSAGE_CHARS, OVERLAY_CHANNELS, type OverlayAnswer, type OverlayPrefs, type OverlayPrefWrite, type OverlayRequest, type OverlaySettingsAway, type OverlaySettingsAwayState, type PopupAnswer } from '../../preload/overlay-channels';
import { DESKTOP_CONFIGURATION, LANGUAGE_SETTING, TERMINAL_PROFILES_SETTING } from '../../local-services/desktop-configuration';
import { hostAwayOf, hostCoreFacts, lookupOnUpCore, OverlaySettings, settingsPageChat, type HostCoreFacts, type HostCoreSources, type SettingsScopes, type SettingsViewHost } from '../overlay-settings';
import type { RemoteConnection } from '../remote/connection';
import { CoreHost } from '../core-host';
import { WebviewPrompts } from '../../../core/chat-panel/webview-prompts';
import type { AttachedView } from '../../../core/chat-panel/types';
import type { OverlayHost } from '../overlay';
import { fakeHandleWhileOpen } from './fake-popup-channels';

const A = path.join(path.resolve(os.tmpdir(), 'overlay-settings-root'), 'alpha');
const USER_FILE = '/home/me/.damocles/settings.json';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
// the page main's settingsTarget names for a local chat's panel
const pageOf = (panelId: string) => ({ authority: 'local', folder: A, chat: `new:${panelId}` });
const REMOTE_PAGE = { authority: 'loopback', folder: '/srv/alpha', chat: 'session-remote' };

function fakeOverlay() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const requests: OverlayRequest[] = [];
  const dismissed: string[] = [];
  let answer: ((value: OverlayAnswer) => void) | undefined;
  const overlay = {
    on: (channel: string, handler: (...args: unknown[]) => void) => { listeners.set(channel, handler); },
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    handleWhileOpen: fakeHandleWhileOpen(handlers),
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    request: (request: OverlayRequest) => {
      requests.push(request);
      return new Promise<OverlayAnswer>((resolve) => { answer = resolve; });
    },
    dismiss: (kind: string) => {
      dismissed.push(kind);
      answer?.({ kind: 'dismissed' });
    },
  };
  return {
    overlay: overlay as unknown as OverlayHost,
    sent,
    requests,
    dismissed,
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
  // core's side of the settings modal, as core-service.ts serves it
  const attached = new Map<number, { readonly panelId: string; readonly view: AttachedView }>();
  const lines: string[] = [];
  const real: SettingsViewHost = {
    attachSettingsView: async (panelId, attachment, view) => {
      attached.set(attachment, { panelId, view });
      return harness.manager.attachView(panelId, view);
    },
    dispatchSettingsView: async (attachment, message) => {
      const entry = attached.get(attachment);
      if (entry) await harness.manager.dispatchFromView(entry.panelId, entry.view, message);
    },
  };
  // what the tests swap: the core the chat runs on and how its panel is found
  const hooks: { core: () => SettingsViewHost | undefined; targetPanel: () => Promise<string | undefined> } = {
    core: () => real,
    targetPanel: async () => target,
  };
  const settings = new OverlaySettings({
    overlay: fake.overlay,
    settings: settingsPlatform.settings,
    target: async () => {
      const panelId = await hooks.targetPanel();
      const host = hooks.core();
      return panelId === undefined || host === undefined ? undefined : { host, panelId, page: pageOf(panelId) };
    },
    scopes: () => undefined,
    focused: () => undefined,
    relaunch,
    resetLayout,
    terminalProfiles: () => ({ profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] }) as const,
    log: (line) => lines.push(line),
    languageAtLaunch: 'el',
    knownHost: () => false,
    allowYolo: async () => false,
    signIn: async () => undefined,
    hostAway: () => ({ state: 'reconnecting' }),
  });
  harness.routed.length = 0;
  return {
    harness, fake, settings, first, second, settingsPlatform, relaunch, resetLayout, lines, attached, hooks,
    select: (panelId: string) => { target = panelId; },
  };
}

describe('OverlaySettings', () => {
  it('opens the settings of a remote chat on the User tab for a sign-in, and counts as showing while it finds the chat of that tab', async () => {
    const fake = fakeOverlay();
    const seen: Array<[unknown, boolean]> = [];
    const settings: OverlaySettings = new OverlaySettings({
      overlay: fake.overlay,
      settings: createFakePlatform().settings,
      target: async (scope) => {
        seen.push([scope, settings.showing()]);
        return undefined;
      },
      scopes: () => ({ host: { authority: 'loopback', name: 'Local daemon' } }),
      focused: () => undefined,
      relaunch: vi.fn(),
      resetLayout: vi.fn(),
      terminalProfiles: () => ({ profiles: [], hidden: [], problems: [] }),
      log: () => undefined,
      languageAtLaunch: 'en',
      knownHost: () => false,
      allowYolo: async () => false,
      signIn: async () => undefined,
      hostAway: () => ({ state: 'reconnecting' }),
    });
    await expect(settings.show({ section: 'accounts', account: 'openai' })).rejects.toThrow('No chat could be opened');
    expect(seen).toEqual([['user', true]]);
    expect(settings.showing()).toBe(false);
    await expect(settings.show({ section: 'workspace' })).rejects.toThrow();
    // the host's core does not answer, so the User tab is tried before the settings give up
    expect(seen.slice(-2)).toEqual([['machine', true], ['user', true]]);
  });

  it('attaches the modal to the selected chat, runs its requests there and copies the chat\'s settings messages to it', async () => {
    const { harness, fake, settings, first } = await setup();
    const shown = settings.show({ section: 'workspace' });
    await tick();
    expect(fake.requests).toEqual([{ kind: 'settings', section: 'workspace', generation: 1, page: pageOf(first.panelId) }]);
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

  it('goes with a closing window: dismissed in the overlay, it follows no chat the close unloads and opens none', async () => {
    const { harness, fake, settings, first, second, select } = await setup();
    const shown = settings.show({});
    await tick();
    expect(harness.manager.attachedView(first.panelId)).toBeDefined();

    settings.close();
    select(second.panelId);
    settings.selectionChanged();
    first.host.close();
    await expect(shown).resolves.toBeUndefined();
    await tick();

    expect(fake.dismissed).toEqual(['settings']);
    expect(harness.manager.attachedView(second.panelId)).toBeUndefined();
    expect(fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAttached)).toEqual([]);
  });

  it('shows nothing when its window closes while it is still finding the chat to attach to', async () => {
    const { fake, settings, hooks } = await setup();
    let found!: () => void;
    const finding = new Promise<void>((resolve) => { found = resolve; });
    hooks.targetPanel = async () => {
      await finding;
      return undefined;
    };
    const shown = settings.show({});
    settings.close();
    found();
    await expect(shown).resolves.toBeUndefined();
    expect(fake.requests).toEqual([]);
  });

  it('follows a selection change and drops a message sent for the previous chat', async () => {
    const { harness, fake, settings, first, second, select } = await setup();
    void settings.show({});
    await tick();
    select(second.panelId);
    settings.selectionChanged();
    await tick();
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2, page: pageOf(second.panelId) } });
    expect(harness.manager.attachedView(first.panelId)).toBeUndefined();
    expect(harness.manager.attachedView(second.panelId)).toBeDefined();

    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 1, message: { type: 'setPermissionMode', mode: 'plan' } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setPermissionMode', mode: 'acceptEdits' } });
    await tick();
    expect(harness.routed.map((r) => [r.message, r.panelId])).toEqual([[{ type: 'setPermissionMode', mode: 'acceptEdits' }, second.panelId]]);
  });

  it('runs what the remounted modal sends for a re-attach still under way once core attached it, and drops it when the attach fails', async () => {
    const { harness, fake, settings, first, second, select, hooks, lines } = await setup();
    const real = hooks.core()!;
    let release!: () => void;
    let refuse!: () => void;
    const holding: SettingsViewHost = {
      ...real,
      attachSettingsView: async (panelId, attachment, view) => {
        if (attachment === 2) await new Promise<void>((resolve) => { release = resolve; });
        if (attachment === 3) await new Promise<void>((_resolve, reject) => { refuse = () => reject(new Error('core refused')); });
        return real.attachSettingsView(panelId, attachment, view);
      },
    };
    hooks.core = () => holding;
    void settings.show({});
    await tick();

    select(second.panelId);
    settings.selectionChanged();
    await tick();
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2, page: pageOf(second.panelId) } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setBudgetLimit', budgetUsd: 4 } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setBudgetLimit', budgetUsd: 5 } });
    await tick();
    expect(harness.routed).toEqual([]);
    release();
    await tick();
    expect(harness.routed.map((r) => [r.message, r.panelId])).toEqual([
      [{ type: 'setBudgetLimit', budgetUsd: 4 }, second.panelId],
      [{ type: 'setBudgetLimit', budgetUsd: 5 }, second.panelId],
    ]);
    expect(lines.filter((line) => line.includes('dropped'))).toEqual([]);

    harness.routed.length = 0;
    select(first.panelId);
    settings.selectionChanged();
    await tick();
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 3, message: { type: 'setBudgetLimit', budgetUsd: 6 } });
    refuse();
    await tick();
    expect(harness.routed).toEqual([]);
    expect(lines).toContain('[settings] dropped 1 settings messages sent for an attachment that did not attach');
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
    void settings.show({});
    await tick();
    fake.sent.length = 0;

    select(asked.panelId);
    settings.selectionChanged();
    await tick();

    expect(fake.sent.map(({ channel, payload }) => [channel, (payload as { type?: string; title?: string; generation?: number })])).toEqual([
      [OVERLAY_CHANNELS.settingsAttached, { generation: 2, page: pageOf(asked.panelId) }],
      [OVERLAY_CHANNELS.settingsMessage, expect.objectContaining({ type: 'extensionUiRequest', title: 'Paste the code' })],
    ]);
    expect(harness.routed.map((r) => r.message.type)).not.toContain('requestSettingsState');
  });

  it('disposes an attachment core finishes after the modal closed', async () => {
    const { harness, fake, settings, first, second, select, hooks } = await setup();
    const real = hooks.core()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holding: SettingsViewHost = {
      ...real,
      attachSettingsView: async (panelId, attachment, view) => {
        if (panelId === second.panelId) await held;
        return real.attachSettingsView(panelId, attachment, view);
      },
    };
    hooks.core = () => holding;
    const shown = settings.show({});
    await tick();
    expect(harness.manager.attachedView(first.panelId)).toBeDefined();
    select(second.panelId);
    settings.selectionChanged();
    await tick();
    fake.close();
    await shown;
    release();
    await tick();
    expect(harness.manager.attachedView(first.panelId)).toBeUndefined();
    expect(harness.manager.attachedView(second.panelId)).toBeUndefined();
  });

  it('drops what the modal sends to a chat that detached while core attached it, and follows the selection again', async () => {
    const { harness, fake, settings, first, lines, hooks } = await setup();
    const real = hooks.core()!;
    let attaches = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const detaching: SettingsViewHost = {
      ...real,
      attachSettingsView: async (panelId, attachment, view) => {
        attaches++;
        if (attaches === 2) await held;
        const handle = await real.attachSettingsView(panelId, attachment, view);
        if (attaches === 1) view.detached();
        return handle;
      },
    };
    hooks.core = () => detaching;
    void settings.show({});
    await tick();
    expect(attaches).toBe(2);
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 1, message: { type: 'setBudgetLimit', budgetUsd: 5 } });
    release();
    await tick();
    expect(lines).toContain('[settings] dropped a settings message: the chat or engine it was attached to is gone');
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2, page: pageOf(first.panelId) } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setBudgetLimit', budgetUsd: 6 } });
    await tick();
    expect(harness.routed.map((r) => [r.message, r.panelId])).toEqual([[{ type: 'setBudgetLimit', budgetUsd: 6 }, first.panelId]]);
  });

  it('drops what the modal sends once its core ended, logs it, and attaches to the next core', async () => {
    const { harness, fake, settings, first, lines, hooks } = await setup();
    const deps = hooks;
    const real = deps.core()!;
    void settings.show({});
    await tick();
    deps.core = () => undefined;
    settings.coreEnded(real);
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 1, message: { type: 'setBudgetLimit', budgetUsd: 5 } });
    await tick();
    expect(harness.routed).toEqual([]);
    expect(lines).toContain('[settings] dropped a settings message: the chat or engine it was attached to is gone');

    deps.core = () => real;
    settings.selectionChanged();
    await tick();
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2, page: pageOf(first.panelId) } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setBudgetLimit', budgetUsd: 7 } });
    await tick();
    expect(harness.routed.map((r) => [r.message, r.panelId])).toEqual([[{ type: 'setBudgetLimit', budgetUsd: 7 }, first.panelId]]);
  });

  it("tells the modal each attachment's page, in the request and in every push", async () => {
    const { fake, settings, first, second, select } = await setup();
    void settings.show({});
    await tick();
    expect(fake.requests).toMatchObject([{ generation: 1, page: pageOf(first.panelId) }]);
    select(second.panelId);
    settings.selectionChanged();
    await tick();
    const pushes = () => fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAttached).map((entry) => entry.payload);
    expect(pushes()).toEqual([{ generation: 2, page: pageOf(second.panelId) }]);
  });

  it('re-attaches to the same chat on the next core after its core ended, with the same page', async () => {
    const { harness, fake, settings, first, hooks } = await setup();
    const ended = hooks.core()!;
    const next: SettingsViewHost = { ...ended };
    void settings.show({});
    await tick();
    hooks.core = () => next;
    settings.coreEnded(ended);
    await tick();
    expect(fake.requests).toMatchObject([{ generation: 1, page: pageOf(first.panelId) }]);
    expect(fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAttached).map((entry) => entry.payload)).toEqual([{ generation: 2, page: pageOf(first.panelId) }]);
    expect(harness.manager.attachedView(first.panelId)).toBeDefined();
  });

  it('refuses a request type outside SETTINGS_VIEW_REQUESTS, a malformed envelope and an oversized one', async () => {
    const { harness, fake, settings } = await setup();
    void settings.show({});
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

  it('rejects an unknown section, account or release before anything opens', async () => {
    const { fake, settings } = await setup();
    await expect(settings.show({ section: 'nope' as never })).rejects.toThrow(/Unknown settings section/);
    await expect(settings.show({ section: 'accounts', account: 'nope' as never })).rejects.toThrow(/Unknown settings account/);
    await expect(settings.show({ section: 'about', release: '3.4.0/../x' })).rejects.toThrow(/Unknown release/);
    expect(fake.requests).toEqual([]);
  });

  it('sends a section and account asked for while the modal shows to that modal, and opens no second one', async () => {
    const { fake, settings, first } = await setup();
    void settings.show({});
    await tick();
    await settings.show({ section: 'accounts', account: 'openai' });
    expect(fake.requests).toEqual([{ kind: 'settings', generation: 1, page: pageOf(first.panelId) }]);
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsTarget, payload: { section: 'accounts', account: 'openai' } });
  });

  it('carries the release to expand in What\'s new in the request and in a later target', async () => {
    const { fake, settings, first } = await setup();
    void settings.show({ section: 'about', release: '3.4.0' });
    await tick();
    expect(fake.requests).toEqual([{ kind: 'settings', section: 'about', release: '3.4.0', generation: 1, page: pageOf(first.panelId) }]);
    await settings.show({ section: 'about', release: '3.3.0' });
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsTarget, payload: { section: 'about', release: '3.3.0' } });
  });

  it('pushes the desktop settings to the open modal when one changes, and only while it shows', async () => {
    const { fake, settings, settingsPlatform } = await setup();
    const pushed = () => fake.sent.filter(({ channel }) => channel === OVERLAY_CHANNELS.prefsChanged).map(({ payload }) => payload as { values: Record<string, unknown> });
    await settingsPlatform.settings.update('damocles.desktop.theme', 'light', 'user');
    expect(pushed()).toEqual([]);

    void settings.show({});
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
    void settings.show({});
    await tick();
    const set = async (key: unknown, value: unknown): Promise<OverlayPrefWrite> => {
      const answer = (await fake.invoke(OVERLAY_CHANNELS.prefsSet, { key, value })) as PopupAnswer<OverlayPrefWrite>;
      if (!answer.ok) throw new Error('prefsSet answered closed');
      return answer.value;
    };
    for (const [key, value] of [
      ['damocles.desktop.language', 'de'],
      ['damocles.desktop.language', 1],
      ['damocles.desktop.restoreLayout', 'false'],
      ['damocles.maxBudgetUsd', 5],
      ['damocles.desktop.editor.fontSize', 101],
      ['damocles.desktop.editor.tabSize', 2.5],
      ['damocles.desktop.editor.wordWrap', 'bounded'],
      ['damocles.desktop.terminal.fontSize', 33],
      ['damocles.desktop.terminal.scrollback', -1],
      ['damocles.desktop.terminal.cursorStyle', 'beam'],
      ['damocles.desktop.terminal.defaultProfile', 1],
      ['damocles.desktop.terminal.lineHeight', 0.9],
      ['damocles.desktop.terminal.lineHeight', 2.01],
      ['damocles.desktop.terminal.lineHeight', Number.NaN],
      ['damocles.desktop.terminal.lineHeight', '1.2'],
      ['damocles.desktop.terminal.fontFamily', 'x'.repeat(1001)],
      ['damocles.desktop.terminal.cursorBlinking', 'true'],
      ['damocles.desktop.terminal.multiLinePasteWarning', 'sometimes'],
      ['damocles.desktop.terminal.confirmOnKill', 'ask'],
      ['damocles.desktop.terminal.shellIntegration.enabled', 'false'],
      ['damocles.desktop.files.exclude', { '**/x': 'yes' }],
      ['damocles.desktop.files.exclude', ['**/x']],
      // profiles are edited in the user settings file only, never through the renderer
      ['damocles.desktop.terminal.profiles', {}],
      ['damocles.desktop.terminal.profiles', { Evil: { path: 'C:\\evil.exe' } }],
      ['damocles.desktop.terminal.profiles', { 'Command Prompt': null }],
      ['__proto__', true],
      ['constructor', 'x'],
      [7, true],
    ] as const) {
      expect(await set(key, value), `${String(key)}=${String(value)}`).toMatchObject({ ok: false });
    }
    expect(await set('damocles.desktop.language', 'el')).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.notifications.enabled', false)).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.editor.fontSize', 15)).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.cursorStyle', 'bar')).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.lineHeight', 1.35)).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.fontFamily', 'Cascadia Code, monospace')).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.macOptionIsMeta', true)).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.multiLinePasteWarning', 'never')).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.confirmOnKill', 'always')).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.terminal.shellIntegration.enabled', false)).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.files.exclude', { '**/.git': false, '**/dist': true })).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.git.branchProtection', ['main', 'release/*'])).toEqual({ ok: true, file: USER_FILE });
    expect(await set('damocles.desktop.git.branchProtection', ['main', 7])).toMatchObject({ ok: false });
    expect(settingsPlatform.settings.inspect('damocles.desktop.language')).toStrictEqual({ userValue: 'el' });
    const prefs = (await fake.invoke(OVERLAY_CHANNELS.prefsGet)) as OverlayPrefs;
    expect(prefs.languageAtLaunch).toBe('el');
    expect(prefs.values[LANGUAGE_SETTING]).toBe('el');
    // every declared desktop setting but the terminal profiles, which reach no renderer
    expect(Object.keys(DESKTOP_CONFIGURATION)).toContain(TERMINAL_PROFILES_SETTING);
    expect(Object.keys(prefs.values).sort()).toEqual(Object.keys(DESKTOP_CONFIGURATION).filter((key) => key !== TERMINAL_PROFILES_SETTING).sort());
  });

  it('restarts, restores the default layout and writes desktop settings only while the modal is open, answering closed as a value otherwise', async () => {
    const { fake, settings, relaunch, resetLayout, settingsPlatform } = await setup();
    const closed = { ok: false, reason: 'closed' };
    await expect(fake.invoke(OVERLAY_CHANNELS.prefsSet, { key: 'damocles.desktop.language', value: 'el' })).resolves.toEqual(closed);
    await expect(fake.invoke(OVERLAY_CHANNELS.relaunch)).resolves.toEqual(closed);
    await expect(fake.invoke(OVERLAY_CHANNELS.layoutReset)).resolves.toEqual(closed);
    expect(settingsPlatform.settings.inspect('damocles.desktop.language')?.userValue).toBeUndefined();
    expect(relaunch).not.toHaveBeenCalled();
    expect(resetLayout).not.toHaveBeenCalled();
    void settings.show({});
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.relaunch)).resolves.toEqual({ ok: true, value: undefined });
    await expect(fake.invoke(OVERLAY_CHANNELS.layoutReset)).resolves.toEqual({ ok: true, value: undefined });
    expect(relaunch).toHaveBeenCalledOnce();
    expect(resetLayout).toHaveBeenCalledOnce();
  });

  it('lists the terminal profile report only while the modal is open, for an empty request only, and pushes it again only then', async () => {
    const { fake, settings } = await setup();
    await expect(fake.invoke(OVERLAY_CHANNELS.terminalProfiles, {})).resolves.toEqual({ ok: false, reason: 'closed' });
    settings.terminalProfilesChanged();
    expect(fake.sent.filter(({ channel }) => channel === OVERLAY_CHANNELS.terminalProfilesChanged)).toEqual([]);
    void settings.show({ section: 'terminal' });
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.terminalProfiles, {})).resolves.toEqual({ ok: true, value: { profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] } });
    await expect(fake.invoke(OVERLAY_CHANNELS.terminalProfiles, { path: 'C:\\' })).rejects.toThrow('Malformed terminal profiles request');
    settings.terminalProfilesChanged();
    expect(fake.sent.filter(({ channel }) => channel === OVERLAY_CHANNELS.terminalProfilesChanged)).toEqual([{ channel: OVERLAY_CHANNELS.terminalProfilesChanged, payload: { profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] } }]);
  });
});

describe('OverlaySettings scope tabs', () => {
  async function scoped() {
    h = createHarness([folderEntry(A)]);
    const harness = h;
    const local = await openPanel(harness);
    const remote = await openPanel(harness);
    const fake = fakeOverlay();
    const attached = new Map<number, { readonly panelId: string; readonly view: AttachedView }>();
    const hooks = {
      remoteUp: true,
      refuse: (_scope: string | undefined): boolean => false,
      // what an attach waits for before core answers it, as a remote core over the wire does
      hold: (_scope: string | undefined): Promise<void> | undefined => undefined,
      attaches: 0,
      allowYolo: [] as Array<{ authority: string; anchor: object }>,
      signIns: [] as string[],
      // the Connect dialog a sign-in opens, until it closes
      connectDialog: (): Promise<void> => Promise.resolve(),
      // the selected chat's host, and what finding its chat waits for
      host: { authority: 'loopback', name: 'Local daemon' } as SettingsScopes['host'],
      holdTarget: (): Promise<void> | undefined => undefined,
      // the selection moved to a local chat, which shows no tabs
      selectedLocal: false,
      // the tabs each target was asked for, and why the host's core is unavailable
      targets: [] as Array<string | undefined>,
      away: 'reconnecting' as Exclude<OverlaySettingsAway, 'switchOffered'> | OverlaySettingsAwayState,
      // the selected chat is gone from its core, which is up
      chatGone: false,
      // runs each time a lookup finds no remote chat, before main reads why
      noChat: (): void => undefined,
    };
    const host = (): SettingsViewHost => ({
      attachSettingsView: async (panelId, attachment, view, scope) => {
        hooks.attaches++;
        await hooks.hold(scope);
        if (hooks.refuse(scope)) throw new Error('No open chat panel');
        const scoped: AttachedView = scope === undefined ? view : { ...view, scope };
        attached.set(attachment, { panelId, view: scoped });
        return harness.manager.attachView(panelId, scoped);
      },
      dispatchSettingsView: async (attachment, message) => {
        const entry = attached.get(attachment);
        if (entry) await harness.manager.dispatchFromView(entry.panelId, entry.view, message);
      },
    });
    const localCore = host();
    const remoteCore = host();
    const settings = new OverlaySettings({
      overlay: fake.overlay,
      settings: createFakePlatform({ settings: { scopeFiles: { user: USER_FILE } } }).settings,
      target: async (scope) => {
        await hooks.holdTarget();
        hooks.targets.push(scope);
        if (hooks.selectedLocal) return { host: localCore, panelId: local.panelId, page: pageOf(local.panelId) };
        if (scope === 'user') return { host: localCore, panelId: local.panelId, scope, page: pageOf(local.panelId) };
        if (hooks.remoteUp && !hooks.chatGone) return { host: remoteCore, panelId: remote.panelId, scope: scope ?? 'machine', page: REMOTE_PAGE };
        hooks.noChat();
        return undefined;
      },
      scopes: () => (hooks.selectedLocal ? undefined : { host: hooks.host }),
      focused: () => undefined,
      relaunch: vi.fn(),
      resetLayout: vi.fn(),
      terminalProfiles: () => ({ profiles: [], hidden: [], problems: [] }),
      log: () => undefined,
      languageAtLaunch: 'en',
      knownHost: () => false,
      allowYolo: async (authority, anchor) => {
        hooks.allowYolo.push({ authority, anchor });
        return true;
      },
      signIn: async (authority) => {
        hooks.signIns.push(authority);
        await hooks.connectDialog();
      },
      hostAway: () => (hooks.remoteUp ? undefined : typeof hooks.away === 'string' ? { state: hooks.away } : hooks.away),
    });
    harness.routed.length = 0;
    const attachedEvents = () => fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAttached).map((entry) => entry.payload);
    const send = async (generation: number) => {
      harness.routed.length = 0;
      fake.fire(OVERLAY_CHANNELS.settingsSend, { generation, message: { type: 'setBudgetLimit', budgetUsd: generation } });
      await tick();
      return harness.routed.map((r) => r.panelId);
    };
    const awayPayloads = () => fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAway).map((entry) => entry.payload as OverlaySettingsAwayState | null);
    const awayEvents = () => awayPayloads().map((payload) => payload?.state ?? null);
    return { harness, fake, settings, local, remote, localCore, remoteCore, hooks, attachedEvents, awayEvents, awayPayloads, send };
  }

  // The modal shows a remote chat's Project tab when its host's core goes away.
  async function projectTabLost() {
    const scope = await scoped();
    const { fake, settings, remoteCore, hooks } = scope;
    void settings.show({});
    await tick();
    await fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    hooks.remoteUp = false;
    hooks.targets.length = 0;
    settings.coreEnded(remoteCore);
    await tick();
    return scope;
  }

  it("keeps the Project tab whose host's core ended, waiting for that core, and attaches no other tab meanwhile", async () => {
    const { settings, hooks, attachedEvents, awayEvents } = await projectTabLost();
    expect(awayEvents()).toEqual(['reconnecting']);
    // a re-attach the selection asks for meanwhile waits for the same core
    settings.selectionChanged();
    await tick();
    expect(hooks.targets).toEqual(['project', 'project']);
    expect(attachedEvents().map((event) => (event as { scopes: { active: string } }).scopes.active)).toEqual(['project']);
    expect(awayEvents()).toEqual(['reconnecting']);
  });

  it("re-attaches the waiting tab once its host's core is ready, and drops what the modal sent meanwhile for good", async () => {
    const { harness, fake, settings, remote, hooks, attachedEvents, awayEvents, send } = await projectTabLost();
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setBudgetLimit', budgetUsd: 2 } });
    await tick();
    expect(harness.routed).toEqual([]);
    hooks.remoteUp = true;
    settings.coreReady('ssh+other');
    await tick();
    expect(attachedEvents()).toHaveLength(1);
    settings.coreReady('loopback');
    await tick();
    expect(attachedEvents().at(-1)).toEqual({ generation: 3, page: REMOTE_PAGE, scopes: { host: { name: 'Local daemon' }, active: 'project' } });
    expect(awayEvents()).toEqual(['reconnecting', null]);
    expect(harness.routed).toEqual([]);
    expect(await send(3)).toEqual([remote.panelId]);
    expect(harness.routed.map((r) => r.view?.scope)).toEqual(['project']);
  });

  it('tells the waiting tab its host went offline, and reconnecting again, and attaches it once the core is back', async () => {
    const { settings, hooks, attachedEvents, awayEvents } = await projectTabLost();
    hooks.away = 'offline';
    settings.authorityChanged('ssh+other');
    settings.authorityChanged('loopback');
    settings.authorityChanged('loopback');
    expect(awayEvents()).toEqual(['reconnecting', 'offline']);
    hooks.away = 'reconnecting';
    settings.authorityChanged('loopback');
    hooks.remoteUp = true;
    settings.coreReady('loopback');
    await tick();
    expect(awayEvents()).toEqual(['reconnecting', 'offline', 'reconnecting', null]);
    expect(attachedEvents().at(-1)).toMatchObject({ generation: 3, scopes: { active: 'project' } });
  });

  it("opens the User tab from an offline host's banner, and stays on it once the host's core is back", async () => {
    const { fake, settings, local, hooks, attachedEvents, awayEvents, send } = await projectTabLost();
    hooks.away = 'offline';
    settings.authorityChanged('loopback');
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'user' })).resolves.toEqual({ ok: true, value: 'user' });
    expect(attachedEvents().at(-1)).toEqual({ generation: 3, page: pageOf(local.panelId), scopes: { host: { name: 'Local daemon' }, active: 'user' } });
    expect(awayEvents()).toEqual(['reconnecting', 'offline', null]);
    expect(await send(3)).toEqual([local.panelId]);
    hooks.remoteUp = true;
    settings.coreReady('loopback');
    await tick();
    expect(attachedEvents()).toHaveLength(2);
  });

  it('follows a selection change to another chat while a tab waits for its host', async () => {
    const { settings, local, hooks, attachedEvents, awayEvents, send } = await projectTabLost();
    hooks.selectedLocal = true;
    settings.selectionChanged();
    await tick();
    expect(attachedEvents().at(-1)).toEqual({ generation: 3, page: pageOf(local.panelId) });
    expect(awayEvents()).toEqual(['reconnecting', null]);
    expect(await send(3)).toEqual([local.panelId]);
  });

  it("tells a waiting tab its host's engine halted and is restarting, and attaches it once a change finds the core up", async () => {
    const { settings, hooks, attachedEvents, awayEvents } = await projectTabLost();
    hooks.away = 'halted';
    settings.authorityChanged('loopback');
    hooks.away = 'restarting';
    settings.authorityChanged('loopback');
    hooks.remoteUp = true;
    settings.authorityChanged('loopback');
    await tick();
    expect(awayEvents()).toEqual(['reconnecting', 'halted', 'restarting', null]);
    expect(attachedEvents().at(-1)).toMatchObject({ generation: 3, scopes: { active: 'project' } });
  });

  it("keeps a clicked tab whose host's core ended under its attach as the tab that waits, as the renderer shows it, and attaches it once the core is back", async () => {
    const { fake, settings, remote, remoteCore, hooks, attachedEvents, awayEvents, send } = await scoped();
    void settings.show({});
    await tick();
    const release = holdAttaches(hooks);
    hooks.refuse = () => !hooks.remoteUp;
    const click = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    await tick();
    expect(attachedEvents()).toEqual([{ generation: 2, page: REMOTE_PAGE, scopes: { host: { name: 'Local daemon' }, active: 'project' } }]);
    hooks.remoteUp = false;
    settings.coreEnded(remoteCore);
    release();
    // the renderer took Project from settingsAttached, and the click answers the tab main waits on
    await expect(click).resolves.toEqual({ ok: true, value: 'project' });
    await tick();
    expect(awayEvents()).toEqual(['reconnecting']);
    expect(attachedEvents()).toHaveLength(1);

    hooks.hold = () => undefined;
    hooks.remoteUp = true;
    settings.coreReady('loopback');
    await tick();
    expect(attachedEvents().at(-1)).toEqual({ generation: 3, page: REMOTE_PAGE, scopes: { host: { name: 'Local daemon' }, active: 'project' } });
    expect(awayEvents()).toEqual(['reconnecting', null]);
    expect(await send(3)).toEqual([remote.panelId]);
  });

  it("opens the User tab, waiting for nothing, when the chat of the tab shown closed on its host's core, which is up", async () => {
    const { fake, settings, local, remote, hooks, attachedEvents, awayEvents, send } = await scoped();
    void settings.show({});
    await tick();
    await fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    hooks.chatGone = true;
    remote.host.close();
    await tick();
    expect(attachedEvents().at(-1)).toEqual({ generation: 3, page: pageOf(local.panelId), scopes: { host: { name: 'Local daemon' }, active: 'user' } });
    expect(awayEvents()).toEqual([]);
    expect(await send(3)).toEqual([local.panelId]);
  });

  it("attaches the tab shown when its host's core came back while main looked for its chat, before anything waited for it", async () => {
    const { settings, remote, remoteCore, hooks, attachedEvents, awayEvents, send } = await scoped();
    void settings.show({});
    await tick();
    hooks.remoteUp = false;
    hooks.noChat = () => {
      hooks.noChat = () => undefined;
      hooks.remoteUp = true;
      settings.coreReady('loopback');
    };
    settings.coreEnded(remoteCore);
    await tick();
    expect(awayEvents()).toEqual([]);
    expect(attachedEvents().at(-1)).toEqual({ generation: 2, page: REMOTE_PAGE, scopes: { host: { name: 'Local daemon' }, active: 'machine' } });
    expect(await send(2)).toEqual([remote.panelId]);
  });

  it('reopens on the User tab when it closed while a tab waited for its host, which is still down', async () => {
    const { fake, settings, local, awayEvents, send } = await projectTabLost();
    fake.close();
    await tick();
    void settings.show({});
    await tick();
    expect(fake.requests.at(-1)).toMatchObject({ scopes: { active: 'user' } });
    expect(awayEvents()).toEqual(['reconnecting']);
    expect(await send((fake.requests.at(-1) as { generation: number }).generation)).toEqual([local.panelId]);
  });

  it('moves a waiting tab to the User tab for an Accounts target, which ends the wait', async () => {
    const { settings, local, attachedEvents, awayEvents, send } = await projectTabLost();
    await settings.show({ section: 'accounts' });
    expect(attachedEvents().at(-1)).toEqual({ generation: 3, page: pageOf(local.panelId), scopes: { host: { name: 'Local daemon' }, active: 'user' } });
    expect(awayEvents()).toEqual(['reconnecting', null]);
    expect(await send(3)).toEqual([local.panelId]);
  });

  it('refuses a tab whose core does not answer, keeping the tab and the attachment it had, and answers the tab a switch attached', async () => {
    const { fake, settings, local, remote, hooks, attachedEvents, send } = await scoped();
    void settings.show({});
    await tick();
    expect(fake.requests.at(-1)).toMatchObject({ generation: 1, scopes: { active: 'machine' } });
    hooks.remoteUp = false;
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' })).rejects.toThrow('could not be opened');
    expect(attachedEvents()).toEqual([]);
    expect(await send(1)).toEqual([remote.panelId]);

    await expect(fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'user' })).resolves.toEqual({ ok: true, value: 'user' });
    expect(attachedEvents()).toEqual([{ generation: 2, page: pageOf(local.panelId), scopes: { host: { name: 'Local daemon' }, active: 'user' } }]);
    expect(await send(2)).toEqual([local.panelId]);
  });

  it("moves an open modal to the host's tab for a host-tab target, whichever tab it showed", async () => {
    const { fake, settings, remote, attachedEvents, send } = await scoped();
    void settings.show({});
    await tick();
    await fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'user' });
    expect(attachedEvents().at(-1)).toMatchObject({ scopes: { active: 'user' } });
    await settings.show({ section: 'integrations' });
    expect(attachedEvents().at(-1)).toMatchObject({ scopes: { active: 'user' } });
    await settings.show({ section: 'integrations' }, 'machine');
    expect(attachedEvents().at(-1)).toMatchObject({ scopes: { active: 'machine' } });
    expect(await send(attachedEvents().length + 1)).toEqual([remote.panelId]);
  });

  it("asks to allow YOLO only from a remote chat's host or Project tab, for the attached chat's host, and refuses a malformed anchor", async () => {
    const { fake, settings, hooks } = await scoped();
    const anchor = { x: 900, y: 420, width: 36, height: 20 };
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor })).resolves.toEqual({ ok: false, reason: 'closed' });
    void settings.show({});
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor })).resolves.toEqual({ ok: true, value: true });
    await fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor })).resolves.toEqual({ ok: true, value: true });
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor: { x: -1, y: 0, width: 1, height: 1 } })).rejects.toThrow('Malformed');
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor, host: 'ssh+other' })).rejects.toThrow('Malformed');
    await fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'user' });
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor })).rejects.toThrow('No remote host tab');
    expect(hooks.allowYolo).toEqual([{ authority: 'loopback', anchor }, { authority: 'loopback', anchor }]);
  });

  it('refuses to ask while the modal re-attaches to a chat of another host, and asks for that host once it attached', async () => {
    const { fake, settings, hooks } = await scoped();
    const anchor = { x: 900, y: 420, width: 36, height: 20 };
    void settings.show({});
    await tick();
    let release!: () => void;
    hooks.holdTarget = () => new Promise<void>((resolve) => (release = resolve));
    hooks.host = { authority: 'ssh+h2', name: 'staging' };
    settings.selectionChanged();
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor })).rejects.toThrow('re-attaching');
    hooks.holdTarget = () => undefined;
    release();
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsAllowYolo, { anchor })).resolves.toEqual({ ok: true, value: true });
    expect(hooks.allowYolo).toEqual([{ authority: 'ssh+h2', anchor }]);
  });

  it('tells the page which host main may ask to allow YOLO on, in the request, each attach and a rename', async () => {
    const { fake, settings, hooks, attachedEvents } = await scoped();
    hooks.host = { authority: 'ssh+h1', name: 'prod', color: 'danger', canAllowYolo: true };
    void settings.show({});
    await tick();
    expect(fake.requests.at(-1)).toMatchObject({ scopes: { host: { name: 'prod', color: 'danger', canAllowYolo: true } } });
    await fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    expect(attachedEvents().at(-1)).toMatchObject({ scopes: { host: { name: 'prod', color: 'danger', canAllowYolo: true } } });
    hooks.host = { authority: 'ssh+h1', name: 'prod-1', canAllowYolo: true };
    settings.hostChanged('ssh+h1');
    expect(fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsScopeHost).map((entry) => entry.payload)).toEqual([{ name: 'prod-1', canAllowYolo: true }]);
  });

  it("opens on the User tab while the host's core is unavailable", async () => {
    const { fake, settings, local, hooks, send } = await scoped();
    hooks.remoteUp = false;
    void settings.show({ section: 'workspace' });
    await tick();
    expect(fake.requests.at(-1)).toMatchObject({ generation: 1, scopes: { active: 'user' } });
    expect(await send(1)).toEqual([local.panelId]);
  });

  it('opens Remote hosts, or a saved host named in the target, on the User tab, and refuses an unknown host', async () => {
    const { fake, settings } = await scoped();
    void settings.show({ section: 'remoteHosts' });
    await tick();
    expect(fake.requests.at(-1)).toMatchObject({ section: 'remoteHosts', scopes: { active: 'user' } });
    await expect(settings.show({ section: 'remoteHosts', host: 'nope' })).rejects.toThrow('Unknown host');
  });

  it('tells the open modal\'s host tab its new name and color once that host changed, and no other host\'s change', async () => {
    const { fake, settings } = await scoped();
    void settings.show({});
    await tick();
    settings.hostChanged('ssh+other');
    settings.hostChanged('loopback');
    expect(fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsScopeHost).map((entry) => entry.payload)).toEqual([{ name: 'Local daemon' }]);
  });

  it('attaches the previous tab again when core refuses the new one, once', async () => {
    const { fake, settings, remote, hooks, attachedEvents, send } = await scoped();
    void settings.show({});
    await tick();
    hooks.refuse = (scope) => scope === 'project';
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' })).rejects.toThrow('No open chat panel');
    await tick();
    expect(attachedEvents().map((event) => (event as { scopes: { active: string } }).scopes.active)).toEqual(['project', 'machine']);
    expect(await send(3)).toEqual([remote.panelId]);

    hooks.refuse = () => true;
    const before = hooks.attaches;
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'user' })).rejects.toThrow('No open chat panel');
    await tick();
    expect(hooks.attaches - before).toBe(2);
  });

  // The renderer takes a tab's generation from settingsAttached, which main sends before core answers the attach.
  function holdAttaches(hooks: { hold: (scope: string | undefined) => Promise<void> | undefined }): () => void {
    let release: () => void = () => undefined;
    hooks.hold = () => new Promise<void>((resolve) => { release = resolve; });
    return () => release();
  }
  const sendFor = (fake: ReturnType<typeof fakeOverlay>, generation: number, type: 'requestSettingsState' | 'setBudgetLimit'): void => {
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation, message: type === 'requestSettingsState' ? { type } : { type, budgetUsd: generation } });
  };

  it('runs what the modal sends for a tab core is still attaching on that tab once it is attached, back and forth, and none of it on the tab it left', async () => {
    const { harness, fake, settings, remote, hooks, attachedEvents } = await scoped();
    void settings.show({});
    await tick();
    const routed = () => harness.routed.map((r) => [r.message.type, (r.message as { budgetUsd?: number }).budgetUsd, r.panelId, r.view?.scope]);

    let release = holdAttaches(hooks);
    const toProject = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    await tick();
    expect(attachedEvents()).toEqual([{ generation: 2, page: REMOTE_PAGE, scopes: { host: { name: 'Local daemon' }, active: 'project' } }]);
    sendFor(fake, 2, 'requestSettingsState');
    sendFor(fake, 2, 'setBudgetLimit');
    await tick();
    expect(harness.routed).toEqual([]);
    release();
    await expect(toProject).resolves.toEqual({ ok: true, value: 'project' });
    await tick();
    expect(routed()).toEqual([['requestSettingsState', undefined, remote.panelId, 'project'], ['setBudgetLimit', 2, remote.panelId, 'project']]);

    harness.routed.length = 0;
    release = holdAttaches(hooks);
    const toHost = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'machine' });
    await tick();
    sendFor(fake, 3, 'requestSettingsState');
    sendFor(fake, 1, 'setBudgetLimit');
    await tick();
    expect(harness.routed).toEqual([]);
    release();
    await expect(toHost).resolves.toEqual({ ok: true, value: 'machine' });
    await tick();
    expect(routed()).toEqual([['requestSettingsState', undefined, remote.panelId, 'machine']]);
  });

  it('drops what the modal sent for a tab core refused, and runs what it sends for the tab attached again', async () => {
    const { harness, fake, settings, remote, hooks, attachedEvents } = await scoped();
    void settings.show({});
    await tick();
    const release = holdAttaches(hooks);
    hooks.refuse = (scope) => scope === 'project';
    const toProject = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' });
    await tick();
    sendFor(fake, 2, 'setBudgetLimit');
    hooks.hold = () => undefined;
    release();
    await expect(toProject).rejects.toThrow('No open chat panel');
    await tick();
    expect(attachedEvents().map((event) => (event as { generation: number }).generation)).toEqual([2, 3]);
    expect(harness.routed).toEqual([]);

    sendFor(fake, 2, 'setBudgetLimit');
    sendFor(fake, 3, 'requestSettingsState');
    await tick();
    expect(harness.routed.map((r) => [r.message.type, r.panelId, r.view?.scope])).toEqual([['requestSettingsState', remote.panelId, 'machine']]);
  });

  it('runs nothing the modal sent for a tab core was attaching when the modal closed', async () => {
    const { harness, fake, settings, remote, hooks } = await scoped();
    const shown = settings.show({});
    await tick();
    const release = holdAttaches(hooks);
    const toProject = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' }) as Promise<unknown>;
    await tick();
    sendFor(fake, 2, 'setBudgetLimit');
    fake.close();
    await shown;
    release();
    await expect(toProject).rejects.toThrow();
    await tick();
    expect(harness.routed).toEqual([]);
    expect(harness.manager.attachedView(remote.panelId)).toBeUndefined();
  });

  it("opens the User tab, lifting the banner, when the host's core is back but refuses the waiting tab and its retry too", async () => {
    const { settings, local, hooks, attachedEvents, awayEvents, send } = await projectTabLost();
    hooks.remoteUp = true;
    hooks.refuse = (scope) => scope === 'project';
    settings.coreReady('loopback');
    await vi.waitFor(() => expect(attachedEvents().at(-1)).toMatchObject({ scopes: { active: 'user' } }));
    expect(awayEvents()).toEqual(['reconnecting', null]);
    expect(attachedEvents().at(-1)).toMatchObject({ page: pageOf(local.panelId) });
    expect(await send((attachedEvents().at(-1) as { generation: number }).generation)).toEqual([local.panelId]);
  });

  it('ends the wait before it attaches a tab of another host, even one under the same name', async () => {
    const { fake, settings, hooks } = await projectTabLost();
    hooks.host = { authority: 'ssh+h2', name: 'Local daemon' };
    settings.selectionChanged();
    await tick();
    const order = fake.sent
      .filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAway || entry.channel === OVERLAY_CHANNELS.settingsAttached)
      .map((entry) => (entry.channel === OVERLAY_CHANNELS.settingsAway ? `away:${(entry.payload as OverlaySettingsAwayState | null)?.state ?? 'null'}` : 'attached'));
    expect(order).toEqual(['attached', 'away:reconnecting', 'away:null', 'attached']);
  });

  it("opens the sign-in of the waiting tab's host, only while that host waits for it, and never one the renderer names", async () => {
    const { fake, settings, hooks } = await projectTabLost();
    // a click that raced a change of the wait does nothing
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsSignIn, {})).resolves.toEqual({ ok: true, value: undefined });
    expect(hooks.signIns).toEqual([]);
    hooks.away = 'signIn';
    settings.authorityChanged('loopback');
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsSignIn, { host: 'ssh+other' })).rejects.toThrow('Malformed');
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsSignIn, {})).resolves.toEqual({ ok: true, value: undefined });
    expect(hooks.signIns).toEqual(['loopback']);
    fake.close();
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsSignIn, {})).resolves.toEqual({ ok: false, reason: 'closed' });
    expect(hooks.signIns).toEqual(['loopback']);
  });

  it('answers a sign-in only once the Connect dialog ended the modal, so the page holds Sign in until then', async () => {
    const { fake, settings, hooks } = await projectTabLost();
    hooks.away = 'signIn';
    settings.authorityChanged('loopback');
    hooks.connectDialog = () => new Promise<void>(() => undefined);
    let answer: unknown;
    void (fake.invoke(OVERLAY_CHANNELS.settingsSignIn, {}) as Promise<unknown>).then((value) => (answer = value));
    await tick();
    expect(hooks.signIns).toEqual(['loopback']);
    expect(answer).toBeUndefined();
    // the Connect dialog took the modal's place
    fake.close();
    await tick();
    expect(answer).toEqual({ ok: true, value: undefined });
  });

  it("tells a waiting tab why it waits only once main started the attempt that replaces its host's connection, never offline in between", async () => {
    const { settings, hooks, awayEvents } = await projectTabLost();
    settings.replacing('loopback', () => {
      // the connection ends as the user disconnecting it would, then the next attempt starts
      hooks.away = 'offline';
      settings.authorityChanged('loopback');
      hooks.away = 'reconnecting';
      settings.authorityChanged('loopback');
    });
    hooks.away = 'signIn';
    settings.authorityChanged('loopback');
    expect(awayEvents()).toEqual(['reconnecting', 'signIn']);
  });

  it('does nothing for a sign-in while the selection moved to a chat of another host', async () => {
    const { fake, settings, hooks } = await projectTabLost();
    hooks.away = 'signIn';
    settings.authorityChanged('loopback');
    let release!: () => void;
    hooks.holdTarget = () => new Promise<void>((resolve) => (release = resolve));
    hooks.host = { authority: 'ssh+h2', name: 'staging' };
    settings.selectionChanged();
    await tick();
    await expect(fake.invoke(OVERLAY_CHANNELS.settingsSignIn, {})).resolves.toEqual({ ok: true, value: undefined });
    expect(hooks.signIns).toEqual([]);
    hooks.holdTarget = () => undefined;
    release();
    await tick();
  });

  it("tells a waiting tab the update banner offers its host's switch, with the banner's count, and reconnecting once the user chose", async () => {
    const { settings, hooks, awayPayloads } = await projectTabLost();
    hooks.away = { state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 2 } };
    settings.authorityChanged('loopback');
    settings.authorityChanged('loopback');
    hooks.away = { state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 1 } };
    settings.authorityChanged('loopback');
    hooks.away = 'reconnecting';
    settings.authorityChanged('loopback');
    expect(awayPayloads()).toEqual([
      { state: 'reconnecting' },
      { state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 2 } },
      { state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 1 } },
      { state: 'reconnecting' },
    ]);
  });

  it('attaches the later of two tab clicks main has not answered yet, whichever it found first', async () => {
    const { fake, settings, remote, hooks, attachedEvents, send } = await scoped();
    void settings.show({});
    await tick();
    let release!: () => void;
    hooks.holdTarget = () => new Promise<void>((resolve) => (release = resolve));
    const toProject = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'project' }) as Promise<unknown>;
    await tick();
    hooks.holdTarget = () => undefined;
    const back = fake.invoke(OVERLAY_CHANNELS.settingsScope, { scope: 'machine' });
    release();
    await toProject.catch(() => undefined);
    await expect(back).resolves.toEqual({ ok: true, value: 'machine' });
    await tick();
    expect(attachedEvents().at(-1)).toMatchObject({ scopes: { active: 'machine' } });
    expect(await send((attachedEvents().at(-1) as { generation: number }).generation)).toEqual([remote.panelId]);
    expect(hooks.targets.at(-1)).toBe('machine');
  });

  it('stays attached when a core it is not attached to ends', async () => {
    const { settings, remote, localCore, remoteCore, attachedEvents, send } = await scoped();
    void settings.show({});
    await tick();
    settings.coreEnded(localCore);
    await tick();
    expect(attachedEvents()).toEqual([]);
    expect(await send(1)).toEqual([remote.panelId]);
    settings.coreEnded(remoteCore);
    expect(await send(1)).toEqual([]);
  });
});

describe('settingsPageChat', () => {
  const TOKEN = '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60';
  it("names a remote chat with no session by its page's token, so its host tab keeps the page when the chat reopens in a new view", () => {
    const before = settingsPageChat(undefined, { panelId: 'view-1', panelToken: TOKEN });
    expect(settingsPageChat(undefined, { panelId: 'view-2', panelToken: TOKEN })).toBe(before);
    expect(settingsPageChat(undefined, { panelId: 'view-2', panelToken: 'another-token' })).not.toBe(before);
  });

  it('names a chat by its session once it has one, and by its view before its page reported a token', () => {
    expect(settingsPageChat('session-1', { panelId: 'view-1', panelToken: TOKEN })).toBe('session-1');
    expect(settingsPageChat(undefined, { panelId: 'view-1', panelToken: undefined })).toBe('new:view-1');
  });
});

describe('hostAwayOf', () => {
  const facts = (given: Partial<HostCoreFacts>): HostCoreFacts => ({ connected: false, reconnect: undefined, state: 'offline', handedOff: false, update: undefined, halted: false, restarting: false, coreUp: false, reopened: false, ...given });
  const offer = { serverVersion: '3.7.0', runningAgents: 2, phase: 'offer' } as const;
  it.each([
    ['a host disconnected, removed or never connected', facts({}), 'offline'],
    ['an attempt under way', facts({ state: 'connecting' }), 'reconnecting'],
    ['a suspect connection', facts({ state: 'connecting', reconnect: 'suspect' }), 'reconnecting'],
    ['a loop waiting to retry', facts({ state: 'failed', reconnect: 'waiting' }), 'reconnecting'],
    ['a sign-in the loop waits for', facts({ state: 'failed', reconnect: 'signIn' }), 'signIn'],
    ['a permanent failure', facts({ state: 'failed', reconnect: 'failed' }), 'failed'],
    ['a failure no loop retries', facts({ state: 'failed' }), 'offline'],
    ['a daemon of another protocol the update flow stops as it runs nothing', facts({ state: 'failed', handedOff: true }), 'reconnecting'],
    ['a daemon of another protocol whose agents the flow waits for after Switch when they finish', facts({ state: 'failed', handedOff: true, update: { ...offer, phase: 'waiting' } }), 'reconnecting'],
    ['a daemon of another protocol whose update banner offers the switch', facts({ state: 'failed', handedOff: true, update: offer }), 'switchOffered'],
    ['a connection whose core is attaching, its chats not reopened on it yet', facts({ connected: true, state: 'connected' }), 'reconnecting'],
    ['a connection whose engine restarted, its chats reopened on it before', facts({ connected: true, state: 'connected', reopened: true }), 'restarting'],
    ['a connection whose engine restarts', facts({ connected: true, state: 'connected', restarting: true }), 'restarting'],
    ['a connection whose engine is halted', facts({ connected: true, state: 'connected', halted: true }), 'halted'],
    ['a connection whose halted engine the user restarts', facts({ connected: true, state: 'connected', halted: true, restarting: true }), 'restarting'],
    ['a connection whose core is up', facts({ connected: true, state: 'connected', coreUp: true }), undefined],
  ] as const)('reads %s as %s', (_case, given, expected) => {
    expect(hostAwayOf(given)?.state).toBe(expected);
  });

  it("carries the update banner's facts with the switch it offers", () => {
    expect(hostAwayOf(facts({ state: 'failed', handedOff: true, update: offer }))).toEqual({ state: 'switchOffered', update: { serverVersion: '3.7.0', runningAgents: 2 } });
  });
});

describe('hostCoreFacts', () => {
  const first = {} as RemoteConnection;
  const second = {} as RemoteConnection;
  // a RemoteCore whose last core state the first connection reported
  const core = (given: { halted?: boolean; restarting?: boolean; up?: boolean; phase?: 'running' | 'halted' | 'restarting' | 'starting'; reopenedOn?: RemoteConnection } = {}): NonNullable<HostCoreSources['core']> => ({
    host: { halted: () => given.halted === true, current: () => (given.up ? {} : undefined) },
    isRestarting: () => given.restarting === true,
    coreStateOn: (connection) => (connection === first && given.phase !== undefined ? { epoch: null, phase: given.phase, restarts: 0, pid: null, ppid: null } : undefined),
    reopenedOn: (connection) => connection === given.reopenedOn,
  });
  const sources = (given: Partial<HostCoreSources>): HostCoreSources => ({ connection: first, reconnect: undefined, state: 'connected', followed: undefined, core: core(), reopeningSelected: false, ...given });

  it("reads the core up only while the selected chat is not reopening with it", () => {
    expect(hostCoreFacts(sources({ core: core({ up: true }) })).coreUp).toBe(true);
    expect(hostCoreFacts(sources({ core: core({ up: true }), reopeningSelected: true })).coreUp).toBe(false);
    expect(hostCoreFacts(sources({ core: core({ up: false }) })).coreUp).toBe(false);
  });

  it("reads the engine's phase only as the current connection reported it", () => {
    expect(hostCoreFacts(sources({ core: core({ phase: 'halted' }) })).halted).toBe(true);
    expect(hostCoreFacts(sources({ connection: second, core: core({ phase: 'halted' }) })).halted).toBe(false);
    expect(hostCoreFacts(sources({ core: core({ phase: 'starting' }) })).restarting).toBe(true);
    expect(hostCoreFacts(sources({ connection: second, core: core({ phase: 'restarting' }) })).restarting).toBe(false);
    expect(hostCoreFacts(sources({ connection: second, core: core({ halted: true }) })).halted).toBe(true);
    expect(hostCoreFacts(sources({ connection: undefined, state: 'failed', core: core({ phase: 'halted' }) }))).toMatchObject({ connected: false, halted: false });
  });

  it("reads whether the current connection's chats reopened on it, and the update flow's banner", () => {
    expect(hostCoreFacts(sources({ core: core({ reopenedOn: first }) })).reopened).toBe(true);
    expect(hostCoreFacts(sources({ connection: second, core: core({ reopenedOn: first }) })).reopened).toBe(false);
    const update = { serverVersion: '3.7.0', runningAgents: 1, phase: 'offer' } as const;
    expect(hostCoreFacts(sources({ connection: undefined, followed: { update: () => update } }))).toMatchObject({ handedOff: true, update });
    expect(hostCoreFacts(sources({ connection: undefined, followed: { update: () => undefined } }))).toMatchObject({ handedOff: true, update: undefined });
  });
});

describe('lookupOnUpCore', () => {
  // a core main started; ready settles only once the test says so
  function hostedCore() {
    let ready!: () => void;
    let ended = false;
    let isReady = false;
    const core = {
      ready: new Promise<void>((resolve) => (ready = resolve)).then(() => { isReady = true; }),
      isReady: () => isReady && !ended,
      hasEnded: () => ended,
      dispose: async () => { ended = true; },
      end: () => { ended = true; },
      makeReady: () => ready(),
    };
    return core;
  }
  type Core = ReturnType<typeof hostedCore>;
  function coreHost() {
    const started: Core[] = [];
    const host = new CoreHost<Core>({
      start: () => {
        const core = hostedCore();
        started.push(core);
        return core;
      },
      openTabs: async () => undefined,
      retainTabStates: () => undefined,
      log: () => undefined,
      drainTimeoutMs: 100,
      haltedChanged: () => undefined,
    });
    return { host, started };
  }

  it('finds nothing at once while a restart replaces the core, where run would wait for the next core', async () => {
    const { host, started } = coreHost();
    host.start().makeReady();
    await host.ready();
    // the daemon restarted the engine: the core ended, and the restart starts the next one, which is not ready yet
    started[0]!.end();
    void host.restart(started[0]!);
    let ran = false;
    void host.run('Settings', () => { ran = true; });
    const lookup = vi.fn(async () => 'panel');
    await expect(lookupOnUpCore(host, lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    await tick();
    expect(ran).toBe(false);

    started[1]!.makeReady();
    await host.ready();
    await expect(lookupOnUpCore(host, lookup)).resolves.toBe('panel');
    expect(lookup).toHaveBeenCalledWith(started[1]);
    await host.dispose();
  });

  it('finds nothing when the core ended while it looked', async () => {
    const { host, started } = coreHost();
    host.start().makeReady();
    await host.ready();
    await expect(lookupOnUpCore(host, async (core) => {
      core.end();
      return 'panel';
    })).resolves.toBeUndefined();
    expect(started).toHaveLength(1);
    await host.dispose();
  });
});
