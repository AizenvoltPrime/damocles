// The acting client: core's endpoint runs each served request and panel message as the actor its envelope names and stamps it on
// what core sends from that work; the daemon names the forwarding client itself, whatever a client sent; a request with no
// actor goes to the client that sent core a message last.
import { afterEach, describe, expect, it } from 'vitest';
import { runPinnedTurn, runPin } from '../../../core/client-snapshots';
import { createClientSnapshots, createRemoteHost } from '../../core-host/platform/clients';
import { createClientMirrors, createCoreRouter, type CoreRouter } from '../../daemon/core-routes';
import type { DaemonState } from '../../daemon/daemon-state';
import { createRunRegistry } from '../../daemon/run-registry';
import { createCoreEndpoint, createLoopback, createMainEndpoint, currentActor, processActor, type MainEndpoint } from '..';
import { createActorContext } from '../actor';
import type { CoreInit } from '../messages';

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const state: DaemonState = { snapshot: () => ({}), update: async () => undefined, applyClient: () => false, flush: async () => undefined };
const emptyMirrors = {
  state: { global: {}, workspace: {} },
  trust: { keys: [] },
  folders: { folders: [] },
  editor: {},
  terminal: { shown: false, shortcut: '' },
  language: { language: 'en' as const },
  clientAuth: { providers: {} },
  clientUser: { settings: {}, permissionRules: [] },
  clientPolicy: { voice: false, allowBypass: false },
};

let router: CoreRouter | undefined;
afterEach(() => {
  router?.dispose();
  router = undefined;
});

