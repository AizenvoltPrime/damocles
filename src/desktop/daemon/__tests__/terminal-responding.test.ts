import { describe, expect, it } from 'vitest';
import { createEndpoint, type CoreTransport } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import { INVALID } from '../../core-protocol/schema';
import type { HostMessage } from '../../pty-host/protocol';
import type { HostedTerminal } from '../../terminal-host/host-messages';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type TerminalResponding, type WorkspaceToClient } from '../../workspace/messages';
import { createRunRegistry } from '../run-registry';
import { createTerminalHub, type HubClient } from '../terminal-hub';
import { createWorkspaceHost, NOT_RESPONDING_FEATURE, type WorkspaceModules } from '../workspace-host';
import { fakeHost, fakeHosts, settled } from './fake-terminal-host';

const held = (id: string, extra: Partial<HostedTerminal> = {}): HostedTerminal => ({ id, pid: 7, cols: 120, rows: 40, scrollback: 2000, title: 'bash', projectKey: '/srv/app', ...extra });

// a hub over a lost host 200 holding term-3 and term-4, each client's messages and responding changes as text
function lostHost(terminals: readonly HostedTerminal[] = [held('term-3'), held('term-4', { pid: 8 })], ended = false) {
  const registry = createRunRegistry();
  const hosts = fakeHosts(fakeHost(100, 'own'), ended);
  const hub = createTerminalHub({ hosts: hosts.hosts, registry, log: () => undefined });
  const seen: string[] = [];
  hub.onResponding((viewer, change) => seen.push(`${viewer.id} ${change.id} ${change.hostPid} ${change.responding ? 'responding' : 'not responding'}`));
  const client = (id: string): HubClient => ({ id, message: (message) => seen.push(`${id} ${message.type} ${message.id}${message.type === 'exit' ? ` ${message.exitCode}` : ''}`) });
  const older = fakeHost(200, 'older', terminals);
  hosts.adopt(older);
  return { hub, hosts, registry, older, seen, client };
}

