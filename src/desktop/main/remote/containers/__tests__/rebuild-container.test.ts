import { describe, expect, it, vi } from 'vitest';
import type { ContainerRebuildRun } from '../../../../preload/overlay-channels';
import { BUILD_LOG_PUSH_MS } from '../../connections';
import { SshConnectError } from '../../ssh/ssh-transport';
import { rebuildContainer, type RebuildDeps } from '../rebuild-container';

function deps(order: string[], overrides: Partial<RebuildDeps> = {}): RebuildDeps {
  return {
    passGate: async () => {
      order.push('gate');
    },
    shutDown: async () => {
      order.push('stop');
    },
    up: async (onLog) => {
      order.push('up');
      onLog({ lines: ['#1 building'], total: 1 });
    },
    oldContainerKept: async () => {
      order.push('kept?');
      return false;
    },
    reconnect: async () => {
      order.push('reconnect');
    },
    log: () => undefined,
    ...overrides,
  };
}

describe('Rebuild Container', () => {
  it('passes the gate before it stops anything, then rebuilds with its log and connects again', async () => {
    const order: string[] = [];
    const runs: ContainerRebuildRun[] = [];
    expect(await rebuildContainer(deps(order), (run) => runs.push(run))).toEqual({ ok: true });
    expect(order).toEqual(['gate', 'stop', 'up', 'reconnect']);
    expect(runs.at(-1)).toEqual({ steps: { stopping: 'done', building: 'done', reconnecting: 'done' }, log: { lines: ['#1 building'], total: 1 } });
  });

  it('stops nothing when the gate refuses, and names why', async () => {
    for (const code of ['configRefused', 'folderUntrusted', 'composeUnsupported', 'containerEngineMissing'] as const) {
      const order: string[] = [];
      const runs: ContainerRebuildRun[] = [];
      const result = await rebuildContainer(deps(order, { passGate: async () => { throw new SshConnectError(code, {}, ''); } }), (run) => runs.push(run));
      expect(result).toEqual({ ok: false, code });
      expect(order).toEqual([]);
      expect(runs).toEqual([]);
    }
  });

  it('says nothing was stopped when the gate fails any other way, with the message as shown text', async () => {
    const failures: [unknown, string][] = [
      [new SshConnectError('devcontainerFailed', { message: 'read-configuration output: features is not an object' }, ''), 'read-configuration output: features is not an object'],
      // passGate turns a malformed or too large configuration into devcontainerFailed with its shown message
      [new SshConnectError('devcontainerFailed', { message: 'the configuration lists 300 values, more than 200' }, ''), 'the configuration lists 300 values, more than 200'],
      // an offline SSH host: requireConnection throws before anything runs
      [new SshConnectError('viaNotConnected', { host: 'prod' }, ''), 'the SSH connection failed: viaNotConnected'],
      [new Error('prod is not connected\u202E\u0007'), 'prod is not connected'],
    ];
    for (const [err, message] of failures) {
      const order: string[] = [];
      const runs: ContainerRebuildRun[] = [];
      const result = await rebuildContainer(deps(order, { passGate: async () => { throw err; } }), (run) => runs.push(run));
      expect(result).toEqual({ ok: false, code: 'configFailed', message });
      expect(order).toEqual([]);
      expect(runs).toEqual([]);
    }
  });

  it('says nothing was removed when the daemon\'s shutdown fails, and builds nothing', async () => {
    const order: string[] = [];
    const runs: ContainerRebuildRun[] = [];
    const result = await rebuildContainer(deps(order, { shutDown: async () => { order.push('stop'); throw new Error('control.shutdownNow timed out'); } }), (run) => runs.push(run));
    expect(result).toEqual({ ok: false, code: 'stopFailed', message: 'control.shutdownNow timed out' });
    expect(order).toEqual(['gate', 'stop']);
    expect(runs.at(-1)?.steps).toEqual({ stopping: 'failed', building: 'pending', reconnecting: 'pending' });
  });

  it('sends a fast build log at most once per BUILD_LOG_PUSH_MS, a step change at once with the newest log, and nothing after it ended', async () => {
    vi.useFakeTimers();
    try {
      const runs: ContainerRebuildRun[] = [];
      let finish!: () => void;
      let log!: (log: ContainerRebuildRun['log']) => void;
      const rebuilt = rebuildContainer(deps([], {
        up: (onLog) => {
          log = onLog;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      }), (run) => runs.push(run));
      await vi.waitFor(() => expect(log).toBeDefined());
      const before = runs.length;
      for (let i = 1; i <= 50; i++) log({ lines: [`line ${i}`], total: i });
      expect(runs.length).toBe(before);
      vi.advanceTimersByTime(BUILD_LOG_PUSH_MS);
      expect(runs.length).toBe(before + 1);
      expect(runs.at(-1)?.log).toEqual({ lines: ['line 50'], total: 50 });
      log({ lines: ['line 51'], total: 51 });
      finish();
      await rebuilt;
      // the step change carried line 51; the pending push was dropped
      expect(runs.find((run) => run.steps.building === 'done')?.log).toEqual({ lines: ['line 51'], total: 51 });
      const count = runs.length;
      vi.advanceTimersByTime(BUILD_LOG_PUSH_MS * 2);
      expect(runs.length).toBe(count);
      expect(vi.getTimerCount()).toBe(0);
      // a line arriving after the build step ended starts no push
      log({ lines: ['late'], total: 52 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the old container is still there when up failed before removing it, or found no engine, and is gone only when the engine no longer lists it', async () => {
    const kept = await rebuildContainer(deps([], { up: async () => { throw new SshConnectError('devcontainerFailed', { message: 'Dockerfile: no such file' }, ''); }, oldContainerKept: async () => true }), () => undefined);
    expect(kept).toEqual({ ok: false, code: 'buildFailedKept', message: 'Dockerfile: no such file' });
    const order: string[] = [];
    const noEngine = await rebuildContainer(deps(order, { up: async () => { throw new SshConnectError('containerEngineMissing', { engine: 'docker' }, ''); } }), () => undefined);
    expect(noEngine).toMatchObject({ ok: false, code: 'buildFailedKept' });
    expect(order).not.toContain('kept?');
    // an engine that cannot say leaves the run failed with no claim either way
    const runs: ContainerRebuildRun[] = [];
    await expect(rebuildContainer(deps([], { up: async () => { throw new Error('up failed'); }, oldContainerKept: async () => { throw new Error('docker could not say'); } }), (run) => runs.push(run))).rejects.toThrow('docker could not say');
    expect(runs.at(-1)?.steps.building).toBe('failed');
  });

  it('reports a failed build with the CLI\'s message and connects no more; a failed connect after a good build is its own failure', async () => {
    const order: string[] = [];
    const failed = await rebuildContainer(deps(order, { up: async () => { throw new SshConnectError('devcontainerFailed', { message: 'no such image' }, ''); } }), () => undefined);
    expect(failed).toEqual({ ok: false, code: 'buildFailed', message: 'no such image' });
    expect(order).toEqual(['gate', 'stop', 'kept?']);
    const lost = await rebuildContainer(deps([], { reconnect: async () => { throw new Error('timedOut'); } }), () => undefined);
    expect(lost).toEqual({ ok: false, code: 'reconnectFailed' });
  });
});
