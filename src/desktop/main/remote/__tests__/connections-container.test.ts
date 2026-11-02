import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_LOG_PUSH_MS, RemoteConnections, type ContainerStartRequest } from '../connections';
import type { ContainerHostRecord } from '../host-store';
import { SshConnectError } from '../ssh/ssh-transport';

const record: ContainerHostRecord = { id: 'c1', kind: 'container', key: 'c'.repeat(32), engine: 'docker', origin: 'devcontainer', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json', name: 'app', recentFolders: [], settings: {} };

afterEach(() => {
  vi.useRealTimers();
});

describe('a container attempt', () => {
  it('starts with Building container when the container builds, never asks, and keeps the build log on the attempt', async () => {
    vi.useFakeTimers();
    let request: ContainerStartRequest | undefined;
    let finish = (): void => undefined;
    const changed = vi.fn();
    const connections: RemoteConnections = new RemoteConnections({
      host: () => record,
      startSsh: () => Promise.reject(new Error('no ssh')),
      startWsl: () => Promise.reject(new Error('no wsl')),
      startContainer: (started) => {
        request = started;
        return new Promise((resolve) => {
          finish = () => resolve({ stream: new PassThrough(), stderrTail: () => '', dispose: () => undefined });
        });
      },
      savePlatform: async () => undefined,
      installFolderSettled: async () => undefined,
      connect: async (hostId) => {
        await connections.transport(hostId);
      },
      connection: () => undefined,
      changed,
      log: () => undefined,
    });
    const attemptId = connections.connect('c1', true);
    await vi.waitFor(() => expect(request).toBeDefined());
    // the transport reads whether a user watches at the moment it would build or ask
    expect(request!.watched()).toBe(true);
    connections.watch('c1', false);
    expect(request!.watched()).toBe(false);
    connections.watch('c1', true);
    request!.hooks.step('building');
    expect(connections.attempt('c1')).toMatchObject({ transport: 'container', step: 'building', visited: ['building'] });
    // a build outlasts the reconnect loop's attempt bound, as stage 1 does
    expect(connections.staging('c1')).toBe(true);
    // log lines gather: the attempt holds the newest at once, and its change is told once per BUILD_LOG_PUSH_MS
    changed.mockClear();
    request!.hooks.buildLog({ lines: ['#1'], total: 1 });
    request!.hooks.buildLog({ lines: ['#1', '#2'], total: 2 });
    expect(connections.attempt('c1')?.buildLog).toEqual({ lines: ['#1', '#2'], total: 2 });
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BUILD_LOG_PUSH_MS);
    expect(changed).toHaveBeenCalledTimes(1);
    request!.hooks.step('connecting');
    request!.hooks.step('checking');
    finish();
    await connections.outcome(attemptId);
    expect(connections.attempt('c1')).toMatchObject({ step: 'connected', visited: ['building', 'connecting', 'checking'] });
  });

  // A container attempt whose transport the test settles; requests holds each start's request.
  function containerAttempts(): { connections: RemoteConnections; requests: ContainerStartRequest[]; changed: ReturnType<typeof vi.fn>; settle: (err?: Error) => void } {
    const requests: ContainerStartRequest[] = [];
    const changed = vi.fn();
    let settle: (err?: Error) => void = () => undefined;
    const connections: RemoteConnections = new RemoteConnections({
      host: () => record,
      startSsh: () => Promise.reject(new Error('no ssh')),
      startWsl: () => Promise.reject(new Error('no wsl')),
      startContainer: (started) => {
        requests.push(started);
        return new Promise((resolve, reject) => {
          settle = (err) => (err ? reject(err) : resolve({ stream: new PassThrough(), stderrTail: () => '', dispose: () => undefined }));
        });
      },
      savePlatform: async () => undefined,
      installFolderSettled: async () => undefined,
      connect: async (hostId) => {
        await connections.transport(hostId);
      },
      connection: () => undefined,
      changed,
      log: () => undefined,
    });
    return { connections, requests, changed, settle: (err) => settle(err) };
  }

  it('drops the build log once the attempt moved past building, so later changes do not carry it', async () => {
    vi.useFakeTimers();
    const { connections, requests, changed } = containerAttempts();
    connections.connect('c1', true);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const hooks = requests[0]!.hooks;
    hooks.step('building');
    hooks.buildLog({ lines: ['#1'], total: 1 });
    hooks.step('connecting');
    expect(connections.attempt('c1')?.buildLog).toBeUndefined();
    // the pending push went with the step change, which was told at once
    changed.mockClear();
    vi.advanceTimersByTime(BUILD_LOG_PUSH_MS);
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // a late log line past building changes nothing
    hooks.buildLog({ lines: ['#1', '#2'], total: 2 });
    expect(connections.attempt('c1')?.buildLog).toBeUndefined();
    hooks.progress(0.5);
    expect(connections.attempt('c1')).not.toHaveProperty('buildLog');
  });

  it('keeps the build log of a build that failed, and clears its push when the attempt fails, is forgotten or disposed', async () => {
    vi.useFakeTimers();
    const failed = containerAttempts();
    const attemptId = failed.connections.connect('c1', true);
    await vi.waitFor(() => expect(failed.requests).toHaveLength(1));
    failed.requests[0]!.hooks.step('building');
    failed.requests[0]!.hooks.buildLog({ lines: ['ERROR: no such image'], total: 1 });
    failed.settle(new SshConnectError('devcontainerFailed', { message: 'no such image' }, ''));
    await failed.connections.outcome(attemptId)?.catch(() => undefined);
    expect(failed.connections.attempt('c1')).toMatchObject({ step: 'failed', buildLog: { lines: ['ERROR: no such image'], total: 1 } });
    expect(vi.getTimerCount()).toBe(0);

    for (const end of ['forget', 'dispose'] as const) {
      const ended = containerAttempts();
      ended.connections.connect('c1', true);
      await vi.waitFor(() => expect(ended.requests).toHaveLength(1));
      ended.requests[0]!.hooks.step('building');
      ended.requests[0]!.hooks.buildLog({ lines: ['#1'], total: 1 });
      expect(vi.getTimerCount()).toBe(1);
      if (end === 'forget') ended.connections.forget('c1');
      else ended.connections.dispose();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('sends Retry of a container to build to the Connect dialog, never to an unwatched attempt', async () => {
    const connections: RemoteConnections = new RemoteConnections({
      host: () => record,
      startSsh: () => Promise.reject(new Error('no ssh')),
      startWsl: () => Promise.reject(new Error('no wsl')),
      startContainer: () => Promise.reject(new SshConnectError('containerNeedsBuild', {}, '')),
      savePlatform: async () => undefined,
      installFolderSettled: async () => undefined,
      connect: async (hostId) => {
        await connections.transport(hostId);
      },
      connection: () => undefined,
      changed: () => undefined,
      log: () => undefined,
    });
    expect(connections.needsWatchedAttempt('c1')).toBe(false);
    await connections.outcome(connections.connect('c1', false))?.catch(() => undefined);
    expect(connections.failure('c1')?.code).toBe('containerNeedsBuild');
    expect(connections.needsWatchedAttempt('c1')).toBe(true);
  });
});
