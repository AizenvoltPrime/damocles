import { describe, expect, it } from 'vitest';
import { VoiceRelay, type ForeignCore, type RemoteChatView } from '../voice-relay';

interface Fake {
  readonly relay: VoiceRelay;
  readonly calls: Array<readonly unknown[]>;
  readonly posted: Array<readonly [string, string]>;
  readonly views: Map<string, RemoteChatView>;
  readonly attached: Set<string>;
}

function fake(): Fake {
  const calls: Array<readonly unknown[]> = [];
  const posted: Array<readonly [string, string]> = [];
  const views = new Map<string, RemoteChatView>();
  const attached = new Set<string>(['loopback']);
  const view = (authority: string, id: string): RemoteChatView => ({ authority, postJson: (_type, json) => posted.push([id, json]) });
  views.set('remote-view', view('loopback', 'remote-view'));
  views.set('local-view', view('local', 'local-view'));
  views.set('other-view', view('ssh+other', 'other-view'));
  const local: ForeignCore = {
    attachForeign: async (...args) => {
      calls.push(['attach', ...args]);
    },
    detachForeign: async (...args) => {
      calls.push(['detach', ...args]);
    },
    foreignMessage: async (...args) => {
      calls.push(['message', ...args]);
    },
    speak: async (...args) => {
      calls.push(['speak', ...args]);
    },
  };
  const relay = new VoiceRelay({ chatView: (id) => views.get(id), attached: (authority) => attached.has(authority), local, log: () => undefined });
  return { relay, calls, posted, views, attached };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('foreign views (main side)', () => {
  it('routes only VOICE_VIEW_MESSAGES of a live remote chat view to this computer\'s core, attaching its proxy once', async () => {
    const { relay, calls } = fake();
    expect(relay.fromView('remote-view', { type: 'startVoiceRecording' })).toBe(true);
    expect(relay.fromView('remote-view', { type: 'stopVoiceRecording' })).toBe(true);
    expect(relay.fromView('remote-view', { type: 'sendMessage', text: 'hi' })).toBe(false);
    expect(relay.fromView('remote-view', { type: 'setVoiceApiKey', apiKey: 'k' })).toBe(false);
    await settle();
    expect(calls).toEqual([
      ['attach', 'loopback', 'remote-view'],
      ['message', 'remote-view', { type: 'startVoiceRecording' }],
      ['message', 'remote-view', { type: 'stopVoiceRecording' }],
    ]);
  });

  it('leaves a local chat\'s voice to its own core and takes nothing from an unknown view', async () => {
    const { relay, calls } = fake();
    expect(relay.fromView('local-view', { type: 'startVoiceRecording' })).toBe(false);
    expect(relay.fromView('no-such-view', { type: 'startVoiceRecording' })).toBe(false);
    await settle();
    expect(calls).toEqual([]);
  });

  it('drops a remote chat\'s voice while its authority is not attached', async () => {
    const { relay, calls } = fake();
    expect(relay.fromView('other-view', { type: 'startVoiceRecording' })).toBe(true);
    await settle();
    expect(calls).toEqual([]);
  });

  it('delivers only a voice post of a proxy, and only to that live remote view of an attached authority', async () => {
    const { relay, posted, views, attached } = fake();
    relay.foreignPost('remote-view', { type: 'transcriptionResult', text: 'hello' });
    expect(posted).toEqual([]);
    relay.fromView('remote-view', { type: 'startVoiceRecording' });
    await settle();
    relay.foreignPost('remote-view', { type: 'transcriptionResult', text: 'hello' });
    relay.foreignPost('local-view', { type: 'transcriptionResult', text: 'x' });
    relay.foreignPost('remote-view', { type: 'sessionStarted', sessionId: 'local-session' });
    expect(posted).toEqual([['remote-view', JSON.stringify({ type: 'transcriptionResult', text: 'hello' })]]);
    attached.delete('loopback');
    relay.foreignPost('remote-view', { type: 'transcriptionResult', text: 'late' });
    attached.add('loopback');
    views.delete('remote-view');
    relay.foreignPost('remote-view', { type: 'transcriptionResult', text: 'closed' });
    expect(posted).toHaveLength(1);
  });

  it('speaks a remote reply only for a view of that authority, and lets go of a closed view\'s proxy', async () => {
    const { relay, calls } = fake();
    await relay.speak('loopback', 'remote-view', 'Done.');
    await expect(relay.speak('ssh+other', 'remote-view', 'x')).rejects.toThrow('No chat of this host');
    await expect(relay.speak('loopback', 'local-view', 'x')).rejects.toThrow();
    relay.fromView('remote-view', { type: 'startVoiceRecording' });
    await settle();
    relay.viewClosed('remote-view');
    await settle();
    expect(calls).toEqual([
      ['speak', 'remote-view', 'Done.'],
      ['attach', 'loopback', 'remote-view'],
      ['message', 'remote-view', { type: 'startVoiceRecording' }],
      ['detach', 'remote-view'],
    ]);
  });
});
