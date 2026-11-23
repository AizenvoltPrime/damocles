import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SettingsStore } from '../../../platform/settings-store';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ThemeToolDetails } from '../../../shared/themes/agent';
import { CLIENT_FEATURE_MISSING, CREDENTIAL_CLIENT_ABSENT } from '../../../shared/remote-user';
import { englishText } from '../../../shared/localized-text';
import { CORE_TO_MAIN } from '../../../desktop/core-protocol/messages';
import { INVALID } from '../../../desktop/core-protocol/schema';
import {
  CLIENT_THEMES_OFF, MAX_RELAYED_THEME_PNG_BYTES, MAX_THEME_UPLOAD_BYTES, RELAYED_DRAFT_TTL_MS, THEME_UPLOAD_CHUNK_BYTES, THEMES_FEATURE,
  type UserThemeCalls, type UserThemeMethod,
} from '../../../shared/themes/relay';
import { writeThemeArchive } from '../../themes/archive';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform } from '../../platform-host';
import { runPinnedTurn } from '../../client-snapshots';
import { createThemeService } from '../../themes';
import { PermissionHandler } from '../../permission-handler';
import { themeClosedReason, themeGroupUnavailable, themeOffReason, themeOutdatedReason, themeUnreachableReason, userScopeReach } from '../../user-scope';
import { getPiCodingAgent } from '../pi-loader';
import { buildThemeToolsOn, type ThemeHostPort } from '../tools/theme-tools';
import { createThemeRelayHost, relayedThemeBackend, type ThemeRelayHost } from '../tools/theme-relay';

// The theme tools of a chat on a remote host (docs/invariants.md "Remote daemon and wire", user.theme): the daemon's core keeps
// the flow and the cards, every store call goes to the device the turn is pinned to, and that device's core alone writes. Here
// the device's side is a real store behind createThemeRelayHost, reached the way main forwards each request.

const AUTHORITY = 'ssh+prod-1';
const COMPUTER = 'DESKTOP-7Q2';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const AMBER = { name: 'Amber Night', look: 'dark', colors: { accent: '#e0a030' } };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-relay-'));
});

afterEach(() => {
  installPlatform(createFakePlatform());
  fs.rmSync(root, { recursive: true, force: true });
});

function fileSettings(): SettingsStore {
  const file = path.join(root, 'settings.json');
  const read = (): Record<string, unknown> => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {});
  return {
    get: (key: string, fallback?: unknown) => read()[key] ?? fallback,
    inspect: () => ({}),
    update: async (key: string, value: unknown) => fs.writeFileSync(file, JSON.stringify({ ...read(), [key]: value })),
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: () => file,
  } as unknown as SettingsStore;
}

// the device's window arrangement, which only the device's main reads
const DEVICE_ARRANGEMENT = { sidebarWidth: 300, sectionOrder: ['projects', 'files', 'search', 'repos', 'scm', 'graph', 'chats'] } as const;

function fakeHost(): ThemeHostPort & { currentArrangement: ReturnType<typeof vi.fn>; applyArrangement: ReturnType<typeof vi.fn> } {
  return {
    currentArrangement: vi.fn(async () => DEVICE_ARRANGEMENT),
    applyArrangement: vi.fn(async () => undefined),
    render: vi.fn(async () => PNG),
    screenshotTake: vi.fn(async () => ({ shotId: '0123456789abcdef0123456789abcdef', url: 'app://damocles/theme-shot/0123456789abcdef0123456789abcdef', width: 1, height: 1 })),
    screenshotRead: vi.fn(async () => PNG),
    screenshotDrop: vi.fn(async () => undefined),
    applied: vi.fn(async () => 'kept' as const),
    showInWindow: vi.fn(async () => undefined),
    stopShowing: vi.fn(async () => undefined),
    state: vi.fn(async () => ({ kind: 'dark' as const, themeId: 'damocles', decidedBy: 'system' })),
    onShowEnded: () => ({ dispose: () => undefined }),
    onScreenshotGone: () => ({ dispose: () => undefined }),
  };
}

type Run = { content: Array<{ type: string; text?: string }>; details: ThemeToolDetails; isError?: boolean };
const text = (result: Run): string => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

/** This computer's side as main forwards to it: the host project, the computer's name, and its core's relay. */
function forward(relay: ThemeRelayHost, host: ThemeHostPort, pressedStages: Set<string>, method: UserThemeMethod, params: unknown, signal: AbortSignal): Promise<unknown> {
  const project = { key: `${AUTHORITY}|/srv/app`, name: 'app' };
  switch (method) {
    case 'read': return relay.read(AUTHORITY, (params as UserThemeCalls['read']['params']).request, project, signal);
    case 'uploadStart': return Promise.resolve(relay.uploadStart(AUTHORITY, params as UserThemeCalls['uploadStart']['params']));
    case 'uploadChunk': return Promise.resolve(relay.uploadChunk(AUTHORITY, params as UserThemeCalls['uploadChunk']['params']));
    case 'stage': {
      const { folder: _folder, ...request } = params as UserThemeCalls['stage']['params'];
      return relay.stage(AUTHORITY, request, project, signal).then((answer) => (answer.kind === 'change' ? { ...answer, computer: COMPUTER } : answer));
    }
    // main says pressed only for an Apply its own page posted on the card of that stage, once
    case 'commit': return relay.commit(AUTHORITY, (params as { stageId: string }).stageId, pressedStages.delete((params as { stageId: string }).stageId), signal);
    case 'discard': return relay.discard(AUTHORITY, (params as { stageId: string }).stageId, (params as { keepDraft?: boolean }).keepDraft);
    case 'preview': return relay.preview(AUTHORITY, params as UserThemeCalls['preview']['params']);
    case 'installPrepare':
      return relay.installPrepare(AUTHORITY, (params as UserThemeCalls['installPrepare']['params']).url, signal).then((answer) => ('preview' in answer ? { ...answer, computer: COMPUTER } : answer));
    case 'installCommit': return relay.installCommit(AUTHORITY, params as UserThemeCalls['installCommit']['params']);
    case 'installCancel': return relay.installCancel(AUTHORITY, (params as UserThemeCalls['installCancel']['params']).installId);
    // main serves the window's screenshots itself
    case 'screenshotTake': return host.screenshotTake(signal);
    case 'screenshot': return host.screenshotRead((params as UserThemeCalls['screenshot']['params']).shotId, signal).then((png) => ({ png }));
    case 'screenshotDrop': return host.screenshotDrop((params as UserThemeCalls['screenshotDrop']['params']).shotId);
    default: return Promise.reject(new Error(`no ${method} here`));
  }
}

