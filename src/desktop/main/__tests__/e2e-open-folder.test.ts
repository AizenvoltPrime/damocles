import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectStepEvent } from '../../preload/overlay-channels';
import type { ProjectConnection } from '../../preload/shell-channels';
import type { RemoteConnection } from '../remote/connection';
import { openFolderDeadlineMs, waitForRemoteFolderConnection } from '../e2e-open-folder';

const HOST = 'h1';
const AUTHORITY = 'ssh+h1';
const DEADLINE_MS = 5_000;

function fake() {
  const world = {
    attempt: { attemptId: 'a1', hostId: HOST, transport: 'ssh', step: 'connecting', visited: ['connecting'], notices: [] } as ConnectStepEvent | undefined,
    state: 'connecting' as ProjectConnection,
    usable: false,
    cancelled: [] as string[],
  };
  const connections = {
    connect: () => 'a1',
    attempt: () => world.attempt,
    cancel: (attemptId: string) => { world.cancelled.push(attemptId); },
  };
  const authorities = {
    state: () => world.state,
    connection: () => (world.usable ? ({} as RemoteConnection) : undefined),
  };
  const connected = (): void => {
    world.attempt = { ...world.attempt!, step: 'connected' };
    world.state = 'connected';
    world.usable = true;
  };
  const waiting = waitForRemoteFolderConnection(connections, authorities, HOST, AUTHORITY, DEADLINE_MS);
  const settled = { done: false };
  // also keeps a rejection before the assertion attaches from surfacing as unhandled
  waiting.then(() => { settled.done = true; }, () => { settled.done = true; });
  return { world, waiting, settled, connected };
}

describe('waitForRemoteFolderConnection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('settles once the attempt it started connected and the connection is usable', async () => {
    const { waiting, connected } = fake();
    await vi.advanceTimersByTimeAsync(300);
    connected();
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('rejects once the attempt it started is gone', async () => {
    const { world, waiting } = fake();
    world.attempt = { ...world.attempt!, step: 'installing' };
    await vi.advanceTimersByTimeAsync(100);
    world.attempt = undefined;
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).rejects.toThrow('connecting ended: attempt a1 is gone, last step installing');
  });

  it('rejects once another attempt replaced the one it started', async () => {
    const { world, waiting } = fake();
    world.attempt = { ...world.attempt!, attemptId: 'a2' };
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).rejects.toThrow('connecting ended: attempt a1 was replaced at step connecting, the new one is at connecting');
  });

  it('rejects when the connection is lost after the attempt connected', async () => {
    const { world, waiting } = fake();
    world.attempt = { ...world.attempt!, step: 'connected' };
    world.state = 'failed';
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).rejects.toThrow(`connecting lost: the attempt connected, then ${AUTHORITY} went failed`);
  });

  it('keeps waiting on a suspect connection, then rejects at the deadline naming the last step', async () => {
    const { world, waiting, settled } = fake();
    world.attempt = { ...world.attempt!, step: 'connected' };
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 100);
    expect(settled.done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(waiting).rejects.toThrow(`connecting timed out after ${DEADLINE_MS} ms at step connected with ${AUTHORITY} connecting`);
  });

  it('rejects at the deadline while the attempt stays on one step', async () => {
    const { world, waiting } = fake();
    world.attempt = { ...world.attempt!, step: 'installing' };
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100);
    await expect(waiting).rejects.toThrow(`connecting timed out after ${DEADLINE_MS} ms at step installing`);
  });

  it('cancels the attempt and rejects when it asks a question', async () => {
    const { world, waiting } = fake();
    world.attempt = { ...world.attempt!, prompt: { promptId: 'p1', kind: 'hostKey', host: 'prod', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' } };
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).rejects.toThrow('connecting asked: hostKey');
    expect(world.cancelled).toEqual(['a1']);
  });

  it('rejects with the failure code of a failed attempt', async () => {
    const { world, waiting } = fake();
    world.attempt = { ...world.attempt!, step: 'failed', failure: { code: 'permissionDenied', params: {} } };
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).rejects.toThrow('connecting failed: permissionDenied');
  });
});

describe('openFolderDeadlineMs', () => {
  it('ends a minute before the test times out, so a spec whose timeout is raised waits as long for its connect', () => {
    expect(openFolderDeadlineMs(300_000)).toBe(240_000);
    expect(openFolderDeadlineMs(600_000)).toBe(540_000);
  });

  it('keeps half of a short timeout, and sets none when the test has none', () => {
    expect(openFolderDeadlineMs(60_000)).toBe(30_000);
    expect(openFolderDeadlineMs(0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('waitForRemoteFolderConnection deadline', () => {
  it('refuses a deadline that is not a positive number before it connects', async () => {
    const connect = vi.fn(() => 'a1');
    const connections = { connect, attempt: () => undefined, cancel: () => undefined };
    const authorities = { state: () => 'connecting' as ProjectConnection, connection: () => undefined };
    await expect(waitForRemoteFolderConnection(connections, authorities, HOST, AUTHORITY, Number.NaN)).rejects.toThrow('positive number');
    await expect(waitForRemoteFolderConnection(connections, authorities, HOST, AUTHORITY, 0)).rejects.toThrow('positive number');
    expect(connect).not.toHaveBeenCalled();
  });
});
