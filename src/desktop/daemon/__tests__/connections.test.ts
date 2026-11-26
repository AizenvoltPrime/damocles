import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PI_AGENT_DIR } from '../../../core/pi-session/agent-dir';
import { piSessionDir } from '../../../core/pi-session/session-store/session-dir';
import { encode } from '../../../remote/codec';
import { HANDSHAKE_MAX_BYTES } from '../../../remote/handshake';
import { CHANNEL } from '../../../remote/mux';
import { createPersistentProtocol } from '../../../remote/persistent-protocol';
import { streamSocket } from '../../../remote/stream-transport';
import { WriteRefusedError } from '../../workspace/file-system';
import type { HostStarters } from '../../workspace/host-starters';
import { createConnections, MAX_UNAUTHENTICATED, type ConnectionPresence, type ConnectionsDeps } from '../connections';
import type { CoreTransport } from '../../core-protocol/endpoint';
import type { ClientLink } from '../core-routes';
import { authenticateBridge } from '../../../remote/handshake';
import { duplexPair, type Duplex } from 'node:stream';
import { TEST_FACTS } from './in-process-daemon';
import { readPidFile, runPaths, SHARED_HOME_WINDOW_MS, writePidFile } from '../token';
import { startInProcessDaemon, type InProcessDaemon } from './in-process-daemon';
import { connectClient, resumeClient } from './test-client';
import { holdStream } from '../../../remote/tunnel-pipe';
import type { AgentRelay } from '../agent-relay';
import type { ConnectionMirrorWatches, MirrorWatches } from '../mirror-server';
import { RUNS_EVENT_MS, type Run } from '../control-messages';

// no terminal or formatter runs in these tests
const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

// every connection's mirror watches: none watch anything, but for what the test gives
function mirrorWatches(watches: Partial<ConnectionMirrorWatches> = {}, released?: (connectionId: string) => void): MirrorWatches {
  return {
    forConnection: (connectionId) => ({
      released: false,
      follow: () => Promise.resolve(),
      followProject: () => Promise.resolve({ folders: { own: '/sessions/app', worktrees: [], unreadable: false } }),
      followSubcalls: () => Promise.resolve(),
      dispose: () => released?.(connectionId),
      ...watches,
    }),
  };
}

// the mux frame kinds (mux.ts KIND), read off the wire
const KIND_OPEN = 0;
const KIND_DATA = 1;

let daemon: InProcessDaemon;

beforeEach(async () => {
  daemon = await startInProcessDaemon({ starters: NO_HOSTS });
});

afterEach(async () => {
  await daemon.shutdown();
});

