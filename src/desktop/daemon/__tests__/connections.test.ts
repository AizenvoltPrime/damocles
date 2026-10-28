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
import { createConnections, MAX_UNAUTHENTICATED, type ConnectionPresence } from '../connections';
import type { CoreTransport } from '../../core-protocol/endpoint';
import type { ClientLink } from '../core-routes';
import { authenticateBridge } from '../../../remote/handshake';
import { duplexPair, type Duplex } from 'node:stream';
import { TEST_FACTS } from './in-process-daemon';
import { readPidFile, runPaths, SHARED_HOME_WINDOW_MS, writePidFile } from '../token';
import { startInProcessDaemon, type InProcessDaemon } from './in-process-daemon';
import { connectClient, resumeClient } from './test-client';

// no terminal or formatter runs in these tests
const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

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
    expect(client.outcome).toMatchObject({ kind: 'refused', refused: { reason: 'protocol' } });
    expect(await client.frozen.request('listRuns', {})).toEqual({ runs: [] });
    // a command outside the frozen set is a violation there, which closes the connection
    const viaFrozen = client.frozen as unknown as { request(method: string, params: unknown): Promise<unknown> };
    await expect(viaFrozen.request('logs.list', {})).rejects.toThrow();
    expect(await client.closed).toBeTruthy();
  });

  it('refuses an unknown reconnection token and closes', async () => {
    const client = await connectClient(await daemon.connect(), { reconnectionToken: new Uint8Array(32) });
    expect(client.outcome).toMatchObject({ kind: 'refused', refused: { reason: 'unknown-token' } });
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

  it('answers shutdownNow, then removes its pid file and exits', async () => {
    const client = await connectClient(await daemon.connect());
    await client.control.request('shutdownNow', {});
    expect(await daemon.exited).toBe('control.shutdownNow');
    expect(await readPidFile(daemon.paths.pidFile)).toBeUndefined();
  });
});

// Connections alone, with a core channel the test posts on, so traffic queues while the client is away in a known order.
describe('daemon connections inside the grace', () => {
  const token = randomBytes(32);

  function harness(maxHeldBytes: number) {
    let core: CoreTransport | undefined;
    let coreDrained: (() => Promise<void>) | undefined;
    const links: ClientLink[] = [];
    const presence: Array<readonly ConnectionPresence[]> = [];
    const lines: string[] = [];
    const connections = createConnections({
      serverVersion: '0.0.0-test',
      facts: TEST_FACTS,
      workspace: { serve: () => ({ dispose: () => undefined }) },
      core: {
        epoch: () => null,
        onState: () => ({ dispose: () => undefined }),
        connect: (_id, _clientId, channel, _close, link) => {
          core = channel;
          coreDrained = link.drained;
          links.push(link);
          return { attach: () => { throw new Error('no core in this test'); }, dispose: () => undefined };
        },
      },
      control: {} as never,
      connectionsChanged: (connected) => presence.push(connected),
      agentSock: () => undefined,
      maxHeldBytes,
      log: (line) => lines.push(line),
    });
    // what the attach bridge hands the app: a socket past the bridge's authentication
    // a duplexPair side's destroy never reaches the other, so a drop destroys both
    const ends = new Map<Duplex, Duplex>();
    const drop = (ours: Duplex): void => {
      ours.destroy();
      ends.get(ours)?.destroy();
    };
    const socket = async (): Promise<Duplex> => {
      const [ours, theirs] = duplexPair();
      ends.set(ours, theirs);
      connections.accept(theirs, token);
      const bridge = createPersistentProtocol({ socket: streamSocket(ours), maxBodyBytes: HANDSHAKE_MAX_BYTES, log: () => undefined });
      await authenticateBridge(bridge, token);
      const rest = bridge.detach();
      if (rest.length > 0) ours.unshift(Buffer.from(rest));
      return ours;
    };
    return { connections, socket, drop, presence, lines, links, core: () => core!, coreDrained: () => coreDrained!() };
  }

  it('drops a dropped connection whose held frames pass the bound, so the next resume is refused unknown-token', async () => {
    const { connections, socket, drop, presence, lines, core } = harness(64 * 1024);
    const first = await socket();
    const client = await connectClient(first, { clientId: 'away' });
    client.protocol.holdOnDrop();
    drop(first);
    await vi.waitFor(() => expect(presence.at(-1)).toEqual(['inGrace']));
    // core keeps talking while the client is away: nothing is sent, the longest queued message (the latest of equal ones) is
    // exempt, so the third passes the bound
    core().post({ filler: 'x'.repeat(40 * 1024) });
    core().post({ filler: 'x'.repeat(40 * 1024) });
    expect(lines.join('\n')).not.toContain('held frames passed');
    core().post({ filler: 'x'.repeat(40 * 1024) });
    expect(lines.join('\n')).toContain('held frames passed the per-connection bound');
    expect(presence.at(-1)).toEqual([]);
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
    expect(presence.at(-1)).toEqual([]);
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

  it('counts a connection inside its grace as inGrace, and connected again once resumed', async () => {
    const { connections, socket, drop, presence } = harness(64 * 1024 * 1024);
    const first = await socket();
    const client = await connectClient(first, { clientId: 'back' });
    client.protocol.holdOnDrop();
    expect(presence.at(-1)).toEqual(['connected']);
    drop(first);
    await vi.waitFor(() => expect(presence.at(-1)).toEqual(['inGrace']));
    await vi.waitFor(() => expect(client.protocol.lost()).toBe(true));
    expect(await resumeClient(client, await socket(), 'back')).toMatchObject({ kind: 'welcome', welcome: { resumed: true } });
    expect(presence.at(-1)).toEqual(['connected']);
    client.protocol.close('done');
    await connections.endAll();
  });
});
