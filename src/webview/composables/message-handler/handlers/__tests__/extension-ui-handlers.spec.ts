// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createApp } from 'vue';
import { createHandlerRegistry } from '../../handler-registry';
import type { HandlerRegistry, HandlerContext } from '../../types';
import { i18n } from '@/i18n';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * Slice 2 §5 — the webview end of the extension-UI seam, driven through the REAL registry and the
 * REAL store. The registry is included (not just the handler factory) because a handler that exists
 * but is never registered is exactly as broken as one that does nothing, and only the registry proves
 * the message type is actually routed.
 *
 * The messages fed in here are `ExtensionToWebviewMessage` values, so a shape the extension cannot
 * emit will not type-check.
 */

type UiRequestMessage = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;

function context(): HandlerContext {
  // Only `stores.extensionUiStore` is touched by these handlers; the rest of HandlerContext is
  // irrelevant here and deliberately absent rather than stubbed into something that could be trusted.
  return { stores: { extensionUiStore: useExtensionUiStore() } } as unknown as HandlerContext;
}

/**
 * `createHandlerRegistry` calls `useI18n()`, which is only legal inside a component `setup`. Build it
 * the way the webview does rather than bypassing the registry — routing is half of what is under test.
 */
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

const request = (over: Partial<UiRequestMessage> = {}): UiRequestMessage => ({
  type: 'extensionUiRequest',
  requestId: 'r1',
  kind: 'select',
  title: 'MCP Input Request',
  options: ['Continue', 'Decline'],
  ...over,
});

describe('extensionUiRequest handler', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('forwards nested-agent attribution into the store', () => {
    const ctx = context();
    dispatch(request({ requestId: 'r1', agentId: 'ag-1', agentName: 'Scout', teamId: 'team-9' }), ctx);

    expect(ctx.stores.extensionUiStore.current).toMatchObject({
      requestId: 'r1',
      agentId: 'ag-1',
      agentName: 'Scout',
      teamId: 'team-9',
    });
  });

  it('OMITS attribution keys for a panel-owned dialog rather than storing undefined', () => {
    // The dialog branches on `current.agentName` being present. An explicit `agentName: undefined`
    // renders the same today but makes "is this an agent's dialog?" a truthiness question again —
    // the exact class of predicate this slice exists to remove.
    const ctx = context();
    dispatch(request({ requestId: 'panel' }), ctx);

    const stored = ctx.stores.extensionUiStore.current!;
    expect('agentId' in stored).toBe(false);
    expect('agentName' in stored).toBe(false);
    expect('teamId' in stored).toBe(false);
  });

  it('queues two concurrent agents; answering the first surfaces the second (§4.3)', () => {
    const ctx = context();
    dispatch(request({ requestId: 'r1', agentId: 'ag-1', agentName: 'Scout' }), ctx);
    dispatch(request({ requestId: 'r2', agentId: 'ag-2', agentName: 'Builder' }), ctx);

    const store = ctx.stores.extensionUiStore;
    expect(store.queue).toHaveLength(2);
    expect(store.current?.requestId).toBe('r1');

    store.resolve('r1');
    expect(store.current?.requestId).toBe('r2');
    expect(store.current?.agentName).toBe('Builder');
  });
});

describe('extensionUiCancel handler', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('drops the withdrawn request by id even when it is not the head (§4.5)', () => {
    const ctx = context();
    dispatch(request({ requestId: 'r1', agentId: 'ag-1' }), ctx);
    dispatch(request({ requestId: 'r2', agentId: 'ag-2' }), ctx);

    dispatch({ type: 'extensionUiCancel', requestId: 'r2' }, ctx);

    expect(ctx.stores.extensionUiStore.queue.map((r) => r.requestId)).toEqual(['r1']);
    expect(ctx.stores.extensionUiStore.current?.requestId).toBe('r1');
  });

  it('is registered in the real handler registry', () => {
    // Guards the wiring, not the body: an unregistered type is dropped by the router with no error.
    expect(buildRegistry().extensionUiCancel).toBeTypeOf('function');
  });
});
