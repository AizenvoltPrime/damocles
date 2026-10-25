import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from '../codec';
import { acceptConnection, authenticateBridge, HANDSHAKE_MAX_BYTES, sayHello, type Accepted, type HelloAnswer, type HostFacts } from '../handshake';
import { createPersistentProtocol, type PersistentProtocol } from '../persistent-protocol';
import { fakeSocket, message, parseHeader, socketPair } from './sockets';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const log = (): void => undefined;
const TOKEN = crypto.randomBytes(32);
const FACTS: HostFacts = { os: 'linux', arch: 'x64', libc: 'glibc', homedir: '/home/u', shell: '/bin/bash', gitAvailable: true, pathFlavor: 'posix' };

const welcome = (serverTime: number = Date.now()): HelloAnswer => ({
  kind: 'welcome',
  welcome: { serverVersion: '1.2.3', protocolVersion: 1, features: [], facts: FACTS, reconnectionToken: new Uint8Array(32), resumed: false, coreEpoch: null, serverTime },
});

function daemonSide(protocol: PersistentProtocol, answer: () => HelloAnswer = () => welcome()): { accepted: Promise<Accepted>; failed: Promise<string> } {
  let resolveAccepted!: (accepted: Accepted) => void;
  let resolveFailed!: (reason: string) => void;
  const accepted = new Promise<Accepted>((resolve) => { resolveAccepted = resolve; });
  const failed = new Promise<string>((resolve) => { resolveFailed = resolve; });
  acceptConnection({ protocol, token: TOKEN, answer, accepted: resolveAccepted, failed: resolveFailed });
  return { accepted, failed };
}