function setup(clientSettings: Record<string, unknown> = {}, device: { readonly settings?: Record<string, unknown>; readonly downloads?: string } = {}) {
  if (device.settings) fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(device.settings));
  const settings = fileSettings();
  const themes = createThemeService({ root, settings, ...(device.downloads !== undefined ? { e2eThemeDownloads: device.downloads } : {}) });
  const host = fakeHost();
  const relay = createThemeRelayHost({ themes, host, settings, authority: 'local' });
  const fake = createFakeRemoteHost();
  const platform = { ...createFakePlatform({ settings: { user: clientSettings } }), remote: fake.remote };
  installPlatform(platform);
  fake.set('clientAuth', 'client-b', { providers: {} });
  fake.set('clientFeatures', 'client-a', [THEMES_FEATURE]);
  fake.set('clientFeatures', 'client-b', [THEMES_FEATURE]);
  const calls: { clientId: string; method: UserThemeMethod; params: unknown; signal?: AbortSignal }[] = [];
  // the Apply presses the device's main saw: a card names its stage only on the device the change lands on
  const pressedStages = new Set<string>();
  vi.mocked(fake.remote.themeCall).mockImplementation(((clientId: string, method: UserThemeMethod, params: unknown, signal?: AbortSignal) => {
    calls.push({ clientId, method, params, ...(signal ? { signal } : {}) });
    return forward(relay, host, pressedStages, method, params, signal ?? new AbortController().signal);
  }) as typeof fake.remote.themeCall);

  const handler = new PermissionHandler(platform, getPiCodingAgent);
  const posted: ExtensionToWebviewMessage[] = [];
  const byDevice: Record<string, ExtensionToWebviewMessage[]> = { 'client-a': [], 'client-b': [] };
  handler.setPostMessage((message) => posted.push(message));
  handler.setDevicePost((messageFor) => {
    for (const clientId of ['client-a', 'client-b']) {
      const message = messageFor(clientId);
      if (message) byDevice[clientId]!.push(message);
    }
  });
  const tools = new Map<string, ToolDefinition>(buildThemeToolsOn(relayedThemeBackend({ remote: fake.remote, folder: () => '/srv/app' }), {
    cards: handler,
    isPlanMode: () => false,
    chat: () => ({ id: 'remote-session-1', title: 'Make it warm' }),
    // the remote chat's own web search, which its gate judged the install URL by
    sourceReach: () => ({ webSearch: true, imageGeneration: 'off' }),
  }).map((tool) => [tool.name, tool]));
  const run = (tool: string, input: Record<string, unknown>, signal = new AbortController().signal): Promise<Run> =>
    runPinnedTurn(fake.remote, 'run-1', () => tools.get(tool)!.execute(`call-${Math.random()}`, input as never, signal, undefined, undefined as never)) as Promise<Run>;
  // the user's answer from a view of clientId's device
  const answer = (clientId: string, choice: 'apply' | 'discard'): void => {
    const request = [...byDevice[clientId]!].reverse().find((message) => message.type === 'requestThemeChange');
    if (request?.type !== 'requestThemeChange') throw new Error(`no card on ${clientId}`);
    if (choice === 'apply' && request.stageId !== undefined) pressedStages.add(request.stageId);
    fake.setActor(clientId);
    handler.resolveThemeChange(request.promptId, choice, undefined);
    fake.setActor(undefined);
  };
  return { themes, relay, host, fake, calls, handler, byDevice, posted, run, answer };
}

const cardOn = async (byDevice: Record<string, ExtensionToWebviewMessage[]>, clientId: string): Promise<Extract<ExtensionToWebviewMessage, { type: 'requestThemeChange' }>> => {
  await vi.waitFor(() => expect(byDevice[clientId]!.some((message) => message.type === 'requestThemeChange')).toBe(true));
  return byDevice[clientId]!.find((message) => message.type === 'requestThemeChange') as Extract<ExtensionToWebviewMessage, { type: 'requestThemeChange' }>;
};

