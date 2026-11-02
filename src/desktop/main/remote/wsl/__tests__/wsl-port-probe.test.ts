import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPortProbe } from '../../../../daemon/port-probe';
import { acceptedWithin, PROBE_ATTEMPT_GAP_MS, PROBE_TIMEOUT_MS, probeLoopback, windowsPortHolder, type WindowsListeners } from '../wsl-port-probe';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listen(onConnection: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(onConnection);
  servers.push(server);
  return new Promise((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, () => resolve((server.address() as net.AddressInfo).port)));
}

describe('the WSL loopback probe', () => {
  it('finds WSL forwarding when the daemon\'s listener answers its own nonce', async () => {
    const probe = openPortProbe(() => undefined);
    const { port, nonce } = await probe.answer;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await probeLoopback(port, nonce)).toEqual({ forwarded: true });
    await probe.close();
  });

  it('finds no forwarding when another program answers on the port', async () => {
    const port = await listen((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    expect(await probeLoopback(port, 'a'.repeat(32))).toEqual({ forwarded: false, reason: 'wrongAnswer' });
    const silentClose = await listen((socket) => socket.end());
    expect(await probeLoopback(silentClose, 'a'.repeat(32))).toEqual({ forwarded: false, reason: 'wrongAnswer' });
  });

  it('finds no forwarding when nothing listens on the port for the whole window', async () => {
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await probeLoopback(port, 'a'.repeat(32), 300)).toEqual({ forwarded: false, reason: 'refused' });
  });
});

// A socket as net.connect returns it, which the test answers as WSL's relay would: refused, an answer, or nothing.
function fakeSocket(behavior: 'refuse' | 'hang' | string): net.Socket {
  const socket = new EventEmitter() as EventEmitter & { destroy(): void; destroyed: boolean };
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  queueMicrotask(() => {
    if (behavior === 'refuse') socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    else if (behavior !== 'hang') socket.emit('data', Buffer.from(behavior));
  });
  return socket as unknown as net.Socket;
}

describe('the probe\'s 2 s window for WSL\'s relay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const NONCE = 'b'.repeat(32);
  // the attempts' answers in turn, the last one repeating
  const relay = (answers: readonly string[]) => {
    const attempts: number[] = [];
    const connect = (): net.Socket => {
      attempts.push(Date.now());
      return fakeSocket(answers[Math.min(attempts.length - 1, answers.length - 1)]!);
    };
    return { attempts, connect };
  };

  it('is forwarded when the relay answers the nonce after refusing while it set up, paced by the gap', async () => {
    const { attempts, connect } = relay(['refuse', 'refuse', 'refuse', `${NONCE}\n`]);
    const verdict = probeLoopback(4242, NONCE, PROBE_TIMEOUT_MS, connect);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await verdict).toEqual({ forwarded: true });
    expect(attempts.map((at) => at - attempts[0]!)).toEqual([0, PROBE_ATTEMPT_GAP_MS, 2 * PROBE_ATTEMPT_GAP_MS, 3 * PROBE_ATTEMPT_GAP_MS]);
  });

  it('tunnels when the port is refused for the whole window, measured from the first attempt', async () => {
    const { attempts, connect } = relay(['refuse']);
    let verdict: unknown;
    void probeLoopback(4242, NONCE, PROBE_TIMEOUT_MS, connect).then((value) => {
      verdict = value;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toEqual({ forwarded: false, reason: 'refused' });
    const count = attempts.length;
    expect(count).toBeLessThanOrEqual(PROBE_TIMEOUT_MS / PROBE_ATTEMPT_GAP_MS + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toHaveLength(count);
  });

  it('tunnels at once on a wrong answer after a refusal, and connects no more', async () => {
    const { attempts, connect } = relay(['refuse', 'HTTP/1.1 400 Bad Request\r\n\r\n']);
    const verdict = probeLoopback(4242, NONCE, PROBE_TIMEOUT_MS, connect);
    await vi.advanceTimersByTimeAsync(PROBE_ATTEMPT_GAP_MS);
    expect(await verdict).toEqual({ forwarded: false, reason: 'wrongAnswer' });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(attempts).toHaveLength(2);
  });

  it('tunnels at 2 s when a connect hangs', async () => {
    const { attempts, connect } = relay(['hang']);
    let verdict: unknown;
    void probeLoopback(4242, NONCE, PROBE_TIMEOUT_MS, connect).then((value) => {
      verdict = value;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toEqual({ forwarded: false, reason: 'timeout' });
    expect(attempts).toHaveLength(1);
  });
});

describe('waiting for WSL\'s relay to take a port', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  // the connects' answers in turn, the last one repeating
  const relay = (answers: readonly boolean[]) => {
    const attempts: Array<{ readonly at: number; readonly host: string; readonly port: number }> = [];
    const accept = async (host: string, port: number): Promise<boolean> => {
      attempts.push({ at: Date.now(), host, port });
      return answers[Math.min(attempts.length - 1, answers.length - 1)]!;
    };
    return { attempts, accept };
  };

  it('answers once the port accepts after refusing while the relay set up, paced by the gap', async () => {
    const { attempts, accept } = relay([false, false, true]);
    const accepted = acceptedWithin('::1', 5173, PROBE_TIMEOUT_MS, accept);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await accepted).toBe(true);
    expect(attempts.map(({ at, host, port }) => [at - attempts[0]!.at, host, port])).toEqual([[0, '::1', 5173], [PROBE_ATTEMPT_GAP_MS, '::1', 5173], [2 * PROBE_ATTEMPT_GAP_MS, '::1', 5173]]);
  });

  it('gives up when the port refuses for the whole window, measured from the first attempt, and connects no more', async () => {
    const { attempts, accept } = relay([false]);
    let accepted: boolean | undefined;
    void acceptedWithin('127.0.0.1', 5173, PROBE_TIMEOUT_MS, accept).then((value) => {
      accepted = value;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(accepted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(accepted).toBe(false);
    const count = attempts.length;
    expect(count).toBe(PROBE_TIMEOUT_MS / PROBE_ATTEMPT_GAP_MS + 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toHaveLength(count);
  });
});

describe('who holds a port on this computer', () => {
  const listeners = (rows: Array<{ pid: number; port: number }>, images: Record<number, string | undefined>): WindowsListeners => ({
    rows: () => rows.map((row) => ({ ...row, bindAddress: '127.0.0.1', family: 4 as const })),
    imagePath: (pid) => images[pid],
  });

  it('tells no listener and WSL\'s relay apart from another Windows process', () => {
    const relay = 'C:\\Program Files\\WSL\\wslrelay.exe';
    expect(windowsPortHolder(5173, listeners([{ pid: 1, port: 3000 }], { 1: relay }))).toBe('none');
    expect(windowsPortHolder(5173, listeners([{ pid: 1, port: 5173 }, { pid: 1, port: 5173 }], { 1: 'C:\\PROGRAM FILES\\WSL\\WSLRELAY.EXE' }))).toBe('wslRelay');
    expect(windowsPortHolder(5173, listeners([{ pid: 2, port: 5173 }], { 2: 'C:\\Program Files\\nodejs\\node.exe' }))).toBe('other');
    expect(windowsPortHolder(5173, listeners([{ pid: 1, port: 5173 }, { pid: 2, port: 5173 }], { 1: relay, 2: 'C:\\tools\\vite.exe' }))).toBe('other');
    // a process this user cannot open is another program too
    expect(windowsPortHolder(5173, listeners([{ pid: 4, port: 5173 }], {}))).toBe('other');
  });
});
