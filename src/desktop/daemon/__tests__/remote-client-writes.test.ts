import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { createClaudeAuthHandlers } from '../../../core/chat-panel/message-router/handlers/claude-auth-handlers';
import { createOpenAIHandlers } from '../../../core/chat-panel/message-router/handlers/openai-handlers';
import { createProviderAccountHandlers } from '../../../core/chat-panel/message-router/handlers/provider-account-handlers';
import { createSettingsHandlers } from '../../../core/chat-panel/message-router/handlers/settings-handlers';
import { createRemoteChatSettingHandlers } from '../../../core/chat-panel/message-router/handlers/remote-chat-setting-handlers';
import { SettingsManager } from '../../../core/chat-panel/settings-manager';
import type { PanelHost } from '../../../platform/window-service';
import type { HandlerContext, HandlerDependencies } from '../../../core/chat-panel/message-router/types';
import type { HostInstance } from '../../../core/chat-panel/types';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import { installPlatform } from '../../../core/platform-host';
import { customProviderDef } from '../../../core/pi-session/custom-providers';
import { BrokeredCredentialStore } from '../../../core/pi-session/credential-broker';
import { OPENAI_API_KEY_SECRET } from '../../../core/pi-session/openai-auth';
import { PiRuntime } from '../../../core/pi-session/pi-runtime';
import { KEY_PROVIDER_IDS } from '../../../shared/settings-sections';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../shared/types/messages';
import { runPinnedTurn } from '../../../core/client-snapshots';
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../core-protocol';
import { FEATURES } from '../../../remote/protocol-version';
import { MAX_DESIGN_ID_CHARS } from '../../../shared/design-paths';
import { createActorContext, processActor, type ActorContext } from '../../core-protocol/actor';
import { DesktopSettingsStore } from '../../local-services/settings-store';
import { createClientMirrors, createCoreRouter, type CoreRouter } from '../core-routes';
import { createDaemonState } from '../daemon-state';
import { createRunRegistry } from '../run-registry';

const PROVIDER_KEY_SECRETS = [OPENAI_API_KEY_SECRET, ...KEY_PROVIDER_IDS.map((provider) => customProviderDef(provider).key.secretKey)];

// A daemon's core never writes this computer's files or changes its credentials: every route that could, refuses.
const quiet = (): void => undefined;
let dir: string;
let router: CoreRouter | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-writes-'));
});

afterEach(() => {
  router?.dispose();
  router = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function attachedClient() {
  const coreLoop = createLoopback();
  const daemonMain = createMainEndpoint(coreLoop.main, quiet);
  const core = createCoreEndpoint(coreLoop.core, quiet);
  const state = createDaemonState(path.join(dir, 'state'), quiet);
  router = createCoreRouter({ core: daemonMain, state, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: vi.fn(), agentShellUrl: () => undefined, clientPolicyChanged: () => undefined, log: quiet });
  const loop = createLoopback();
  const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
  const clientSecrets = new Map<string, string>([...PROVIDER_KEY_SECRETS.map((key): [string, string] => [`remote/h1/${key}`, 'sk-client']), ['remote/h1/mcp.token', 't']]);
  const asked = vi.fn();
  main.serve('secrets.get', ({ key }) => { asked('get', key); return clientSecrets.get(key); });
  main.serve('secrets.store', ({ key, value }) => { asked('store', key); clientSecrets.set(key, value); });
  main.serve('secrets.delete', ({ key }) => { asked('delete', key); clientSecrets.delete(key); });
  main.serve('secrets.keys', () => [...clientSecrets.keys()]);
  router.attach({
    id: 'connection-1',
    clientId: 'client-1',
    hostId: 'h1',
    transport: loop.core,
    mirrors: {
      trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' },
      clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false },
    },
    close: vi.fn(),
    drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }),
  });
  return { core, state, asked, clientSecrets };
}

