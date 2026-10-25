// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp } from 'vue';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext } from '../../types';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * The gitignore leak flag crossing the wire into the store.
 *
 * `mcpServerStatus` and `mcpConfigUpdate` carry the same field and are kept in sync by hand, so a
 * line dropped from one of them ships green unless both are driven. Both are driven here, through the
 * REAL registry and the REAL store, because a handler that exists but is not registered is as broken
 * as one that does nothing.
 */

function context(): HandlerContext {
  // Only `stores.settingsStore` is reached by these two handlers.
  return { stores: { settingsStore: useSettingsStore() } } as unknown as HandlerContext;
}

/** `createHandlerRegistry` calls `useI18n()`, which is only legal inside a component `setup`. */
function buildRegistry(): HandlerRegistry {
  let registry!: HandlerRegistry;
  const app = createApp({
    setup() {
      registry = createHandlerRegistry();
      return () => null;
    },
  });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return registry;
}

function dispatch(msg: ExtensionToWebviewMessage, ctx: HandlerContext, registry = buildRegistry()): void {
  const handler = registry[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

const serverStatus = (localMcpUnignored: boolean): ExtensionToWebviewMessage => ({
  type: 'mcpServerStatus',
  servers: [],
  mcpEnabled: true,
  configErrors: [],
  toolExposureScopes: ['user'],
  localMcpUnignored,
});

const configUpdate = (localMcpUnignored: boolean): ExtensionToWebviewMessage => ({
  type: 'mcpConfigUpdate',
  servers: [],
  configErrors: [],
  localMcpUnignored,
});

describe('toolExposureScopes reaching the settings store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts at User and takes the scopes each mcpServerStatus offers', () => {
    const ctx = context();
    expect(ctx.stores.settingsStore.mcpToolExposureScopes).toEqual(['user']);

    dispatch({ ...serverStatus(false), toolExposureScopes: ['user', 'project', 'local'] } as ExtensionToWebviewMessage, ctx);
    expect(ctx.stores.settingsStore.mcpToolExposureScopes).toEqual(['user', 'project', 'local']);
  });
});

describe('localMcpUnignored reaching the settings store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts false so a panel opened before the first payload shows no warning', () => {
    expect(useSettingsStore().mcpLocalUnignored).toBe(false);
  });

  it.each([
    ['mcpServerStatus', serverStatus],
    ['mcpConfigUpdate', configUpdate],
  ] as const)('%s raises the flag for true and clears it for false', (_type, build) => {
    const ctx = context();

    dispatch(build(true), ctx);
    expect(ctx.stores.settingsStore.mcpLocalUnignored).toBe(true);

    // Clearing matters more than raising: the user adds the ignore line and the warning must go.
    dispatch(build(false), ctx);
    expect(ctx.stores.settingsStore.mcpLocalUnignored).toBe(false);
  });

  it('lets a later mcpConfigUpdate clear a flag mcpServerStatus raised', () => {
    // The two handlers write the same store field, and the reload path answers with both messages.
    const ctx = context();

    dispatch(serverStatus(true), ctx);
    dispatch(configUpdate(false), ctx);

    expect(ctx.stores.settingsStore.mcpLocalUnignored).toBe(false);
  });

  it('lets a later mcpServerStatus clear a flag mcpConfigUpdate raised', () => {
    const ctx = context();

    dispatch(configUpdate(true), ctx);
    dispatch(serverStatus(false), ctx);

    expect(ctx.stores.settingsStore.mcpLocalUnignored).toBe(false);
  });
});

