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
    close,
  } as unknown as RemoteConnection;
  return { value, close };
}

function authorities(transport: () => Promise<PassThrough> = async () => new PassThrough()) {
  const changes: string[] = [];
  const subject = new Authorities({
    transport,
    appVersion: '1.0.0',
    clientId: 'client',
    deviceName: 'this computer',
    terminalIdleDays: () => 7,
    projectOfCwd: () => undefined,
    changed: (key) => changes.push(`${key}:${subject.state(key)}`),
    notConnected: (key) => new NotConnectedError(`${key} is not connected.`),
    log: () => undefined,
  });
  return { subject, changes };
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
});