describe('daemon connections', () => {
  it('welcomes a client and serves control and workspace requests', async () => {
    const client = await connectClient(await daemon.connect());
    expect(client.outcome.kind).toBe('welcome');
    await client.control.request('attach', { terminalIdleDays: 7 });
    expect(await client.control.request('listRuns', {})).toEqual({ runs: [] });
    expect(client.outcome.kind === 'welcome' && client.outcome.welcome.features).toEqual(expect.arrayContaining(['protocol.resume', 'control.ping']));
    expect(await client.control.request('ping', {})).toEqual({});
    const folder = fs.mkdtempSync(`${process.env['TMP'] ?? '/tmp'}/dm-conn-`);
    fs.writeFileSync(`${folder}/a.txt`, 'bytes');
    const read = await client.workspace.request('files.read', { path: `${folder}/a.txt` });
    expect(read.kind).toBe('bytes');
    if (read.kind === 'bytes') expect(Buffer.from(read.bytes).toString()).toBe('bytes');
    const logs = await client.control.request('logs.list', {});
    expect(logs.logs.map((entry) => entry.name)).toEqual([]);
    client.protocol.close('done');
  });

  it('names the other machines whose daemon used this home within the window, once each, by a hostname it accepts', async () => {
    const now = Date.now();
    const others: ReadonlyArray<readonly [string, string, number]> = [
      ['aaaaaaaaaaaaaaaa', 'lab-03', 0],
      ['bbbbbbbbbbbbbbbb', 'lab-02.example.org', 60_000],
      ['cccccccccccccccc', 'lab-03', 0],
      ['dddddddddddddddd', 'evil\u202Ename', 0],
      ['eeeeeeeeeeeeeeee', 'lab-09', SHARED_HOME_WINDOW_MS + 60_000],
    ];
    for (const [key, hostname, age] of others) {
      const pidFile = runPaths(path.dirname(path.dirname(daemon.paths.serverDir)), key).pidFile;
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      await writePidFile(pidFile, { version: '1', pid: 7, hostname, endpoint: '/tmp/damocles-x/daemon.sock', socketFolder: '/tmp/damocles-x', updatedAt: now - age });
      fs.utimesSync(pidFile, new Date(now - age), new Date(now - age));
    }
    const client = await connectClient(await daemon.connect());
    expect(client.outcome.kind === 'welcome' && client.outcome.welcome.features).toContain('control.sharedHome');
    expect(await client.control.request('sharedHome', {})).toEqual({ hosts: ['lab-02.example.org', 'lab-03'] });
    client.protocol.close('done');
  });

  it('tells each client that asked which devices are attached, by device name and never client id, on every attach and close', async () => {
    const desk = await connectClient(await daemon.connect(), { clientId: 'client-desk', deviceName: 'desk' });
    const seen: unknown[] = [];
    desk.control.onEvent('clients', (event) => seen.push(event));
    await desk.control.request('attach', { terminalIdleDays: 7, watchClients: true });
    const quiet = await connectClient(await daemon.connect(), { clientId: 'client-quiet', deviceName: 'old app' });
    const unasked = vi.fn();
    quiet.control.onEvent('clients', unasked);
    await quiet.control.request('attach', { terminalIdleDays: 7 });
    const laptop = await connectClient(await daemon.connect(), { clientId: 'client-laptop', deviceName: 'laptop' });
    await laptop.control.request('attach', { terminalIdleDays: 7, watchClients: true });
    laptop.protocol.close('done');
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    expect(seen).toEqual([
      { clients: [{ deviceName: 'desk', self: true }] },
      { clients: [{ deviceName: 'desk', self: true }, { deviceName: 'old app', self: false }] },
      { clients: [{ deviceName: 'desk', self: true }, { deviceName: 'old app', self: false }, { deviceName: 'laptop', self: false }] },
      { clients: [{ deviceName: 'desk', self: true }, { deviceName: 'old app', self: false }] },
    ]);
    expect(JSON.stringify(seen)).not.toContain('client-');
    expect(unasked).not.toHaveBeenCalled();
    desk.protocol.close('done');
    quiet.protocol.close('done');
  });

  it('carries WriteRefusedError by name with its refusal', async () => {
    const client = await connectClient(await daemon.connect());
    const folder = fs.realpathSync.native(fs.mkdtempSync(`${process.env['TMP'] ?? '/tmp'}/dm-conn-`));
    fs.mkdirSync(`${folder}/proj`);
    const project = { key: `${folder}/proj`, fsPath: `${folder}/proj`, name: 'proj' };
    const write = client.workspace.request('files.writeInPlace', { project, location: { path: `${folder}/outside.txt`, projectKey: project.key, relativePath: '../outside.txt' }, bytes: new Uint8Array([1]) });
    const error = await write.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WriteRefusedError);
    expect((error as WriteRefusedError).refusal).toBe('outsideProject');
    client.protocol.close('done');
  });

  it('refuses a connection that cannot prove the token, writing only the challenge answer', async () => {
    const record = await readPidFile(daemon.paths.pidFile);
    const socket = net.connect(record!.endpoint);
    await new Promise((resolve) => socket.once('connect', resolve));
    const protocol = createPersistentProtocol({ socket: streamSocket(socket), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
    const controls: Uint8Array[] = [];
    const regular: Uint8Array[] = [];
    protocol.onControl((body) => {
      controls.push(body);
      // a bridge without the token can only guess the last proof
      protocol.sendControl(encode({ proof: randomBytes(32) }));
    });
    protocol.onMessage((body) => regular.push(body));
    const closed = new Promise<string>((resolve) => protocol.onClose(resolve));
    protocol.sendControl(encode({ v: 1, nonce: randomBytes(32) }));
    expect(await closed).toBe('the connection closed');
    expect(controls).toHaveLength(1);
    expect(regular).toHaveLength(0);
  });

  it('closes a connection at once while MAX_UNAUTHENTICATED others are still authenticating, and serves clients once they end', async () => {
    const { endpoint } = (await readPidFile(daemon.paths.pidFile))!;
    const open = (): Promise<net.Socket> => new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
    const silent: net.Socket[] = [];
    for (let index = 0; index < MAX_UNAUTHENTICATED; index++) silent.push(await open());
    const extra = await open();
    // the handshake's own deadline would close it only after 10 s
    await new Promise<void>((resolve) => extra.once('close', () => resolve()));
    for (const socket of silent) socket.destroy();
    await vi.waitFor(async () => {
      const client = await connectClient(await daemon.connect());
      expect(client.outcome.kind).toBe('welcome');
      client.protocol.close('done');
    }, { timeout: 5000 });
  }, 8000);

  it('keeps the frozen control commands open after refusing another protocol version', async () => {
    const client = await connectClient(await daemon.connect(), { protocolVersion: 99 });
    // a refused connection has no welcome, so the refusal names the frozen commands a later app may call
    expect(client.outcome).toMatchObject({ kind: 'refused', refused: { reason: 'protocol', frozenFeatures: ['control.handOver'] } });
    expect(await client.frozen.request('listRuns', {})).toEqual({ runs: [] });
    // a command outside the frozen set is a violation there, which closes the connection
    const viaFrozen = client.frozen as unknown as { request(method: string, params: unknown): Promise<unknown> };
    await expect(viaFrozen.request('logs.list', {})).rejects.toThrow();
    expect(await client.closed).toBeTruthy();
  });

  it('serves handOver on the frozen endpoint of a refused connection: now exits', async () => {
    const client = await connectClient(await daemon.connect(), { protocolVersion: 99 });
    await client.frozen.request('handOver', { when: 'now' });
    expect(await daemon.exited).toBe('handOver now');
    expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
  });

  it('serves handOver idle on the frozen endpoint, waiting for a connected client that did not ask', async () => {
    const other = await connectClient(await daemon.connect(), { clientId: 'other' });
    const asker = await connectClient(await daemon.connect(), { clientId: 'asker', protocolVersion: 99 });
    await asker.frozen.request('handOver', { when: 'idle' });
    const running = await Promise.race([daemon.exited, new Promise<string>((resolve) => setTimeout(() => resolve('running'), 200))]);
    expect(running).toBe('running');
    other.protocol.close('done');
    expect(await daemon.exited).toBe('handOver, and no agent run, damocles --wait or other client is left');
  });

  it('serves handOverIfIdle: with no agent run and no damocles --wait, answers now and exits handed over', async () => {
    const client = await connectClient(await daemon.connect());
    expect(client.outcome.kind === 'welcome' && client.outcome.welcome.features).toContain('control.handOverIfIdle');
    expect(await client.control.request('handOverIfIdle', {})).toEqual({ when: 'now' });
    expect(await daemon.exited).toBe('handOver now, and no agent run or damocles --wait was pending');
    expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
  });

  it('closes a connection that asks handOver with a when outside its closed list, and stays up', async () => {
    const client = await connectClient(await daemon.connect(), { protocolVersion: 99 });
    const viaFrozen = client.frozen as unknown as { request(method: string, params: unknown): Promise<unknown> };
    await expect(viaFrozen.request('handOver', { when: 'later' })).rejects.toThrow();
    expect(await client.closed).toBeTruthy();
    const running = await Promise.race([daemon.exited, new Promise<string>((resolve) => setTimeout(() => resolve('running'), 200))]);
    expect(running).toBe('running');
  });

  it('refuses an unknown reconnection token and closes', async () => {
    const client = await connectClient(await daemon.connect(), { reconnectionToken: new Uint8Array(32) });
    expect(client.outcome).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token', frozenFeatures: ['control.handOver'] } });
    expect(await client.closed).toBeTruthy();
  });

  it('resumes a dropped connection inside its grace, and what the client sent while away arrives', async () => {
    const lines: string[] = [];
    await daemon.shutdown();
    daemon = await startInProcessDaemon({ starters: NO_HOSTS, log: (line) => lines.push(line) });
    const socket = await daemon.connect();
    const client = await connectClient(socket, { clientId: 'roaming' });
    client.protocol.holdOnDrop();
    await client.control.request('attach', { terminalIdleDays: 7 });
    const lost = new Promise((resolve) => client.protocol.onLost(resolve));
    socket.destroy();
    await lost;
    await vi.waitFor(() => expect(lines.some((line) => /connection-\d+ lost/.test(line))).toBe(true));
    const runs = client.control.request('listRuns', {});
    const outcome = await resumeClient(client, await daemon.connect(), 'roaming');
    expect(outcome).toMatchObject({ kind: 'welcome', welcome: { resumed: true } });
    expect(await runs).toEqual({ runs: [] });
    expect(lines.some((line) => /connection-\d+ resumed/.test(line))).toBe(true);
    client.protocol.close('done');
  });

  it('refuses the token once the grace ended, and a fresh connection is welcomed', async () => {
    const lines: string[] = [];
    await daemon.shutdown();
    daemon = await startInProcessDaemon({ starters: NO_HOSTS, graceMs: 50, log: (line) => lines.push(line) });
    const socket = await daemon.connect();
    const client = await connectClient(socket, { clientId: 'late' });
    client.protocol.holdOnDrop();
    socket.destroy();
    await vi.waitFor(() => expect(lines.some((line) => line.includes('the grace ended'))).toBe(true));
    expect(await resumeClient(client, await daemon.connect(), 'late')).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
    const fresh = await connectClient(await daemon.connect(), { clientId: 'late' });
    expect(fresh.outcome).toMatchObject({ kind: 'welcome', welcome: { resumed: false } });
    fresh.protocol.close('done');
  });

  it('answers disconnect, then ends the connection without holding it for a resume', async () => {
    const client = await connectClient(await daemon.connect(), { clientId: 'leaving' });
    client.protocol.holdOnDrop();
    await client.control.request('attach', { terminalIdleDays: 7 });
    const lost = new Promise((resolve) => client.protocol.onLost(resolve));
    await client.control.request('disconnect', {});
    expect(await lost).toBe('the connection closed');
    expect(await resumeClient(client, await daemon.connect(), 'leaving')).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
    client.protocol.close('done');
  });

  it('replaces a live clientId with the new connection', async () => {
    const first = await connectClient(await daemon.connect(), { clientId: 'same' });
    const second = await connectClient(await daemon.connect(), { clientId: 'same' });
    expect(await first.closed).toMatch(/closed|failed/);
    expect(await second.control.request('listRuns', {})).toEqual({ runs: [] });
    second.protocol.close('done');
  });

  it('sends mirror.sync\'s answer before it opens the streams the answer names', async () => {
    const project = path.join(os.tmpdir(), 'dm-mirror-order', 'app');
    const sessions = piSessionDir(project, PI_AGENT_DIR);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'a.jsonl'), 'line\n');
    const client = await connectClient(await daemon.connect());
    const frames: Array<{ channel: number; kind: number }> = [];
    client.protocol.onMessage((body) => frames.push({ channel: body[0]!, kind: body[1]! }));
    client.mux.onStream(() => undefined);
    const { changes } = await client.control.request('mirror.sync', { projectKey: project, budgetBytes: 1 << 20, files: [] });
    expect(changes).toEqual([{ file: 'a.jsonl', kind: 'full', offset: 0, length: 5, stream: changes[0]!.stream }]);
    await vi.waitFor(() => expect(frames.some((frame) => frame.channel === changes[0]!.stream && frame.kind === KIND_OPEN)).toBe(true));
    const answer = frames.findIndex((frame) => frame.channel === CHANNEL.control && frame.kind === KIND_DATA);
    const open = frames.findIndex((frame) => frame.channel === changes[0]!.stream && frame.kind === KIND_OPEN);
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(answer).toBeLessThan(open);
    client.protocol.close('done');
  });

  it('tells every other device that asked, by the asking device\'s name, that a switch ends it, before their connections end', async () => {
    for (const ask of ['handOverIfIdle', 'handOver now', 'shutdownNow'] as const) {
      const asker = await connectClient(await daemon.connect(), { clientId: 'asker', deviceName: 'DESKTOP-A' });
      const watching = await connectClient(await daemon.connect(), { clientId: 'watching', deviceName: 'Laptop B' });
      const unasked = await connectClient(await daemon.connect(), { clientId: 'unasked', deviceName: 'Old app' });
      expect(asker.outcome.kind === 'welcome' && asker.outcome.welcome.features).toContain('control.handingOver');
      const seen: string[] = [];
      for (const [name, connection] of [['asker', asker], ['watching', watching], ['unasked', unasked]] as const) {
        connection.control.onEvent('handingOver', ({ deviceName }) => seen.push(`${name} told: ${deviceName}`));
        void connection.closed.then(() => seen.push(`${name} closed`));
      }
      await asker.control.request('attach', { terminalIdleDays: 7, watchHandOver: true });
      await watching.control.request('attach', { terminalIdleDays: 7, watchHandOver: true });
      await unasked.control.request('attach', { terminalIdleDays: 7 });
      if (ask === 'handOverIfIdle') expect(await asker.control.request('handOverIfIdle', {})).toEqual({ when: 'now' });
      else if (ask === 'handOver now') await asker.control.request('handOver', { when: 'now' });
      else await asker.control.request('shutdownNow', {});
      await daemon.exited;
      await Promise.all([asker.closed, watching.closed, unasked.closed]);
      expect(seen.filter((line) => line.includes('told')), ask).toEqual(['watching told: DESKTOP-A']);
      expect(seen.indexOf('watching told: DESKTOP-A'), ask).toBeLessThan(seen.indexOf('watching closed'));
      await daemon.shutdown();
      daemon = await startInProcessDaemon({ starters: NO_HOSTS });
    }
  });

  it('answers shutdownNow, then removes its pid file and exits', async () => {
    const client = await connectClient(await daemon.connect());
    await client.control.request('shutdownNow', {});
    expect(await daemon.exited).toBe('control.shutdownNow');
    expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
  });

  // two apps of different builds on one host: the one that asks must not end the other's connection
  it('after one client asks shutdownWhenIdle, stays while another client is connected and exits once it leaves', async () => {
    const asker = await connectClient(await daemon.connect(), { clientId: 'asker' });
    const other = await connectClient(await daemon.connect(), { clientId: 'other' });
    await asker.control.request('shutdownWhenIdle', {});
    const running = await Promise.race([daemon.exited, new Promise<string>((resolve) => setTimeout(() => resolve('running'), 200))]);
    expect(running).toBe('running');
    other.protocol.close('done');
    expect(await daemon.exited).toBe('shutdownWhenIdle, and no run, terminal or other client is left');
    asker.protocol.close('done');
  });
});

