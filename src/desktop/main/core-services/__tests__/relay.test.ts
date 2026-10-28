import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakePanelHost } from '../../../../__mocks__/fake-platform';
import type { Disposable } from '../../../../platform/disposable';
import { createCorePlatform } from '../../../core-host/platform';
import { createLoopback, createMainEndpoint, INVALID, parseCoreInit } from '../../../core-protocol';
import { createDesktopKeyValueState } from '../../../local-services/key-value-state';
import { createHostServices, type RelayView } from '../host-services';
import { hostExtras } from './host-deps';

// A replay of a 28 MB conversation (the largest session file in the freeze investigation's sample) through main's relay.
const CONVERSATION_BYTES = 28 * 1024 * 1024;
const TURN_TEXT = 'The function reads the file, splits it into lines and counts the words on each. '.repeat(40);
const TOOL_OUTPUT = 'src/core/chat-panel/panel-manager.ts:214: async mentionFile(panelId: string, target: MentionTarget)\n'.repeat(80);

function conversation(): Array<{ readonly type: string }> {
  const messages: Array<{ readonly type: string }> = [];
  let bytes = 0;
  for (let turn = 0; bytes < CONVERSATION_BYTES; turn++) {
    const user = { type: 'userReplay', content: `Question ${turn}: ${TURN_TEXT.slice(0, 400)}`, promptIndex: turn, timestamp: 1_790_000_000_000 + turn };
    const assistant = {
      type: 'assistantReplay',
      content: TURN_TEXT,
      thinking: TURN_TEXT.slice(0, 1200),
      tools: [{ id: `tool-${turn}`, name: 'Grep', input: { pattern: `word${turn}`, path: 'src' }, result: TOOL_OUTPUT, isError: false }],
    };
    messages.push(user, assistant);
    bytes += JSON.stringify(user).length + JSON.stringify(assistant).length;
  }
  return messages;
}

const dirs: string[] = [];
const cleanups: Disposable[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('relays a 28 MB conversation as JSON text that main forwards without parsing', () => {
  const main = createFakePlatform({ chatBrowserPane: true, folders: [{ fsPath: path.resolve('/projects/a'), name: 'a' }] });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-relay-'));
  dirs.push(userData);
  const loopback = createLoopback();
  const endpoint = createMainEndpoint(loopback.main, () => undefined);
  const forwarded: Array<{ readonly type: string; readonly chars: number }> = [];
  const host = createHostServices({
    endpoint,
    platform: main,
    trust: { trustedKeys: () => [], onDidGrant: () => ({ dispose: () => undefined }), requestTrust: async () => false },
    state: createDesktopKeyValueState(userData, () => undefined),
    terminalToggle: () => ({ shown: false, shortcut: 'Ctrl+`' }),
    resolveProxy: async () => 'DIRECT',
    createView: (panelId, create) => Object.assign(main.window.createPanel(create) as FakePanelHost, {
      panelId,
      postJson: (type: string, json: string) => forwarded.push({ type, chars: json.length }),
      showPage: () => undefined,
      closeReason: 'user' as const,
    }) satisfies RelayView,
    git: { available: true },
    e2eHooks: false,
    ...hostExtras(),
    log: () => undefined,
  });
  const init = parseCoreInit(structuredClone(host.init));
  if (init === INVALID) throw new Error('main\'s init does not parse');
  const core = createCorePlatform(loopback.core, init, () => ({
    capabilities: () => main.capabilities,
    settings: main.settings,
    fileWatchers: main.fileWatchers,
    confinement: main.confinement,
    localization: main.localization,
    logSinks: main.logSinks,
    paths: main.paths,
  }));
  cleanups.push({ dispose: () => core.dispose() }, { dispose: () => endpoint.close('closed') }, host);
  const chat = core.window.createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });
  const messages = conversation();
  const totalChars = messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);

  const parse = vi.spyOn(JSON, 'parse');
  for (const message of messages) void chat.postMessage(message);

  expect(parse).not.toHaveBeenCalled();
  expect(forwarded).toHaveLength(messages.length);
  expect(forwarded.reduce((sum, entry) => sum + entry.chars, 0)).toBe(totalChars);
  expect(totalChars).toBeGreaterThanOrEqual(CONVERSATION_BYTES);
});

