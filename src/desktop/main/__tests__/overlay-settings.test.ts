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
import { MAX_SETTINGS_MESSAGE_CHARS, OVERLAY_CHANNELS, type OverlayAnswer, type OverlayPrefs, type OverlayPrefWrite, type OverlayRequest, type PopupAnswer } from '../../preload/overlay-channels';
import { DESKTOP_CONFIGURATION, LANGUAGE_SETTING, TERMINAL_PROFILES_SETTING } from '../../local-services/desktop-configuration';
import { OverlaySettings, type SettingsViewHost } from '../overlay-settings';
import { WebviewPrompts } from '../../../core/chat-panel/webview-prompts';
import type { OverlayHost } from '../overlay';
import { fakeHandleWhileOpen } from './fake-popup-channels';

const A = path.join(path.resolve(os.tmpdir(), 'overlay-settings-root'), 'alpha');
const USER_FILE = '/home/me/.damocles/settings.json';
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
  const attached = new Map<number, string>();
  const lines: string[] = [];
  const real: SettingsViewHost = {
    attachSettingsView: async (panelId, attachment, view) => {
      attached.set(attachment, panelId);
      return harness.manager.attachView(panelId, view);
    },
    dispatchSettingsView: (attachment, message) => harness.manager.dispatchFromView(attached.get(attachment) ?? '', message),
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
      return panelId === undefined || host === undefined ? undefined : { host, panelId };
    },
    scopes: () => undefined,
    focused: () => undefined,
    relaunch,
    resetLayout,
    terminalProfiles: () => ({ profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] }) as const,
    log: (line) => lines.push(line),
    languageAtLaunch: 'el',
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
    void settings.show({});
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
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2 } });
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
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsAttached, payload: { generation: 2 } });
    fake.fire(OVERLAY_CHANNELS.settingsSend, { generation: 2, message: { type: 'setBudgetLimit', budgetUsd: 7 } });
    await tick();
    expect(harness.routed.map((r) => [r.message, r.panelId])).toEqual([[{ type: 'setBudgetLimit', budgetUsd: 7 }, first.panelId]]);
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
    const { fake, settings } = await setup();
    void settings.show({});
    await tick();
    await settings.show({ section: 'accounts', account: 'openai' });
    expect(fake.requests).toEqual([{ kind: 'settings', generation: 1 }]);
    expect(fake.sent).toContainEqual({ channel: OVERLAY_CHANNELS.settingsTarget, payload: { section: 'accounts', account: 'openai' } });
  });

  it('carries the release to expand in What\'s new in the request and in a later target', async () => {
    const { fake, settings } = await setup();
    void settings.show({ section: 'about', release: '3.4.0' });
    await tick();
    expect(fake.requests).toEqual([{ kind: 'settings', section: 'about', release: '3.4.0', generation: 1 }]);
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
    const attached = new Map<number, string>();
    const hooks = { remoteUp: true, refuse: (_scope: string | undefined): boolean => false, attaches: 0 };
    const host = (): SettingsViewHost => ({
      attachSettingsView: async (panelId, attachment, view, scope) => {
        hooks.attaches++;
        if (hooks.refuse(scope)) throw new Error('No open chat panel');
        attached.set(attachment, panelId);
        return harness.manager.attachView(panelId, view);
      },
      dispatchSettingsView: (attachment, message) => harness.manager.dispatchFromView(attached.get(attachment) ?? '', message),
    });
    const localCore = host();
    const remoteCore = host();
    const settings = new OverlaySettings({
      overlay: fake.overlay,
      settings: createFakePlatform({ settings: { scopeFiles: { user: USER_FILE } } }).settings,
      target: async (scope) => (scope === 'user'
        ? { host: localCore, panelId: local.panelId, scope }
        : hooks.remoteUp ? { host: remoteCore, panelId: remote.panelId, scope: scope ?? 'machine' } : undefined),
      scopes: () => ({ host: { authority: 'loopback', name: 'Local daemon' } }),
      focused: () => undefined,
      relaunch: vi.fn(),
      resetLayout: vi.fn(),
      terminalProfiles: () => ({ profiles: [], hidden: [], problems: [] }),
      log: () => undefined,
      languageAtLaunch: 'en',
    });
    harness.routed.length = 0;
    const attachedEvents = () => fake.sent.filter((entry) => entry.channel === OVERLAY_CHANNELS.settingsAttached).map((entry) => entry.payload);
    const send = async (generation: number) => {
      harness.routed.length = 0;
      fake.fire(OVERLAY_CHANNELS.settingsSend, { generation, message: { type: 'setBudgetLimit', budgetUsd: generation } });
      await tick();
      return harness.routed.map((r) => r.panelId);
    };
    return { harness, fake, settings, local, remote, localCore, remoteCore, hooks, attachedEvents, send };
  }

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
    expect(attachedEvents()).toEqual([{ generation: 2, scopes: { host: { name: 'Local daemon' }, active: 'user' } }]);
    expect(await send(2)).toEqual([local.panelId]);
  });

  it("opens on the User tab while the host's core is unavailable", async () => {
    const { fake, settings, local, hooks, send } = await scoped();
    hooks.remoteUp = false;
    void settings.show({ section: 'workspace' });
    await tick();
    expect(fake.requests.at(-1)).toMatchObject({ generation: 1, scopes: { active: 'user' } });
    expect(await send(1)).toEqual([local.panelId]);
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