// The user-scope relays are the designed exceptions, checked by main: user.memory.apply and user.mcp.* (user-relays.test.ts), and
// user.browser.tool, whose profile and saved downloads are under ~/.damocles/browser-profiles/<authority>/ (main/remote's browser-relay.test.ts).
describe('a daemon\'s core cannot write client files or change client credentials', () => {
  it.each(PROVIDER_KEY_SECRETS)('provider key %s: get answers undefined unasked, store and delete refuse, keys omit it', async (key) => {
    const { core, asked, clientSecrets } = attachedClient();
    expect(await core.request('secrets.get', { key })).toBeUndefined();
    await expect(core.request('secrets.store', { key, value: 'sk-evil' })).rejects.toThrow(/client/);
    await expect(core.request('secrets.delete', { key })).rejects.toThrow(/client/);
    expect(await core.request('secrets.keys', {})).toEqual(['mcp.token']);
    expect(asked).not.toHaveBeenCalledWith(expect.anything(), `remote/h1/${key}`);
    expect(clientSecrets.get(`remote/h1/${key}`)).toBeDefined();
  });

  it('user-scope settings: a write from anywhere but the host tab is refused and the client\'s user layer is never a file', async () => {
    const machineFile = path.join(dir, 'home', '.damocles', 'settings.json');
    const fake = createFakePlatform();
    const store = new DesktopSettingsStore({
      userFile: machineFile,
      contributed: parseContributedConfiguration({ contributes: { configuration: { properties: { 'damocles.model': { default: 'm' } } } } }),
      fileWatchers: fake.fileWatchers,
      projects: fake.workspaceFolders,
      trust: fake.trust,
      chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
      notifications: undefined,
      log: quiet,
      remote: { fromHostTab: () => false, clientSettings: () => ({ 'damocles.model': 'client-model' }), onDidChangeClientSettings: () => ({ dispose: () => undefined }) },
    });
    await expect(store.update('damocles.model', 'host-model', 'user')).rejects.toThrow(/User tab/);
    expect(fs.existsSync(machineFile)).toBe(false);
    expect(store.get('damocles.model')).toBe('client-model');
    store.dispose();
  });

  it('a chat view\'s pin and Tools switches refuse on a daemon\'s core, on its own route and the remote chat route, and nothing reaches the client', async () => {
    const machineFile = path.join(dir, 'home', '.damocles', 'settings.json');
    const fake = createFakePlatform();
    const remote = createFakeRemoteHost();
    const clientUser = { 'damocles.pinnedHeaderHidden': false, 'damocles.compass.enabled': false, 'damocles.tools.disabled': ['A'] };
    const settings = new DesktopSettingsStore({
      userFile: machineFile,
      contributed: parseContributedConfiguration({ contributes: { configuration: { properties: {
        'damocles.pinnedHeaderHidden': { default: false, scope: 'application' },
        'damocles.compass.enabled': { default: false },
        'damocles.tools.disabled': { default: [] },
      } } } }),
      fileWatchers: fake.fileWatchers,
      projects: fake.workspaceFolders,
      trust: fake.trust,
      chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
      notifications: undefined,
      log: quiet,
      remote: { fromHostTab: () => false, clientSettings: () => clientUser, onDidChangeClientSettings: () => ({ dispose: () => undefined }) },
    });
    const platform = { ...fake, settings, remote: remote.remote };
    const posted: ExtensionToWebviewMessage[] = [];
    const postMessage = (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message);
    const settingsManager = new SettingsManager({ postMessage, platform, folders: () => [] });
    const deps = { platform, postMessage, settingsManager, getPanels: () => new Map(), subscriptions: [] } as unknown as HandlerDependencies;
    const host = {} as PanelHost;
    const ctx = { host, reply: host, panelId: 'panel-1', folder: { fsPath: dir } } as unknown as HandlerContext;
    const messages = [
      { type: 'setPinnedHeaderHidden', hidden: true },
      { type: 'toggleToolGroup', group: 'compass', enabled: true },
      { type: 'toggleTool', toolName: 'B', enabled: false },
    ] as WebviewToExtensionMessage[];
    const chatRoutes = createSettingsHandlers(deps);
    const remoteChatRoutes = createRemoteChatSettingHandlers(deps);
    for (const message of messages) {
      await chatRoutes[message.type]!(message, ctx);
      await remoteChatRoutes[message.type]!(message, { host });
    }
    const keys = ['damocles.pinnedHeaderHidden', 'damocles.compass.enabled', 'damocles.tools.disabled'];
    expect(posted.filter((message) => message.type === 'settingWriteResult')).toEqual(keys.flatMap((key) => [
      expect.objectContaining({ key, ok: false }),
      expect.objectContaining({ key, ok: false }),
    ]));
    expect(fs.existsSync(machineFile)).toBe(false);
    expect(clientUser).toEqual({ 'damocles.pinnedHeaderHidden': false, 'damocles.compass.enabled': false, 'damocles.tools.disabled': ['A'] });
    for (const relay of [remote.remote.credentials, remote.remote.memoryApply, remote.remote.mcpCall, remote.remote.browserTool]) expect(relay).not.toHaveBeenCalled();
    settingsManager.dispose();
    settings.dispose();
  });

  it('the broker\'s delete is refused and never reaches the client', async () => {
    const host = createFakeRemoteHost();
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    await expect(broker.delete('anthropic')).rejects.toThrow(/User tab/);
    expect(host.remote.credentials).not.toHaveBeenCalled();
  });
});