describe('the theme tools of a chat on a remote host', () => {
  it('stage on the pinned device, raise the card here, and apply there: the device owns the draft and writes the theme', async () => {
    const { themes, calls, byDevice, run, answer } = setup();
    const result = run('ThemeSet', AMBER);
    const card = await cardOn(byDevice, 'client-a');
    expect(card.theme?.name).toBe('Amber Night');
    expect(card.otherDevice).toBeUndefined();
    expect(card.stageId).toEqual(expect.any(String));
    expect((await themes.list()).some((entry) => entry.status === 'ok' && entry.name === 'Amber Night')).toBe(false);
    answer('client-a', 'apply');
    const done = await result;
    expect(done.details.outcome).toBe('applied');
    expect(calls.map(({ clientId, method }) => `${clientId} ${method}`)).toEqual(['client-a stage', 'client-a commit']);
    expect(calls[0]!.params).toMatchObject({ tool: 'set', folder: '/srv/app', chat: { id: 'remote-session-1', title: 'Make it warm' }, planMode: false });
    expect((await themes.list()).some((entry) => entry.status === 'ok' && entry.name === 'Amber Night')).toBe(true);
    const history = await themes.history();
    expect(history.at(-1)?.actor).toEqual({ kind: 'agent', chatId: 'remote-session-1', title: 'Make it warm' });
  });

  it('on another attached device the card names the computer, carries no image, and only Discard there answers it', async () => {
    const { themes, calls, byDevice, run, answer } = setup();
    const result = run('ThemeSet', AMBER);
    const other = await cardOn(byDevice, 'client-b');
    expect(other.otherDevice).toEqual({ computer: COMPUTER });
    expect(other.stageId).toBeUndefined();
    expect(other.theme).toBeUndefined();
    expect(other.canShowInWindow).toBe(false);
    expect(other.changes).toEqual((await cardOn(byDevice, 'client-a')).changes);

    answer('client-b', 'apply');
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.map(({ method }) => method)).toEqual(['stage']);
    answer('client-b', 'discard');
    const done = await result;
    expect(done.details.outcome).toBe('discarded');
    expect(calls.map(({ method }) => method)).toEqual(['stage', 'discard']);
    expect(await themes.history()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'drafts')) ? fs.readdirSync(path.join(root, 'drafts')) : []).toEqual([]);
  });

  it("layout current takes the device's window arrangement on the device, and the pick there puts it in place; this core reads none", async () => {
    const { themes, host, calls, byDevice, run, answer } = setup();
    const result = run('ThemeSet', { ...AMBER, layout: 'current' });
    await cardOn(byDevice, 'client-a');
    // the input crosses as the model wrote it: the device, not this core, resolves what current means
    expect(calls[0]!.params).toMatchObject({ input: { layout: 'current' } });
    answer('client-a', 'apply');
    expect((await result).details.outcome).toBe('applied');
    const theme = (await themes.list()).find((entry) => entry.status === 'ok' && entry.name === 'Amber Night');
    expect(theme?.status === 'ok' && theme.theme.layout).toEqual(DEVICE_ARRANGEMENT);
    expect(host.applyArrangement).toHaveBeenCalledWith(DEVICE_ARRANGEMENT, 1);
    expect(await themes.undo()).toMatchObject({ arrangement: DEVICE_ARRANGEMENT });
  });

  describe('install', () => {
    const URL_INPUT = { install: { url: 'https://e2e.test/aurora.damocles-theme' } };
    const downloads = async (): Promise<string> => {
      const folder = path.join(root, 'e2e');
      fs.mkdirSync(folder, { recursive: true });
      const theme = { schemaVersion: 1, id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Aurora Borealis', looks: { dark: { colors: { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' } } } };
      fs.writeFileSync(path.join(folder, 'aurora.damocles-theme'), await writeThemeArchive(JSON.stringify(theme), new Map()));
      return folder;
    };
    type InstallRequest = Extract<ExtensionToWebviewMessage, { type: 'requestThemeInstall' }>;
    const installCardOn = async (byDevice: Record<string, ExtensionToWebviewMessage[]>, clientId: string): Promise<InstallRequest> => {
      await vi.waitFor(() => expect(byDevice[clientId]!.some((message) => message.type === 'requestThemeInstall')).toBe(true));
      return byDevice[clientId]!.find((message) => message.type === 'requestThemeInstall') as InstallRequest;
    };

    it('ends the card as expired when the device that staged the install says it dropped it, and only that device', async () => {
      const { fake, calls, posted, byDevice, run } = setup({}, { settings: { 'damocles.pi.webSearch.enabled': true }, downloads: await downloads() });
      const running = run('ThemeSet', URL_INPUT);
      const { installId } = (await installCardOn(byDevice, 'client-a')).preview;
      fake.themeInstallExpired({ clientId: 'client-b', installId });
      expect(posted.some((message) => message.type === 'themeInstallClosed')).toBe(false);
      fake.themeInstallExpired({ clientId: 'client-a', installId });
      const result = await running;
      expect(result.details.outcome).toBe('installExpired');
      expect(posted.some((message) => message.type === 'themeInstallClosed')).toBe(true);
      // the device already dropped it, so nothing is cancelled there
      expect(calls.map(({ method }) => method)).toEqual(['installPrepare']);
    });

    it('prepares and commits on the pinned device, which downloads the link; another device\'s card names the computer and only its Cancel counts', async () => {
      const { themes, fake, calls, handler, byDevice, run } = setup({}, { settings: { 'damocles.pi.webSearch.enabled': true }, downloads: await downloads() });
      const result = run('ThemeSet', URL_INPUT);
      const mine = await installCardOn(byDevice, 'client-a');
      const theirs = await installCardOn(byDevice, 'client-b');
      expect(calls.map(({ clientId, method }) => `${clientId} ${method}`)).toEqual(['client-a installPrepare']);
      expect(calls[0]!.params).toEqual({ url: 'https://e2e.test/aurora.damocles-theme' });
      expect(mine.otherDevice).toBeUndefined();
      expect(mine.preview.source).toEqual({ kind: 'agent', host: 'e2e.test', fileName: 'aurora.damocles-theme' });
      expect(theirs.otherDevice).toEqual({ computer: COMPUTER });
      fake.setActor('client-b');
      handler.resolveThemeInstall(theirs.promptId, { choice: 'install', useArrangement: false });
      fake.setActor(undefined);
      expect(handler.pendingPrompts().map((prompt) => prompt.kind)).toEqual(['themeInstall']);
      fake.setActor('client-a');
      handler.resolveThemeInstall(mine.promptId, { choice: 'install', useArrangement: false });
      fake.setActor(undefined);
      const done = await result;
      expect(done.details).toMatchObject({ outcome: 'installed', themeName: 'Aurora Borealis' });
      expect(calls.map(({ method }) => method)).toEqual(['installPrepare', 'installCommit']);
      expect(calls[1]!.params).toMatchObject({ installId: mine.preview.installId, useArrangement: false, chat: { id: 'remote-session-1', title: 'Make it warm' } });
      expect((await themes.history()).map((entry) => entry.actor)).toEqual([{ kind: 'agent', chatId: 'remote-session-1', title: 'Make it warm' }]);
    });

    it("downloads nothing while this computer's web search is off, and its Cancel ends the staged install there", async () => {
      const off = setup({}, { settings: { 'damocles.pi.webSearch.enabled': false }, downloads: await downloads() });
      const refused = await off.run('ThemeSet', URL_INPUT);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('only while its web search is on');
      expect(off.byDevice['client-a']!.some((message) => message.type === 'requestThemeInstall')).toBe(false);

      const on = setup({}, { settings: { 'damocles.pi.webSearch.enabled': true }, downloads: await downloads() });
      const result = on.run('ThemeSet', URL_INPUT);
      const card = await installCardOn(on.byDevice, 'client-b');
      on.fake.setActor('client-b');
      on.handler.resolveThemeInstall(card.promptId, { choice: 'cancel' });
      on.fake.setActor(undefined);
      expect((await result).details.outcome).toBe('installCancelled');
      expect(on.calls.map(({ method }) => method)).toEqual(['installPrepare', 'installCancel']);
      // the install is gone on the device, so a late commit of it is refused
      expect(await on.relay.installCommit(AUTHORITY, { installId: card.preview.installId, useArrangement: false, chat: { id: 'remote-session-1' } })).toMatchObject({ refused: expect.anything() });
    });

    it('commits, cancels and allows flashing (a press main sends from that authority\'s chat page) only for the authority that staged the install', async () => {
      const { relay } = setup({}, { settings: { 'damocles.pi.webSearch.enabled': true }, downloads: await downloads() });
      const prepared = await relay.installPrepare(AUTHORITY, 'https://e2e.test/aurora.damocles-theme', new AbortController().signal);
      if (!('preview' in prepared)) throw new Error('refused');
      const { installId } = prepared.preview;
      expect(await relay.allowFlash('ssh+other', installId, 'a'.repeat(64))).toEqual({ allowed: false });
      expect(await relay.installCommit('ssh+other', { installId, useArrangement: false, chat: { id: 's' } })).toMatchObject({ refused: expect.anything() });
      await relay.installCancel('ssh+other', installId);
      expect(await relay.installCommit(AUTHORITY, { installId, useArrangement: false, chat: { id: 's' } })).toMatchObject({ installed: expect.objectContaining({ name: 'Aurora Borealis' }) });
    });
  });

  it("leave the card's Show in window off and say why when the device's window refuses the proposal", async () => {
    const { host, handler, byDevice, fake, run, answer } = setup();
    vi.mocked(host.showInWindow).mockResolvedValueOnce('safeStart');
    const result = run('ThemeSet', AMBER);
    const card = await cardOn(byDevice, 'client-a');
    fake.setActor('client-a');
    handler.setThemeShowInWindow(card.promptId, true);
    fake.setActor(undefined);
    await vi.waitFor(() => expect(byDevice['client-a']).toContainEqual({ type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: false, showNote: 'safeStart' }));
    answer('client-a', 'discard');
    expect((await result).details.outcome).toBe('discarded');
  });

  it("turn the card's Show in window off with the note when the device's window ends it, and only for that device's card", async () => {
    const { fake, calls, handler, byDevice, posted, run, answer } = setup();
    const result = run('ThemeSet', AMBER);
    const card = await cardOn(byDevice, 'client-a');
    fake.setActor('client-a');
    handler.setThemeShowInWindow(card.promptId, true);
    fake.setActor(undefined);
    await vi.waitFor(() => expect(byDevice['client-a']).toContainEqual({ type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: true }));
    const { stageId } = calls.find(({ method }) => method === 'preview')!.params as UserThemeCalls['preview']['params'];
    const turnedOff = (): ExtensionToWebviewMessage[] => byDevice['client-a']!.filter((message) => message.type === 'themeChangeUpdated' && message.showInWindow === false);

    // another device, and a card the stage does not show, end nothing
    fake.themeShowEnded({ clientId: 'client-b', stageId, promptId: card.promptId, reason: 'takenOver' });
    fake.themeShowEnded({ clientId: 'client-a', stageId, promptId: 'another-card', reason: 'takenOver' });
    expect(turnedOff()).toEqual([]);

    fake.themeShowEnded({ clientId: 'client-a', stageId, promptId: card.promptId, reason: 'takenOver' });
    expect(turnedOff()).toEqual([{ type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: false, showNote: 'takenOver' }]);
    // another device's card has no Show in window to change
    expect([...byDevice['client-b']!, ...posted].filter((message) => message.type === 'themeChangeUpdated')).toEqual([]);
    answer('client-a', 'discard');
    expect((await result).details.outcome).toBe('discarded');
    // the window no longer shows it, so closing the card asks the device to stop nothing
    expect(calls.filter(({ method }) => method === 'preview').map(({ params }) => (params as UserThemeCalls['preview']['params']).on)).toEqual([true]);
  });

  it("send ThemeRead's empty theme id as none, so the wire takes the request and the device answers as it answers its own chats", async () => {
    const { calls, run } = setup();
    const result = await run('ThemeRead', { about: 'theme', theme: '' });
    const sent = calls.find(({ method }) => method === 'read')!;
    expect(sent.params).toEqual({ request: { about: 'theme' }, folder: '/srv/app' });
    expect(CORE_TO_MAIN.requests['user.theme.read'].params({ clientId: sent.clientId, ...(sent.params as object) })).not.toBe(INVALID);
    expect(text(result)).toBe('about: theme needs theme, the id of an installed theme.');
  });

  it('refuse with the reason when the device has the tools off, predates the relay, or is not attached', async () => {
    const off = setup();
    vi.mocked(off.fake.remote.themeCall).mockRejectedValueOnce(new Error(CLIENT_THEMES_OFF));
    const refusedOff = await off.run('ThemeRead', {});
    expect(refusedOff.isError).toBe(true);
    expect(text(refusedOff)).toBe(englishText(themeOffReason()));

    vi.mocked(off.fake.remote.themeCall).mockRejectedValueOnce(new Error(CLIENT_FEATURE_MISSING));
    expect(text(await off.run('ThemeSet', AMBER))).toBe(englishText(themeOutdatedReason()));

    vi.mocked(off.fake.remote.themeCall).mockRejectedValueOnce(new Error(CREDENTIAL_CLIENT_ABSENT));
    expect(text(await off.run('ThemeSchedule', { enabled: false }))).toBe(englishText(themeClosedReason()));

    off.calls.length = 0;
    off.fake.set('clientAuth', 'client-a', undefined);
    const away = await off.run('ThemeRead', {});
    expect(text(away)).toBe(englishText(themeClosedReason()));
    expect(off.calls).toEqual([]);
  });

  it('reach the group only while the pinned device is attached, lists themes and has the group on, each else with its reason', () => {
    const { fake } = setup();
    const reach = (): boolean => runPinnedTurn(fake.remote, 'run-1', () => userScopeReach().theme);
    const reason = (): string => runPinnedTurn(fake.remote, 'run-1', () => englishText(themeUnreachableReason()));
    // the Tools panel's reason for the group follows the same state
    const panel = (): string | undefined => runPinnedTurn(fake.remote, 'run-1', () => themeGroupUnavailable());
    expect(reach()).toBe(true);
    expect(panel()).toBeUndefined();
    fake.set('clientFeatures', 'client-a', []);
    expect(reach()).toBe(false);
    expect(reason()).toBe(englishText(themeOutdatedReason()));
    expect(panel()).toBe('themeAppOutdated');
    fake.set('clientFeatures', 'client-a', [THEMES_FEATURE]);
    fake.set('clientAuth', 'client-a', undefined);
    expect(reach()).toBe(false);
    expect(reason()).toBe(englishText(themeClosedReason()));
    expect(panel()).toBe('themeAppClosed');

    const groupOff = setup({ 'damocles.desktop.themes.agentTools': false });
    expect(runPinnedTurn(groupOff.fake.remote, 'run-1', () => userScopeReach().theme)).toBe(false);
    expect(runPinnedTurn(groupOff.fake.remote, 'run-1', () => englishText(themeUnreachableReason()))).toBe(englishText(themeOffReason()));
    // switched off is the group's own switch, which stays usable
    expect(runPinnedTurn(groupOff.fake.remote, 'run-1', () => themeGroupUnavailable())).toBeUndefined();
  });

  it('upload a 40 MB asset in 4 MiB chunks, one at a time, and the device holds it once its SHA-256 matched', async () => {
    const { fake, calls } = setup();
    const bytes = new Uint8Array(MAX_THEME_UPLOAD_BYTES).map((_, i) => (i * 31) & 0xff);
    let inFlight = 0;
    let most = 0;
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    vi.mocked(fake.remote.themeCall).mockImplementation((async (...args: Parameters<typeof forwardTo>) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        return await forwardTo(...args);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fake.remote.themeCall);
    const backend = relayedThemeBackend({ remote: fake.remote, folder: () => '/srv/app' });
    const held = await runPinnedTurn(fake.remote, 'run-1', () => backend.upload({ bytes, name: '/home/dev/art/ichigo.webm' }, 'remote-session-1', new AbortController().signal));
    expect(held).toEqual({ upload: expect.any(String) });
    const chunks = calls.filter(({ method }) => method === 'uploadChunk').map(({ params }) => (params as UserThemeCalls['uploadChunk']['params']));
    expect(chunks).toHaveLength(Math.ceil(MAX_THEME_UPLOAD_BYTES / THEME_UPLOAD_CHUNK_BYTES));
    expect(chunks.every((chunk) => chunk.data.byteLength <= THEME_UPLOAD_CHUNK_BYTES)).toBe(true);
    expect(chunks.map((chunk) => chunk.offset)).toEqual(chunks.map((_, index) => index * THEME_UPLOAD_CHUNK_BYTES));
    expect(most).toBe(1);
    // only the file's name crosses, never the host's folders
    expect(calls[0]!.params).toMatchObject({ bytes: MAX_THEME_UPLOAD_BYTES, name: 'ichigo.webm' });
  });

  it('fail an upload whose chunk was corrupted on the way, by its SHA-256, and hold nothing for the stage', async () => {
    const { fake, relay } = setup();
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    let uploadId = '';
    vi.mocked(fake.remote.themeCall).mockImplementation((async (clientId: string, method: UserThemeMethod, params: unknown, signal?: AbortSignal) => {
      if (method === 'uploadStart') {
        const started = await forwardTo(clientId, method, params as never, signal) as { uploadId: string };
        uploadId = started.uploadId;
        return started;
      }
      if (method !== 'uploadChunk') return forwardTo(clientId, method, params as never, signal);
      const chunk = params as UserThemeCalls['uploadChunk']['params'];
      const data = new Uint8Array(chunk.data);
      if (chunk.offset === THEME_UPLOAD_CHUNK_BYTES) data[7] = data[7]! ^ 0xff;
      return forwardTo(clientId, method, { ...chunk, data } as never, signal);
    }) as typeof fake.remote.themeCall);
    const backend = relayedThemeBackend({ remote: fake.remote, folder: () => '/srv/app' });
    const bytes = new Uint8Array(THEME_UPLOAD_CHUNK_BYTES * 2 + 5).fill(7);
    const held = await runPinnedTurn(fake.remote, 'run-1', () => backend.upload({ bytes }, 'remote-session-1', new AbortController().signal));
    expect(held).toEqual({ error: expect.stringContaining('SHA-256') });

    const staged = await relay.stage(AUTHORITY, { tool: 'set', input: { ...AMBER, asset: { name: 'beach', from: { file: 'beach.png' } }, paletteFromWallpaper: 'beach' }, toolCallId: 'c', chat: { id: 'remote-session-1' }, planMode: false, upload: uploadId }, undefined, new AbortController().signal);
    expect(staged).toMatchObject({ kind: 'done', isError: true, content: [{ type: 'text', text: expect.stringContaining('The image did not arrive') }] });
  });
});

