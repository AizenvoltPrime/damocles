import { describe, expect, it, vi } from 'vitest';
import { ForeignViewRelay, type ForeignCore, type RemoteChatView } from '../foreign-view-relay';
import { CoreNotRunningError } from '../../core-host';
import { FOREIGN_VIEW_NOT_ATTACHED } from '../../../../shared/remote-user';
import { createRemoteChatSettingHandlers } from '../../../../core/chat-panel/message-router/handlers/remote-chat-setting-handlers';
import type { HandlerDependencies } from '../../../../core/chat-panel/message-router/types';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { PanelHost } from '../../../../platform/window-service';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../../shared/types/messages';

const TOOLS_FEATURES = ['tools.setOnHost'];

interface Fake {
  readonly relay: ForeignViewRelay;
  readonly local: ForeignCore;
  readonly calls: Array<readonly unknown[]>;
  readonly posted: Array<readonly [string, string]>;
  readonly views: Map<string, RemoteChatView>;
  readonly attached: Set<string>;
  readonly connections: Map<string, readonly string[]>;
  readonly logged: string[];
}

function fake(): Fake {
  const calls: Array<readonly unknown[]> = [];
  const posted: Array<readonly [string, string]> = [];
  const views = new Map<string, RemoteChatView>();
  const attached = new Set<string>(['loopback']);
  const connections = new Map<string, readonly string[]>([['loopback', TOOLS_FEATURES], ['ssh+other', TOOLS_FEATURES]]);
  const view = (authority: string, id: string, offline?: object): RemoteChatView => ({ authority, offline, postJson: (_type, json) => posted.push([id, json]) });
  views.set('remote-view', view('loopback', 'remote-view'));
  views.set('local-view', view('local', 'local-view'));
  views.set('other-view', view('ssh+other', 'other-view'));
  views.set('transcript-view', view('ssh+other', 'transcript-view', { hostId: 'h1', hostName: 'other' }));
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
  const logged: string[] = [];
  const relay = new ForeignViewRelay({
    chatView: (id) => views.get(id),
    attached: (authority) => attached.has(authority),
    connectionFeatures: (authority) => connections.get(authority),
    hostName: (authority) => `host ${authority}`,
    local,
    log: (line) => logged.push(line),
  });
  return { relay, local, calls, posted, views, attached, connections, logged };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const toast = (view: string, failure: string, detail: unknown): readonly [string, string] =>
  [view, JSON.stringify({ type: 'notification', message: { message: failure, args: [detail] }, notificationType: 'error' })];
const failedResult = (view: string, key: string, detail: unknown): readonly [string, string] =>
  [view, JSON.stringify({ type: 'settingWriteResult', key, ok: false, error: detail })];

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

  it('attaches again after a refused attach, so the view\'s browser calls do not fail until it closes', async () => {
    const { relay, local, calls } = fake();
    let refuse = true;
    const attach = local.attachForeign;
    local.attachForeign = async (...args) => {
      if (refuse) {
        calls.push(['refused', ...args]);
        throw new Error('the local core restarted');
      }
      await attach(...args);
    };
    await expect(relay.attachView('remote-view', 'loopback')).rejects.toThrow('the local core restarted');
    await settle();
    refuse = false;
    await relay.attachView('remote-view', 'loopback');
    await relay.attachView('remote-view', 'loopback');
    expect(calls).toEqual([['refused', 'loopback', 'remote-view'], ['attach', 'loopback', 'remote-view']]);
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

  it('leaves a local chat\'s setting writes to its own core', async () => {
    const { relay, calls } = fake();
    expect(relay.fromView('local-view', { type: 'setPinnedHeaderHidden', hidden: true })).toBe(false);
    expect(relay.fromView('local-view', { type: 'toggleToolGroup', group: 'compass', enabled: true })).toBe(false);
    expect(relay.fromView('local-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false })).toBe(false);
    await settle();
    expect(calls).toEqual([]);
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

  it('lets go of a closed view\'s proxy only after the writes it queued reached the local core', async () => {
    const { relay, local, calls } = fake();
    let land!: () => void;
    const message = local.foreignMessage;
    local.foreignMessage = async (...args) => {
      await new Promise<void>((resolve) => (land = resolve));
      await message(...args);
    };
    relay.fromView('remote-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false });
    await settle();
    relay.viewClosed('remote-view');
    await settle();
    expect(calls).toEqual([['attach', 'loopback', 'remote-view']]);
    land();
    await settle();
    expect(calls).toEqual([
      ['attach', 'loopback', 'remote-view'],
      ['message', 'remote-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false }],
      ['detach', 'remote-view'],
    ]);
  });
});

describe('a remote chat view\'s user-setting writes (main side)', () => {
  it('go to this computer\'s core, also while the chat\'s own core is not attached', async () => {
    const { relay, calls, logged } = fake();
    const writes = [
      { type: 'setPinnedHeaderHidden', hidden: true },
      { type: 'toggleToolGroup', group: 'compass', enabled: true },
      { type: 'toggleTool', toolName: 'WebFetch', enabled: false },
    ];
    for (const message of writes) expect(relay.fromView('other-view', message)).toBe(true);
    await settle();
    expect(calls).toEqual([['attach', 'ssh+other', 'other-view'], ...writes.map((message) => ['message', 'other-view', message])]);
    expect(logged).toEqual(writes.map(({ type }) => `[foreign-view] ${type} from a chat on ssh+other goes to this computer's core`));
  });

  it('send a Tools switch while the host is away when its last connection in this run listed tools.setOnHost', async () => {
    const { relay, calls, connections, posted } = fake();
    relay.hostConnected('ssh+other', TOOLS_FEATURES);
    connections.delete('ssh+other');
    relay.fromView('other-view', { type: 'toggleToolGroup', group: 'compass', enabled: false });
    await settle();
    expect(calls).toContainEqual(['message', 'other-view', { type: 'toggleToolGroup', group: 'compass', enabled: false }]);
    expect(posted).toEqual([]);
  });

  it('answer a Tools switch for a daemon without tools.setOnHost with a failed result and its toast, and send the pin', async () => {
    const { relay, calls, connections, posted } = fake();
    connections.set('ssh+other', ['core.attach']);
    relay.fromView('other-view', { type: 'toggleToolGroup', group: 'compass', enabled: true });
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false });
    relay.fromView('other-view', { type: 'setPinnedHeaderHidden', hidden: true });
    await settle();
    const update = { message: 'Update Damocles on {0} to change this switch from its chats.', args: ['host ssh+other'] };
    expect(posted).toEqual([
      toast('other-view', 'Failed to save tool group setting: {0}', update),
      failedResult('other-view', 'damocles.compass.enabled', update),
      toast('other-view', 'Failed to save tool setting: {0}', update),
      failedResult('other-view', 'damocles.tools.disabled', update),
    ]);
    expect(calls).toEqual([['attach', 'ssh+other', 'other-view'], ['message', 'other-view', { type: 'setPinnedHeaderHidden', hidden: true }]]);
  });

  it('answer a Tools switch for a host that never connected in this run as not connected', async () => {
    const { relay, calls, connections, posted } = fake();
    connections.delete('ssh+other');
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false });
    await settle();
    const away = { message: '{0} is not connected.', args: ['host ssh+other'] };
    expect(posted).toEqual([toast('other-view', 'Failed to save tool setting: {0}', away), failedResult('other-view', 'damocles.tools.disabled', away)]);
    expect(calls).toEqual([]);
  });

  it('answer a refused Tools switch after the writes the view queued before it', async () => {
    const { relay, local, connections, posted } = fake();
    let land!: () => void;
    local.foreignMessage = async (viewId) => {
      await new Promise<void>((resolve) => (land = resolve));
      relay.foreignPost(viewId, { type: 'settingWriteResult', key: 'damocles.tools.disabled', ok: true, scope: 'user' });
    };
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'A', enabled: false });
    await settle();
    connections.set('ssh+other', []);
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'B', enabled: false });
    await settle();
    expect(posted).toEqual([]);
    land();
    await settle();
    expect(posted.map(([, json]) => (JSON.parse(json) as { type: string; ok?: boolean }).ok)).toEqual([true, undefined, false]);
  });

  it('from a transcript, send the pin and drop the Tools switches, which its page never shows', async () => {
    const { relay, calls, posted, logged } = fake();
    expect(relay.fromView('transcript-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false })).toBe(true);
    expect(relay.fromView('transcript-view', { type: 'toggleToolGroup', group: 'compass', enabled: true })).toBe(true);
    expect(relay.fromView('transcript-view', { type: 'setPinnedHeaderHidden', hidden: true })).toBe(true);
    await settle();
    expect(calls).toEqual([['attach', 'ssh+other', 'transcript-view'], ['message', 'transcript-view', { type: 'setPinnedHeaderHidden', hidden: true }]]);
    expect(posted).toEqual([]);
    expect(logged.filter((line) => line.includes('transcript'))).toHaveLength(2);
  });

  it('answer a write the local core never took because it is not running with the engine text, under the handler\'s key', async () => {
    const { relay, local, posted } = fake();
    local.foreignMessage = async () => {
      throw new CoreNotRunningError();
    };
    relay.fromView('other-view', { type: 'toggleToolGroup', group: 'compass', enabled: true });
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false });
    relay.fromView('other-view', { type: 'setPinnedHeaderHidden', hidden: true });
    relay.fromView('remote-view', { type: 'startVoiceRecording' });
    await settle();
    const detail = { message: "This computer's Damocles engine is not running." };
    expect(posted).toEqual([
      toast('other-view', 'Failed to save tool group setting: {0}', detail),
      failedResult('other-view', 'damocles.compass.enabled', detail),
      toast('other-view', 'Failed to save tool setting: {0}', detail),
      failedResult('other-view', 'damocles.tools.disabled', detail),
      toast('other-view', 'Failed to save pinned header setting: {0}', detail),
      failedResult('other-view', 'damocles.pinnedHeaderHidden', detail),
    ]);
  });

  it.each([
    { type: 'setPinnedHeaderHidden', hidden: true },
    { type: 'toggleToolGroup', group: 'browser', enabled: true },
    { type: 'toggleTool', toolName: 'WebFetch', enabled: false },
  ])('answer an unanswered $type under the key and toast wording this computer\'s core gives it', async (write) => {
    const platform = createFakePlatform({ host: 'desktop' });
    vi.spyOn(platform.settings, 'update').mockRejectedValue(new Error('EACCES'));
    const fromCore: ExtensionToWebviewMessage[] = [];
    const handlers = createRemoteChatSettingHandlers({ platform, postMessage: (_host, message) => void fromCore.push(message) } as Pick<HandlerDependencies, 'postMessage' | 'platform'>);
    await handlers[write.type]!(write as unknown as WebviewToExtensionMessage, { host: {} as PanelHost });

    const { relay, local, posted } = fake();
    local.foreignMessage = async () => {
      throw new CoreNotRunningError();
    };
    relay.fromView('other-view', write);
    await settle();
    const fromMain = posted.map(([, json]) => JSON.parse(json) as ExtensionToWebviewMessage);

    const shape = (messages: ExtensionToWebviewMessage[]) => messages.map((message) =>
      message.type === 'notification' ? { type: message.type, wording: (message.message as { message: string }).message } : message.type === 'settingWriteResult' ? { type: message.type, key: message.key, ok: message.ok } : message);
    expect(shape(fromMain)).toEqual(shape(fromCore));
    expect(fromMain).toHaveLength(2);
  });

  it('answer any other failure with the generic text', async () => {
    const { relay, local, posted, logged } = fake();
    local.foreignMessage = async () => {
      throw new Error('Malformed tool setting');
    };
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false });
    await settle();
    const detail = { message: 'An unexpected error occurred. The log has the details.' };
    expect(posted).toEqual([toast('other-view', 'Failed to save tool setting: {0}', detail), failedResult('other-view', 'damocles.tools.disabled', detail)]);
    expect(logged).toContain('[foreign-view] toggleTool from a chat on ssh+other failed: Malformed tool setting');
  });

  it('attach the view again once and send once more when the local core lost its proxy to a restart', async () => {
    const { relay, local, calls, posted } = fake();
    let refusals = 1;
    const message = local.foreignMessage;
    local.foreignMessage = async (...args) => {
      if (refusals-- > 0) {
        calls.push(['refused', ...args]);
        throw new Error(FOREIGN_VIEW_NOT_ATTACHED);
      }
      await message(...args);
      relay.foreignPost(args[0], { type: 'settingWriteResult', key: 'damocles.tools.disabled', ok: true, scope: 'user' });
    };
    relay.fromView('other-view', { type: 'toggleTool', toolName: 'WebFetch', enabled: false });
    relay.localCoreStarted();
    await settle();
    const write = { type: 'toggleTool', toolName: 'WebFetch', enabled: false };
    expect(calls).toEqual([['attach', 'ssh+other', 'other-view'], ['refused', 'other-view', write], ['attach', 'ssh+other', 'other-view'], ['message', 'other-view', write]]);
    expect(posted).toEqual([['other-view', JSON.stringify({ type: 'settingWriteResult', key: 'damocles.tools.disabled', ok: true, scope: 'user' })]]);
  });

  it('answer a write whose retry is refused again with the generic text, retrying only once', async () => {
    const { relay, local, calls, posted } = fake();
    local.foreignMessage = async (...args) => {
      calls.push(['refused', ...args]);
      throw new Error(FOREIGN_VIEW_NOT_ATTACHED);
    };
    relay.fromView('other-view', { type: 'setPinnedHeaderHidden', hidden: true });
    await settle();
    expect(calls.filter(([kind]) => kind === 'refused')).toHaveLength(2);
    const detail = { message: 'An unexpected error occurred. The log has the details.' };
    expect(posted).toEqual([toast('other-view', 'Failed to save pinned header setting: {0}', detail), failedResult('other-view', 'damocles.pinnedHeaderHidden', detail)]);
  });

  it('deliver a result and toast while the host is not attached only while one of the view\'s writes waits for its answer', async () => {
    const { relay, local, posted, views, logged } = fake();
    const result = { type: 'settingWriteResult', key: 'damocles.pinnedHeaderHidden', ok: true, scope: 'user' };
    const failure = { type: 'notification', message: { message: 'Failed' }, notificationType: 'error' };
    local.foreignMessage = async (viewId) => {
      relay.foreignPost(viewId, failure);
      relay.foreignPost(viewId, result);
      relay.foreignPost(viewId, { type: 'transcriptionResult', text: 'not attached' });
      relay.foreignPost(viewId, { type: 'toolStatus', data: { groups: [], tools: [] } });
    };
    relay.foreignPost('other-view', result);
    relay.fromView('other-view', { type: 'setPinnedHeaderHidden', hidden: true });
    await settle();
    expect(posted).toEqual([['other-view', JSON.stringify(failure)], ['other-view', JSON.stringify(result)]]);

    // a toast the local core posts once the write settled, a voice one say, waits for the host to attach
    relay.foreignPost('other-view', failure);
    relay.foreignPost('other-view', { type: 'sessionStarted', sessionId: 'local-session' });
    expect(posted).toHaveLength(2);
    expect(logged.filter((line) => line.includes('dropped'))).toEqual([
      '[foreign-view] dropped a settingWriteResult post for view other-view, which this proxy does not deliver',
      '[foreign-view] dropped a transcriptionResult post for view other-view, which this proxy does not deliver',
      '[foreign-view] dropped a toolStatus post for view other-view, which this proxy does not deliver',
      '[foreign-view] dropped a notification post for view other-view, which this proxy does not deliver',
      '[foreign-view] dropped a sessionStarted post for view other-view, which this proxy does not deliver',
    ]);
    views.delete('other-view');
    relay.foreignPost('other-view', result);
    expect(posted).toHaveLength(2);
  });
});
