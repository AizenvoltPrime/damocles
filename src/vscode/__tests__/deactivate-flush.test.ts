import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { createFakePlatform } from '../../__mocks__/fake-platform';

const core = vi.hoisted(() => ({
  dispose: vi.fn<() => Promise<void>>(),
  flushCoreWrites: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../core/chat-panel', () => ({
  ChatPanelProvider: class {
    getVoiceService(): unknown { return {}; }
    getPanelManager(): unknown { return { onAllPanelsClosed: () => undefined }; }
    dispose(): Promise<void> { return core.dispose(); }
  },
  flushCoreWrites: core.flushCoreWrites,
}));
vi.mock('../platform', () => ({ createVsCodePlatform: () => createFakePlatform() }));
vi.mock('../panels/sidebar-view-provider', () => ({ SidebarViewProvider: class {} }));
vi.mock('../voice/status-bar', () => ({ createVoiceStatusBarItem: () => ({ dispose: () => undefined }) }));
vi.mock('../../core/voice/auto-disable', () => ({ setupAutoDisable: () => undefined }));
vi.mock('../../core/config/legacy-settings-migrations', () => ({ runLegacySettingsMigrations: async () => undefined }));
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