describe("this computer's side of the relay", () => {
  it('refuses chunks out of order and an input the tool schema does not hold', async () => {
    const { relay } = setup();
    const { uploadId } = relay.uploadStart(AUTHORITY, { sessionId: 's', sha256: '0'.repeat(64), bytes: 10 });
    expect(() => relay.uploadChunk(AUTHORITY, { uploadId, offset: 5, data: new Uint8Array(5) })).toThrow(/in order/);
    expect(() => relay.uploadChunk(AUTHORITY, { uploadId, offset: 0, data: new Uint8Array(5) })).toThrow(/not open/);
    expect(() => relay.uploadChunk('ssh+other', { uploadId, offset: 0, data: new Uint8Array(5) })).toThrow(/not open/);
    const refused = await relay.stage(AUTHORITY, { tool: 'set', input: { colors: { accent: 'orange' } }, toolCallId: 'c', chat: { id: 's' }, planMode: false }, undefined, new AbortController().signal);
    expect(refused).toMatchObject({ kind: 'done', isError: true });
  });

  const DRAFT_THEME = { schemaVersion: 1, name: 'Old', looks: { dark: { colors: { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' } } } } as const;
  const draftOf = (themes: ReturnType<typeof setup>['themes'], authority: string, createdAt: number, sessionId = 's') =>
    ({ id: themes.drafts.newId(), owner: { authority, sessionId, toolCallId: 'c' }, createdAt, baseThemeId: null, baseHash: null, theme: { ...DRAFT_THEME, id: themes.drafts.newId() } });

  it('expires a relayed draft 24 hours after its last change, whenever it was first made, and keeps its own chats\' drafts', async () => {
    const { themes, relay } = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      // first made long ago, each written now: the write is the last change
      const old = draftOf(themes, AUTHORITY, start - RELAYED_DRAFT_TTL_MS * 2);
      const continued = draftOf(themes, AUTHORITY, start - RELAYED_DRAFT_TTL_MS * 2);
      const own = draftOf(themes, 'local', start - RELAYED_DRAFT_TTL_MS * 2);
      for (const each of [old, continued, own]) await themes.drafts.put(each);
      expect(await relay.expireDrafts()).toBe(0);
      vi.setSystemTime(start + RELAYED_DRAFT_TTL_MS - 60 * 60 * 1000);
      await themes.drafts.put(continued);
      vi.setSystemTime(start + RELAYED_DRAFT_TTL_MS + 1);
      expect(await relay.expireDrafts()).toBe(1);
      expect(await themes.drafts.get(old.id)).toBeUndefined();
      expect(await themes.drafts.get(continued.id)).toBeDefined();
      expect(await themes.drafts.get(own.id)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never expires a relayed draft while a stage still names it', async () => {
    const { themes, relay } = setup();
    const staged = await relay.stage(AUTHORITY, { tool: 'set', input: AMBER, toolCallId: 'c', chat: { id: 's' }, planMode: false }, undefined, new AbortController().signal);
    if (staged.kind !== 'change') throw new Error('not staged');
    const draftId = staged.details.draftId!;
    expect(await relay.expireDrafts(Date.now() + RELAYED_DRAFT_TTL_MS * 2)).toBe(0);
    expect(await themes.drafts.get(draftId)).toBeDefined();
    await relay.discard(AUTHORITY, staged.stageId);
    expect(await themes.drafts.get(draftId)).toBeUndefined();
  });

  it('refuses an oversize asset, an empty chunk and a chunk past the declared size', () => {
    const { relay } = setup();
    expect(() => relay.uploadStart(AUTHORITY, { sessionId: 's', sha256: '0'.repeat(64), bytes: MAX_THEME_UPLOAD_BYTES + 1 })).toThrow(/at most 40 MB/);
    const empty = relay.uploadStart(AUTHORITY, { sessionId: 's', sha256: '0'.repeat(64), bytes: 10 });
    expect(() => relay.uploadChunk(AUTHORITY, { uploadId: empty.uploadId, offset: 0, data: new Uint8Array(0) })).toThrow(/in order/);
    const overrun = relay.uploadStart(AUTHORITY, { sessionId: 's', sha256: '0'.repeat(64), bytes: 10 });
    expect(relay.uploadChunk(AUTHORITY, { uploadId: overrun.uploadId, offset: 0, data: new Uint8Array(6) })).toEqual({ received: 6, complete: false });
    expect(() => relay.uploadChunk(AUTHORITY, { uploadId: overrun.uploadId, offset: 6, data: new Uint8Array(5) })).toThrow(/in order/);
    expect(() => relay.uploadChunk(AUTHORITY, { uploadId: overrun.uploadId, offset: 6, data: new Uint8Array(4) })).toThrow(/not open/);
  });

  it("holds two uploads being received per host, never dropping another host's, and one per chat", () => {
    const { relay } = setup();
    const start = (authority: string, sessionId: string): string => relay.uploadStart(authority, { sessionId, sha256: '0'.repeat(64), bytes: 10 }).uploadId;
    const chunk = (authority: string, uploadId: string) => relay.uploadChunk(authority, { uploadId, offset: 0, data: new Uint8Array(5) });
    const other = start('ssh+other', 's1');
    const first = start(AUTHORITY, 's1');
    const second = start(AUTHORITY, 's2');
    const third = start(AUTHORITY, 's3');
    expect(() => chunk(AUTHORITY, first)).toThrow('This upload is not open: it ended, it waited too long for its next chunk, or a newer upload of this host replaced it');
    expect(chunk(AUTHORITY, second)).toEqual({ received: 5, complete: false });
    expect(chunk(AUTHORITY, third)).toEqual({ received: 5, complete: false });
    expect(chunk('ssh+other', other)).toEqual({ received: 5, complete: false });
    // a chat's new upload replaces the one it was sending
    const again = start(AUTHORITY, 's3');
    expect(() => relay.uploadChunk(AUTHORITY, { uploadId: third, offset: 5, data: new Uint8Array(5) })).toThrow(/not open/);
    expect(chunk(AUTHORITY, again)).toEqual({ received: 5, complete: false });
  });

  it('drops an upload that waits five minutes for its next chunk, and one held that long with no stage naming it', async () => {
    vi.useFakeTimers();
    try {
      const { relay } = setup();
      const { uploadId } = relay.uploadStart(AUTHORITY, { sessionId: 's', sha256: '0'.repeat(64), bytes: 10 });
      vi.advanceTimersByTime(4 * 60_000);
      expect(relay.uploadChunk(AUTHORITY, { uploadId, offset: 0, data: new Uint8Array(5) })).toEqual({ received: 5, complete: false });
      vi.advanceTimersByTime(4 * 60_000);
      expect(relay.uploadChunk(AUTHORITY, { uploadId, offset: 5, data: new Uint8Array(1) })).toEqual({ received: 6, complete: false });
      vi.advanceTimersByTime(5 * 60_000);
      expect(() => relay.uploadChunk(AUTHORITY, { uploadId, offset: 6, data: new Uint8Array(4) })).toThrow(/not open/);

      const bytes = new Uint8Array([1, 2, 3]);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const held = relay.uploadStart(AUTHORITY, { sessionId: 's', sha256, bytes: 3, name: 'beach.png' });
      expect(relay.uploadChunk(AUTHORITY, { uploadId: held.uploadId, offset: 0, data: bytes })).toEqual({ received: 3, complete: true });
      vi.advanceTimersByTime(5 * 60_000);
      vi.useRealTimers();
      const staged = await relay.stage(AUTHORITY, { tool: 'set', input: { ...AMBER, asset: { name: 'beach', from: { file: 'beach.png' } }, paletteFromWallpaper: 'beach' }, toolCallId: 'c', chat: { id: 's' }, planMode: false, upload: held.uploadId }, undefined, new AbortController().signal);
      expect(staged).toMatchObject({ kind: 'done', isError: true, content: [{ type: 'text', text: expect.stringContaining('The image did not arrive') }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds its own answers: an image above 16 MiB leaves as a sentence, and a staged summary goes without it', async () => {
    const { relay, host } = setup();
    vi.mocked(host.render).mockResolvedValue(new Uint8Array(MAX_RELAYED_THEME_PNG_BYTES + 1));
    const read = await relay.read(AUTHORITY, { about: 'current', preview: true }, undefined, new AbortController().signal);
    expect(read.content.at(-1)).toEqual({ type: 'text', text: 'The image was too large to send.' });
    expect(read.content.some((part) => part.type === 'image')).toBe(false);
    const staged = await relay.stage(AUTHORITY, { tool: 'set', input: AMBER, toolCallId: 'c', chat: { id: 's' }, planMode: false }, undefined, new AbortController().signal);
    if (staged.kind !== 'change') throw new Error('not staged');
    expect(staged.summary.png).toBeUndefined();
    expect(staged.summary.text).toContain('Amber Night');
  });

  it('never names why a preview was not drawn, which could hold a path of this computer', async () => {
    const { relay, host } = setup();
    vi.mocked(host.render).mockRejectedValue(new Error("EACCES: permission denied, open 'C:\\Users\\me\\.damocles\\themes\\x'"));
    const read = await relay.read(AUTHORITY, { about: 'current', preview: true }, undefined, new AbortController().signal);
    expect(read.content.at(-1)).toEqual({ type: 'text', text: 'No preview image: the preview could not be drawn.' });
  });

  describe('Apply', () => {
    const signal = new AbortController().signal;
    const NOT_PRESSED = { refused: 'Not applied: nobody pressed Apply for this change on the computer that shows this chat.' };
    const APPLY_MODE = 'damocles.desktop.themes.applyMode';
    const stageOn = async (relay: ThemeRelayHost, planMode = false) => {
      const staged = await relay.stage(AUTHORITY, { tool: 'set', input: AMBER, toolCallId: 'c', chat: { id: 's' }, planMode }, undefined, signal);
      if (staged.kind !== 'change') throw new Error('not staged');
      return staged;
    };
    const applied = async (themes: ReturnType<typeof setup>['themes']): Promise<boolean> => (await themes.list()).some((entry) => entry.status === 'ok' && entry.name === 'Amber Night');

    it("commits a stage that raised a card only when main says its Apply was pressed, whatever the request's plan mode was", async () => {
      const { relay, themes } = setup();
      const staged = await stageOn(relay);
      expect(staged.onTheFly).toBe(false);
      expect(await relay.commit(AUTHORITY, staged.stageId, false, signal)).toEqual(NOT_PRESSED);
      expect(await applied(themes)).toBe(false);
      // the refusal ended nothing: the card is still open and its Apply still commits
      expect(await relay.commit(AUTHORITY, staged.stageId, true, signal)).toEqual({ outcome: 'applied' });
      expect(await applied(themes)).toBe(true);
    });

    it('commits an on-the-fly stage with no press, its keep-changes banner being the consent, and decides on-the-fly from its own setting alone', async () => {
      const { relay, themes, host } = setup({}, { settings: { [APPLY_MODE]: 'onTheFly' } });
      const staged = await stageOn(relay);
      expect(staged.onTheFly).toBe(true);
      expect(await relay.commit(AUTHORITY, staged.stageId, false, signal)).toEqual({ outcome: 'kept' });
      expect(host.applied).toHaveBeenCalledTimes(1);
      expect(await applied(themes)).toBe(true);
      // plan mode on the remote chat only narrows: the stage raises a card, and then needs its press
      const planned = await stageOn(relay, true);
      expect(planned.onTheFly).toBe(false);
      expect(await relay.commit(AUTHORITY, planned.stageId, false, signal)).toEqual(NOT_PRESSED);
    });

    it('refuses an on-the-fly stage with no press once this computer was switched to cards', async () => {
      const { relay, themes } = setup({}, { settings: { [APPLY_MODE]: 'onTheFly' } });
      const staged = await stageOn(relay);
      fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ [APPLY_MODE]: 'preview' }));
      expect(await relay.commit(AUTHORITY, staged.stageId, false, signal)).toEqual(NOT_PRESSED);
      expect(await applied(themes)).toBe(false);
    });
  });

  describe('installs and Forget host', () => {
    const URL = 'https://e2e.test/aurora.damocles-theme';
    const downloads = async (): Promise<string> => {
      const folder = path.join(root, 'e2e');
      fs.mkdirSync(folder, { recursive: true });
      const theme = { ...DRAFT_THEME, id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Aurora Borealis' };
      fs.writeFileSync(path.join(folder, 'aurora.damocles-theme'), await writeThemeArchive(JSON.stringify(theme), new Map()));
      return folder;
    };
    const WEB_ON = { 'damocles.pi.webSearch.enabled': true };
    const signal = new AbortController().signal;

    it('keeps at most two installs open per host, leaves room for this computer, and counts only those its core still stages', async () => {
      const { relay, themes } = setup({}, { settings: WEB_ON, downloads: await downloads() });
      const first = await relay.installPrepare(AUTHORITY, URL, signal);
      const second = await relay.installPrepare(AUTHORITY, URL, signal);
      if (!('preview' in first) || !('preview' in second)) throw new Error('refused');
      const third = await relay.installPrepare(AUTHORITY, URL, signal);
      expect('refused' in third && englishText(third.refused)).toBe('2 theme installs are already open. Install or cancel one first.');
      expect(await relay.installPrepare('ssh+other', URL, signal)).toMatchObject({ preview: expect.anything() });
      expect(await themes.installPrepare({ kind: 'url', url: URL }, { agent: true })).toMatchObject({ installId: expect.any(String) });
      // gone from core without the relay hearing of it, as an expired one is
      await themes.installCancel(first.preview.installId);
      expect(await relay.installPrepare(AUTHORITY, URL, signal)).toMatchObject({ preview: expect.anything() });
    });

    it("Forget host removes the host's drafts, stages, uploads and staged installs, and no other host's", async () => {
      const { relay, themes } = setup({}, { settings: WEB_ON, downloads: await downloads() });
      const stage = (authority: string) => relay.stage(authority, { tool: 'set', input: AMBER, toolCallId: 'c', chat: { id: 's' }, planMode: false }, undefined, signal);
      const mine = await stage(AUTHORITY);
      const theirs = await stage('ssh+other');
      if (mine.kind !== 'change' || theirs.kind !== 'change') throw new Error('not staged');
      const loose = draftOf(themes, AUTHORITY, Date.now(), 'another-chat');
      await themes.drafts.put(loose);
      const own = draftOf(themes, 'local', Date.now());
      await themes.drafts.put(own);
      const { uploadId } = relay.uploadStart(AUTHORITY, { sessionId: 's', sha256: '0'.repeat(64), bytes: 10 });
      const prepared = await relay.installPrepare(AUTHORITY, URL, signal);
      if (!('preview' in prepared)) throw new Error('refused');

      await relay.forgetAuthority(AUTHORITY);
      expect(await themes.drafts.get(mine.details.draftId!)).toBeUndefined();
      expect(await themes.drafts.get(loose.id)).toBeUndefined();
      expect(await themes.drafts.get(theirs.details.draftId!)).toBeDefined();
      expect(await themes.drafts.get(own.id)).toBeDefined();
      expect(await relay.commit(AUTHORITY, mine.stageId, true, signal)).toEqual({ refused: 'This proposal is no longer open; propose it again.' });
      expect(() => relay.uploadChunk(AUTHORITY, { uploadId, offset: 0, data: new Uint8Array(5) })).toThrow(/not open/);
      expect(themes.installOpen(prepared.preview.installId)).toBe(false);
      expect(await relay.commit('ssh+other', theirs.stageId, true, signal)).toEqual({ outcome: 'applied' });
    });

    it('keeps only the hosts main still knows: a host forgotten while the engine was down loses its relayed state too', async () => {
      const { relay, themes } = setup();
      const kept = draftOf(themes, AUTHORITY, Date.now());
      const gone = draftOf(themes, 'ssh+gone', Date.now());
      const own = draftOf(themes, 'local', Date.now());
      for (const each of [kept, gone, own]) await themes.drafts.put(each);
      await relay.keepAuthorities(new Set([AUTHORITY]));
      expect(await themes.drafts.get(gone.id)).toBeUndefined();
      expect(await themes.drafts.get(kept.id)).toBeDefined();
      expect(await themes.drafts.get(own.id)).toBeDefined();
    });
  });
});

describe("the daemon's core's calls to the device", () => {
  const signal = new AbortController().signal;
  const STAGE = { tool: 'set' as const, input: AMBER, toolCallId: 'c', chat: { id: 'remote-session-1' }, planMode: false };

  it('answers a card with the device that staged it, and commits there, whatever the pin is by then', async () => {
    const { fake, calls } = setup();
    const backend = relayedThemeBackend({ remote: fake.remote, folder: () => '/srv/app' });
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    vi.mocked(fake.remote.themeCall).mockImplementation((async (...args: Parameters<typeof forwardTo>) => {
      const answer = await forwardTo(...args);
      if (args[1] === 'stage') fake.setActing('client-b');
      return answer;
    }) as typeof fake.remote.themeCall);
    const staged = await backend.stage(STAGE, signal);
    if (staged.kind !== 'change') throw new Error('not staged');
    expect(backend.device?.(staged.stageId)).toBe('client-a');
    expect(backend.device?.('an-unknown-id')).toBeUndefined();
    await backend.commit(staged.stageId, signal);
    expect(calls.map(({ clientId, method }) => `${clientId} ${method}`)).toEqual(['client-a stage', 'client-a commit']);
  });

  it('honours an end of Show in window that arrives before the answer to turning it on', async () => {
    const { fake, handler, byDevice, posted, run, answer, calls } = setup();
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    vi.mocked(fake.remote.themeCall).mockImplementation((async (...args: Parameters<typeof forwardTo>) => {
      const [clientId, method, params] = args;
      const preview = params as UserThemeCalls['preview']['params'];
      // one ordered connection: the device's end is delivered before its answer
      if (method === 'preview' && preview.on) fake.themeShowEnded({ clientId, stageId: preview.stageId, promptId: preview.promptId, reason: 'takenOver' });
      return forwardTo(...args);
    }) as typeof fake.remote.themeCall);
    const result = run('ThemeSet', AMBER);
    const card = await cardOn(byDevice, 'client-a');
    fake.setActor('client-a');
    handler.setThemeShowInWindow(card.promptId, true);
    fake.setActor(undefined);
    await vi.waitFor(() => expect(byDevice['client-a']).toContainEqual({ type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: false, showNote: 'takenOver' }));
    await vi.waitFor(() => expect(calls.some(({ method }) => method === 'preview')).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    expect([...byDevice['client-a']!, ...posted]).not.toContainEqual({ type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: true });
    answer('client-a', 'discard');
    expect((await result).details.outcome).toBe('discarded');
  });

  it("gives Show in window's start the tool's signal, and each cleanup call a deadline of its own, so a device that never answers holds no turn", async () => {
    const { fake, handler, byDevice, run, answer, calls } = setup();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
      vi.mocked(fake.remote.themeCall).mockImplementation(((...args: Parameters<typeof forwardTo>) => {
        const [, method, , callSignal] = args;
        if (method !== 'discard') return forwardTo(...args);
        calls.push({ clientId: args[0], method, params: args[2], ...(callSignal ? { signal: callSignal } : {}) });
        return new Promise((_resolve, reject) => callSignal?.addEventListener('abort', () => reject(new Error('The device did not answer'))));
      }) as typeof fake.remote.themeCall);
      const turn = new AbortController();
      const result = run('ThemeSet', AMBER, turn.signal);
      const card = await cardOn(byDevice, 'client-a');
      fake.setActor('client-a');
      handler.setThemeShowInWindow(card.promptId, true);
      fake.setActor(undefined);
      await vi.waitFor(() => expect(byDevice['client-a']).toContainEqual({ type: 'themeChangeUpdated', promptId: card.promptId, showInWindow: true }));
      expect(calls.find(({ method }) => method === 'preview')!.signal).toBe(turn.signal);
      answer('client-a', 'discard');
      await vi.waitFor(() => expect(calls.some(({ method }) => method === 'discard')).toBe(true));
      const off = calls.filter(({ method }) => method === 'preview').at(-1)!;
      expect(off.params).toMatchObject({ on: false });
      expect(off.signal).toBe(deadline.signal);
      expect(calls.find(({ method }) => method === 'discard')!.signal).toBe(deadline.signal);
      deadline.abort();
      expect((await result).details.outcome).toBe('discarded');
    } finally {
      timeout.mockRestore();
    }
  });

  it('sends one upload of a chat at a time, and an aborted one stops sending', async () => {
    const { fake, calls } = setup();
    const backend = relayedThemeBackend({ remote: fake.remote, folder: () => '/srv/app' });
    const bytes = new Uint8Array(THEME_UPLOAD_CHUNK_BYTES + 5).fill(3);
    const order: string[] = [];
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    const stop = new AbortController();
    vi.mocked(fake.remote.themeCall).mockImplementation((async (...args: Parameters<typeof forwardTo>) => {
      const [, method, params, callSignal] = args;
      if (callSignal?.aborted) throw new Error('aborted');
      if (method === 'uploadStart') order.push(`start ${(params as { name?: string }).name}`);
      const answer = await forwardTo(...args);
      if (method === 'uploadChunk' && (answer as { complete: boolean }).complete) order.push('complete');
      if (method === 'uploadStart' && (params as { name?: string }).name === 'c.png') stop.abort();
      return answer;
    }) as typeof fake.remote.themeCall);
    const [a, b] = await Promise.all([
      backend.upload({ bytes, name: 'a.png' }, 'remote-session-1', signal),
      backend.upload({ bytes, name: 'b.png' }, 'remote-session-1', signal),
    ]);
    expect(a).toEqual({ upload: expect.any(String) });
    expect(b).toEqual({ upload: expect.any(String) });
    expect(order).toEqual(['start a.png', 'complete', 'start b.png', 'complete']);
    calls.length = 0;
    await expect(backend.upload({ bytes, name: 'c.png' }, 'remote-session-1', stop.signal)).rejects.toThrow('aborted');
    expect(calls.map(({ method }) => method)).toEqual(['uploadStart']);
  });

  it("shows ThemeRead's screenshot card only on the device whose window it is, reads the shot there after Allow and drops it", async () => {
    const { fake, handler, host, calls, byDevice, run } = setup();
    const result = run('ThemeRead', { screenshot: true });
    await vi.waitFor(() => expect(byDevice['client-a']!.some((message) => message.type === 'requestThemeScreenshot')).toBe(true));
    expect(byDevice['client-b']!.some((message) => message.type === 'requestThemeScreenshot')).toBe(false);
    const card = byDevice['client-a']!.find((message) => message.type === 'requestThemeScreenshot') as Extract<ExtensionToWebviewMessage, { type: 'requestThemeScreenshot' }>;
    fake.setActor('client-b');
    handler.resolveThemeScreenshot(card.promptId, 'allow');
    fake.setActor('client-a');
    expect(calls.some(({ method }) => method === 'screenshot')).toBe(false);
    handler.resolveThemeScreenshot(card.promptId, 'allow');
    fake.setActor(undefined);
    const done = await result;
    expect(done.details).toMatchObject({ screenshot: 'sent' });
    expect(calls.map(({ clientId, method }) => `${clientId} ${method}`)).toEqual(['client-a read', 'client-a screenshotTake', 'client-a screenshot', 'client-a screenshotDrop']);
    expect(host.screenshotDrop).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef');
  });
});

describe("a remote chat's screenshot card whose screenshot its device let go of", () => {
  it('closes on the word of the device that took the screenshot, never on another device\'s', async () => {
    const { fake, byDevice, posted, run } = setup();
    const result = run('ThemeRead', { screenshot: true });
    await vi.waitFor(() => expect(byDevice['client-a']!.some((message) => message.type === 'requestThemeScreenshot')).toBe(true));
    const shotId = '0123456789abcdef0123456789abcdef';
    fake.themeScreenshotGone({ clientId: 'client-b', shotId });
    fake.themeScreenshotGone({ clientId: 'client-a', shotId: 'f'.repeat(32) });
    expect(posted.some((message) => message.type === 'themeScreenshotClosed')).toBe(false);
    fake.themeScreenshotGone({ clientId: 'client-a', shotId });
    const done = await result;
    expect(done.content.some((part) => part.type === 'text' && part.text?.includes('the window let go of it'))).toBe(true);
    expect(posted.some((message) => message.type === 'themeScreenshotClosed')).toBe(true);
  });
});

describe('a turn of a remote chat that stops, and a card that ends with Change', () => {
  const ON_THE_FLY = { settings: { 'damocles.desktop.themes.applyMode': 'onTheFly' } };
  const STOPPED = 'The turn stopped before the change was applied. Nothing was changed.';
  const applied = async (themes: ReturnType<typeof setup>['themes']): Promise<boolean> => (await themes.list()).some((entry) => entry.status === 'ok' && entry.name === 'Amber Night');
  const draftFiles = (): string[] => (fs.existsSync(path.join(root, 'drafts')) ? fs.readdirSync(path.join(root, 'drafts')) : []);

  it('sends no commit for an on-the-fly change once the turn stopped while it was staged, and discards the stage', async () => {
    const { fake, calls, run, themes } = setup({}, ON_THE_FLY);
    const stop = new AbortController();
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    vi.mocked(fake.remote.themeCall).mockImplementation((async (...args: Parameters<typeof forwardTo>) => {
      const answer = await forwardTo(...args);
      if (args[1] === 'stage') stop.abort();
      return answer;
    }) as typeof fake.remote.themeCall);
    const result = await run('ThemeSet', AMBER, stop.signal);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(STOPPED);
    expect(calls.map(({ method }) => method)).toEqual(['stage', 'discard']);
    expect(await applied(themes)).toBe(false);
    expect(draftFiles()).toEqual([]);
  });

  it("refuses a relayed commit whose signal already aborted, on this computer's core", async () => {
    const { relay, themes } = setup({}, ON_THE_FLY);
    const staged = await relay.stage(AUTHORITY, { tool: 'set', input: AMBER, toolCallId: 'c', chat: { id: 's' }, planMode: false }, undefined, new AbortController().signal);
    if (staged.kind !== 'change') throw new Error('not staged');
    const stopped = new AbortController();
    stopped.abort();
    expect(await relay.commit(AUTHORITY, staged.stageId, false, stopped.signal)).toEqual({ refused: STOPPED });
    expect(await applied(themes)).toBe(false);
    await relay.discard(AUTHORITY, staged.stageId);
    expect(draftFiles()).toEqual([]);
  });

  it('says it does not know whether the device applied a commit that failed as the turn stopped, and fails the call when the turn runs on', async () => {
    const { fake, calls, run } = setup({}, ON_THE_FLY);
    const stop = new AbortController();
    let stopping = true;
    const forwardTo = vi.mocked(fake.remote.themeCall).getMockImplementation()!;
    vi.mocked(fake.remote.themeCall).mockImplementation((async (...args: Parameters<typeof forwardTo>) => {
      if (args[1] !== 'commit') return forwardTo(...args);
      if (stopping) stop.abort();
      throw new Error('The request was cancelled.');
    }) as typeof fake.remote.themeCall);
    const result = await run('ThemeSet', AMBER, stop.signal);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The turn stopped while the change was being applied, so it may or may not have been applied. Read the theme state before saying which.');
    expect(result.details.outcome).toBeUndefined();
    expect(calls.map(({ method }) => method)).toEqual(['stage', 'discard']);

    stopping = false;
    await expect(run('ThemeSet', { ...AMBER, name: 'Amber Day' })).rejects.toThrow('The request was cancelled.');
    expect(calls.map(({ method }) => method)).toEqual(['stage', 'discard', 'stage', 'discard']);
  });

  it('ends the stage on the device and keeps its draft after Change, so the draft can expire with no card open', async () => {
    const { fake, handler, byDevice, calls, run, relay, themes } = setup();
    const result = run('ThemeSet', AMBER);
    const card = await cardOn(byDevice, 'client-a');
    fake.setActor('client-a');
    handler.resolveThemeChange(card.promptId, 'change', 'Warmer');
    fake.setActor(undefined);
    const done = await result;
    expect(done.details.outcome).toBe('changesRequested');
    expect(calls.at(-1)).toMatchObject({ method: 'discard', params: { stageId: card.stageId, keepDraft: true } });
    expect(await themes.drafts.get(done.details.draftId!)).toBeDefined();
    expect(await relay.expireDrafts(Date.now() + RELAYED_DRAFT_TTL_MS * 2)).toBe(1);
    expect(await themes.drafts.get(done.details.draftId!)).toBeUndefined();
  });
});
