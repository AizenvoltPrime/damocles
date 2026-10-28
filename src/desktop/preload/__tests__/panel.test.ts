import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_CHANNELS } from '../panel-channels';

const H = vi.hoisted(() => ({
  exposed: undefined as undefined | {
    getState(): unknown;
    setState(next: unknown): void;
    onMessage(listener: (message: unknown) => void): () => void;
    getHost(): { name: string } | undefined;
    onHost(listener: (host: { name: string }) => void): () => void;
  },
  handlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  initAnswers: [] as unknown[],
  sent: [] as Array<[string, unknown]>,
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: typeof H.exposed) => { H.exposed = api; } },
  ipcRenderer: {
    sendSync: () => H.initAnswers.shift(),
    send: (channel: string, payload: unknown) => H.sent.push([channel, payload]),
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      H.handlers.set(channel, handler);
    },
  },
}));

// The preload runs in a page; only the listener registration touches the document here.
vi.stubGlobal('document', { addEventListener: () => undefined });

beforeEach(() => {
  H.initAnswers.length = 0;
  H.sent.length = 0;
});

describe('panel preload', () => {
  it('answers no state while main refuses the frame, then hydrates on a later call', async () => {
    await import('../panel');
    const bridge = H.exposed!;

    H.initAnswers.push(null);
    expect(bridge.getState()).toBeUndefined();

    H.initAnswers.push({ state: { sessionId: 's1' }, theme: { kind: 'dark', css: '', reducedMotion: false } });
    expect(bridge.getState()).toEqual({ sessionId: 's1' });
    bridge.setState({ sessionId: 's2' });
    expect(bridge.getState()).toEqual({ sessionId: 's2' });
    expect(H.sent).toEqual([['damocles:panel:set-state', { sessionId: 's2' }]]);
  });

  it('tells a page that read no host before main answered its init the host once main does, and listens on no channel without a sender', async () => {
    vi.resetModules();
    await import('../panel');
    const bridge = H.exposed!;
    const heard: string[] = [];
    bridge.onHost((host) => heard.push(host.name));
    H.initAnswers.push(null);
    expect(bridge.getHost()).toBeUndefined();
    H.initAnswers.push({ state: null, theme: { kind: 'dark', css: '', reducedMotion: false }, host: { hostId: 'h1', name: 'prod-1', computer: 'laptop' } });
    expect(bridge.getState()).toBeNull();
    expect(heard).toEqual(['prod-1']);
    expect(bridge.getHost()).toEqual({ hostId: 'h1', name: 'prod-1', computer: 'laptop' });
    expect([...H.handlers.keys()].sort()).toEqual([PANEL_CHANNELS.message, PANEL_CHANNELS.theme, PANEL_CHANNELS.host, PANEL_CHANNELS.connection].sort());
  });

  it('takes a renamed host main pushes, telling the page, and reads the offline transcript flag from the init', async () => {
    vi.resetModules();
    await import('../panel');
    const bridge = H.exposed! as NonNullable<typeof H.exposed> & { getOffline(): unknown };
    const heard: string[] = [];
    bridge.onHost((host) => heard.push(host.name));
    H.initAnswers.push({ state: null, theme: { kind: 'dark', css: '', reducedMotion: false }, host: { hostId: 'h1', name: 'prod-1', computer: 'laptop' }, offline: { hostId: 'h1', hostName: 'prod-1' } });
    expect(bridge.getOffline()).toEqual({ hostId: 'h1', hostName: 'prod-1' });
    H.handlers.get(PANEL_CHANNELS.host)!({}, { hostId: 'h1', name: 'billing-prod', color: 'danger', computer: 'laptop' });
    expect(heard).toEqual(['prod-1', 'billing-prod']);
    expect(bridge.getHost()).toEqual({ hostId: 'h1', name: 'billing-prod', color: 'danger', computer: 'laptop' });
  });

  it('reads a remote chat\'s connection from the init, follows main\'s pushes and sends a chip\'s Cancel with only its action and id', async () => {
    vi.resetModules();
    await import('../panel');
    const bridge = H.exposed! as NonNullable<typeof H.exposed> & { getConnection(): unknown; onConnection(listener: (connection: unknown) => void): () => void; queueAction(action: unknown): void };
    const heard: unknown[] = [];
    bridge.onConnection((connection) => heard.push(connection));
    const away = { state: { phase: 'waiting', since: 1, retryAt: 2 }, queued: [{ id: 'q1', text: 'hi', imageCount: 0, status: 'queued' }] };
    H.initAnswers.push({ state: null, theme: { kind: 'dark', css: '', reducedMotion: false }, connection: away });
    expect(bridge.getConnection()).toEqual(away);
    const back = { state: { phase: 'connected' }, queued: [] };
    H.handlers.get(PANEL_CHANNELS.connection)!({}, back);
    expect(heard).toEqual([away, back]);
    expect(bridge.getConnection()).toEqual(back);
    bridge.queueAction({ action: 'cancel', id: 'q1', extra: 'dropped' });
    expect(H.sent).toEqual([[PANEL_CHANNELS.queueAction, { action: 'cancel', id: 'q1' }]]);
  });

  it("sends the banner's Reconnect or Sign in to main on its own channel", async () => {
    vi.resetModules();
    await import('../panel');
    const bridge = H.exposed! as NonNullable<typeof H.exposed> & { hostAction(action: string): void };
    bridge.hostAction('reconnect');
    bridge.hostAction('signIn');
    expect(H.sent).toEqual([[PANEL_CHANNELS.hostAction, 'reconnect'], [PANEL_CHANNELS.hostAction, 'signIn']]);
  });

  it('hands the page each host message, drops text that is not JSON and says so in the page console', async () => {
    await import('../panel');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const received: unknown[] = [];
    H.exposed!.onMessage((message) => received.push(message));
    const deliver = H.handlers.get(PANEL_CHANNELS.message)!;
    expect(() => deliver({}, '{"type":"partial"')).not.toThrow();
    deliver({}, '{"type":"ready"}');
    const frame = { type: 'frame', data: new Uint8Array([1]) };
    deliver({}, frame);
    expect(received).toEqual([{ type: 'ready' }, frame]);
    expect(warn).toHaveBeenCalledWith('[damocles] dropped a host message that is not JSON');
    warn.mockRestore();
  });
});