// A daemon with its core endpoint (core's side, stamping like a daemon's core) and clients named by their hello client id.
function daemon() {
  const coreLoop = createLoopback();
  const core = createCoreEndpoint(coreLoop.core, quiet, undefined, processActor);
  router = createCoreRouter({ core: createMainEndpoint(coreLoop.main, quiet, undefined, processActor), state, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: () => undefined, log: quiet });
  const attached = router;
  const client = (clientId: string): { readonly main: MainEndpoint; readonly raw: { post(message: unknown): void } } => {
    const loop = createLoopback();
    // a raw request's response reaches this endpoint as one it never sent
    const main = createMainEndpoint(loop.main, quiet, quiet);
    attached.attach({ id: `connection-of-${clientId}`, clientId, hostId: 'h1', transport: loop.core, mirrors: emptyMirrors, close: quiet, drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
    main.serve('notifications.show', () => clientId);
    return { main, raw: loop.main };
  };
  return { core, client };
}

describe('the endpoint\'s actor', () => {
  it('runs a served request as its envelope\'s actor and stamps it on every request made from that work, across awaits', async () => {
    const actors = createActorContext();
    const loop = createLoopback();
    const sent: unknown[] = [];
    loop.main.onMessage((raw) => sent.push(raw));
    const core = createCoreEndpoint(loop.core, quiet, undefined, actors);
    core.serve('chats.open', async () => {
      await flush();
      void core.request('notifications.show', { severity: 'info', message: 'hi', actions: [] }).catch(() => undefined);
    });
    loop.main.post({ kind: 'request', id: 1, method: 'chats.open', params: {}, actor: 'device-a' });
    loop.main.post({ kind: 'request', id: 2, method: 'chats.open', params: {} });
    await flush();
    await flush();
    const asks = sent.filter((message) => (message as { method?: string }).method === 'notifications.show');
    expect(asks).toEqual([
      expect.objectContaining({ actor: 'device-a' }),
      expect.not.objectContaining({ actor: expect.anything() }),
    ]);
    core.close('done');
  });

  it('stamps an event with the actor of the work that emitted it, and runs its listeners as that actor', async () => {
    const actors = createActorContext();
    // a channel that delivers outside the sender's context, as a child process's IPC channel does
    const sent: unknown[] = [];
    let deliver!: (raw: unknown) => void;
    const core = createCoreEndpoint({ post: (raw) => sent.push(raw), onMessage: () => ({ dispose: () => undefined }) }, quiet, undefined, actors);
    const main = createMainEndpoint({ post: () => undefined, onMessage: (listener) => { deliver = listener; return { dispose: () => undefined }; } }, quiet, undefined, actors);
    const heard: Array<string | undefined> = [];
    main.onEvent('window.toggleTerminal', () => heard.push(actors.current()));
    actors.run('device-a', () => core.emit('window.toggleTerminal', {}));
    core.emit('window.toggleTerminal', {});
    for (const raw of sent.splice(0)) deliver(raw);
    expect(heard).toEqual(['device-a', undefined]);
    core.close('done');
    main.close('done');
  });

  it('sends no actor from an endpoint without an actor context, as main toward this computer\'s core', async () => {
    const loop = createLoopback();
    const sent: unknown[] = [];
    loop.core.onMessage((raw) => sent.push(raw));
    const main = createMainEndpoint(loop.main, quiet);
    await processActor.run('device-a', async () => {
      void main.request('chats.open', {}).catch(() => undefined);
    });
    expect(sent).toEqual([expect.not.objectContaining({ actor: expect.anything() })]);
    main.close('done');
  });

  it('refuses an envelope whose actor is not a client id', () => {
    const loop = createLoopback();
    const violations: string[] = [];
    createCoreEndpoint(loop.core, quiet, (error) => violations.push(error.message), processActor);
    loop.main.post({ kind: 'request', id: 1, method: 'chats.open', params: {}, actor: 'evil\nline' });
    loop.main.post({ kind: 'request', id: 2, method: 'chats.open', params: {}, actor: 'x'.repeat(129) });
    expect(violations).toHaveLength(2);
  });
});

describe('the daemon\'s actor', () => {
  it('names the forwarding client by its hello client id, overwriting the actor a client sent', async () => {
    const { core, client } = daemon();
    const seen: Array<string | undefined> = [];
    core.serve('chats.open', () => {
      seen.push(currentActor());
    });
    const a = client('device-a');
    // a client's own actor naming another device is dropped and replaced
    a.raw.post({ kind: 'request', id: 7, method: 'chats.open', params: {}, actor: 'device-b' });
    await flush();
    await a.main.request('chats.open', {});
    expect(seen).toEqual(['device-a', 'device-a']);
  });

  it('routes what core asks during a client\'s turn to that client, though another client sent a message since', async () => {
    const { core, client } = daemon();
    let turn!: Promise<string | undefined>;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    core.onPanel((_viewId, envelope) => {
      if (envelope.op !== 'message') return;
      // the turn outlives the message that started it, as pi's run does
      turn = finished.then(() => core.request('notifications.show', { severity: 'info', message: 'done', actions: [] }));
    });
    core.serve('chats.restore', () => undefined);
    const a = client('device-a');
    const b = client('device-b');
    await a.main.request('chats.restore', { viewId: 'view-a' });
    a.main.postPanel('view-a', 'message', { message: { type: 'sendMessage' } });
    await flush();
    await b.main.request('chats.restore', { viewId: 'view-b' });
    finish();
    expect(await turn).toBe('device-a');
  });

  it('sends a request with no actor (a timer, a watcher) to the client that sent core a message last', async () => {
    const { core, client } = daemon();
    core.serve('chats.open', () => undefined);
    const a = client('device-a');
    client('device-b');
    await a.main.request('chats.open', {});
    // outside every client's work: no actor
    expect(await processActor.run(undefined, () => core.request('notifications.show', { severity: 'info', message: 'tick', actions: [] }))).toBe('device-a');
  });

  it('pins a turn to the client whose message started it, through the acting client core reads', async () => {
    const { core, client } = daemon();
    const init = { remote: { hostId: 'h' }, mirrors: { clientAuth: {}, clientUser: {}, clientPolicy: {}, actingClient: {} } } as unknown as CoreInit & { readonly remote: { readonly hostId: string } };
    const snapshots = createClientSnapshots(core, init);
    const remote = createRemoteHost(core, init, snapshots, () => undefined);
    const pins: Array<string | undefined> = [];
    core.onPanel((_viewId, envelope) => {
      if (envelope.op === 'message') runPinnedTurn(remote, 'panel-1', () => pins.push(runPin()?.clientId));
    });
    core.serve('chats.restore', () => undefined);
    const a = client('device-a');
    const b = client('device-b');
    await a.main.request('chats.restore', { viewId: 'view-a' });
    // b acted last, so the mirror names it; the message's actor still names a
    await b.main.request('chats.restore', { viewId: 'view-b' });
    a.main.postPanel('view-a', 'message', { message: { type: 'sendMessage' } });
    await flush();
    expect(pins).toEqual(['device-a']);
    snapshots.dispose();
  });
});