describe('a daemon routes credential and transcript requests so no client\'s files or credentials change', () => {
  const MIRRORS = {
    trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' },
    clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false },
  } as const;

  // the daemon's router between a core endpoint that reads the actor of what it serves and any number of clients
  function daemon() {
    const coreLoop = createLoopback();
    const coreActors = createActorContext();
    const core = createCoreEndpoint(coreLoop.core, quiet, undefined, coreActors);
    const state = createDaemonState(path.join(dir, 'state'), quiet);
    router = createCoreRouter({ core: createMainEndpoint(coreLoop.main, quiet, undefined, processActor), state, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: vi.fn(), agentShellUrl: () => undefined, clientPolicyChanged: () => undefined, log: quiet });
    const attach = (clientId: string, actors?: ActorContext) => {
      const loop = createLoopback();
      const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; }, actors);
      router!.attach({ id: `connection-${clientId}`, clientId, hostId: 'h1', transport: loop.core, mirrors: MIRRORS, close: vi.fn(), drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
      return main;
    };
    return { core, coreActors, attach };
  }

  // main runs no credential manager for an erase but on the user's click (git-credential-relay.test.ts)
  it('askpass.credential erase reaches only the client the request acts for, as it was sent, and its answer alone comes back', async () => {
    const { core, coreActors, attach } = daemon();
    const asked = { 'client-1': vi.fn(), 'client-2': vi.fn() };
    for (const clientId of ['client-1', 'client-2'] as const) {
      attach(clientId).serve('askpass.credential', (request) => {
        asked[clientId](request);
        return { kind: 'none' } as const;
      });
    }
    const request = { op: 'erase', fields: { protocol: 'https', host: 'github.com', username: 'ada' }, targetHelper: false } as const;
    await expect(coreActors.run('client-2', () => core.request('askpass.credential', request))).resolves.toEqual({ kind: 'none' });
    expect(asked['client-2']).toHaveBeenCalledWith(request);
    expect(asked['client-1']).not.toHaveBeenCalled();
  });

  it('user.credentials.push lands only in the pushing client\'s broker entry, whatever actor its envelope names', async () => {
    const { core, coreActors, attach } = daemon();
    attach('client-1');
    const pusherActors = createActorContext();
    const pusher = attach('client-2', pusherActors);
    const host = createFakeRemoteHost(async () => ({ type: 'none' }));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    const pushedBy: Array<string | undefined> = [];
    core.serve('user.credentials.push', ({ provider, credential }) => {
      pushedBy.push(coreActors.current());
      broker.push(coreActors.current()!, provider, credential);
    });
    const credential = { type: 'oauth', access: 'pushed-by-2', refresh: '', expiresIn: 3_600_000 } as const;
    // both devices are attached, as a pushing one always is
    host.set('clientAuth', 'client-1', { providers: {} });
    host.set('clientAuth', 'client-2', { providers: {} });
    await pusherActors.run('client-1', () => pusher.request('user.credentials.push', { provider: 'anthropic', credential }));
    expect(pushedBy).toEqual(['client-2']);
    host.setActing('client-1');
    await expect(runPinnedTurn(host.remote, 'panel-1', () => broker.read('anthropic'))).resolves.toBeUndefined();
    host.setActing('client-2');
    await expect(runPinnedTurn(host.remote, 'panel-2', () => broker.read('anthropic'))).resolves.toMatchObject({ access: 'pushed-by-2' });
    broker.dispose();
  });

  it.each(['chats.openTranscript', 'chats.listMirrored'] as const)('%s from a client is refused before core', async (method) => {
    const { core, attach } = daemon();
    const main = attach('client-1');
    const served = vi.fn();
    core.serve(method, served as never);
    const params = method === 'chats.openTranscript' ? { viewId: 'v1', hostId: 'h1', file: '/home/ada/.damocles/x.jsonl' } : { hostId: 'h1', folder: '/home/ada' };
    await expect((main.request as (name: string, value: unknown) => Promise<unknown>)(method, params)).rejects.toThrow();
    expect(served).not.toHaveBeenCalled();
  });
});