function pair(): { bridge: PersistentProtocol; daemon: PersistentProtocol } {
  const [a, b] = socketPair();
  return {
    bridge: createPersistentProtocol({ socket: a, maxBodyBytes: HANDSHAKE_MAX_BYTES, log }),
    daemon: createPersistentProtocol({ socket: b, maxBodyBytes: HANDSHAKE_MAX_BYTES, log }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe('handshake', () => {
  it('authenticates both ways, then answers hello with the measured skew', async () => {
    const { bridge, daemon } = pair();
    const serverTime = Date.now() + 5 * 60_000;
    const side = daemonSide(daemon, () => welcome(serverTime));
    await authenticateBridge(bridge, TOKEN);
    const outcome = await sayHello(bridge, { appVersion: '1.2.3', protocolVersion: 1, clientId: 'client-a', deviceName: 'laptop' });
    const accepted = await side.accepted;
    expect(accepted.hello).toMatchObject({ clientId: 'client-a', deviceName: 'laptop', protocolVersion: 1 });
    expect(outcome.kind).toBe('welcome');
    if (outcome.kind !== 'welcome') return;
    expect(outcome.welcome.facts).toEqual(FACTS);
    expect(Math.abs(outcome.skewMs - 5 * 60_000)).toBeLessThan(1000);
    expect(vi.mocked(crypto.timingSafeEqual)).toHaveBeenCalledTimes(2);
  });

  it('attaches the next listeners before a message pipelined behind hello is read', async () => {
    const { bridge, daemon } = pair();
    const received: string[] = [];
    let resolve!: () => void;
    const got = new Promise<void>((done) => { resolve = done; });
    acceptConnection({
      protocol: daemon,
      token: TOKEN,
      answer: () => welcome(),
      accepted: () => {
        daemon.onMessage((body) => {
          received.push(Buffer.from(body).toString());
          resolve();
        });
      },
      failed: (reason) => received.push(`failed: ${reason}`),
    });
    await authenticateBridge(bridge, TOKEN);
    void sayHello(bridge, { appVersion: '1', protocolVersion: 1, clientId: 'c', deviceName: 'd' });
    bridge.send(Buffer.from('right behind hello'));
    await got;
    expect(received).toEqual(['right behind hello']);
  });

  it('refuses a bridge that cannot prove the token through the timing-safe check, writing nothing after its answer', async () => {
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const side = daemonSide(protocol);
    socket.receive(message(2, 0, 0, encode({ v: 1, nonce: crypto.randomBytes(32) })));
    expect(socket.written).toHaveLength(1);
    const answer = decode(socket.written[0]!.subarray(13), { maxBytes: 1024 }) as { nonce: Uint8Array; proof: Uint8Array };
    expect(answer.nonce).toHaveLength(32);
    socket.receive(message(2, 0, 0, encode({ proof: crypto.createHmac('sha256', crypto.randomBytes(32)).update('x').digest() })));
    expect(await side.failed).toBe('the bridge did not prove the token');
    expect(vi.mocked(crypto.timingSafeEqual)).toHaveBeenCalledTimes(1);
    expect(socket.written).toHaveLength(1);
    expect(socket.destroyed()).toBe(true);
  });

  it('closes a connection that sends nothing after 10 s, having written no byte', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const side = daemonSide(protocol);
    vi.advanceTimersByTime(9999);
    expect(socket.destroyed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await side.failed).toBe('no authentication within 10000 ms');
    expect(socket.written).toHaveLength(0);
    expect(socket.destroyed()).toBe(true);
  });

  it('closes a bridge that stops after the challenge at 10 s, having written only the challenge answer', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const protocol = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const side = daemonSide(protocol);
    socket.receive(message(2, 0, 0, encode({ v: 1, nonce: crypto.randomBytes(32) })));
    vi.advanceTimersByTime(10_000);
    await side.failed;
    expect(socket.written.map((frame) => parseHeader(frame).type)).toEqual([2]);
  });

  it('closes on a regular message or a malformed message before authentication, writing nothing', async () => {
    for (const frame of [message(1, 1, 0, new Uint8Array(1)), message(2, 0, 0, Uint8Array.from([99])), message(2, 0, 0, encode({ v: 2, nonce: new Uint8Array(32) }))]) {
      const socket = fakeSocket();
      const side = daemonSide(createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log }));
      socket.receive(frame);
      await side.failed;
      expect(socket.written).toHaveLength(0);
    }
  });

  it('sends a stand-in endpoint without the token only the bridge nonce', async () => {
    const socket = fakeSocket();
    const bridge = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const auth = authenticateBridge(bridge, TOKEN);
    expect(socket.written).toHaveLength(1);
    const first = decode(socket.written[0]!.subarray(13), { maxBytes: 1024 }) as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(['nonce', 'v']);
    socket.receive(message(2, 0, 0, encode({ nonce: crypto.randomBytes(32), proof: crypto.randomBytes(32) })));
    await expect(auth).rejects.toThrow(/not this user's daemon/);
    expect(socket.written).toHaveLength(1);
  });

  it('refuses a replayed bridge proof under fresh nonces', async () => {
    const recorded = pair();
    daemonSide(recorded.daemon);
    const proofs: Uint8Array[] = [];
    const sendControl = recorded.bridge.sendControl.bind(recorded.bridge);
    recorded.bridge.sendControl = (body) => {
      proofs.push(body);
      sendControl(body);
    };
    await authenticateBridge(recorded.bridge, TOKEN);

    const socket = fakeSocket();
    const side = daemonSide(createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log }));
    // the recorded challenge, then the recorded proof, against a daemon that drew a new nonce
    socket.receive(message(2, 0, 0, proofs[0]!));
    socket.receive(message(2, 0, 0, proofs[1]!));
    expect(await side.failed).toBe('the bridge did not prove the token');
  });

  it('refuses hello text that could forge a log line or UI text', async () => {
    const bad = [
      { appVersion: '1.0\r\n[daemon] forged', clientId: 'c', deviceName: 'd' },
      { appVersion: '1.0', clientId: 'c/../x', deviceName: 'd' },
      { appVersion: '1.0', clientId: 'c', deviceName: 'laptop\u202e' },
      { appVersion: '1.0', clientId: 'c', deviceName: 'line\nbreak' },
    ];
    for (const fields of bad) {
      const { bridge, daemon } = pair();
      const side = daemonSide(daemon);
      await authenticateBridge(bridge, TOKEN);
      bridge.sendControl(encode({ type: 'hello', protocolVersion: 1, clientTime: Date.now(), ...fields }));
      expect(await side.failed).toBe('a malformed hello');
    }
  });

  it('refuses a welcome whose text could forge a log line', async () => {
    const socket = fakeSocket();
    const app = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const outcome = sayHello(app, { appVersion: '1', protocolVersion: 1, clientId: 'c', deviceName: 'd' });
    const answer = welcome();
    if (answer.kind !== 'welcome') throw new Error('unreachable');
    socket.receive(message(2, 0, 0, encode({ type: 'welcome', ...answer.welcome, serverVersion: '1\r\nforged', facts: { ...FACTS } })));
    await expect(outcome).rejects.toThrow(/outside the contract/);
  });

  it('accepts a welcome with every field at its limit', async () => {
    const socket = fakeSocket();
    const app = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const outcome = sayHello(app, { appVersion: '1', protocolVersion: 1, clientId: 'c', deviceName: 'd' });
    const answer = welcome();
    if (answer.kind !== 'welcome') throw new Error('unreachable');
    const features = Array.from({ length: 256 }, (_, index) => `${String(index).padStart(3, '0')}${'f'.repeat(125)}`);
    const facts = { ...FACTS, homedir: '€'.repeat(4096), shell: '€'.repeat(4096) };
    socket.receive(message(2, 0, 0, encode({ type: 'welcome', ...answer.welcome, features, facts })));
    expect(await outcome).toMatchObject({ kind: 'welcome', welcome: { features, facts } });
  });

  it('refuses a welcome for another protocol version than its hello', async () => {
    const socket = fakeSocket();
    const app = createPersistentProtocol({ socket, maxBodyBytes: HANDSHAKE_MAX_BYTES, log });
    const outcome = sayHello(app, { appVersion: '1', protocolVersion: 1, clientId: 'c', deviceName: 'd' });
    const answer = welcome();
    if (answer.kind !== 'welcome') throw new Error('unreachable');
    socket.receive(message(2, 0, 0, encode({ type: 'welcome', ...answer.welcome, protocolVersion: 2, facts: { ...FACTS } })));
    await expect(outcome).rejects.toThrow(/welcomed protocol 2, not 1/);
    expect(socket.destroyed()).toBe(true);
  });

  it('reports a refusal for another protocol version', async () => {
    const { bridge, daemon } = pair();
    daemonSide(daemon, () => ({ kind: 'refused', refused: { reason: 'protocol', serverVersion: '9.0.0', protocolVersion: 9 } }));
    await authenticateBridge(bridge, TOKEN);
    const outcome = await sayHello(bridge, { appVersion: '1', protocolVersion: 1, clientId: 'c', deviceName: 'd' });
    expect(outcome).toEqual({ kind: 'refused', refused: { reason: 'protocol', serverVersion: '9.0.0', protocolVersion: 9 } });
  });
});
