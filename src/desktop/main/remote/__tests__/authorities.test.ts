import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteConnection } from '../connection';
import { Authorities } from '../authorities';
import { NotConnectedError } from '../../workspace/workspaces';

const connect = vi.hoisted(() => vi.fn());
vi.mock('../connection', () => ({ connect }));
vi.mock('../../workspace/remote-workspace', () => ({ createRemoteWorkspace: () => ({}) }));

// A connection whose close fires its listeners once; closedAlready: it closed before anyone listened.
function connection(closedAlready?: string) {
  const listeners = new Set<(reason: string) => void>();
  let closedWith = closedAlready;
  const close = vi.fn((reason: string) => {
    if (closedWith !== undefined) return;
    closedWith = reason;
    for (const listener of [...listeners]) listener(reason);
  });
  const value = {
    onClose: (listener: (reason: string) => void) => {
      if (closedWith !== undefined) listener(closedWith);
      else listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onLost: () => ({ dispose: () => undefined }),
    onSuspect: () => ({ dispose: () => undefined }),
    lost: () => false,
    suspectSince: () => undefined,
    close,
  } as unknown as RemoteConnection;
  return { value, close };
}

function authorities(transport: () => Promise<PassThrough> = async () => new PassThrough()) {
  const changes: string[] = [];
  const attached: RemoteConnection[] = [];
  const subject: Authorities = new Authorities({
    transport,
    appVersion: '1.0.0',
    clientId: 'client',
    deviceName: 'this computer',
    terminalIdleDays: () => 7,
    otherProtocol: () => undefined,
    projectOfCwd: () => undefined,
    changed: (key) => {
      changes.push(`${key}:${subject.state(key)}`);
    },
    attached: (_key, connection) => {
      attached.push(connection);
    },
    notConnected: (key) => new NotConnectedError(`${key} is not connected.`),
    log: () => undefined,
  });
  return { subject, changes, attached };
}

// A connection the daemon holds for a resume, whose drop, suspect state and resume the test drives.
function resumable(resume: () => Promise<'resumed' | 'refused'>) {
  const lostListeners = new Set<(reason: string) => void>();
  const suspectListeners = new Set<(since: number | undefined) => void>();
  let lost = false;
  let suspect: number | undefined;
  const base = connection();
  const held = Object.assign(base.value, {
    onLost: (listener: (reason: string) => void) => {
      lostListeners.add(listener);
      return { dispose: () => lostListeners.delete(listener) };
    },
    onSuspect: (listener: (since: number | undefined) => void) => {
      suspectListeners.add(listener);
      return { dispose: () => suspectListeners.delete(listener) };
    },
    lost: () => lost,
    suspectSince: () => suspect,
    cutTransport: vi.fn(),
    resume: vi.fn(async () => {
      const answer = await resume();
      if (answer === 'resumed') lost = false;
      return answer;
    }),
  });
  return {
    held,
    close: base.close,
    drop: () => {
      lost = true;
      for (const listener of [...lostListeners]) listener('the connection closed');
    },
    setSuspect: (since: number | undefined) => {
      suspect = since;
      for (const listener of [...suspectListeners]) listener(since);
    },
  };
}

beforeEach(() => {
  connect.mockReset();
});

describe('Authorities', () => {
  it('shares one attempt among callers and is connected once it lands', async () => {
    const { value } = connection();
    let land!: (connection: RemoteConnection) => void;
    connect.mockReturnValue(new Promise((resolve) => (land = resolve)));
    const { subject, changes } = authorities();
    const first = subject.connect('loopback');
    const second = subject.connect('loopback');
    expect(subject.state('loopback')).toBe('connecting');
    land(value);
    await Promise.all([first, second]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(subject.state('loopback')).toBe('connected');
    expect(subject.connection('loopback')).toBe(value);
    expect(subject.connectedKeys()).toEqual(['loopback']);
    await subject.connect('loopback');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(changes).toEqual(['loopback:connecting', 'loopback:connected']);
  });

  it('starts the handshake only once the transport is up, so its time limit never counts the bridge start', async () => {
    let up!: (stream: PassThrough) => void;
    const { subject } = authorities(() => new Promise((resolve) => (up = resolve)));
    connect.mockResolvedValueOnce(connection().value);
    const attempt = subject.connect('loopback');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).not.toHaveBeenCalled();
    expect(subject.state('loopback')).toBe('connecting');
    const stream = new PassThrough();
    up(stream);
    await attempt;
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ stream }));
  });

  it('is failed when the transport cannot start', async () => {
    const { subject } = authorities(async () => {
      throw new Error('no tar');
    });
    await expect(subject.connect('loopback')).rejects.toThrow('no tar');
    expect(subject.state('loopback')).toBe('failed');
    expect(connect).not.toHaveBeenCalled();
  });

  it('is failed after an attempt fails, and connects again on the next call', async () => {
    connect.mockRejectedValueOnce(new Error('refused'));
    const { subject } = authorities();
    await expect(subject.connect('loopback')).rejects.toThrow('refused');
    expect(subject.state('loopback')).toBe('failed');
    connect.mockResolvedValueOnce(connection().value);
    await subject.connect('loopback');
    expect(subject.state('loopback')).toBe('connected');
  });

  it('is failed once a live connection drops, and offline once the app quits', async () => {
    const dropped = connection();
    connect.mockResolvedValueOnce(dropped.value);
    const { subject } = authorities();
    await subject.connect('loopback');
    dropped.value.close('reset');
    expect(subject.state('loopback')).toBe('failed');
    expect(subject.connection('loopback')).toBeUndefined();

    const live = connection();
    connect.mockResolvedValueOnce(live.value);
    await subject.connect('loopback');
    subject.dispose();
    expect(live.close).toHaveBeenCalledWith('the app is quitting');
    expect(subject.state('loopback')).toBe('offline');
    await expect(subject.connect('loopback')).rejects.toThrow('quitting');
  });

  it('is offline, not failed, after the user disconnects it, and connects again on the next call', async () => {
    const live = connection();
    connect.mockResolvedValueOnce(live.value);
    const { subject, changes } = authorities();
    await subject.connect('loopback');
    changes.length = 0;
    subject.disconnect('loopback');
    expect(live.close).toHaveBeenCalledWith('the user disconnected');
    expect(subject.state('loopback')).toBe('offline');
    expect(subject.connection('loopback')).toBeUndefined();
    expect(changes).toEqual(['loopback:offline']);
    subject.disconnect('loopback');
    connect.mockResolvedValueOnce(connection().value);
    await subject.connect('loopback');
    expect(subject.state('loopback')).toBe('connected');
  });

  it('is never left connected by a connection that closed as it came up', async () => {
    connect.mockResolvedValueOnce(connection('closed at once').value);
    const { subject } = authorities();
    await subject.connect('loopback');
    expect(subject.state('loopback')).toBe('failed');
    expect(subject.connection('loopback')).toBeUndefined();
  });

  it('closes a connection that lands after the quit began, and keeps none', async () => {
    const late = connection();
    let land!: (connection: RemoteConnection) => void;
    connect.mockReturnValue(new Promise((resolve) => (land = resolve)));
    const { subject } = authorities();
    const attempt = subject.connect('loopback');
    subject.dispose();
    land(late.value);
    await expect(attempt).rejects.toThrow('quitting');
    expect(late.close).toHaveBeenCalledWith('the app is quitting');
    expect(subject.state('loopback')).toBe('offline');
    expect(subject.connectedKeys()).toEqual([]);
  });

  it('resumes a lost connection over a new transport, keeping it, and attaches fresh after a refused resume', async () => {
    const lostListeners = new Set<(reason: string) => void>();
    let lost = false;
    const answers: Array<'resumed' | 'refused'> = ['resumed', 'refused'];
    const base = connection();
    const held = Object.assign(base.value, {
      onLost: (listener: (reason: string) => void) => {
        lostListeners.add(listener);
        return { dispose: () => lostListeners.delete(listener) };
      },
      lost: () => lost,
      cutTransport: vi.fn(),
      resume: vi.fn(async () => {
        const answer = answers.shift()!;
        if (answer === 'resumed') lost = false;
        return answer;
      }),
    });
    const fresh = connection().value;
    connect.mockResolvedValueOnce(held).mockResolvedValueOnce(fresh);
    let transports = 0;
    const { subject, changes } = authorities(async () => {
      transports++;
      return new PassThrough();
    });
    await subject.connect('loopback');
    const drop = (): void => {
      lost = true;
      for (const listener of [...lostListeners]) listener('the connection closed');
    };
    drop();
    expect(subject.state('loopback')).toBe('failed');
    expect(subject.connection('loopback')).toBeUndefined();
    expect(subject.heldConnection('loopback')).toBe(held);
    await subject.connect('loopback');
    expect(held.resume).toHaveBeenCalledTimes(1);
    expect(subject.connection('loopback')).toBe(held);
    expect(connect).toHaveBeenCalledTimes(1);
    drop();
    await subject.connect('loopback');
    // the refused token: the held connection closes and a second transport attaches fresh
    expect(base.close).toHaveBeenCalledWith('the daemon no longer holds this connection');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(transports).toBe(4);
    expect(subject.connection('loopback')).toBe(fresh);
    expect(changes.at(-1)).toBe('loopback:connected');
  });

  it('gives up the transport of a suspect connection when asked to connect, and resumes over a new one', async () => {
    let suspect: number | undefined;
    let lost = false;
    const base = connection();
    const held = Object.assign(base.value, {
      suspectSince: () => suspect,
      lost: () => lost,
      cutTransport: vi.fn(() => { lost = true; }),
      resume: vi.fn(async () => {
        lost = false;
        suspect = undefined;
        return 'resumed' as const;
      }),
    });
    connect.mockResolvedValueOnce(held);
    const { subject } = authorities();
    await subject.connect('loopback');
    suspect = 1234;
    expect(subject.connection('loopback')).toBeUndefined();
    await subject.connect('loopback');
    expect(held.cutTransport).toHaveBeenCalledTimes(1);
    expect(held.resume).toHaveBeenCalledTimes(1);
    expect(subject.connection('loopback')).toBe(held);
  });
});