describe('a daemon\'s core refuses every sign-in and key change before any pi call, probe or network use', () => {
  const remotePlatform = () => {
    const platform = { ...createFakePlatform(), remote: createFakeRemoteHost().remote };
    installPlatform(platform);
    return platform;
  };

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    installPlatform(createFakePlatform());
    vi.restoreAllMocks();
  });

  const interaction = { prompt: async () => '', notify: () => undefined };
  it.each<[string, (runtime: PiRuntime) => Promise<unknown>]>([
    ['setAnthropicApiKey', (runtime) => runtime.setAnthropicApiKey('sk-ant-x')],
    ['signInSubscription', (runtime) => runtime.signInSubscription(dir, true, interaction)],
    ['setSubscriptionBilling', (runtime) => runtime.setSubscriptionBilling(dir, true)],
    ['signOutAnthropic', (runtime) => runtime.signOutAnthropic()],
    ['setOpenAIApiKey', (runtime) => runtime.setOpenAIApiKey('sk-x')],
    ['clearOpenAIApiKey', (runtime) => runtime.clearOpenAIApiKey()],
    ['signInChatGPT', (runtime) => runtime.signInChatGPT(interaction)],
    ['signOutChatGPT', (runtime) => runtime.signOutChatGPT()],
    ['signOutCodex', (runtime) => runtime.signOutCodex()],
    ['setProviderPreferApiKey', (runtime) => runtime.setProviderPreferApiKey('xai', true)],
    ['signInProvider', (runtime) => runtime.signInProvider('xai', interaction)],
    ['signOutProvider', (runtime) => runtime.signOutProvider('xai')],
  ])('PiRuntime.%s', async (_name, call) => {
    const platform = remotePlatform();
    const runtime = PiRuntime.get(dir);
    const init = vi.spyOn(runtime, 'init');
    const folder = vi.spyOn(runtime, 'folder');
    const writes = [vi.spyOn(platform.state.global, 'update'), vi.spyOn(platform.settings, 'update')];
    await expect(call(runtime)).rejects.toThrow('Sign-ins change only in the User tab on your computer.');
    expect(init).not.toHaveBeenCalled();
    expect(folder).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it('the setProviderPreferApiKey route answers the refusal and writes no state or setting', async () => {
    const platform = remotePlatform();
    const writes = [vi.spyOn(platform.state.global, 'update'), vi.spyOn(platform.settings, 'update')];
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    const message = { type: 'setProviderPreferApiKey', provider: 'xai', preferApiKey: true, requestId: 'r1' } as WebviewToExtensionMessage;
    await createSettingsHandlers(deps).setProviderPreferApiKey!(message, ctx);
    expect(posted).toEqual([{ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: 'r1', ok: false, error: { message: 'Sign-ins change only in the User tab on your computer.' } }]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(PiRuntime.exists).toBe(false);
  });

  it('PiRuntime.resolveCredentialForBroker answers no broker', async () => {
    remotePlatform();
    const runtime = PiRuntime.get(dir);
    const init = vi.spyOn(runtime, 'init');
    await expect(runtime.resolveCredentialForBroker('anthropic')).rejects.toThrow('resolves no credential');
    expect(init).not.toHaveBeenCalled();
  });

  function handlerDeps(platform: ReturnType<typeof remotePlatform>, posted: ExtensionToWebviewMessage[]) {
    const host = { postMessage: (message: ExtensionToWebviewMessage) => posted.push(message) };
    const session = { publishAccountInfo: () => undefined, publishAvailableModels: () => undefined, openaiSignInEnded: async () => undefined };
    const panels = new Map([['panel-1', { host, session } as unknown as HostInstance]]);
    const deps = {
      platform,
      getPanels: () => panels,
      subscriptions: [],
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message),
      broadcastAccountState: async (_what: string, _row: string, read: () => Promise<ExtensionToWebviewMessage | undefined>) => {
        const message = await read();
        if (message) posted.push(message);
      },
    } as unknown as HandlerDependencies;
    return { deps, ctx: { host, reply: host, panelId: 'panel-1', folder: { fsPath: dir } } as unknown as HandlerContext };
  }

  it.each<[string, WebviewToExtensionMessage, string]>([
    ['setOpenAIApiKey', { type: 'setOpenAIApiKey', key: 'sk-x', requestId: 'r1' } as WebviewToExtensionMessage, 'setOpenAIApiKeyAck'],
    ['clearOpenAIApiKey', { type: 'clearOpenAIApiKey', requestId: 'r1' } as WebviewToExtensionMessage, 'clearOpenAIApiKeyAck'],
  ])('the %s route answers the refusal and never probes OpenAI', async (route, message, ack) => {
    const platform = remotePlatform();
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    await createOpenAIHandlers(deps)[route as 'setOpenAIApiKey']!(message, ctx);
    expect(posted).toEqual([{ type: ack, requestId: 'r1', ok: false, error: { message: 'Sign-ins change only in the User tab on your computer.' } }]);
    expect(fetched).not.toHaveBeenCalled();
    expect(PiRuntime.exists).toBe(false);
  });

  it.each<[string, WebviewToExtensionMessage]>([
    ['startChatGPTOAuth', { type: 'startChatGPTOAuth' } as WebviewToExtensionMessage],
  ])('the %s route fails with the refusal', async (route, message) => {
    const platform = remotePlatform();
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    await createOpenAIHandlers(deps)[route as 'startChatGPTOAuth']!(message, ctx);
    expect(posted).toContainEqual({ type: 'openaiChatGPTAuthFailed', error: { message: 'Sign-ins change only in the User tab on your computer.' } });
  });

  it.each<[string, WebviewToExtensionMessage]>([
    ['claudeSetApiKey', { type: 'claudeSetApiKey', key: 'sk-ant-x' } as WebviewToExtensionMessage],
    ['claudeSignIn', { type: 'claudeSignIn', useAllowance: true } as WebviewToExtensionMessage],
    ['claudeSignOut', { type: 'claudeSignOut' } as WebviewToExtensionMessage],
    ['claudeSetBilling', { type: 'claudeSetBilling', useAllowance: false } as WebviewToExtensionMessage],
  ])('the Claude %s route reports the refusal', async (route, message) => {
    const platform = remotePlatform();
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    await createClaudeAuthHandlers(deps).handlers[route as 'claudeSetApiKey']!(message, ctx);
    expect(posted).toContainEqual({ type: 'claudeAuthError', error: { message: 'Sign-ins change only in the User tab on your computer.' } });
  });

  it.each<[string, WebviewToExtensionMessage]>([
    ['providerSignIn', { type: 'providerSignIn', provider: 'xai' } as WebviewToExtensionMessage],
    ['providerSignOut', { type: 'providerSignOut', provider: 'xai' } as WebviewToExtensionMessage],
  ])('the %s route puts the refusal in the sign-in state and never starts pi', async (route, message) => {
    const platform = remotePlatform();
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    await createProviderAccountHandlers(deps).handlers[route as 'providerSignIn']!(message, ctx);
    expect(posted).toEqual([
      { type: 'providerSignInState', provider: 'xai', state: { phase: 'idle', error: { kind: 'remote', message: { message: 'Sign-ins change only in the User tab on your computer.' } } } },
    ]);
    expect(PiRuntime.exists).toBe(false);
  });

  it.each<[string, WebviewToExtensionMessage, string]>([
    ['setProviderApiKey', { type: 'setProviderApiKey', provider: 'xai', key: 'xai-key', requestId: 'r1' } as WebviewToExtensionMessage, 'setProviderApiKeyAck'],
    ['clearProviderApiKey', { type: 'clearProviderApiKey', provider: 'xai', requestId: 'r1' } as WebviewToExtensionMessage, 'clearProviderApiKeyAck'],
  ])('the %s route answers the refusal before any secret write', async (route, message, ack) => {
    const platform = remotePlatform();
    const store = vi.spyOn(platform.secrets, 'store');
    const remove = vi.spyOn(platform.secrets, 'delete');
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    await createProviderAccountHandlers(deps).handlers[route as 'setProviderApiKey']!(message, ctx);
    expect(posted).toEqual([{ type: ack, provider: 'xai', requestId: 'r1', ok: false, error: { message: 'Sign-ins change only in the User tab on your computer.' } }]);
    expect(store).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(PiRuntime.exists).toBe(false);
  });
});