it('drops a post type this core may not send, and relays the rest', () => {
  const main = createFakePlatform({ chatBrowserPane: true, folders: [{ fsPath: path.resolve('/projects/a'), name: 'a' }] });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-relay-'));
  dirs.push(userData);
  const loopback = createLoopback();
  const endpoint = createMainEndpoint(loopback.main, () => undefined);
  const forwarded: string[] = [];
  const host = createHostServices({
    endpoint,
    platform: main,
    trust: { trustedKeys: () => [], onDidGrant: () => ({ dispose: () => undefined }), requestTrust: async () => false },
    state: createDesktopKeyValueState(userData, () => undefined),
    terminalToggle: () => ({ shown: false, shortcut: 'Ctrl+`' }),
    resolveProxy: async () => 'DIRECT',
    createView: (panelId, create) => Object.assign(main.window.createPanel(create) as FakePanelHost, {
      panelId,
      postJson: (type: string) => forwarded.push(type),
      showPage: () => undefined,
      closeReason: 'user' as const,
    }) satisfies RelayView,
    git: { available: true },
    e2eHooks: false,
    ...hostExtras(),
    // a remote core's voice view state; only this computer's core feeds it to a view
    refusedPosts: new Set(['voiceConfigUpdate', 'voiceFirstRunRequired']),
    log: () => undefined,
  });
  const init = parseCoreInit(structuredClone(host.init));
  if (init === INVALID) throw new Error('main\'s init does not parse');
  const core = createCorePlatform(loopback.core, init, () => ({
    capabilities: () => main.capabilities,
    settings: main.settings,
    fileWatchers: main.fileWatchers,
    confinement: main.confinement,
    localization: main.localization,
    logSinks: main.logSinks,
    paths: main.paths,
  }));
  cleanups.push({ dispose: () => core.dispose() }, { dispose: () => endpoint.close('closed') }, host);
  const chat = core.window.createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });
  void chat.postMessage({ type: 'voiceConfigUpdate', config: { mode: 'wake-word' } });
  void chat.postMessage({ type: 'voiceFirstRunRequired', reason: 'first-time' });
  void chat.postMessage({ type: 'streamStart' });
  expect(forwarded).toEqual(['streamStart']);
});

// Main's relay of chat views it adopts, with what reached core's side of the channel.
function relayServices(divert: (view: RelayView, message: unknown) => boolean = () => false) {
  const main = createFakePlatform({ chatBrowserPane: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-relay-'));
  dirs.push(userData);
  const loopback = createLoopback();
  const endpoint = createMainEndpoint(loopback.main, () => undefined);
  const toCore: unknown[] = [];
  loopback.core.onMessage((message) => toCore.push(message));
  const host = createHostServices({
    endpoint,
    platform: main,
    trust: { trustedKeys: () => [], onDidGrant: () => ({ dispose: () => undefined }), requestTrust: async () => false },
    state: createDesktopKeyValueState(userData, () => undefined),
    terminalToggle: () => ({ shown: false, shortcut: 'Ctrl+`' }),
    resolveProxy: async () => 'DIRECT',
    createView: () => { throw new Error('no view here'); },
    git: { available: true },
    e2eHooks: false,
    ...hostExtras(),
    divert,
    log: () => undefined,
  });
  cleanups.push({ dispose: () => endpoint.close('closed') });
  const view = (panelId: string): RelayView & FakePanelHost => Object.assign(main.window.createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] }) as FakePanelHost, {
    panelId,
    postJson: () => undefined,
    showPage: () => undefined,
    closeReason: 'detach' as const,
  });
  // the page messages that reached core, by type
  const relayed = (): string[] => toCore.flatMap((raw) => {
    const type = JSON.stringify(raw).match(/"message":\{"type":"([^"]+)"/)?.[1];
    return type === undefined ? [] : [type];
  });
  return { host, view, relayed };
}

it('settles a held view false when it closes before its page is ready or the services are disposed, and with its page token on its ready', async () => {
  const { host, view, relayed } = relayServices();
  const ready = view('view-1');
  const joined = host.adoptHeld(ready);
  ready.fireMessage({ type: 'getSettings' });
  ready.fireMessage({ type: 'ready', panelToken: 'token-1' });
  await expect(joined).resolves.toEqual({ panelToken: 'token-1' });
  ready.fireMessage({ type: 'afterReady' });

  const closing = view('view-2');
  const closed = host.adoptHeld(closing);
  closing.close();
  await expect(closed).resolves.toBe(false);

  const left = host.adoptHeld(view('view-3'));
  host.dispose();
  await expect(left).resolves.toBe(false);
  // only what a page sent after its ready reached core
  expect(relayed()).toEqual(['afterReady']);
});

it("joins a joined view again on its page's later ready instead of sending core that ready", async () => {
  const { host, view, relayed } = relayServices();
  const joined = view('view-1');
  const held = host.adoptHeld(joined);
  joined.fireMessage({ type: 'ready', panelToken: 'token-of-this-device' });
  await held;
  const rejoins: string[] = [];
  host.rejoinOnReady('view-1', () => rejoins.push('join'));
  joined.fireMessage({ type: 'sendMessage' });
  joined.fireMessage({ type: 'ready', panelToken: 'token-of-this-device' });
  expect(rejoins).toEqual(['join']);
  expect(relayed()).toEqual(['sendMessage']);
});

it('relays to core no page message that main diverts', async () => {
  const diverted: unknown[] = [];
  const { host, view, relayed } = relayServices((_view, message) => (message as { type: string }).type === 'startVoiceRecording' && diverted.push(message) > 0);
  const chat = view('view-1');
  await host.adopt(chat, async () => undefined);
  chat.fireMessage({ type: 'startVoiceRecording' });
  chat.fireMessage({ type: 'getSettings' });
  expect(diverted).toEqual([{ type: 'startVoiceRecording' }]);
  expect(relayed()).toEqual(['getSettings']);
});