describe('a terminal host that is not responding', () => {
  it('marks each of its terminals for every viewer and in the list, clears that once the host answers again, and then runs what was held', () => {
    const { hub, hosts, older, seen, client } = lostHost();
    const a = client('a');
    const b = client('b');
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    hub.post(b, { type: 'serialize', id: 'term-3' }, undefined);
    // each new view hears its host's state
    expect(seen).toEqual(['a term-3 200 responding', 'b term-3 200 responding']);
    seen.length = 0;
    older.link.close('it did not answer a list within 10000 ms');
    hub.post(a, { type: 'input', id: 'term-3', data: 'ls\r' }, undefined);
    hosts.respond(200, false);
    // term-4 has no viewer: the list tells a device that looks later
    expect(seen).toEqual(['a term-3 200 not responding', 'b term-3 200 not responding']);
    expect(hub.list()).toEqual([{ id: 'term-3', pid: 7, cols: 120, rows: 40, notRespondingHost: 200 }, { id: 'term-4', pid: 8, cols: 120, rows: 40, notRespondingHost: 200 }]);
    seen.length = 0;
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]);
    hosts.adopt(again);
    expect(seen).toEqual(['a term-3 200 responding', 'b term-3 200 responding']);
    expect(hub.list()).toEqual([{ id: 'term-3', pid: 7, cols: 120, rows: 40 }, { id: 'term-4', pid: 8, cols: 120, rows: 40 }]);
    expect(again.sent.filter((sent) => sent.type === 'input')).toEqual([{ type: 'input', id: 'term-3', data: 'ls\r' }]);
    expect(hosts.calls).toEqual([]);
  });

  it('kills the process group of a terminal\'s shell on Kill, ends it for every viewer, drops what it held, and kills it in its host if the host lists it again', async () => {
    const { hub, hosts, registry, older, seen, client } = lostHost();
    const a = client('a');
    const b = client('b');
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    hub.post(b, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hub.post(a, { type: 'input', id: 'term-3', data: 'ls\r' }, undefined);
    seen.length = 0;
    // the host card's Kill on a device that does not view it
    hub.post(client('c'), { type: 'kill', id: 'term-3' }, undefined);
    expect(hosts.calls).toEqual(['killGroup 200 term-3']);
    // once the shell was proved and its kill sent
    await settled();
    expect(seen).toEqual(['a exit term-3 1', 'b exit term-3 1']);
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-4']);
    expect(registry.runs().map((run) => run.id)).toEqual(['term-4']);
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]);
    hosts.adopt(again);
    expect(again.sent).toEqual([{ type: 'kill', id: 'term-3' }]);
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-4']);
    // its exit, once the host ends it, is nobody's
    again.fromHost({ type: 'exit', id: 'term-3', exitCode: 1 });
    await settled();
    expect(seen).toEqual(['a exit term-3 1', 'b exit term-3 1']);
    expect(hosts.emptied).toEqual([]);
  });

  // the user pressed Kill on a frozen terminal before the daemon judged its host: the tab closed, so the shell must not run on
  it('kills the process group of a terminal whose Kill waited for its host once that host is not responding', async () => {
    const { hub, hosts, older, seen, client } = lostHost();
    const a = client('a');
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    seen.length = 0;
    hub.post(a, { type: 'kill', id: 'term-3' }, undefined);
    expect(hosts.calls).toEqual([]);
    expect(seen).toEqual([]);
    hosts.respond(200, false);
    expect(hosts.calls).toEqual(['killGroup 200 term-3']);
    await settled();
    expect(seen).toEqual(['a term-3 200 not responding', 'a exit term-3 1']);
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-4']);
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]);
    hosts.adopt(again);
    expect(again.sent).toEqual([{ type: 'kill', id: 'term-3' }]);
  });

  it('tells the viewers of a terminal whose waiting Kill cannot be proved that its host is not responding', async () => {
    const { hub, hosts, older, seen, client } = lostHost();
    const a = client('a');
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hub.post(client('c'), { type: 'kill', id: 'term-3' }, undefined);
    hosts.killAnswers('unproved');
    seen.length = 0;
    hosts.respond(200, false);
    await settled();
    expect(hosts.calls).toEqual(['killGroup 200 term-3']);
    expect(seen).toEqual(['a term-3 200 not responding']);
    expect(hub.list().map((terminal) => `${terminal.id} ${terminal.notRespondingHost}`)).toEqual(['term-3 200', 'term-4 200']);
  });

  it('sends a Kill that waited for its host to that host when it answers before it is judged', () => {
    const { hub, hosts, older, client } = lostHost();
    older.link.close('nothing arrived for 20000 ms');
    hub.post(client('a'), { type: 'kill', id: 'term-3' }, undefined);
    const again = fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]);
    hosts.adopt(again);
    expect(again.sent).toEqual([{ type: 'kill', id: 'term-3' }]);
    expect(hosts.calls).toEqual([]);
  });

  it('kills nothing more when the host attaches again without the killed terminal', async () => {
    const { hub, hosts, older, client } = lostHost();
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hub.post(client('a'), { type: 'kill', id: 'term-3' }, undefined);
    await settled();
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-4', { pid: 8 })]);
    hosts.adopt(again);
    expect(again.sent).toEqual([]);
    expect(hosts.calls).toEqual(['killGroup 200 term-3']);
  });

  it('lets a host go once the kills of every terminal it still listed answered', async () => {
    const { hub, hosts, older, client } = lostHost([held('term-3')]);
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hub.post(client('a'), { type: 'kill', id: 'term-3' }, undefined);
    await settled();
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(again);
    expect(hosts.emptied).toEqual([]);
    await settled();
    expect(hosts.emptied).toEqual([again.link]);
  });

  // its ready may have come after the link was lost, and the host's terminals file names the shell then
  it('kills the shell its host\'s terminals file names for a terminal whose shell had no pid here, and kills it in its host later', async () => {
    const { hub, hosts, older, seen, client } = lostHost([held('term-3', { pid: 0 })]);
    const a = client('a');
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hub.post(a, { type: 'kill', id: 'term-3' }, undefined);
    expect(hosts.calls).toEqual(['killGroup 200 term-3']);
    await settled();
    expect(seen.at(-1)).toBe('a exit term-3 1');
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(again);
    expect(again.sent).toEqual([{ type: 'kill', id: 'term-3' }]);
  });

  it('keeps a terminal listed and not responding while its shell cannot be proved, tells no viewer it exited, and kills it in its host when the host answers', async () => {
    const { hub, hosts, older, seen, client } = lostHost();
    hub.post(client('a'), { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hosts.killAnswers('unproved');
    seen.length = 0;
    hub.post(client('c'), { type: 'kill', id: 'term-3' }, undefined);
    await settled();
    expect(hosts.calls).toEqual(['killGroup 200 term-3']);
    expect(seen).toEqual([]);
    expect(hub.list().map((terminal) => `${terminal.id} ${terminal.notRespondingHost}`)).toEqual(['term-3 200', 'term-4 200']);
    hosts.respond(200, true);
    const again = fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]);
    hosts.adopt(again);
    expect(again.sent.filter((sent) => sent.type === 'kill')).toEqual([{ type: 'kill', id: 'term-3' }]);
    await settled();
    expect(seen.at(-1)).toBe('a exit term-3 1');
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-4']);
  });

  it('ends its terminals for every viewer when it ends while not responding, and forgets the state', () => {
    const { hub, hosts, older, seen, client } = lostHost();
    hub.post(client('a'), { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    seen.length = 0;
    hosts.end(200);
    expect(seen).toEqual(['a exit term-3 1']);
    expect(hub.list()).toEqual([]);
    expect(hosts.calls).toEqual([]);
  });

  it('sends a Kill to an answering host as before, and kills nothing itself', () => {
    const { hub, hosts, older, client } = lostHost();
    hub.post(client('a'), { type: 'kill', id: 'term-3' }, undefined);
    expect(older.sent).toEqual([{ type: 'kill', id: 'term-3' }]);
    older.fromHost({ type: 'exit', id: 'term-3', exitCode: 1 });
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hosts.respond(200, true);
    hosts.adopt(fakeHost(200, 'older', [held('term-4', { pid: 8 })]));
    hub.post(client('a'), { type: 'kill', id: 'term-4' }, undefined);
    expect(hosts.calls).toEqual([]);
  });

  // the next daemon adopts them and decides for itself
  it('kills nothing and tells no viewer anything when the daemon releases its hosts while one is not responding', () => {
    const { hub, hosts, older, seen, client } = lostHost();
    hub.post(client('a'), { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    seen.length = 0;
    hub.release('the daemon is handing over');
    hosts.end(200);
    expect(seen).toEqual([]);
    expect(hosts.calls).toEqual(['release: the daemon is handing over']);
  });

  // a client reads terminals.list and then attaches its views: a change in between must not leave its tab stale
  it('tells a connection that starts viewing a terminal of a known host that host\'s state, and answers each viewed terminal\'s state', () => {
    const { hub, hosts, older, seen, client } = lostHost();
    const a = client('a');
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    expect(seen).toEqual(['a term-3 200 not responding']);
    expect(hub.respondingOf(a)).toEqual([{ id: 'term-3', hostPid: 200, responding: false }]);
    hosts.respond(200, true);
    hosts.adopt(fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]));
    hub.post(a, { type: 'serialize', id: 'term-4' }, undefined);
    expect(seen).toEqual(['a term-3 200 not responding', 'a term-3 200 responding', 'a term-4 200 responding']);
    expect(hub.respondingOf(a)).toEqual([{ id: 'term-3', hostPid: 200, responding: true }, { id: 'term-4', hostPid: 200, responding: true }]);
    expect(hub.respondingOf(client('b'))).toEqual([]);
  });

  it('asks the hosts to end a terminal host and answers what they answered', async () => {
    expect(await lostHost(undefined, true).hub.endHost(200)).toBe(true);
    const { hub, hosts } = lostHost(undefined, false);
    expect(await hub.endHost(300)).toBe(false);
    expect(hosts.calls).toEqual(['endHost 300']);
  });

  it('ends the attached hosts on a shutdown that ends the terminals, and every host of this machine on a removal', async () => {
    const { hub, hosts } = lostHost();
    await hub.endTerminals('attached');
    await hub.endTerminals('removal');
    expect(hosts.calls).toEqual(['endAll', 'endForRemoval']);
  });
});

