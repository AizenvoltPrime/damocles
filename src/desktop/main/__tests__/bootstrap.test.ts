import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Disposable } from '../../../platform/disposable';
import { createFakePlatform, type FakePanelHost } from '../../../__mocks__/fake-platform';
import { createCoreEndpoint, parseCoreInit, INVALID, type CoreEndpoint, type CoreTransport } from '../../core-protocol';
import type { CoreExit, CoreProcess } from '../core-process';
import { hostExtras } from '../core-services/__tests__/host-deps';

// A Damocles Core process for these tests: its channel delivers on a later turn, structured-cloned, as a utility process's does.
interface FakeCore {
  readonly process: CoreProcess;
  // the core side's channel: what main sent before core listened is held for it
  readonly raw: { post(message: unknown): void; readonly held: unknown[]; listen(listener: (raw: unknown) => void): void };
  exit(code: number): void;
  readonly killed: () => boolean;
}

const H = vi.hoisted(() => ({ cores: [] as unknown[] }));

function fakeCore(): FakeCore {
  const toMain = new Set<(raw: unknown) => void>();
  const held: unknown[] = [];
  let toCore: ((raw: unknown) => void) | undefined;
  const exitListeners = new Set<(code: number) => void>();
  let resolveEnded!: (exit: CoreExit) => void;
  const ended = new Promise<CoreExit>((resolve) => (resolveEnded = resolve));
  let resolveExited!: (code: number) => void;
  const exitedWith = new Promise<number>((resolve) => (resolveExited = resolve));
  let exited = false;
  let killed = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    for (const listener of [...exitListeners]) listener(code);
    resolveExited(code);
    resolveEnded({ code, reason: killed ? 'killed' : null, stderr: null });
  };
  const transport: CoreTransport = {
    post: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => {
        if (toCore) toCore(copy);
        else held.push(copy);
      });
    },
    onMessage: (listener): Disposable => {
      toMain.add(listener);
      return { dispose: () => { toMain.delete(listener); } };
    },
  };
  return {
    process: {
      pid: 4242,
      spawned: Promise.resolve(),
      transport,
      onExit: (listener) => {
        exitListeners.add(listener);
        return { dispose: () => { exitListeners.delete(listener); } };
      },
      exited: exitedWith,
      ended,
      kill: () => {
        killed = true;
        setImmediate(() => exit(1));
      },
    },
    raw: {
      post: (message) => {
        const copy = structuredClone(message);
        setImmediate(() => {
          for (const listener of [...toMain]) listener(copy);
        });
      },
      held,
      listen: (listener) => {
        toCore = listener;
        for (const raw of held.splice(0)) listener(raw);
      },
    },
    exit,
    killed: () => killed,
  };
}

vi.mock('../core-process', () => ({
  forkCore: () => {
    const core = fakeCore();
    H.cores.push(core);
    return core.process;
  },
}));

import { startDesktopCore, type CoreConnectionDeps } from '../bootstrap';
import { createDesktopKeyValueState } from '../platform/key-value-state';
import type { DesktopPlatform } from '../platform';
import type { TrustStore } from '../trust-store';

