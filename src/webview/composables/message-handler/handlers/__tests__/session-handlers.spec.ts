// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp } from 'vue';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext, StoreContext } from '../../types';
import { i18n } from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { useFormStore } from '@/stores/useFormStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlanViewStore } from '@/stores/usePlanViewStore';
import { useTaskStore } from '@/stores/useTaskStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useBtwStore } from '@/stores/useBtwStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * A session reset must close whatever tool overlay was open.
 *
 * The expanded tool id used to live on `useStreamingStore`, so `streamingStore.$reset()` cleared it for
 * free at both reset sites. It lives on `useUIStore` now, and these handlers never call
 * `uiStore.$reset()`, so the clearing has to be an explicit `uiStore.collapseTool()` in each handler.
 * Without it a stale id survives a session switch and can later resolve against an unrelated call that
 * happens to carry the same id. Both reset sites are driven, because they are hand-kept in sync and a
 * line dropped from one of them would otherwise ship green.
 */

function context(): HandlerContext {
  const stores = {
    uiStore: useUIStore(),
    streamingStore: useStreamingStore(),
    sessionStore: useSessionStore(),
    subagentStore: useSubagentStore(),
    questionStore: useQuestionStore(),
    formStore: useFormStore(),
    permissionStore: usePermissionStore(),
    planViewStore: usePlanViewStore(),
    taskStore: useTaskStore(),
    contextInjectionStore: useContextInjectionStore(),
    contextUsageStore: useContextUsageStore(),
    subscriptionUsageStore: useSubscriptionUsageStore(),
    elicitationStore: useElicitationStore(),
    btwStore: useBtwStore(),
  } as unknown as StoreContext;

  let state: Record<string, unknown> = {};
  return {
    stores,
    refs: { messageContainerRef: { value: null }, chatInputRef: { value: null } },
    vscode: {
      postMessage: () => {},
      getState: <T,>() => state as T,
      setState: <T,>(next: T) => {
        state = next as Record<string, unknown>;
      },
    },
  } as unknown as HandlerContext;
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

function dispatch(msg: ExtensionToWebviewMessage, ctx: HandlerContext): void {
  const handler = buildRegistry()[msg.type] as
    | ((m: ExtensionToWebviewMessage, c: HandlerContext) => void)
    | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

describe('a session reset closing the open tool overlay', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each([
    ['sessionCleared', { type: 'sessionCleared' } as const],
    ['conversationCleared', { type: 'conversationCleared' } as const],
  ])('%s clears the expanded tool', (_name, msg) => {
    const ctx = context();
    const uiStore = ctx.stores.uiStore;
    uiStore.expandTool('t-1', 'subagent');

    dispatch(msg, ctx);

    expect(uiStore.expandedToolId).toBeNull();
    expect(uiStore.expandedToolSource).toBeNull();
  });
});
