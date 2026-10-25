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
import { MAX_UNAUTHENTICATED } from '../connections';
import { readPidFile } from '../token';
import { startInProcessDaemon, type InProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

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
    const folder = fs.mkdtempSync(`${process.env['TMP'] ?? '/tmp'}/dm-conn-`);
    fs.writeFileSync(`${folder}/a.txt`, 'bytes');
    const read = await client.workspace.request('files.read', { path: `${folder}/a.txt` });
    expect(read.kind).toBe('bytes');
    if (read.kind === 'bytes') expect(Buffer.from(read.bytes).toString()).toBe('bytes');
    const logs = await client.control.request('logs.list', {});
    expect(logs.logs.map((entry) => entry.name)).toEqual([]);
    client.protocol.close('done');
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
