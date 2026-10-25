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
    H.initAnswers.push({ state: null, theme: { kind: 'dark', css: '', reducedMotion: false }, host: { hostId: 'h1', name: 'prod-1' } });
    expect(bridge.getState()).toBeNull();
    expect(heard).toEqual(['prod-1']);
    expect(bridge.getHost()).toEqual({ hostId: 'h1', name: 'prod-1' });
    expect([...H.handlers.keys()].sort()).toEqual([PANEL_CHANNELS.message, PANEL_CHANNELS.theme].sort());
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