// A daemon whose one client lists every feature of this build and shows chat panel-1 in view-1. A compromised core sends
// whatever it likes, so `post` puts a raw request envelope on core's channel, past the sending endpoint's own check: what
// reaches the client is what the daemon's parser let through, and what it refuses is a violation that closes core's channel.
async function designDaemon() {
  const coreLoop = createLoopback();
  // the answers to the raw requests below reach this endpoint, which never sent them
  const core = createCoreEndpoint(coreLoop.core, quiet, () => undefined);
  const violations: string[] = [];
  const state = createDaemonState(path.join(dir, 'state'), quiet);
  router = createCoreRouter({ core: createMainEndpoint(coreLoop.main, quiet, (error) => violations.push(error.message)), state, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: vi.fn(), agentShellUrl: () => undefined, clientPolicyChanged: () => undefined, log: quiet });
  const loop = createLoopback();
  const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
  router.attach({
    id: 'connection-1', clientId: 'client-1', hostId: 'h1', features: new Set(FEATURES), transport: loop.core,
    mirrors: { trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false } },
    close: vi.fn(), drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }),
  });
  core.serve('chats.restore', () => undefined);
  await main.request('chats.restore', { viewId: 'view-1' });
  core.publish('chats', { panelId: 'panel-1', entry: { panelId: 'panel-1', viewId: 'view-1', hasConversation: true, folder: { key: '/srv/app', fsPath: '/srv/app', name: 'app', label: 'app', projectScope: true }, permissions: { permissionMode: 'default', dangerouslySkipPermissions: false } } });
  let nextId = 1_000_000;
  const post = (method: string, params: unknown): void => coreLoop.core.post({ kind: 'request', id: ++nextId, method, params });
  return { core, main, post, violations };
}

