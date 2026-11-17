import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { createFakePlatform } from '../../__mocks__/fake-platform';

const core = vi.hoisted(() => ({
  dispose: vi.fn<() => Promise<void>>(),
  flushCoreWrites: vi.fn<() => Promise<void>>(),
  // a plain function: a vi.fn handles each promise it returns, which would hide an unhandled rejection
  runtimeDispose: (): Promise<void> => Promise.resolve(),
  runtimeDisposeCalls: 0,
  log: vi.fn<(line: string) => void>(),
}));

vi.mock('../../core/pi-session/pi-runtime', () => ({
  PiRuntime: {
    exists: true,
    disposeInstance: (): Promise<void> => {
      core.runtimeDisposeCalls++;
      return core.runtimeDispose();
    },
  },
}));
vi.mock('../../core/logger', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../core/logger')>()), log: core.log }));

vi.mock('../../core/chat-panel', () => ({
  ChatPanelProvider: class {
    getVoiceService(): unknown { return {}; }
    getPanelManager(): unknown { return { onAllPanelsClosed: () => undefined }; }
    getProjectRelocations(): unknown { return {}; }
    dispose(): Promise<void> { return core.dispose(); }
  },
  flushCoreWrites: core.flushCoreWrites,
}));
vi.mock('../platform', () => ({ createVsCodePlatform: () => createFakePlatform() }));
vi.mock('../panels/sidebar-view-provider', () => ({ SidebarViewProvider: class {} }));
vi.mock('../relocation-offer', () => ({ registerRelocationOffer: () => undefined }));
vi.mock('../voice/status-bar', () => ({ createVoiceStatusBarItem: () => ({ dispose: () => undefined }) }));
vi.mock('../../core/voice/auto-disable', () => ({ setupAutoDisable: () => undefined }));
vi.mock('../../core/config/legacy-settings-migrations', () => ({ runLegacySettingsMigrations: async () => undefined, movePreferApiKeyFlagsToSettings: async () => undefined }));
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    window: {
      ...actual.window,
      registerWebviewViewProvider: () => ({ dispose: () => undefined }),
      registerWebviewPanelSerializer: () => ({ dispose: () => undefined }),
    },
  };
});

import { activate, deactivate } from '../extension';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.finally(() => { settled = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return settled;
}

beforeEach(async () => {
  core.dispose.mockReset().mockResolvedValue(undefined);
  core.flushCoreWrites.mockReset().mockResolvedValue(undefined);
  core.runtimeDispose = () => Promise.resolve();
  core.runtimeDisposeCalls = 0;
  core.log.mockReset();
  await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deactivate', () => {
  it('waits for core\'s config writes, flushed once the provider has disposed', async () => {
    const disposed = deferred();
    const flushed = deferred();
    core.dispose.mockReturnValue(disposed.promise);
    core.flushCoreWrites.mockReturnValue(flushed.promise);
    const deactivating = deactivate();
    expect(await settles(deactivating)).toBe(false);
    expect(core.flushCoreWrites).not.toHaveBeenCalled();
    disposed.resolve();
    expect(await settles(deactivating)).toBe(false);
    expect(core.flushCoreWrites).toHaveBeenCalledOnce();
    flushed.resolve();
    await deactivating;
  });

  it('still flushes core\'s writes when the provider\'s dispose fails', async () => {
    core.dispose.mockRejectedValue(new Error('dispose failed'));
    await deactivate().catch(() => undefined);
    expect(core.flushCoreWrites).toHaveBeenCalledOnce();
  });

  it('stops waiting for a write that never settles after its bound', async () => {
    vi.useFakeTimers();
    core.flushCoreWrites.mockReturnValue(new Promise<void>(() => undefined));
    const deactivating = deactivate();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settles(deactivating)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await deactivating;
  });

  it('waits for the dispose of the pi runtime, which may be writing a refreshed credential', async () => {
    const runtimeDisposed = deferred();
    core.runtimeDispose = () => runtimeDisposed.promise;
    const deactivating = deactivate();
    expect(core.runtimeDisposeCalls).toBe(1);
    expect(await settles(deactivating)).toBe(false);
    expect(core.flushCoreWrites).toHaveBeenCalledOnce();
    runtimeDisposed.resolve();
    await deactivating;
  });

  it('handles a runtime dispose that fails while the provider still disposes: logged, never unhandled, and the writes still flushed', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const disposed = deferred();
      core.dispose.mockReturnValue(disposed.promise);
      core.runtimeDispose = () => Promise.reject(new Error('runtime dispose failed'));
      const deactivating = deactivate();
      await new Promise((resolve) => setImmediate(resolve));
      disposed.resolve();
      await deactivating;
      expect(unhandled).toEqual([]);
      expect(core.flushCoreWrites).toHaveBeenCalledOnce();
      expect(core.log.mock.calls.some(([line]) => line.includes('the pi runtime failed') && line.includes('runtime dispose failed'))).toBe(true);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('stops waiting for a runtime dispose that never settles at the end of the budget', async () => {
    vi.useFakeTimers();
    core.runtimeDispose = () => new Promise<void>(() => undefined);
    const deactivating = deactivate();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settles(deactivating)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settles(deactivating)).toBe(true);
    expect(core.log.mock.calls.some(([line]) => line.includes('the pi runtime did not settle'))).toBe(true);
  });

  it('counts the bound from the start of deactivate, so a slow dispose leaves the writes only what remains of it', async () => {
    vi.useFakeTimers();
    core.dispose.mockReturnValue(new Promise<void>((resolve) => setTimeout(resolve, 3_000)));
    core.flushCoreWrites.mockReturnValue(new Promise<void>(() => undefined));
    const deactivating = deactivate();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(core.flushCoreWrites).toHaveBeenCalledOnce();
    expect(await settles(deactivating)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settles(deactivating)).toBe(true);
  });
});
