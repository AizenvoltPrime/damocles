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
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../core-protocol';
import { CLIENT_STATE_KEYS } from '../../core-protocol/messages';
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
  router = createCoreRouter({ core: daemonMain, state, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: vi.fn(), log: quiet });
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
    hostId: 'h1',
    transport: loop.core,
    mirrors: {
      state: { global: {}, workspace: {} }, trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' },
      clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false },
    },
    close: vi.fn(),
  });
  return { core, state, asked, clientSecrets };
}

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

  it.each(CLIENT_STATE_KEYS)('client state key %s: core\'s write is refused and nothing is stored', async (key) => {
    const { core, state } = attachedClient();
    await expect(core.request('state.update', { scope: 'global', key, value: 'x' })).rejects.toThrow(/client/);
    expect(state.snapshot('global')[key]).toBeUndefined();
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
      localization: fake.localization,
      log: quiet,
      remote: { fromHostTab: () => false, clientSettings: () => ({ 'damocles.model': 'client-model' }), onDidChangeClientSettings: () => ({ dispose: () => undefined }) },
    });
    await expect(store.update('damocles.model', 'host-model', 'user')).rejects.toThrow(/User tab/);
    expect(fs.existsSync(machineFile)).toBe(false);
    expect(store.get('damocles.model')).toBe('client-model');
    store.dispose();
  });

  it('the broker\'s delete is refused and never reaches the client', async () => {
    const host = createFakeRemoteHost();
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    await expect(broker.delete('anthropic')).rejects.toThrow(/User tab/);
    expect(host.remote.credentials).not.toHaveBeenCalled();
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
    const stateWrite = vi.spyOn(platform.state.global, 'update');
    await expect(call(runtime)).rejects.toThrow('Sign-ins change only in the User tab on your computer.');
    expect(init).not.toHaveBeenCalled();
    expect(folder).not.toHaveBeenCalled();
    expect(stateWrite).not.toHaveBeenCalled();
  });

  it('the setProviderPreferApiKey route answers the refusal and writes no state', async () => {
    const platform = remotePlatform();
    const stateWrite = vi.spyOn(platform.state.global, 'update');
    const posted: ExtensionToWebviewMessage[] = [];
    const { deps, ctx } = handlerDeps(platform, posted);
    const message = { type: 'setProviderPreferApiKey', provider: 'xai', preferApiKey: true, requestId: 'r1' } as WebviewToExtensionMessage;
    await createSettingsHandlers(deps).setProviderPreferApiKey!(message, ctx);
    expect(posted).toEqual([{ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: 'r1', ok: false, error: 'Sign-ins change only in the User tab on your computer.' }]);
    expect(stateWrite).not.toHaveBeenCalled();
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
    const deps = { platform, getPanels: () => panels, subscriptions: [], postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies;
    return { deps, ctx: { host, panelId: 'panel-1', folder: { fsPath: dir } } as unknown as HandlerContext };
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
    expect(posted).toEqual([{ type: ack, requestId: 'r1', ok: false, error: 'Sign-ins change only in the User tab on your computer.' }]);
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
    expect(posted).toContainEqual({ type: 'openaiChatGPTAuthFailed', error: 'Sign-ins change only in the User tab on your computer.' });
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
    expect(posted).toContainEqual({ type: 'claudeAuthError', error: 'Sign-ins change only in the User tab on your computer.' });
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
      { type: 'providerSignInState', provider: 'xai', state: { phase: 'idle', error: { kind: 'remote', message: 'Sign-ins change only in the User tab on your computer.' } } },
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
    expect(posted).toEqual([{ type: ack, provider: 'xai', requestId: 'r1', ok: false, error: 'Sign-ins change only in the User tab on your computer.' }]);
    expect(store).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(PiRuntime.exists).toBe(false);
  });
});