// Connections alone, with a core channel the test posts on, so traffic queues while the client is away in a known order.
describe('daemon connections inside the grace', () => {
  const token = randomBytes(32);

  function harness(maxHeldBytes: number, overrides: Partial<Pick<ConnectionsDeps, 'control' | 'mirrorWatches' | 'agentUpstream' | 'runs'>> = {}) {
    let core: CoreTransport | undefined;
    let coreDrained: (() => Promise<void>) | undefined;
    const links: ClientLink[] = [];
    const presence: Array<readonly ConnectionPresence[]> = [];
    const closed: string[] = [];
    const lines: string[] = [];
    const connections = createConnections({
      serverVersion: '0.0.0-test',
      facts: TEST_FACTS,
      workspace: { serve: () => ({ dispose: () => undefined }), attached: () => undefined },
      ports: { serve: () => ({ dispose: () => undefined }) },
      core: {
        epoch: () => null,
        onState: () => ({ dispose: () => undefined }),
        connect: (_id, _clientId, channel, _close, link) => {
          core = channel;
          coreDrained = link.drained;
          links.push(link);
          return { attach: () => { throw new Error('no core in this test'); }, clientFeatures: () => new Set(), dispose: () => undefined };
        },
      },
      control: {} as never,
      mirrorWatches: mirrorWatches(),
      runs: { runs: () => [], cliWaits: () => [], onChange: () => ({ dispose: () => undefined }) },
      connectionsChanged: (connected) => presence.push(connected),
      connectionClosed: (id) => closed.push(id),
      agentUpstream: () => undefined,
      maxHeldBytes,
      log: (line) => lines.push(line),
      ...overrides,
    });
    // what the attach bridge hands the app: a socket past the bridge's authentication
    // a duplexPair side's destroy never reaches the other, so a drop destroys both
    const ends = new Map<Duplex, Duplex>();
    const drop = (ours: Duplex): void => {
      ours.destroy();
      ends.get(ours)?.destroy();
    };
    // agentSock: the forwarded agent socket the bridge names
    const socket = async (agentSock?: string): Promise<Duplex> => {
      const [ours, theirs] = duplexPair();
      ends.set(ours, theirs);
      connections.accept(theirs, token);
      const bridge = createPersistentProtocol({ socket: streamSocket(ours), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
      await authenticateBridge(bridge, token, agentSock);
      const rest = bridge.detach();
      if (rest.length > 0) ours.unshift(Buffer.from(rest));
      return ours;
    };
    return { connections, socket, drop, presence, closed, lines, links, core: () => core!, coreDrained: () => coreDrained!() };
  }

  it('relays a client\'s agent only once that connection offers it, asks that client alone, and holds the process until its answer', async () => {
    const upstreams: Array<[string, string | undefined]> = [];
    let relay: AgentRelay | undefined;
    const { connections, socket, drop } = harness(64 * 1024, {
      agentUpstream: (clientId, upstream) => {
        upstreams.push([clientId, upstream?.kind]);
        if (upstream?.kind === 'relay') relay = upstream.relay;
      },
    });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted: net.Socket[] = [];
    server.on('connection', (incoming) => accepted.push(incoming));
    // a process in the container connecting to the client's proxy socket, whose daemon side the proxy hands the relay
    const process = async (): Promise<{ socket: net.Socket; incoming: net.Socket; received: () => string; closed: Promise<void> }> => {
      const before = accepted.length;
      const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
      let text = '';
      socket.on('data', (chunk) => { text += chunk.toString('utf8'); });
      socket.on('error', () => undefined);
      const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
      await vi.waitFor(() => expect(accepted.length).toBe(before + 1));
      return { socket, incoming: accepted[before]!, received: () => text, closed };
    };
    try {
      const laptopSocket = await socket();
      const laptop = await connectClient(laptopSocket, { clientId: 'laptop' });
      const desktopSocket = await socket();
      const desktop = await connectClient(desktopSocket, { clientId: 'desktop' });
      const laptopAsked: number[] = [];
      const desktopAsked: number[] = [];
      laptop.control.onEvent('agent.request', ({ request }) => laptopAsked.push(request));
      desktop.control.onEvent('agent.request', ({ request }) => desktopAsked.push(request));
      expect(upstreams).toEqual([['laptop', undefined], ['desktop', undefined]]);
      await laptop.control.request('agent.relay', {});
      expect(upstreams.at(-1)).toEqual(['laptop', 'relay']);

      const first = await process();
      relay!.request(first.incoming);
      await vi.waitFor(() => expect(laptopAsked).toEqual([1]));
      // nothing the process writes leaves the daemon before the client answers
      first.socket.write('request');
      const stream = holdStream(laptop.mux.openStream());
      const carried: string[] = [];
      stream.onData((bytes) => carried.push(Buffer.from(bytes).toString('utf8')));
      expect(first.incoming.isPaused()).toBe(true);
      expect(carried).toEqual([]);
      expect(await laptop.control.request('agent.connect', { request: 1, stream: stream.id })).toEqual({ ok: true });
      await vi.waitFor(() => expect(carried.join('')).toBe('request'));
      stream.write(Buffer.from('answer'));
      await vi.waitFor(() => expect(first.received()).toBe('answer'));

      // a request already taken, or one never drawn: the named stream is claimed and ended, so it stops counting
      for (const request of [1, 99]) {
        const late = holdStream(laptop.mux.openStream());
        const ended = new Promise<void>((resolve) => late.onEnd(() => resolve()));
        expect(await laptop.control.request('agent.connect', { request, stream: late.id })).toEqual({ ok: false });
        await ended;
        late.end();
      }

      // a refusal closes the waiting process at once
      const second = await process();
      relay!.request(second.incoming);
      await vi.waitFor(() => expect(laptopAsked).toEqual([1, 2]));
      await laptop.control.request('agent.refuse', { request: 2 });
      await second.closed;
      expect(desktopAsked).toEqual([]);

      // an answer naming a stream the daemon no longer holds (main ended it before the request arrived) refuses the process too
      const third = await process();
      relay!.request(third.incoming);
      await vi.waitFor(() => expect(laptopAsked).toEqual([1, 2, 3]));
      await expect(laptop.control.request('agent.connect', { request: 3, stream: 999_999 })).rejects.toThrow('is not open');
      await third.closed;

      // the client out of reach: no upstream until it resumes, and then the relay again, whatever agent socket the new bridge names
      drop(laptopSocket);
      await vi.waitFor(() => expect(upstreams.at(-1)).toEqual(['laptop', undefined]));
      expect((await resumeClient(laptop, await socket('/tmp/ssh-image/agent.1'), 'laptop')).kind).toBe('welcome');
      await vi.waitFor(() => expect(upstreams.at(-1)).toEqual(['laptop', 'relay']));
      // a connection that never offered the relay takes its new bridge's agent socket
      drop(desktopSocket);
      await vi.waitFor(() => expect(upstreams.at(-1)).toEqual(['desktop', undefined]));
      expect((await resumeClient(desktop, await socket('/tmp/ssh-session/agent.2'), 'desktop')).kind).toBe('welcome');
      await vi.waitFor(() => expect(upstreams.at(-1)).toEqual(['desktop', 'socket']));
      desktop.protocol.close('done');
      laptop.protocol.close('done');
    } finally {
      await connections.endAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends the runs to an attach that watches them, at once and then one event for the changes of each RUNS_EVENT_MS, to no other attach, until it closes', async () => {
    const run = (id: string, kind: Run['kind']): Run => ({ kind, id, projectKey: '', title: id, state: 'running', providers: [] });
    let current: readonly Run[] = [];
    const changed = new Set<() => void>();
    const setRuns = (next: readonly Run[]): void => {
      current = next;
      for (const listener of [...changed]) listener();
    };
    const { connections, socket } = harness(64 * 1024, {
      control: { attach: () => undefined } as never,
      runs: { runs: () => current, cliWaits: () => [], onChange: (listener) => (changed.add(listener), { dispose: () => { changed.delete(listener); } }) },
    });
    const watcher = await connectClient(await socket(), { clientId: 'watcher' });
    const other = await connectClient(await socket(), { clientId: 'other' });
    const seen: string[][] = [];
    const unasked = vi.fn();
    watcher.control.onEvent('runs', ({ runs }) => seen.push(runs.map((listed) => listed.id)));
    other.control.onEvent('runs', unasked);
    await watcher.control.request('attach', { terminalIdleDays: 7, watchRuns: true });
    await other.control.request('attach', { terminalIdleDays: 7 });
    expect(seen).toEqual([[]]);
    setRuns([run('term-1', 'terminal')]);
    setRuns([run('term-1', 'terminal'), run('panel-1', 'chat')]);
    setRuns([run('panel-1', 'chat')]);
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, RUNS_EVENT_MS * 2));
    expect(seen).toEqual([[], ['panel-1']]);
    expect(unasked).not.toHaveBeenCalled();
    watcher.protocol.close('done');
    other.protocol.close('done');
    await connections.endAll();
    expect(changed.size).toBe(0);
  });

  it('sends the pending damocles --wait requests with each runs event, which listRuns leaves out', async () => {
    let waits: readonly string[] = [];
    const changed = new Set<() => void>();
    const { connections, socket } = harness(64 * 1024, {
      control: { attach: () => undefined } as never,
      runs: { runs: () => [], cliWaits: () => waits, onChange: (listener) => (changed.add(listener), { dispose: () => { changed.delete(listener); } }) },
    });
    const watcher = await connectClient(await socket(), { clientId: 'watcher' });
    const seen: Array<readonly string[] | undefined> = [];
    watcher.control.onEvent('runs', ({ cliWaits }) => seen.push(cliWaits));
    await watcher.control.request('attach', { terminalIdleDays: 7, watchRuns: true });
    waits = ['COMMIT_EDITMSG'];
    for (const listener of [...changed]) listener();
    await vi.waitFor(() => expect(seen).toEqual([[], ['COMMIT_EDITMSG']]));
    watcher.protocol.close('done');
    await connections.endAll();
  });

  it('follows a project before it serves the project\'s mirror.sync, sends mirror.changed for it, and lets go of it with the connection', async () => {
    const order: string[] = [];
    let announce: (() => void) | undefined;
    let watching!: () => void;
    const released: string[] = [];
    const { connections, socket } = harness(64 * 1024, {
      mirrorWatches: mirrorWatches({
        follow: (projectKey, changed) => {
          order.push(`follow ${projectKey}`);
          announce = changed;
          return new Promise<void>((resolve) => { watching = resolve; });
        },
      }, (id) => released.push(id)),
      control: { 'mirror.sync': () => { order.push('sync'); return { changes: [] }; } } as never,
    });
    const client = await connectClient(await socket());
    const answer = client.control.request('mirror.sync', { projectKey: '/srv/app', budgetBytes: 1024, files: [] });
    await vi.waitFor(() => expect(order).toEqual(['follow /srv/app']));
    // the listing waits for the watch
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['follow /srv/app']);
    watching();
    expect(await answer).toEqual({ changes: [] });
    expect(order).toEqual(['follow /srv/app', 'sync']);
    const heard = new Promise((resolve) => client.control.onEvent('mirror.changed', resolve));
    announce!();
    expect(await heard).toEqual({ projectKey: '/srv/app' });
    expect(released).toEqual([]);
    client.protocol.close('done');
    await connections.endAll();
    expect(released).toHaveLength(1);
  });

  it('answers mirror.sync, mirror.syncProject and mirror.syncSubcalls when their watch fails, and logs it', async () => {
    const webFolders = { own: '/sessions/web', worktrees: [], unreadable: false };
    const listedFrom: unknown[] = [];
    const { connections, socket, lines } = harness(64 * 1024, {
      mirrorWatches: mirrorWatches({
        follow: () => Promise.reject(new Error('no watch for you')),
        followProject: (projectKey) => (projectKey === '/srv/web' ? Promise.resolve({ folders: webFolders, failed: new Error('no project watch') }) : Promise.reject(new Error('no registry read'))),
        followSubcalls: () => Promise.reject(new Error('no ledger watch')),
      }),
      control: { 'mirror.sync': () => ({ changes: [] }), 'mirror.syncProject': (_params: unknown, _connection: unknown, folders: unknown) => { listedFrom.push(folders); return { changes: [] }; }, 'mirror.syncSubcalls': () => ({}) } as never,
    });
    const client = await connectClient(await socket());
    expect(await client.control.request('mirror.sync', { projectKey: '/srv/app', budgetBytes: 1024, files: [] })).toEqual({ changes: [] });
    expect(await client.control.request('mirror.syncProject', { projectKey: '/srv/web', budgetBytes: 1024, files: [] })).toEqual({ changes: [] });
    expect(await client.control.request('mirror.syncProject', { projectKey: '/srv/api', budgetBytes: 1024, files: [] })).toEqual({ changes: [] });
    expect(await client.control.request('mirror.syncSubcalls', { budgetBytes: 1024 })).toEqual({});
    // a sync whose folders the follow could not read reads them itself
    expect(listedFrom).toEqual([webFolders, undefined]);
    expect(lines.filter((line) => line.startsWith('[mirror]'))).toEqual([
      '[mirror] connection-1: watching /srv/app failed, so its changes are not announced: no watch for you',
      '[mirror] connection-1: watching /srv/web and its worktree chats failed, so their changes are not announced: no project watch',
      '[mirror] connection-1: watching /srv/api and its worktree chats failed, so their changes are not announced: no registry read',
      '[mirror] connection-1: watching the sub-call ledger failed, so its changes are not announced: no ledger watch',
    ]);
    client.protocol.close('done');
    await connections.endAll();
  });

  it('follows a project and its worktree chats\' folders before it serves mirror.syncProject, lists the folders it followed, and sends mirror.changed for it', async () => {
    const order: string[] = [];
    let announce: (() => void) | undefined;
    let watching!: () => void;
    const folders = { own: '/sessions/app', worktrees: [{ id: 'live0001', kind: 'chat' as const, folder: '/sessions/wt' }], unreadable: false };
    let listed: unknown;
    const { connections, socket } = harness(64 * 1024, {
      mirrorWatches: mirrorWatches({
        followProject: (projectKey, changed) => {
          order.push(`follow ${projectKey}`);
          announce = changed;
          return new Promise((resolve) => { watching = () => resolve({ folders }); });
        },
      }),
      control: { 'mirror.syncProject': (params: { projectKey: string }, _connection: unknown, followed: unknown) => { order.push(`sync ${params.projectKey}`); listed = followed; return { changes: [] }; } } as never,
    });
    const client = await connectClient(await socket());
    const answer = client.control.request('mirror.syncProject', { projectKey: '/srv/app', budgetBytes: 1024, files: [] });
    await vi.waitFor(() => expect(order).toEqual(['follow /srv/app']));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['follow /srv/app']);
    watching();
    expect(await answer).toEqual({ changes: [] });
    expect(order).toEqual(['follow /srv/app', 'sync /srv/app']);
    expect(listed).toBe(folders);
    const heard = new Promise((resolve) => client.control.onEvent('mirror.changed', resolve));
    announce!();
    expect(await heard).toEqual({ projectKey: '/srv/app' });
    client.protocol.close('done');
    await connections.endAll();
  });

  it('follows the sub-call ledger before it serves mirror.syncSubcalls, and sends mirror.subcallsChanged for it', async () => {
    const order: string[] = [];
    let announce: (() => void) | undefined;
    let watching!: () => void;
    const { connections, socket } = harness(64 * 1024, {
      mirrorWatches: mirrorWatches({
        followSubcalls: (changed) => {
          order.push('follow');
          announce = changed;
          return new Promise<void>((resolve) => { watching = resolve; });
        },
      }),
      control: { 'mirror.syncSubcalls': () => { order.push('sync'); return {}; } } as never,
    });
    const client = await connectClient(await socket());
    const answer = client.control.request('mirror.syncSubcalls', { budgetBytes: 1024 });
    await vi.waitFor(() => expect(order).toEqual(['follow']));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['follow']);
    watching();
    expect(await answer).toEqual({});
    expect(order).toEqual(['follow', 'sync']);
    const heard = new Promise((resolve) => client.control.onEvent('mirror.subcallsChanged', resolve));
    announce!();
    expect(await heard).toEqual({});
    client.protocol.close('done');
    await connections.endAll();
  });

  it('drops a dropped connection whose held frames pass the bound, so the next resume is refused unknown-token', async () => {
    const { connections, socket, drop, presence, lines, core } = harness(64 * 1024);
    const first = await socket();
    const client = await connectClient(first, { clientId: 'away' });
    client.protocol.holdOnDrop();
    drop(first);
    await vi.waitFor(() => expect(presence.at(-1)?.map((connection) => connection.state)).toEqual(['inGrace']));
    // core keeps talking while the client is away: nothing is sent, the longest queued message (the latest of equal ones) is
    // exempt, so the third passes the bound
    core().post({ filler: 'x'.repeat(40 * 1024) });
    core().post({ filler: 'x'.repeat(40 * 1024) });
    expect(lines.join('\n')).not.toContain('held frames passed');
    core().post({ filler: 'x'.repeat(40 * 1024) });
    expect(lines.join('\n')).toContain('held frames passed the per-connection bound');
    expect(presence.at(-1)?.map((connection) => connection.state)).toEqual([]);
    expect(await resumeClient(client, await socket(), 'away')).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
    client.protocol.close('done');
    await connections.endAll();
  });

  // what core posts while a client is too slow: 16 KiB messages, each its own message on the core channel
  const FILLER = { filler: 'x'.repeat(16 * 1024) };
  const overflows = (lines: readonly string[]): number => lines.filter((line) => line.includes('held frames passed the per-connection bound')).length;

  it('drops a live connection whose client stops reading once its backlog passes the bound, and the client attaches fresh once', async () => {
    // above the channel's 1 MiB window, which a waiting producer may still fill
    const bound = 4 * 1024 * 1024;
    const { connections, socket, presence, lines, core, coreDrained } = harness(bound);
    const first = await socket();
    const slow = await connectClient(first, { clientId: 'slow' });
    slow.protocol.holdOnDrop();
    // the client stops reading; the connection stays up, so nothing counts it as dropped
    first.pause();
    let posted = 0;
    while (overflows(lines) === 0 && posted < 8 * bound) {
      core().post(FILLER);
      posted += FILLER.filler.length;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(overflows(lines)).toBe(1);
    expect(posted).toBeLessThan(2 * bound);
    expect(lines.join('\n')).not.toContain(' lost (');
    expect(presence.at(-1)?.map((connection) => connection.state)).toEqual([]);
    expect(await resumeClient(slow, await socket(), 'slow')).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
    // the fresh attach reads, and core waits for the channel to drain, so the same volume again passes no bound
    const fresh = await connectClient(await socket(), { clientId: 'slow' });
    const received: number[] = [];
    fresh.mux.messageChannel(3, 1 << 20).onMessage((bytes) => received.push(bytes.length));
    for (let index = 0; index * FILLER.filler.length < 2 * bound; index++) {
      core().post(FILLER);
      await coreDrained();
    }
    await vi.waitFor(() => expect(received).toHaveLength(2 * bound / FILLER.filler.length));
    expect(overflows(lines)).toBe(1);
    fresh.protocol.close('done');
    slow.protocol.close('done');
    await connections.endAll();
  });

  it('delivers a replay many times the bound to a reading client without an overflow when core waits for the channel to drain', async () => {
    // above the channel's 1 MiB window, which a waiting producer may still fill
    const bound = 4 * 1024 * 1024;
    const { connections, socket, lines, core, coreDrained } = harness(bound);
    const client = await connectClient(await socket(), { clientId: 'rejoining' });
    client.protocol.holdOnDrop();
    const received: number[] = [];
    client.mux.messageChannel(3, 1 << 20).onMessage((bytes) => received.push(bytes.length));
    const messages = 3 * bound / FILLER.filler.length;
    for (let index = 0; index < messages; index++) {
      core().post(FILLER);
      await coreDrained();
    }
    await vi.waitFor(() => expect(received).toHaveLength(messages));
    expect(overflows(lines)).toBe(0);
    client.protocol.close('done');
    await connections.endAll();
  });

  it('refuses a resume whose token is not the connection\'s, and one from another client id with the right token', async () => {
    const { connections, socket, drop } = harness(64 * 1024 * 1024);
    const first = await socket();
    const client = await connectClient(first, { clientId: 'owner' });
    client.protocol.holdOnDrop();
    drop(first);
    await vi.waitFor(() => expect(client.protocol.lost()).toBe(true));
    const forged = { ...client, outcome: client.outcome.kind === 'welcome' ? { ...client.outcome, welcome: { ...client.outcome.welcome, reconnectionToken: randomBytes(32) } } : client.outcome };
    expect(await resumeClient(forged, await socket(), 'owner')).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
    expect(await resumeClient(client, await socket(), 'someone-else')).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
    expect(await resumeClient(client, await socket(), 'owner')).toMatchObject({ kind: 'welcome', welcome: { resumed: true } });
    client.protocol.close('done');
    await connections.endAll();
  });

  it("tells the core channel's link when the connection is lost and when it resumes", async () => {
    const { connections, socket, drop, links } = harness(64 * 1024 * 1024);
    const first = await socket();
    const client = await connectClient(first, { clientId: 'roaming' });
    client.protocol.holdOnDrop();
    const link = links[0]!;
    const seen: boolean[] = [];
    link.onLostChange(() => seen.push(link.lost()));
    expect(link.lost()).toBe(false);
    drop(first);
    await vi.waitFor(() => expect(seen).toEqual([true]));
    await vi.waitFor(() => expect(client.protocol.lost()).toBe(true));
    expect(await resumeClient(client, await socket(), 'roaming')).toMatchObject({ kind: 'welcome', welcome: { resumed: true } });
    expect(seen).toEqual([true, false]);
    client.protocol.close('done');
    await connections.endAll();
  });

  it('ends each connection through its protocol, so what core sends before the client closes its side is never written after the end', async () => {
    const { connections, socket, lines, core } = harness(64 * 1024 * 1024);
    const ours = await socket();
    const client = await connectClient(ours, { clientId: 'staying' });
    client.protocol.holdOnDrop();
    // the client closes its side a network round trip after it read the end, as the app does
    ours.once('end', () => setTimeout(() => ours.end(), 50));
    const ending = connections.endAll();
    core().post({ late: true });
    await ending;
    expect(lines.filter((line) => line.includes(' closed: '))).toEqual(['[daemon] connection-1 closed: the daemon is shutting down']);
    client.protocol.close('done');
  });

  // the lifetime keys a shutdownWhenIdle ask by this id (ControlConnection.id), so a resume must keep it and a close must name it
  it('lists a connection by its id, inGrace inside its grace and connected again once resumed, and names it once it closes', async () => {
    const { connections, socket, drop, presence, closed } = harness(64 * 1024 * 1024);
    const first = await socket();
    const client = await connectClient(first, { clientId: 'back' });
    client.protocol.holdOnDrop();
    expect(presence.at(-1)).toEqual([{ id: 'connection-1', state: 'connected' }]);
    drop(first);
    await vi.waitFor(() => expect(presence.at(-1)).toEqual([{ id: 'connection-1', state: 'inGrace' }]));
    await vi.waitFor(() => expect(client.protocol.lost()).toBe(true));
    expect(await resumeClient(client, await socket(), 'back')).toMatchObject({ kind: 'welcome', welcome: { resumed: true } });
    expect(presence.at(-1)).toEqual([{ id: 'connection-1', state: 'connected' }]);
    expect(closed).toEqual([]);
    await connections.endAll();
    await vi.waitFor(() => expect(closed).toEqual(['connection-1']));
    expect(presence.at(-1)).toEqual([]);
    client.protocol.close('done');
  });
});