// a hub whose daemon never attached to host 300, which hung before the server switch
function unattachedHost() {
  const registry = createRunRegistry();
  const hosts = fakeHosts(fakeHost(100, 'own'));
  const lines: string[] = [];
  const hub = createTerminalHub({ hosts: hosts.hosts, registry, log: (line) => lines.push(line) });
  const seen: string[] = [];
  hub.onResponding((viewer, change) => seen.push(`${viewer.id} ${change.id} ${change.hostPid} ${change.responding ? 'responding' : 'not responding'}`));
  const client = (id: string): HubClient => ({ id, message: (message) => seen.push(`${id} ${message.type} ${message.id}${message.type === 'exit' ? ` ${message.exitCode}` : ''}`) });
  hosts.unattached(300, [held('term-5', { pid: 11, view: JSON.stringify(VIEW) }), held('term-6', { pid: 12 })]);
  return { hub, hosts, registry, seen, client, lines };
}

const VIEW = { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };

describe('a terminal host this daemon never attached to', () => {
  it('lists the terminals its file names, as responding while it is waited for and then as not responding', () => {
    const { hub, hosts, registry, seen, client } = unattachedHost();
    expect(hub.list()).toEqual([{ id: 'term-5', pid: 11, cols: 120, rows: 40, view: VIEW }, { id: 'term-6', pid: 12, cols: 120, rows: 40 }]);
    expect(registry.runs().map((run) => run.id)).toEqual(['term-5', 'term-6']);
    const a = client('a');
    hub.post(a, { type: 'serialize', id: 'term-5' }, undefined);
    hub.post(a, { type: 'input', id: 'term-5', data: 'ls\r' }, undefined);
    expect(seen).toEqual(['a term-5 300 responding']);
    hosts.respond(300, false);
    expect(seen).toEqual(['a term-5 300 responding', 'a term-5 300 not responding']);
    expect(hub.list()).toEqual([{ id: 'term-5', pid: 11, cols: 120, rows: 40, view: VIEW, notRespondingHost: 300 }, { id: 'term-6', pid: 12, cols: 120, rows: 40, notRespondingHost: 300 }]);
    expect(hub.respondingOf(a)).toEqual([{ id: 'term-5', hostPid: 300, responding: false }]);
    expect(hosts.calls).toEqual([]);
  });

  it('kills a terminal\'s shell through its host\'s file on Kill once the host is not responding, and ends its host on End terminal host', async () => {
    const { hub, hosts, seen, client } = unattachedHost();
    const a = client('a');
    hub.post(a, { type: 'serialize', id: 'term-5' }, undefined);
    // a Kill while it is still waited for waits too
    hub.post(a, { type: 'kill', id: 'term-5' }, undefined);
    expect(hosts.calls).toEqual([]);
    hosts.respond(300, false);
    expect(hosts.calls).toEqual(['killGroup 300 term-5']);
    await settled();
    expect(seen.at(-1)).toBe('a exit term-5 1');
    hub.post(client('b'), { type: 'kill', id: 'term-6' }, undefined);
    expect(hosts.calls).toEqual(['killGroup 300 term-5', 'killGroup 300 term-6']);
    await settled();
    expect(hub.list()).toEqual([]);
    expect(await hub.endHost(300)).toBe(false);
    expect(hosts.calls.at(-1)).toBe('endHost 300');
  });

  it('converges once it attaches: the host\'s own list holds, what it no longer holds ends, and what waited runs', () => {
    const { hub, hosts, seen, client } = unattachedHost();
    const a = client('a');
    hub.post(a, { type: 'serialize', id: 'term-5' }, undefined);
    hub.post(a, { type: 'serialize', id: 'term-6' }, undefined);
    hub.post(a, { type: 'input', id: 'term-5', data: 'ls\r' }, undefined);
    hosts.respond(300, false);
    seen.length = 0;
    hosts.respond(300, true);
    const late = fakeHost(300, 'older', [held('term-5', { pid: 11, cols: 100 })]);
    hosts.adopt(late);
    expect(seen).toEqual(['a term-5 300 responding', 'a term-6 300 responding', 'a exit term-6 1']);
    expect(hub.list()).toEqual([{ id: 'term-5', pid: 11, cols: 100, rows: 40, view: VIEW }]);
    // the fresh view and screen, then what waited, in order
    expect(late.sent).toEqual([{ type: 'viewed', id: 'term-5', viewed: true }, { type: 'serialize', id: 'term-5' }, { type: 'input', id: 'term-5', data: 'ls\r' }]);
    expect(hosts.calls).toEqual([]);
  });

  it('ends its terminals for every viewer when it is found ended, its pid another process\'s included', () => {
    const { hub, hosts, seen, client } = unattachedHost();
    hub.post(client('a'), { type: 'serialize', id: 'term-6' }, undefined);
    seen.length = 0;
    hosts.end(300);
    expect(seen).toEqual(['a exit term-6 1']);
    expect(hub.list()).toEqual([]);
  });

  // a Windows pty still connecting when its host hung: no pid, so no client lists it, and no host card row either
  it('leaves out a terminal its file names without a shell pid, from the list and the runs alike', () => {
    const { hub, hosts, registry } = unattachedHost();
    hosts.unattached(400, [held('term-8', { pid: 0 })]);
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-5', 'term-6']);
    expect(registry.runs().map((run) => run.id)).toEqual(['term-5', 'term-6']);
  });

  it('leaves out a terminal whose id another host\'s terminal has', () => {
    const { hub, hosts, lines } = unattachedHost();
    hosts.unattached(400, [held('term-5', { pid: 99 }), held('term-7', { pid: 98 })]);
    expect(hub.list().map((terminal) => `${terminal.id} ${terminal.pid}`)).toEqual(['term-5 11', 'term-6 12', 'term-7 98']);
    expect(lines).toContain('[terminal] the terminal host 400 lists term-5, an id another host\'s terminal has; it is not listed');
  });
});