const dirs: string[] = [];
afterEach(() => {
  H.cores.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function deps(closeTimeoutMs = 1_000, readyTimeoutMs = 60_000): CoreConnectionDeps {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-bootstrap-'));
  dirs.push(userData);
  const main = createFakePlatform({ folders: [] });
  const platform = { ...main, state: createDesktopKeyValueState(userData, () => undefined) } as unknown as DesktopPlatform;
  return {
    platform,
    trust: { trustedFolders: () => [], onDidGrant: () => ({ dispose: () => undefined }), requestTrust: async () => false } as unknown as TrustStore,
    theme: { css: () => '', onDidChange: () => ({ dispose: () => undefined }) },
    terminalToggle: () => ({ shown: false, shortcut: 'Ctrl+`' }),
    resolveProxy: async () => 'DIRECT',
    createView: (panelId, create) => Object.assign(main.window.createPanel(create) as FakePanelHost, { panelId, postJson: () => undefined }),
    git: { available: false, reason: 'no git' },
    e2eHooks: false,
    ...hostExtras(),
    entry: '/app/dist/core-host.js',
    echo: false,
    closeTimeoutMs,
    readyTimeoutMs,
    log: () => undefined,
  };
}

/** The core side of the channel: the init main sent, then core's endpoint over the rest. */
async function coreSide(core: FakeCore): Promise<CoreEndpoint> {
  await vi.waitFor(() => expect(core.raw.held.length).toBeGreaterThan(0));
  expect(parseCoreInit(core.raw.held.shift())).not.toBe(INVALID);
  const listeners = new Set<(raw: unknown) => void>();
  const endpoint = createCoreEndpoint({
    post: (message) => core.raw.post(message),
    onMessage: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  }, () => undefined);
  core.raw.listen((raw) => {
    for (const listener of [...listeners]) listener(raw);
  });
  return endpoint;
}

const publishTargets = (endpoint: CoreEndpoint): void => endpoint.publish('folderTargets', { defaultKey: '/home', targets: [{ key: '/home', fsPath: '/home', name: 'home', label: 'home', projectScope: false }] });

describe('a Damocles Core main forked', () => {
  it('sends the init first, and hands the core out only once it published its folder targets', async () => {
    const crashed = vi.fn();
    const records = [{ id: 'aaaaaaaa', kind: 'adopted' }];
    const desktop = startDesktopCore(deps(), { endedCores: [{ pid: 77, endedAt: 1_000 }], worktreeRecords: records, crashed, leftLeases: vi.fn() });
    const core = H.cores[0] as FakeCore;
    await vi.waitFor(() => expect(core.raw.held.length).toBeGreaterThan(0));
    expect(parseCoreInit(core.raw.held[0])).toMatchObject({ endedCores: [{ pid: 77, endedAt: 1_000 }], worktreeRecords: records });
    const endpoint = await coreSide(core);
    expect(desktop.isReady()).toBe(false);
    publishTargets(endpoint);
    await desktop.ready;
    expect(desktop.isReady()).toBe(true);
    expect(desktop.client.defaultTarget()?.key).toBe('/home');
    expect(crashed).not.toHaveBeenCalled();
  });

  it('kills core for a message outside the contract, and takes the crash path', async () => {
    const crashed = vi.fn();
    const desktop = startDesktopCore(deps(), { endedCores: [], worktreeRecords: [], crashed, leftLeases: vi.fn() });
    const core = H.cores[0] as FakeCore;
    await coreSide(core);
    const closedAfter = vi.fn();
    desktop.client.onAllChatsClosed(closedAfter);
    core.raw.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 7 } });
    // a message core sent after it broke the protocol is never read
    core.raw.post({ kind: 'event', name: 'chat.allClosed', payload: {} });
    await vi.waitFor(() => expect(crashed).toHaveBeenCalledWith(4242, 'protocol violation'));
    expect(core.killed()).toBe(true);
    expect(closedAfter).not.toHaveBeenCalled();
    await expect(desktop.client.projectBusy('/p')).rejects.toThrow(/broke the protocol/);
  });

  it('kills core for a result outside the contract, rejecting the request', async () => {
    const crashed = vi.fn();
    const desktop = startDesktopCore(deps(), { endedCores: [], worktreeRecords: [], crashed, leftLeases: vi.fn() });
    const core = H.cores[0] as FakeCore;
    const endpoint = await coreSide(core);
    endpoint.serve('chats.unload', () => 'yes' as unknown as boolean);
    publishTargets(endpoint);
    await desktop.ready;
    await expect(desktop.client.unload('view-1', false)).rejects.toThrow(/Core protocol violation/);
    await vi.waitFor(() => expect(crashed).toHaveBeenCalledWith(4242, 'protocol violation'));
  });

  it('takes the crash path for an exit main did not ask for, rejecting what was pending and a ready not reached', async () => {
    const crashed = vi.fn();
    const leftLeases = vi.fn();
    const desktop = startDesktopCore(deps(), { endedCores: [], worktreeRecords: [], crashed, leftLeases });
    const core = H.cores[0] as FakeCore;
    await coreSide(core);
    const pending = desktop.client.projectBusy('/p');
    core.exit(9);
    await expect(desktop.ready).rejects.toThrow('Damocles Core stopped before it was ready');
    await expect(pending).rejects.toThrow('Damocles Core stopped');
    expect(crashed).toHaveBeenCalledWith(4242, 'exit code 9');
    expect(leftLeases).toHaveBeenCalledWith(4242);
  });

  it('asks core to shut down, then kills it, without taking the crash path', async () => {
    const crashed = vi.fn();
    const leftLeases = vi.fn();
    const desktop = startDesktopCore(deps(), { endedCores: [], worktreeRecords: [], crashed, leftLeases });
    const core = H.cores[0] as FakeCore;
    const endpoint = await coreSide(core);
    const shutdown = vi.fn(async () => undefined);
    endpoint.serve('core.shutdown', shutdown);
    publishTargets(endpoint);
    await desktop.ready;
    await desktop.dispose();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(core.killed()).toBe(true);
    expect(crashed).not.toHaveBeenCalled();
    expect(leftLeases).not.toHaveBeenCalled();
  });

  it('kills core once its shutdown outlasts the bound, and reports the leases it still held', async () => {
    const crashed = vi.fn();
    const leftLeases = vi.fn();
    const desktop = startDesktopCore(deps(50), { endedCores: [], worktreeRecords: [], crashed, leftLeases });
    const core = H.cores[0] as FakeCore;
    const endpoint = await coreSide(core);
    endpoint.serve('core.shutdown', () => new Promise<void>(() => undefined));
    publishTargets(endpoint);
    await desktop.ready;
    const started = Date.now();
    await desktop.dispose();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(core.killed()).toBe(true);
    expect(crashed).not.toHaveBeenCalled();
    expect(leftLeases).toHaveBeenCalledWith(4242);
  });

  it('reports the leases of a core whose shutdown failed', async () => {
    const leftLeases = vi.fn();
    const desktop = startDesktopCore(deps(), { endedCores: [], worktreeRecords: [], crashed: vi.fn(), leftLeases });
    const endpoint = await coreSide(H.cores[0] as FakeCore);
    endpoint.serve('core.shutdown', () => Promise.reject(new Error('memory close failed')));
    publishTargets(endpoint);
    await desktop.ready;
    await desktop.dispose();
    expect(leftLeases).toHaveBeenCalledWith(4242);
  });

  it('kills a core not ready within the deadline and takes the crash path', async () => {
    const crashed = vi.fn();
    const desktop = startDesktopCore(deps(1_000, 50), { endedCores: [], worktreeRecords: [], crashed, leftLeases: vi.fn() });
    const core = H.cores[0] as FakeCore;
    await coreSide(core);
    await expect(desktop.ready).rejects.toThrow('Damocles Core stopped before it was ready');
    expect(core.killed()).toBe(true);
    expect(crashed).toHaveBeenCalledWith(4242, 'not ready within 50 ms');
  });

  it('leaves a core that became ready in time running', async () => {
    const crashed = vi.fn();
    const desktop = startDesktopCore(deps(1_000, 300), { endedCores: [], worktreeRecords: [], crashed, leftLeases: vi.fn() });
    const core = H.cores[0] as FakeCore;
    publishTargets(await coreSide(core));
    await desktop.ready;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(core.killed()).toBe(false);
    expect(desktop.isReady()).toBe(true);
  });
});
