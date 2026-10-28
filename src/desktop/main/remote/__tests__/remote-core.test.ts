import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakePanelHost } from '../../../../__mocks__/fake-platform';
import type { Disposable } from '../../../../platform/disposable';
import { attachedTransport, createCoreEndpoint, createLoopback, type ChatEntry, type ChatPermissions, type CoreEndpoint } from '../../../core-protocol';
import type { CoreAttach, CoreState } from '../../../daemon/control-messages';
import { createDesktopKeyValueState } from '../../../local-services/key-value-state';
import type { RelayView } from '../../core-services/host-services';
import { hostExtras } from '../../core-services/__tests__/host-deps';
import type { RemoteConnection } from '../connection';
import { RemoteCore, type RemoteHostedCore } from '../remote-core';
import { UserRelays } from '../user-relays';

const EPOCH_A = 'a'.repeat(32);
const EPOCH_B = 'b'.repeat(32);
const TOKEN = '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60';
const PLAN: ChatPermissions = { permissionMode: 'plan', dangerouslySkipPermissions: true };
const target = { key: '/srv/app', fsPath: '/srv/app', name: 'app', label: 'app', projectScope: true };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The daemon's side: control answers and events, and one core endpoint per attach generation, over the connection main
// holds now; a dropped connection fails its requests in flight, as an endpoint closing does.
function fakeDaemon(epoch: string, phase: CoreState['phase'] = 'running') {
  const attaches: CoreAttach[] = [];
  const cores = new Map<number, CoreEndpoint>();
  const stateListeners = new Set<(state: CoreState) => void>();
  let state: CoreState = { epoch, phase, restarts: 0, pid: 42, ppid: 41 };
  let join: (viewKey: string) => { panelId: string } | null = () => null;
  // attachCore answers only once released, so a test can drop the connection while one is in flight
  let held: Promise<void> | undefined;
  const restores: Array<{ viewId: string; permissions?: ChatPermissions }> = [];
  const report = (next: CoreState): void => {
    state = next;
    for (const listener of [...stateListeners]) listener(state);
  };
  const open = (): RemoteConnection => {
    const channel = createLoopback();
    const closeListeners = new Set<(reason: string) => void>();
    let closedWith: string | undefined;
    let failInFlight!: (err: Error) => void;
    const closed = new Promise<never>((_resolve, reject) => (failInFlight = reject));
    closed.catch(() => undefined);
    const control = {
      request: async (method: string, params: unknown) => {
        if (closedWith !== undefined) throw new Error(`closed: ${closedWith}`);
        if (method === 'attachCore') {
          const attach = params as CoreAttach;
          attaches.push(attach);
          if (held) await Promise.race([held, closed]);
          const transport = attachedTransport(channel.core, attach.attach, () => undefined);
          transport.open();
          const core = createCoreEndpoint(transport, () => undefined);
          core.serve('views.join', ({ viewKey }) => join(viewKey));
          core.serve('chats.restore', ({ viewId, permissions }) => {
            restores.push({ viewId, ...(permissions ? { permissions } : {}) });
          });
          cores.set(attach.attach, core);
          // core publishes its folder targets once it serves this attach; while a restart replaces it, nothing is served
          if (state.phase === 'running') setTimeout(() => core.publish('folderTargets', { defaultKey: target.key, targets: [target] }), 0);
          return state;
        }
        if (method === 'restartCore') {
          state = { ...state, phase: 'restarting' };
          return state;
        }
        throw new Error(`no ${method} here`);
      },
      onEvent: (name: string, listener: (state: CoreState) => void): Disposable => {
        if (name !== 'coreState') throw new Error(name);
        stateListeners.add(listener);
        return { dispose: () => { stateListeners.delete(listener); } };
      },
    };
    return {
      facts: {},
      skewMs: 0,
      control,
      workspace: {},
      coreChannel: channel.main,
      onClose: (listener: (reason: string) => void): Disposable => {
        if (closedWith !== undefined) {
          listener(closedWith);
          return { dispose: () => undefined };
        }
        closeListeners.add(listener);
        return { dispose: () => { closeListeners.delete(listener); } };
      },
      close: (reason: string) => {
        if (closedWith !== undefined) return;
        closedWith = reason;
        failInFlight(new Error(`closed: ${reason}`));
        for (const listener of [...closeListeners]) listener(reason);
      },
    } as unknown as RemoteConnection;
  };
  let connection = open();
  return {
    get connection(): RemoteConnection {
      return connection;
    },
    // the connection dropped and main reached the daemon again
    reconnect: (): RemoteConnection => {
      connection.close('dropped');
      connection = open();
      return connection;
    },
    // a new connection while the one before has not closed yet; answers the one before
    replace: (): RemoteConnection => {
      const previous = connection;
      connection = open();
      return previous;
    },
    attaches,
    cores,
    restores,
    // main's coreState listeners, over every connection it ever had
    stateListeners: (): number => stateListeners.size,
    holdAttaches: (): (() => void) => {
      let release!: () => void;
      held = new Promise((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
    },
    joinAs: (answer: (viewKey: string) => { panelId: string } | null) => { join = answer; },
    // the daemon draws a new epoch for a restarted core and tells every client
    newEpoch: (next: string) => report({ ...state, epoch: next, pid: 43, phase: 'running' }),
    // restartCore on a running core: the old epoch restarting, which an attach then made is not served on
    restarting: () => report({ ...state, phase: 'restarting' }),
    // the restart budget ran out: no core runs until a restartCore
    halted: () => report({ ...state, phase: 'halted', pid: null }),
    // what changed while main was away, which the next attachCore answers: a new core, of a restarted daemon when ppid moved
    whileAway: (next: Pick<CoreState, 'epoch' | 'ppid'>) => { state = { ...state, ...next }; },
  };
}

function relayView(host: FakePanelHost, panelId: string, pages: unknown[]): RelayView & FakePanelHost {
  return Object.assign(host, { panelId, postJson: () => undefined, showPage: (page: unknown) => pages.push(page), closeReason: 'detach' as const });
}

function remote(daemon: ReturnType<typeof fakeDaemon>, lastEpoch: string | null, reopenFails = false) {
  const main = createFakePlatform({ chatBrowserPane: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-core-'));
  dirs.push(userData);
  const opened: Array<{ readonly rejoin: boolean; readonly kept: ReadonlyMap<string, ChatPermissions>; readonly core: RemoteHostedCore }> = [];
  const views: Array<{ viewId: string; panelToken: string }> = [];
  const reattached: Array<'server' | 'engine' | undefined> = [];
  let coresEnded = 0;
  // the chats being reopened settle only once released
  let reopening: Promise<void> | undefined;
  const holdReopens = (): (() => void) => {
    let release!: () => void;
    reopening = new Promise((resolve) => (release = resolve));
    return () => {
      reopening = undefined;
      release();
    };
  };
  const core = new RemoteCore({
    authority: 'loopback',
    hostId: 'loopback',
    connection: () => daemon.connection,
    services: () => ({
      platform: main,
      trust: { trustedKeys: () => [], onDidGrant: () => ({ dispose: () => undefined }), requestTrust: async () => false },
      state: createDesktopKeyValueState(userData, () => undefined),
      terminalToggle: () => ({ shown: false, shortcut: 'Ctrl+`' }),
      resolveProxy: async () => 'DIRECT',
      createView: () => { throw new Error('no view here'); },
      git: { available: true },
      e2eHooks: false,
      ...hostExtras(),
      log: () => undefined,
    }),
    lastEpoch,
    openTabs: async (attached, rejoin, kept) => {
      opened.push({ rejoin, kept, core: attached });
      await reopening;
      if (reopenFails) throw new Error('the window is closing');
    },
    chatViews: () => views,
    retainTabStates: () => undefined,
    subscribe: () => [],
    sharedLoopback: true,
    relays: new UserRelays({ resolveCredential: async () => ({ type: 'none' }), clientAuth: async () => ({ providers: {} }), voice: true, homedir: '/nonexistent', userSettingKeys: () => [], userValue: () => undefined, hostPolicy: () => ({ allowBypass: false }), log: () => undefined }),
    changed: () => undefined,
    keptChats: () => 0,
    reattached: (restarted) => reattached.push(restarted),
    coreEnded: () => { coresEnded += 1; },
    drainTimeoutMs: 100,
    log: () => undefined,
  });
  cleanups.push(() => core.dispose());
  return { core, opened, views, main, holdReopens, reattached, coresEnded: () => coresEnded };
}

const chat = (viewId: string): ChatEntry => ({ panelId: 'host-1', viewId, hasConversation: true, folder: target, permissions: PLAN });

describe('RemoteCore', () => {
  it('rejoins the chats when the epoch is the one they were open under', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    await core.host.ready();
    await tick();
    expect(daemon.attaches.map((attach) => [attach.attach, attach.hostId])).toEqual([[1, 'loopback']]);
    expect(opened.map((entry) => entry.rejoin)).toEqual([true]);
    // every remote host starts with YOLO refused, the loopback one sharing this computer's loopback, and this computer's
    // sign-ins and user rules as the relays hold them
    expect(daemon.attaches[0]!.mirrors.clientPolicy).toEqual({ voice: true, allowBypass: false, sharedLoopback: true });
    expect(daemon.attaches[0]!.mirrors.clientAuth).toEqual({ providers: {} });
    expect(core.epoch()).toBe(EPOCH_A);
  });

  it('restores the chats with their kept permissions when a new epoch replaces the core', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened, views } = remote(daemon, null);
    core.connected(daemon.connection);
    await core.host.ready();
    await tick();
    expect(opened.map((entry) => entry.rejoin)).toEqual([false]);
    views.push({ viewId: 'view-1', panelToken: TOKEN });
    daemon.cores.get(1)!.publish('chats', { panelId: 'host-1', entry: chat('view-1') });

    daemon.newEpoch(EPOCH_B);
    await tick();
    await core.host.ready();
    await tick();
    expect(daemon.attaches.map((attach) => attach.attach)).toEqual([1, 2]);
    expect(opened.map((entry) => entry.rejoin)).toEqual([false, false]);
    expect(opened[1]!.kept.get(TOKEN)).toEqual(PLAN);
    expect(core.epoch()).toBe(EPOCH_B);
    // the first generation's endpoint ended with its epoch
    expect(opened[0]!.core.hasEnded()).toBe(true);
  });

  // flushed held messages wait on the core that ended: with no gain on a live connection, only this tells main they are lost
  it('reports the attached core ended when a new epoch, a restart or a halt replaces it on a live connection, and not on a drop', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, coresEnded, reattached } = remote(daemon, null);
    core.connected(daemon.connection);
    await core.host.ready();
    await tick();
    expect(coresEnded()).toBe(0);
    daemon.newEpoch(EPOCH_B);
    await tick();
    expect(coresEnded()).toBe(1);
    await core.host.ready();
    await tick();
    // the reopening after a restart on a live connection is no gain
    expect(reattached).toEqual([undefined]);
    daemon.halted();
    await tick();
    expect(coresEnded()).toBe(2);
    daemon.reconnect();
    await tick();
    expect(coresEnded()).toBe(2);
  });

  it('a restart the daemon reports first as restarting under the old epoch attaches again once the new epoch runs', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened, views } = remote(daemon, null);
    core.connected(daemon.connection);
    await core.host.ready();
    await tick();
    views.push({ viewId: 'view-1', panelToken: TOKEN });
    daemon.cores.get(1)!.publish('chats', { panelId: 'host-1', entry: chat('view-1') });
    daemon.restarting();
    await tick();
    // the chat views closed with their core; the attach made meanwhile is never served
    views.length = 0;
    await tick();
    daemon.newEpoch(EPOCH_B);
    await tick();
    await core.host.ready();
    await tick();
    expect(core.epoch()).toBe(EPOCH_B);
    expect(daemon.attaches.length).toBe(3);
    expect(opened.map((entry) => entry.rejoin)).toEqual([false, false]);
    expect(opened[1]!.kept.get(TOKEN)).toEqual(PLAN);
  });

  it('a rejoining view loads its page, holds its ready and joins by its page token; none found asks for a restore', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, main } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    const attached = await core.host.ready();
    const pages: unknown[] = [];
    const view = relayView(main.window.createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] }) as FakePanelHost, 'view-9', pages);
    const received: unknown[] = [];
    daemon.cores.get(1)!.onPanel((panelId, envelope) => received.push([panelId, envelope.op]));
    daemon.joinAs((viewKey) => (viewKey === TOKEN ? { panelId: 'host-1' } : null));

    const joining = attached.rejoin(view, TOKEN);
    await tick();
    expect(pages).toEqual([{ kind: 'chat' }]);
    view.fireMessage({ type: 'ready', panelToken: TOKEN });
    await expect(joining).resolves.toBe(true);
    // the held ready never reached core; the page's later messages do
    view.fireMessage({ type: 'getSettings' });
    await tick();
    expect(received).toEqual([['view-9', 'message']]);

    const other = relayView(main.window.createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] }) as FakePanelHost, 'view-10', []);
    const refused = attached.rejoin(other, 'b1c2a9e6-0d4b-4c1e-9a1f-1b2c3d4e5f60');
    await tick();
    other.fireMessage({ type: 'ready' });
    await expect(refused).resolves.toBe(false);
  });

  it('a rejoining view whose page is not ready joins nothing once the view closes or the attach ends', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, main } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    const attached = await core.host.ready();
    const panel = (panelId: string): RelayView & FakePanelHost => relayView(main.window.createPanel({ kind: 'chat', title: 'Damocles', localResourceRoots: [] }) as FakePanelHost, panelId, []);

    const closing = panel('view-1');
    const closed = attached.rejoin(closing, TOKEN);
    closing.close();
    await expect(closed).resolves.toBe(false);

    const stranded = attached.rejoin(panel('view-2'), TOKEN);
    daemon.reconnect();
    await expect(stranded).resolves.toBe(false);
  });

  it('halts when the first attach finds the core halted, and a reconnect to a running core clears the halt and reopens the chats', async () => {
    const daemon = fakeDaemon(EPOCH_A, 'halted');
    const { core, opened } = remote(daemon, null);
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(core.host.halted()).toBe(true));
    expect(core.coreState()?.phase).toBe('halted');
    expect(opened).toEqual([]);

    // another client restarted the core while this one was away
    const reconnected = daemon.reconnect();
    daemon.newEpoch(EPOCH_B);
    core.connected(reconnected);
    await core.host.ready();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(core.host.halted()).toBe(false);
    expect(core.epoch()).toBe(EPOCH_B);
    expect(daemon.attaches.map((attach) => attach.attach)).toEqual([1, 2]);
  });

  it('a Restart is in flight until the core runs again, and ends when the core halts or the connection drops', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core } = remote(daemon, null);
    core.connected(daemon.connection);
    await core.host.ready();

    await core.restart();
    expect(core.isRestarting()).toBe(true);
    daemon.newEpoch(EPOCH_B);
    expect(core.isRestarting()).toBe(false);
    await core.host.ready();

    await core.restart();
    daemon.halted();
    expect(core.isRestarting()).toBe(false);
    await vi.waitFor(() => expect(core.host.halted()).toBe(true));

    await core.restart();
    expect(core.isRestarting()).toBe(true);
    daemon.reconnect();
    expect(core.isRestarting()).toBe(false);
  });

  it('a connection lost while attachCore is in flight ends that attach, and the next connection attaches again', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened } = remote(daemon, null);
    const release = daemon.holdAttaches();
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(daemon.attaches).toHaveLength(1));
    const first = core.host.started()!;
    const reconnected = daemon.reconnect();
    await expect(first.ready).rejects.toThrow('closed');
    expect(first.hasEnded()).toBe(true);
    release();
    core.connected(reconnected);
    await core.host.ready();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(daemon.attaches.map((attach) => attach.attach)).toEqual([1, 2]);
  });

  it('a reconnect while the last reattach still reopens the chats attaches again, over the newest connection', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened, holdReopens } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const release = holdReopens();
    core.connected(daemon.reconnect());
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    const newest = daemon.reconnect();
    core.connected(newest);
    release();
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    expect(daemon.attaches.map((attach) => attach.attach)).toEqual([1, 2, 3]);
    const attached = await core.host.ready();
    expect(attached).toBe(opened[2]!.core);
    expect(attached.hasEnded()).toBe(false);
    expect(daemon.connection).toBe(newest);
  });

  it('a reconnect before the reattach under way attached joins it, so its connection gets one attach', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened, holdReopens } = remote(daemon, EPOCH_A);
    const release = holdReopens();
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    // the reattach waits for the launch's reopening, which is still under way
    core.connected(daemon.reconnect());
    core.connected(daemon.reconnect());
    release();
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    await tick();
    expect(daemon.attaches.map((attach) => attach.attach)).toEqual([1, 2]);
    expect((await core.host.ready()).hasEnded()).toBe(false);
  });

  it('hears core state events only from the connection it holds now', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    for (let reconnects = 1; reconnects <= 3; reconnects++) {
      core.connected(daemon.reconnect());
      await vi.waitFor(() => expect(opened).toHaveLength(reconnects + 1));
    }
    expect(daemon.stateListeners()).toBe(1);
    await core.dispose();
    expect(daemon.stateListeners()).toBe(0);
  });

  it('reports each connection once its chats reopened, naming a new epoch after a drop as the server or the engine restarting', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened, reattached } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(reattached).toEqual([undefined]));
    // the same epoch rejoins
    core.connected(daemon.reconnect());
    await vi.waitFor(() => expect(reattached).toEqual([undefined, undefined]));
    daemon.whileAway({ epoch: EPOCH_B, ppid: 51 });
    core.connected(daemon.reconnect());
    await vi.waitFor(() => expect(reattached).toEqual([undefined, undefined, 'server']));
    daemon.whileAway({ epoch: EPOCH_A, ppid: 51 });
    core.connected(daemon.reconnect());
    await vi.waitFor(() => expect(reattached).toEqual([undefined, undefined, 'server', 'engine']));
    expect(opened.map((entry) => entry.rejoin)).toEqual([true, true, false, false]);
    // a core restart on a live connection reopens the chats and is no reconnection
    daemon.newEpoch(EPOCH_B);
    await vi.waitFor(() => expect(opened).toHaveLength(5));
    await tick();
    expect(reattached).toHaveLength(4);
  });

  it('reports a connection whose chats failed to reopen, so the gain still follows it', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core, opened, reattached } = remote(daemon, EPOCH_A, true);
    core.connected(daemon.connection);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await vi.waitFor(() => expect(reattached).toEqual([undefined]));
  });

  it('stops hearing the close of a connection a newer one replaced', async () => {
    const daemon = fakeDaemon(EPOCH_A);
    const { core } = remote(daemon, EPOCH_A);
    core.connected(daemon.connection);
    await core.host.ready();
    const previous = daemon.replace();
    core.connected(daemon.connection);
    await core.host.ready();
    await core.restart();
    expect(core.isRestarting()).toBe(true);
    previous.close('the old transport ended late');
    expect(core.isRestarting()).toBe(true);
  });
});