describe('ChatGPT sign-in messages reaching the settings store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  function openaiContext(): HandlerContext {
    return { stores: { settingsStore: useSettingsStore(), uiStore: useUIStore() }, bridge: { postMessage: () => undefined } } as unknown as HandlerContext;
  }

  it('records a failure error, clears it when a sign-in starts, and ends the in-flight state on completion', () => {
    const ctx = openaiContext();
    const registry = buildRegistry();

    dispatch({ type: 'openaiChatGPTAuthFailed', error: 'port busy' }, ctx, registry);
    expect(ctx.stores.settingsStore.openaiChatGPTAuthError).toBe('port busy');

    dispatch({ type: 'openaiChatGPTAuthStarted' }, ctx, registry);
    expect(ctx.stores.settingsStore.openaiChatGPTAuthInFlight).toBe(true);
    expect(ctx.stores.settingsStore.openaiChatGPTAuthError).toBeNull();

    dispatch({ type: 'openaiChatGPTAuthCompleted' }, ctx, registry);
    expect(ctx.stores.settingsStore.openaiChatGPTAuthInFlight).toBe(false);
  });

  it('stores the ChatGPT, Codex and key status as sent', () => {
    const ctx = openaiContext();
    const status = { chatgpt: { signedIn: true, expiresAt: 1 }, codex: { signedIn: false }, apikey: { configured: true } };

    dispatch({ type: 'openaiAuthStatusChanged', status, preferApiKey: true, active: 'apiKey' }, ctx);

    expect(ctx.stores.settingsStore.openaiAuthStatus).toEqual(status);
    expect(ctx.stores.settingsStore.openaiPreferApiKey).toBe(true);
    expect(ctx.stores.settingsStore.openaiActive).toBe('apiKey');

    // A daemon's core leaves `active` out, which must not keep the previous answer.
    dispatch({ type: 'openaiAuthStatusChanged', status, preferApiKey: true }, ctx);
    expect(ctx.stores.settingsStore.openaiActive).toBeUndefined();
  });

  it('openOpenAIAuthPanel opens Settings and asks it to reveal the OpenAI section', () => {
    const ctx = openaiContext();

    dispatch({ type: 'openOpenAIAuthPanel' }, ctx);

    expect(ctx.stores.uiStore.showSettingsModal).toBe(true);
    expect(ctx.stores.uiStore.settingsTarget).toEqual({ section: 'accounts', account: 'openai' });
  });

  it('openaiAuthRequired opens the OpenAI sign-in and leaves the refused pick to core', () => {
    const ctx = openaiContext();
    const before = { ...ctx.stores.settingsStore.$state };

    dispatch({ type: 'openaiAuthRequired', modelValue: 'gpt-6.1-sol' }, ctx);

    expect(ctx.stores.uiStore.showSettingsModal).toBe(true);
    expect(ctx.stores.uiStore.settingsTarget).toEqual({ section: 'accounts', account: 'openai' });
    expect(ctx.stores.settingsStore.$state).toEqual(before);
  });
});

describe('providerAuthStatusChanged reaching the settings store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('stores every field for its own provider and replaces the previous status', () => {
    const ctx = context();
    const registry = buildRegistry();

    dispatch({ type: 'providerAuthStatusChanged', provider: 'xai', configured: true, external: null, signedIn: true, signedInExpiresAt: 1_700_000_000_000, preferApiKey: true, active: 'apiKey' }, ctx, registry);
    expect(ctx.stores.settingsStore.keyProviderStatus.xai).toEqual({ configured: true, external: null, signedIn: true, signedInExpiresAt: 1_700_000_000_000, preferApiKey: true, active: 'apiKey' });
    expect(ctx.stores.settingsStore.keyProviderStatus.deepseek).toEqual({ configured: false, external: null, signedIn: false, preferApiKey: false });

    dispatch({ type: 'providerAuthStatusChanged', provider: 'xai', configured: false, external: 'environment', signedIn: false, preferApiKey: false }, ctx, registry);
    expect(ctx.stores.settingsStore.keyProviderStatus.xai).toStrictEqual({ configured: false, external: 'environment', signedIn: false, preferApiKey: false });
  });
});

describe('providerSignInState reaching the settings store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts idle and keeps each state core sends for its provider, replacing the previous one', () => {
    const ctx = context();
    const registry = buildRegistry();
    expect(ctx.stores.settingsStore.providerSignInState.xai).toEqual({ phase: 'idle' });

    const deviceCode = { phase: 'deviceCode', userCode: 'ABCD-1234', verificationUri: 'https://accounts.x.ai/device', expiresAt: 1_700_000_000_000 } as const;
    dispatch({ type: 'providerSignInState', provider: 'xai', state: deviceCode }, ctx, registry);
    expect(ctx.stores.settingsStore.providerSignInState.xai).toEqual(deviceCode);

    dispatch({ type: 'providerSignInState', provider: 'xai', state: { phase: 'idle', error: { kind: 'expired', message: 'Code expired' } } }, ctx, registry);
    expect(ctx.stores.settingsStore.providerSignInState.xai).toStrictEqual({ phase: 'idle', error: { kind: 'expired', message: 'Code expired' } });
  });
});
