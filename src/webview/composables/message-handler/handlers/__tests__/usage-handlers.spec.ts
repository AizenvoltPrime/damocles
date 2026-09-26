// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp } from 'vue';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext } from '../../types';
import { i18n } from '@/i18n';
import { useSessionStore } from '@/stores/useSessionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import type { SessionStats } from '@shared/types/session';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * The status bar's billing totals and the context meter's snapshot live side by side in one store object.
 * Each message may write only its own set of fields, or a billing figure leaks into the meter or back.
 */

function context(): HandlerContext {
  return {
    stores: { sessionStore: useSessionStore(), streamingStore: useStreamingStore() },
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
  const handler = buildRegistry()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

const SEEDED: SessionStats = {
  totalInputTokens: 1,
  totalOutputTokens: 2,
  cacheReadTokens: 3,
  cacheCreationTokens: 4,
  costUsd: 5,
  numTurns: 6,
  contextInputTokens: 7,
  contextCacheReadTokens: 8,
  contextCacheWriteTokens: 9,
  contextWindowSize: 200_000,
};

/** The store fields whose value differs from the seeded stats. */
function changedFields(): string[] {
  const now = useSessionStore().sessionStats;
  return (Object.keys(now) as Array<keyof SessionStats>).filter((k) => now[k] !== SEEDED[k]).sort();
}

describe('usage messages write only their own store fields', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useSessionStore().updateStats(SEEDED);
  });

  it('sessionUsage writes the billing totals and the turn count', () => {
    dispatch({
      type: 'sessionUsage',
      usage: { totalInputTokens: 10, totalOutputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, costUsd: 0.5 },
      numTurns: 60,
    }, context());

    expect(changedFields()).toEqual(['cacheCreationTokens', 'cacheReadTokens', 'costUsd', 'numTurns', 'totalInputTokens', 'totalOutputTokens']);
    expect(useSessionStore().sessionStats).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, costUsd: 0.5, numTurns: 60 });
  });

  it('tokenUsageUpdate writes only the context snapshot', () => {
    dispatch({ type: 'tokenUsageUpdate', inputTokens: 70, cacheReadTokens: 80, cacheCreationTokens: 90 }, context());

    expect(changedFields()).toEqual(['contextCacheReadTokens', 'contextCacheWriteTokens', 'contextInputTokens']);
    expect(useSessionStore().sessionStats).toMatchObject({ contextInputTokens: 70, contextCacheReadTokens: 80, contextCacheWriteTokens: 90 });
  });

  it('done ends the turn without touching either set', () => {
    dispatch({ type: 'done', data: { type: 'result', session_id: 's1', is_done: true } }, context());

    expect(changedFields()).toEqual([]);
  });
});