const STEPS = [{ action: 'press', target: { label: 'Name' }, key: 'Escape' }, { action: 'assert', target: { role: 'dialog', name: 'New contact' }, expect: { visible: false } }];
const OUTSIDE_STEPS = [{ action: 'click', target: { selector: 'body' } }, STEPS[1]];

// PD-35: desktop opens a design in the browser only from main's own UI. A daemon's core asking for a preview reaches the
// client as a design and a path for a tab (main's host services open a tab, relay.test.ts), never as a URL to open.
describe("a daemon's core opens no URL on this computer through a design preview", () => {
  it('design.openPreview reaches the client as a design and a path, any URL it carries dropped, and opens nothing', async () => {
    const { main, post } = await designDaemon();
    const previews: unknown[] = [];
    const opened: unknown[] = [];
    main.serve('design.openPreview', (params) => {
      previews.push(params);
    });
    main.serve('shell.openExternal', (params) => {
      opened.push(params);
      return false;
    });
    post('design.openPreview', { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', url: 'https://example.com' });
    await vi.waitFor(() => expect(previews).toEqual([{ panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html' }]));
    expect(opened).toEqual([]);
  });
});

// PD-11: a daemon's core asks the attached client to render a design it holds by its id and a path below it; the client's
// main reads the bytes back through that core's design.read, so no path of this computer and no bytes cross with the ask.
describe("a daemon's core renders a design on this computer only by its id and path", () => {
  it('design.capture and design.probe reach the client with the design, the path and the render settings, and nothing else', async () => {
    const { main, post } = await designDaemon();
    const asked: unknown[] = [];
    main.serve('design.capture', (params) => {
      asked.push(params);
      return { png: new Uint8Array([1]), cssWidth: 390, cssHeight: 900, contentHeight: 900, scale: 2 };
    });
    main.serve('design.probe', (params) => {
      asked.push(params);
      return { widths: [], consoleErrors: [] };
    });
    const elsewhere = { folder: '/home/u/.ssh', bytes: new Uint8Array([1]), url: 'https://example.com' };
    post('design.capture', { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 390, state: null, scale: 2, ...elsewhere });
    post('design.probe', { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390], state: null, sweepTo: 1280, ...elsewhere });
    await vi.waitFor(() => expect(asked).toEqual([
      { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 390, state: null, scale: 2 },
      { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390], state: null, sweepTo: 1280 },
    ]));
  });

  it('a capture or probe outside the contract never reaches the client: the daemon refuses it as a violation', async () => {
    const { main, post, violations } = await designDaemon();
    const asked = vi.fn();
    main.serve('design.capture', asked);
    main.serve('design.probe', asked);
    post('design.capture', { designId: 'x'.repeat(MAX_DESIGN_ID_CHARS + 1), relPath: 'screens/S1.html', width: 390, state: null, scale: 2 });
    post('design.probe', { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [100_000], state: null });
    expect(violations).toHaveLength(2);
    expect(asked).not.toHaveBeenCalled();
  });
});

// D92, D93: a daemon's core asks for a journey or a replay by a design, a screen and steps the wire parser validates again, and a
// replay by its own chat's panel; it names no view, page, URL or selector, so it drives nothing on this computer but a fresh
// render page or that design's preview.
describe("a daemon's core runs and replays a journey only as validated steps of a design screen", () => {
  it('design.journey and design.replayJourney reach the client without any other field', async () => {
    const { main, post } = await designDaemon();
    const asked: unknown[] = [];
    main.serve('design.journey', (params) => {
      asked.push(params);
      return { widths: [{ width: 390, passed: true, steps: [{ ok: true }, { ok: true }] }], consoleErrors: [] };
    });
    main.serve('design.replayJourney', (params) => {
      asked.push(params);
    });
    const elsewhere = { url: 'https://example.com', viewId: 'settings', selector: 'body' };
    post('design.journey', { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390], state: null, steps: STEPS, outline: false, ...elsewhere });
    post('design.replayJourney', { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', state: null, steps: STEPS, reducedMotion: false, ...elsewhere });
    await vi.waitFor(() => expect(asked).toEqual([
      { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390], state: null, steps: STEPS, outline: false },
      { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', state: null, steps: STEPS, reducedMotion: false },
    ]));
  });

  it('steps outside the format never reach the client: the daemon refuses them as a violation', async () => {
    const { main, post, violations } = await designDaemon();
    const asked = vi.fn();
    main.serve('design.journey', asked);
    main.serve('design.replayJourney', asked);
    post('design.journey', { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390], state: null, steps: OUTSIDE_STEPS });
    post('design.replayJourney', { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', state: null, steps: OUTSIDE_STEPS, reducedMotion: false });
    expect(violations).toEqual([expect.stringContaining('request design.journey'), expect.stringContaining('request design.replayJourney')]);
    expect(asked).not.toHaveBeenCalled();
  });
});