describe('Disconnect Host during an attempt', () => {
  it('during a fresh connect: the connection it made is closed and the authority stays offline', async () => {
    const late = connection();
    let land!: (connection: RemoteConnection) => void;
    connect.mockReturnValue(new Promise((resolve) => (land = resolve)));
    const { subject, attached } = authorities();
    const attempt = subject.connect('loopback');
    await new Promise((resolve) => setTimeout(resolve, 0));
    subject.disconnect('loopback');
    expect(subject.state('loopback')).toBe('offline');
    land(late.value);
    await expect(attempt).rejects.toThrow('disconnected');
    expect(late.close).toHaveBeenCalledWith('the user disconnected');
    expect(subject.state('loopback')).toBe('offline');
    expect(subject.connection('loopback')).toBeUndefined();
    expect(attached).toEqual([]);
  });

  it('while the transport starts: its stream is dropped unused and no handshake starts', async () => {
    let up!: (stream: PassThrough) => void;
    const { subject } = authorities(() => new Promise((resolve) => (up = resolve)));
    const attempt = subject.connect('loopback');
    subject.disconnect('loopback');
    const stream = new PassThrough();
    up(stream);
    await expect(attempt).rejects.toThrow('disconnected');
    expect(stream.destroyed).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(subject.state('loopback')).toBe('offline');
  });

  it('during a resume: the resume that fails as the held connection closes leaves it offline, not failed', async () => {
    let fail!: (err: Error) => void;
    const dropped = resumable(() => new Promise((_resolve, reject) => (fail = reject)));
    connect.mockResolvedValueOnce(dropped.held);
    const { subject } = authorities();
    await subject.connect('loopback');
    dropped.drop();
    const attempt = subject.connect('loopback');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dropped.held.resume).toHaveBeenCalledTimes(1);
    subject.disconnect('loopback');
    expect(dropped.close).toHaveBeenCalledWith('the user disconnected');
    fail(new Error('The connection closed: the user disconnected'));
    await expect(attempt).rejects.toThrow('the user disconnected');
    expect(subject.state('loopback')).toBe('offline');
  });

  it('during a resume the daemon answered anyway: nothing is kept and no fresh connection attaches', async () => {
    let answer!: (outcome: 'resumed' | 'refused') => void;
    const dropped = resumable(() => new Promise((resolve) => (answer = resolve)));
    connect.mockResolvedValueOnce(dropped.held);
    let transports = 0;
    const { subject } = authorities(async () => {
      transports++;
      return new PassThrough();
    });
    await subject.connect('loopback');
    dropped.drop();
    const attempt = subject.connect('loopback');
    await new Promise((resolve) => setTimeout(resolve, 0));
    subject.disconnect('loopback');
    answer('refused');
    await expect(attempt).rejects.toThrow('disconnected');
    // the first connect's and the resume's: no transport starts for a fresh attach
    expect(transports).toBe(2);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(subject.state('loopback')).toBe('offline');
    expect(subject.heldConnection('loopback')).toBeUndefined();
  });
});

describe('a fresh connection', () => {
  it('is reported attached once, never again for a resume or a cleared suspect state', async () => {
    const first = resumable(async () => 'resumed');
    const second = connection();
    connect.mockResolvedValueOnce(first.held).mockResolvedValueOnce(second.value);
    const { subject, attached, changes } = authorities();
    await subject.connect('loopback');
    expect(attached).toEqual([first.held]);
    first.setSuspect(1234);
    first.setSuspect(undefined);
    first.drop();
    await subject.connect('loopback');
    expect(subject.connection('loopback')).toBe(first.held);
    expect(changes.filter((change) => change === 'loopback:connected').length).toBeGreaterThan(1);
    expect(attached).toEqual([first.held]);
    // a connection that closed for good: the next one attaches fresh
    first.held.close('reset');
    await subject.connect('loopback');
    expect(attached).toEqual([first.held, second.value]);
  });
});
