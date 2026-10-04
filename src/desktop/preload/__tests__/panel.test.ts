import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  exposed: undefined as undefined | { getState(): unknown; setState(next: unknown): void },
  initAnswers: [] as unknown[],
  sent: [] as Array<[string, unknown]>,
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: typeof H.exposed) => { H.exposed = api; } },
  ipcRenderer: {
    sendSync: () => H.initAnswers.shift(),
    send: (channel: string, payload: unknown) => H.sent.push([channel, payload]),
    on: () => undefined,
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
});
