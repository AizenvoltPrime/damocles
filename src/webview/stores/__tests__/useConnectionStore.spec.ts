// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { OFFLINE_GRACE_MS, type ChatConnection, type HeldMessageAction } from '@shared/host-connection';
import { useConnectionStore } from '../useConnectionStore';

let current: ChatConnection | undefined;
let listener: ((connection: ChatConnection) => void) | undefined;
const actions: HeldMessageAction[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  current = undefined;
  listener = undefined;
  actions.length = 0;
  window.damoclesBridge = {
    postMessage: () => undefined,
    onMessage: () => () => undefined,
    getState: () => undefined,
    setState: () => undefined,
    getHost: () => undefined,
    onHost: () => () => undefined,
    getOffline: () => undefined,
    hostAction: () => undefined,
    getConnection: () => current,
    onConnection: (next) => {
      listener = next;
      return () => undefined;
    },
    queueAction: (action) => void actions.push(action),
  };
});

afterEach(() => {
  delete (window as { damoclesBridge?: unknown }).damoclesBridge;
});

const QUEUED = { id: 'q1', text: 'deploy it', imageCount: 0, status: 'queued' } as const;

describe('useConnectionStore', () => {
  it('reads main\'s connection at attach and follows its pushes: away while the host is not connected', () => {
    current = { state: { phase: 'waiting', since: 1, retryAt: 2 }, queued: [QUEUED] };
    const store = useConnectionStore();
    store.attach();
    expect(store.away).toBe(true);
    expect(store.queued).toEqual([QUEUED]);
    listener!({ state: { phase: 'connected' }, queued: [{ ...QUEUED, status: 'notSent' }] });
    expect(store.away).toBe(false);
    expect(store.queued.map((message) => message.status)).toEqual(['notSent']);
    listener!({ state: { phase: 'offline' }, queued: [] });
    expect(store.away).toBe(true);
  });

  it('is away at once but shows it (dim, hint) only once the drop outlasted the grace', () => {
    current = { state: { phase: 'running', since: Date.now() }, queued: [] };
    const store = useConnectionStore();
    store.attach();
    expect(store.away).toBe(true);
    expect(store.awayShown).toBe(false);
    listener!({ state: { phase: 'running', since: Date.now() - OFFLINE_GRACE_MS }, queued: [] });
    expect(store.awayShown).toBe(true);
    listener!({ state: { phase: 'offline' }, queued: [] });
    expect(store.awayShown).toBe(true);
  });

  it('asks main for Cancel and Discard and changes nothing itself', () => {
    current = { state: { phase: 'running', since: 1 }, queued: [QUEUED] };
    const store = useConnectionStore();
    store.attach();
    store.cancel('q1');
    store.discard('q2');
    expect(actions).toEqual([{ action: 'cancel', id: 'q1' }, { action: 'discard', id: 'q2' }]);
    expect(store.queued).toEqual([QUEUED]);
  });

  // core's hostCapabilities reach the page over the connection, so a drop before they arrive must not hide main's state
  it('follows main\'s connection on a page whose core has not answered yet, so a failure shows Retry', () => {
    current = { state: { phase: 'failed', since: 1, code: 'hostKeyChanged' }, queued: [QUEUED] };
    const store = useConnectionStore();
    store.attach();
    expect(store.state).toEqual({ phase: 'failed', since: 1, code: 'hostKeyChanged' });
    expect(store.queued).toEqual([QUEUED]);
  });

  it('is always connected and holds nothing on a page main gives no connection (a local chat, VS Code)', () => {
    const store = useConnectionStore();
    store.attach();
    expect(store.away).toBe(false);
    expect(store.queued).toEqual([]);
    delete (window as { damoclesBridge?: unknown }).damoclesBridge;
    setActivePinia(createPinia());
    const bridgeless = useConnectionStore();
    bridgeless.attach();
    expect(bridgeless.away).toBe(false);
  });
});
