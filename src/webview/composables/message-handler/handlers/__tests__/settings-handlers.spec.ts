// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp } from 'vue';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext } from '../../types';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
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
  localMcpUnignored,
});

const configUpdate = (localMcpUnignored: boolean): ExtensionToWebviewMessage => ({
  type: 'mcpConfigUpdate',
  servers: [],
  configErrors: [],
  localMcpUnignored,
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
