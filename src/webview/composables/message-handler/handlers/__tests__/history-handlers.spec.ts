// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp } from 'vue';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext } from '../../types';
import { i18n } from '@/i18n';
import { useSessionStore } from '@/stores/useSessionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * The compaction and diagnostic messages crossing the wire into the session store.
 *
 * These run through the REAL registry and the REAL store, because a handler that exists but is not
 * registered is as broken as one that does nothing, and the adapter is the only other place these
 * message types appear.
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

function dispatch(msg: ExtensionToWebviewMessage, ctx: HandlerContext, registry = buildRegistry()): void {
  const handler = registry[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

describe('a replayed steer chip', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  it('keeps its images', () => {
    const ctx = context();
    dispatch({ type: 'userReplay', content: 'look', contentBlocks: [PNG], isInjected: true, steerTarget: { agentId: 'a1' }, promptIndex: 0 }, ctx);

    expect(useStreamingStore().messages.at(-1)).toMatchObject({ content: 'look', isReplay: true, contentBlocks: [PNG], steerTarget: { agentId: 'a1' } });
  });
});

describe('compactionAborted reaches the transcript', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('stores a retrying abort with its trigger and willRetry', () => {
    const ctx = context();
    dispatch(
      { type: 'compactionAborted', trigger: 'overflow', willRetry: true, timestamp: 4242 },
      ctx,
    );

    expect(useSessionStore().compactionAbortedNotices).toHaveLength(1);
    expect(useSessionStore().compactionAbortedNotices[0]).toMatchObject({
      trigger: 'overflow',
      willRetry: true,
      timestamp: 4242,
    });
  });

  it('stores an abort that will not retry, together with its error message', () => {
    const ctx = context();
    dispatch(
      {
        type: 'compactionAborted',
        trigger: 'threshold',
        willRetry: false,
        errorMessage: 'summary model returned no content',
        timestamp: 99,
      },
      ctx,
    );

    expect(useSessionStore().compactionAbortedNotices[0]).toMatchObject({
      trigger: 'threshold',
      willRetry: false,
      errorMessage: 'summary model returned no content',
    });
  });
});

describe('thinkingDroppedNotice reaches the transcript', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('stores the count and the reasons exactly as the adapter rendered them', () => {
    const ctx = context();
    dispatch(
      {
        type: 'thinkingDroppedNotice',
        count: 2,
        reasons: ['signature mismatch at content[0]', 'unknown reason'],
        timestamp: 777,
      },
      ctx,
    );

    expect(useSessionStore().thinkingDroppedNotices[0]).toMatchObject({
      count: 2,
      reasons: ['signature mismatch at content[0]', 'unknown reason'],
      timestamp: 777,
    });
  });
});

describe('compactBoundary carries the trigger and the billed usage', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps overflow distinct from threshold on the marker', () => {
    const ctx = context();
    dispatch({ type: 'compactBoundary', preTokens: 90_000, trigger: 'overflow', timestamp: 10 }, ctx);

    expect(useSessionStore().compactMarkers[0]!.trigger).toBe('overflow');
  });

  it('carries billedTokens and billedCost onto the marker unchanged', () => {
    const ctx = context();
    dispatch(
      {
        type: 'compactBoundary',
        preTokens: 90_000,
        postTokens: 12_000,
        trigger: 'threshold',
        timestamp: 10,
        billedTokens: 12_400,
        billedCost: 0.004,
      },
      ctx,
    );

    // Sub-cent costs must survive the handler; only the component decides to hide the dollar figure.
    expect(useSessionStore().compactMarkers[0]).toMatchObject({ billedTokens: 12_400, billedCost: 0.004 });
  });

  it('leaves both billing fields off a replayed historical boundary', () => {
    const ctx = context();
    dispatch(
      { type: 'compactBoundary', preTokens: 5_000, trigger: 'manual', timestamp: 10, isHistorical: true },
      ctx,
    );

    expect(useSessionStore().compactMarkers[0]!.billedTokens).toBeUndefined();
    expect(useSessionStore().compactMarkers[0]!.billedCost).toBeUndefined();
  });

  it('keeps every notice when the boundary carries no summary, because nothing was removed', () => {
    const ctx = context();
    dispatch({ type: 'compactionAborted', trigger: 'threshold', willRetry: true, timestamp: 1 }, ctx);
    dispatch({ type: 'thinkingDroppedNotice', count: 1, reasons: ['unknown reason'], timestamp: 2 }, ctx);
    dispatch({ type: 'compactBoundary', preTokens: 90_000, trigger: 'threshold', timestamp: 3 }, ctx);

    expect(useSessionStore().compactionAbortedNotices).toHaveLength(1);
    expect(useSessionStore().thinkingDroppedNotices).toHaveLength(1);
    expect(useSessionStore().compactMarkers).toHaveLength(1);
  });
});

describe('what a compaction summary removes from the transcript', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps the abort notice that predicted the retry the summary completed', () => {
    const ctx = context();
    dispatch({ type: 'compactionAborted', trigger: 'threshold', willRetry: true, timestamp: 2 }, ctx);
    dispatch({ type: 'compactBoundary', preTokens: 90_000, trigger: 'threshold', timestamp: 5 }, ctx);
    dispatch({ type: 'compactSummary', summary: 'what the run did so far' }, ctx);

    expect(useSessionStore().compactionAbortedNotices).toHaveLength(1);
  });

  it('drops the notices anchored to the messages the summary removed', () => {
    const ctx = context();
    dispatch({ type: 'cacheMissNotice', missedTokens: 900, missedCost: 0.01, idleMs: 1000, modelChanged: false, timestamp: 2 }, ctx);
    dispatch({ type: 'thinkingDroppedNotice', count: 1, reasons: ['unknown reason'], timestamp: 2 }, ctx);
    dispatch({ type: 'compactBoundary', preTokens: 90_000, trigger: 'threshold', timestamp: 5 }, ctx);
    dispatch({ type: 'compactSummary', summary: 'what the run did so far' }, ctx);

    expect(useSessionStore().cacheMissNotices).toHaveLength(0);
    expect(useSessionStore().thinkingDroppedNotices).toHaveLength(0);
  });

  it('keeps a notice that landed after the boundary the summary cut at', () => {
    const ctx = context();
    dispatch({ type: 'thinkingDroppedNotice', count: 1, reasons: ['unknown reason'], timestamp: 9 }, ctx);
    dispatch({ type: 'compactBoundary', preTokens: 90_000, trigger: 'threshold', timestamp: 5 }, ctx);
    dispatch({ type: 'compactSummary', summary: 'what the run did so far' }, ctx);

    expect(useSessionStore().thinkingDroppedNotices).toHaveLength(1);
  });
});