// Two ends of an in-memory channel; each message arrives on a later task, structured-cloned as the wire copies it.
function channel(): readonly [CoreTransport, CoreTransport] {
  const listeners = [new Set<(raw: unknown) => void>(), new Set<(raw: unknown) => void>()] as const;
  const end = (own: 0 | 1): CoreTransport => ({
    post: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => listeners[own === 0 ? 1 : 0].forEach((listener) => listener(copy)));
    },
    onMessage: (listener) => {
      listeners[own].add(listener);
      return { dispose: () => listeners[own].delete(listener) };
    },
  });
  return [end(0), end(1)];
}

describe('not responding over the workspace channel', () => {
  it('parses the listed host, the change and End terminal host within the contract', () => {
    const listed = CLIENT_TO_WORKSPACE.requests['terminals.list'].result;
    expect(listed([{ id: 'term-1', pid: 7, cols: 80, rows: 24, notRespondingHost: 200 }])).toEqual([{ id: 'term-1', pid: 7, cols: 80, rows: 24, notRespondingHost: 200 }]);
    expect(listed([{ id: 'term-1', pid: 7, cols: 80, rows: 24, notRespondingHost: 0 }])).toBe(INVALID);
    expect(listed([{ id: 'term-1', pid: 7, cols: 80, rows: 24, notRespondingHost: '200' }])).toBe(INVALID);
    const responding = WORKSPACE_TO_CLIENT.events['terminals.responding'];
    expect(responding({ id: 'term-1', hostPid: 200, responding: false })).toEqual({ id: 'term-1', hostPid: 200, responding: false });
    expect(responding({ id: 'term-1', hostPid: 200 })).toBe(INVALID);
    expect(responding({ id: 'not a terminal id', hostPid: 200, responding: true })).toBe(INVALID);
    const endHost = CLIENT_TO_WORKSPACE.requests['terminals.endHost'];
    expect(endHost.params({ hostPid: 200 })).toEqual({ hostPid: 200 });
    expect(endHost.params({ hostPid: -1 })).toBe(INVALID);
    expect(endHost.result({ ended: true })).toEqual({ ended: true });
    expect(endHost.result({})).toBe(INVALID);
  });

  it(`sends the change only to a viewer whose attach listed ${NOT_RESPONDING_FEATURE}, and answers End terminal host`, async () => {
    const hosts = fakeHosts(fakeHost(100, 'own'), true);
    const hub = createTerminalHub({ hosts: hosts.hosts, registry: createRunRegistry(), log: () => undefined });
    const older = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(older);
    const workspace = createWorkspaceHost({ hub, cli: { connected: () => ({ dispose: () => undefined }) }, watchLimits: { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null } } as unknown as WorkspaceModules, () => undefined);
    const connect = (id: string, features: readonly string[]) => {
      const [clientEnd, hostEnd] = channel();
      const violations: string[] = [];
      const served = workspace.serve(id, id, hostEnd, (reason) => violations.push(reason), () => undefined, () => false, () => new Set(features));
      const endpoint = createEndpoint<ClientToWorkspace, WorkspaceToClient>({ transport: clientEnd, outgoing: CLIENT_TO_WORKSPACE, incoming: WORKSPACE_TO_CLIENT, log: () => undefined, errors: ERROR_CODEC, onViolation: (error) => violations.push(error.message) });
      const changes: TerminalResponding[] = [];
      const messages: HostMessage[] = [];
      endpoint.onEvent('terminals.responding', (change) => changes.push(change));
      endpoint.onEvent('terminals.message', ({ message }) => messages.push(message));
      endpoint.emit('terminals.post', { request: { type: 'serialize', id: 'term-3' } });
      return { endpoint, served, violations, changes, messages };
    };
    const current = connect('current', [NOT_RESPONDING_FEATURE]);
    const legacy = connect('older', []);
    const away = connect('away', [NOT_RESPONDING_FEATURE]);
    await settled();
    away.endpoint.emit('terminals.post', { request: { type: 'detach', id: 'term-3' } });
    await settled();
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    await settled();
    expect(current.changes).toEqual([{ id: 'term-3', hostPid: 200, responding: true }, { id: 'term-3', hostPid: 200, responding: false }]);
    expect(legacy.changes).toEqual([]);
    expect(away.changes).toEqual([{ id: 'term-3', hostPid: 200, responding: true }]);
    expect(await away.endpoint.request('terminals.list', {})).toEqual([{ id: 'term-3', pid: 7, cols: 120, rows: 40, notRespondingHost: 200 }]);
    expect(await away.endpoint.request('terminals.endHost', { hostPid: 200 })).toEqual({ ended: true });
    expect(hosts.calls).toEqual(['endHost 200']);
    for (const connection of [current, legacy, away]) {
      expect(connection.violations).toEqual([]);
      connection.endpoint.close('done');
      connection.served.dispose();
    }
  });

  // main reattaches its views before its control.attachCore lists the feature
  it('sends a connection each viewed terminal\'s state once its attach lists the feature', async () => {
    const hosts = fakeHosts(fakeHost(100, 'own'));
    const hub = createTerminalHub({ hosts: hosts.hosts, registry: createRunRegistry(), log: () => undefined });
    const older = fakeHost(200, 'older', [held('term-3'), held('term-4', { pid: 8 })]);
    hosts.adopt(older);
    const workspace = createWorkspaceHost({ hub, cli: { connected: () => ({ dispose: () => undefined }) }, watchLimits: { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null } } as unknown as WorkspaceModules, () => undefined);
    const [clientEnd, hostEnd] = channel();
    const features = new Set<string>();
    const served = workspace.serve('laptop', 'laptop', hostEnd, (reason) => { throw new Error(reason); }, () => undefined, () => false, () => features);
    const endpoint = createEndpoint<ClientToWorkspace, WorkspaceToClient>({ transport: clientEnd, outgoing: CLIENT_TO_WORKSPACE, incoming: WORKSPACE_TO_CLIENT, log: () => undefined, errors: ERROR_CODEC });
    const changes: TerminalResponding[] = [];
    endpoint.onEvent('terminals.responding', (change) => changes.push(change));
    endpoint.emit('terminals.post', { request: { type: 'serialize', id: 'term-3' } });
    await settled();
    older.link.close('nothing arrived for 20000 ms');
    hosts.respond(200, false);
    await settled();
    expect(changes).toEqual([]);
    features.add(NOT_RESPONDING_FEATURE);
    workspace.attached('laptop');
    workspace.attached('another connection');
    await settled();
    expect(changes).toEqual([{ id: 'term-3', hostPid: 200, responding: false }]);
    endpoint.close('done');
    served.dispose();
  });
});
