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
  const dismissed: string[] = [];
  let answer: ((value: OverlayAnswer) => void) | undefined;
  const overlay = {
    on: (channel: string, handler: (...args: unknown[]) => void) => { listeners.set(channel, handler); },
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
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
  const settings = new OverlaySettings({
    overlay: fake.overlay,
    settings: settingsPlatform.settings,
    panelManager: () => harness.manager,
    targetPanel: async () => target,
    focused: () => undefined,
    relaunch,
    resetLayout,
    terminalProfiles: () => ({ profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] }) as const,
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
    const { fake, settings } = await setup();
    let found!: () => void;
    const finding = new Promise<void>((resolve) => { found = resolve; });
    (settings as unknown as { deps: { targetPanel: () => Promise<string | undefined> } }).deps.targetPanel = async () => {
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
    const set = (key: unknown, value: unknown) => fake.invoke(OVERLAY_CHANNELS.prefsSet, { key, value }) as Promise<OverlayPrefWrite>;
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
    expect(settingsPlatform.settings.inspect('damocles.desktop.language')).toStrictEqual({ userValue: 'el' });
    const prefs = (await fake.invoke(OVERLAY_CHANNELS.prefsGet)) as OverlayPrefs;
    expect(prefs.languageAtLaunch).toBe('el');
    expect(Object.keys(prefs.values).sort()).toEqual([
      'damocles.desktop.editor.autoSave',
      'damocles.desktop.editor.detectIndentation',
      'damocles.desktop.editor.fontSize',
      'damocles.desktop.editor.formatOnSave',
      'damocles.desktop.editor.minimap',
      'damocles.desktop.editor.renderWhitespace',
      'damocles.desktop.editor.tabSize',
      'damocles.desktop.editor.wordWrap',
      'damocles.desktop.files.exclude',
      'damocles.desktop.language',
      'damocles.desktop.notifications.enabled',
      'damocles.desktop.notifications.sound',
      'damocles.desktop.reduceMotion',
      'damocles.desktop.restoreLayout',
      'damocles.desktop.search.actionsPosition',
      'damocles.desktop.search.collapseResults',
      'damocles.desktop.search.defaultViewMode',
      'damocles.desktop.search.exclude',
      'damocles.desktop.search.maxResults',
      'damocles.desktop.search.mode',
      'damocles.desktop.search.searchOnType',
      'damocles.desktop.search.searchOnTypeDebouncePeriod',
      'damocles.desktop.search.seedOnFocus',
      'damocles.desktop.search.seedWithNearestWord',
      'damocles.desktop.search.showLineNumbers',
      'damocles.desktop.search.smartCase',
      'damocles.desktop.search.sortOrder',
      'damocles.desktop.search.useReplacePreview',
      'damocles.desktop.searchEditor.defaultNumberOfContextLines',
      'damocles.desktop.searchEditor.doubleClickBehaviour',
      'damocles.desktop.searchEditor.focusResultsOnSearch',
      'damocles.desktop.searchEditor.reusePriorSearchConfiguration',
      'damocles.desktop.terminal.confirmOnKill',
      'damocles.desktop.terminal.cursorBlinking',
      'damocles.desktop.terminal.cursorStyle',
      'damocles.desktop.terminal.defaultProfile',
      'damocles.desktop.terminal.fontFamily',
      'damocles.desktop.terminal.fontSize',
      'damocles.desktop.terminal.lineHeight',
      'damocles.desktop.terminal.macOptionIsMeta',
      'damocles.desktop.terminal.multiLinePasteWarning',
      'damocles.desktop.terminal.scrollback',
      'damocles.desktop.terminal.shellIntegration.decorationsEnabled',
      'damocles.desktop.terminal.shellIntegration.enabled',
      'damocles.desktop.theme',
    ]);
  });

  it('restarts, restores the default layout and writes desktop settings only while the modal is open', async () => {
    const { fake, settings, relaunch, resetLayout } = await setup();
    expect(() => fake.invoke(OVERLAY_CHANNELS.prefsSet, { key: 'damocles.desktop.language', value: 'el' })).toThrow();
    expect(() => fake.invoke(OVERLAY_CHANNELS.relaunch)).toThrow();
    expect(() => fake.invoke(OVERLAY_CHANNELS.layoutReset)).toThrow();
    void settings.show({});
    await tick();
    fake.invoke(OVERLAY_CHANNELS.relaunch);
    fake.invoke(OVERLAY_CHANNELS.layoutReset);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(resetLayout).toHaveBeenCalledOnce();
  });

  it('lists the terminal profile report only while the modal is open, for an empty request only, and pushes it again only then', async () => {
    const { fake, settings } = await setup();
    expect(() => fake.invoke(OVERLAY_CHANNELS.terminalProfiles, {})).toThrow();
    settings.terminalProfilesChanged();
    expect(fake.sent.filter(({ channel }) => channel === OVERLAY_CHANNELS.terminalProfilesChanged)).toEqual([]);
    void settings.show({ section: 'terminal' });
    await tick();
    expect(fake.invoke(OVERLAY_CHANNELS.terminalProfiles, {})).toEqual({ profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] });
    expect(() => fake.invoke(OVERLAY_CHANNELS.terminalProfiles, { path: 'C:\\' })).toThrow();
    settings.terminalProfilesChanged();
    expect(fake.sent.filter(({ channel }) => channel === OVERLAY_CHANNELS.terminalProfilesChanged)).toEqual([{ channel: OVERLAY_CHANNELS.terminalProfilesChanged, payload: { profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }], hidden: ['Command Prompt'], problems: [{ name: 'Evil', reason: 'pathNotAllowed', detail: '\\\\server\\x.exe' }] } }]);
  });
});
