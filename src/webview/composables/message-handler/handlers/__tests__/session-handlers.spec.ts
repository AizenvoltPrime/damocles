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
import { useTeamStore } from '@/stores/useTeamStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { StoredSession } from '@shared/types/session';

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
    teamStore: useTeamStore(),
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

describe('resumeAccepted', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('clears the shown conversation and selects the accepted one under its stored name', () => {
    // Selecting from history no longer clears the panel up front, so this is the only place it happens.
    const ctx = context();
    const { sessionStore, streamingStore } = ctx.stores;
    const stored: StoredSession = { id: 's-x', timestamp: 1, preview: 'first prompt', customTitle: 'Refactor' };
    sessionStore.updateStoredSessions([stored], true, false, 1);
    streamingStore.addUserMessage('the conversation on screen');

    dispatch({ type: 'resumeAccepted', sessionId: 's-x' }, ctx);

    expect(streamingStore.messages).toEqual([]);
    expect(sessionStore.selectedSessionId).toBe('s-x');
    expect(sessionStore.selectedSessionName).toBe('Refactor');
    expect(sessionStore.currentResumedSessionId).toBe('s-x');
    expect(ctx.vscode.getState()).toMatchObject({ sessionId: 's-x', sessionName: 'Refactor' });
  });
});

describe('the webview reading sessionStateChanged', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each([
    ['idle', false],
    ['running', false],
    ['requires_action', true],
  ] as const)('writes %s into the session store unchanged', (state, awaiting) => {
    const ctx = context();

    dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);

    expect(ctx.stores.sessionStore.sessionState).toBe(state);
    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(awaiting);
  });

  it('replays a full parked-and-resumed turn onto the store in order', () => {
    const ctx = context();
    const seen: string[] = [];

    for (const state of ['running', 'requires_action', 'running', 'requires_action', 'running', 'idle'] as const) {
      dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);
      seen.push(ctx.stores.sessionStore.sessionState);
    }

    expect(seen).toEqual(['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']);
  });

  it('leaves no parked state behind when idle follows requires_action directly', () => {
    const ctx = context();

    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-1' }, ctx);
    dispatch({ type: 'sessionStateChanged', state: 'idle', sessionId: 's-1' }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(false);
  });

  it('does not filter on the session id, which can arrive after the first running', () => {
    const ctx = context();
    ctx.stores.sessionStore.setCurrentSession('s-old');

    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-new' }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(true);
  });
});

/**
 * The seven sequences the extension publisher can produce, copied from the emitted-sequences contract.
 * Each row lands the webview on `idle` with nothing parked, which is what a stuck indicator would break.
 * Two rows are the ones a naive store gets wrong: a cancel jumps from `requires_action` straight to
 * `idle`, and a dialog opened outside a turn starts at `requires_action` with no `running` at all.
 */
const PUBLISHED_SEQUENCES = [
  ['clean turn, no prompts', ['running', 'idle']],
  ['one prompt answered mid turn', ['running', 'requires_action', 'running', 'idle']],
  ['permission dialog then a team agent elicitation', ['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']],
  ['two prompts open at once, answered one at a time', ['running', 'requires_action', 'running', 'idle']],
  ['a ctx.ui dialog withdrawn by its abort signal', ['running', 'requires_action', 'running', 'idle']],
  ['turn cancelled with a permission dialog open', ['running', 'requires_action', 'idle']],
  ['a dialog opened with no turn in flight', ['requires_action', 'idle']],
] as const;

describe('every sequence the extension publisher can produce', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each(PUBLISHED_SEQUENCES)('%s replays onto the store in order', (_name, sequence) => {
    const ctx = context();
    const seen: string[] = [];

    for (const state of sequence) {
      dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);
      seen.push(ctx.stores.sessionStore.sessionState);
    }

    expect(seen).toEqual([...sequence]);
  });

  it.each(PUBLISHED_SEQUENCES)('%s ends idle with nothing parked', (_name, sequence) => {
    const ctx = context();

    for (const state of sequence) {
      dispatch({ type: 'sessionStateChanged', state, sessionId: 's-1' }, ctx);
    }

    expect(ctx.stores.sessionStore.sessionState).toBe('idle');
    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(false);
  });

  it('parks on the very first message when a dialog opens on a fresh panel', () => {
    // A dialog opened outside a turn publishes before any sessionStarted, so the store cannot wait for one.
    const ctx = context();

    expect(ctx.stores.sessionStore.sessionState).toBe('idle');

    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-1' }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(true);
  });

  it('stays up when a turn settles under an open dialog and no message arrives', () => {
    // The publisher suppresses the repeat, so the parked state has to survive the silence at turn end.
    const ctx = context();

    dispatch({ type: 'sessionStateChanged', state: 'running', sessionId: 's-1' }, ctx);
    dispatch({ type: 'sessionStateChanged', state: 'requires_action', sessionId: 's-1' }, ctx);
    dispatch({ type: 'processing', isProcessing: false }, ctx);

    expect(ctx.stores.sessionStore.isAwaitingUserAction).toBe(true);
    expect(ctx.stores.uiStore.isProcessing).toBe(false);
  });
});
