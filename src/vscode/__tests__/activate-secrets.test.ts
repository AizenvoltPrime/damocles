import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { createFakePlatform, type FakePlatform } from '../../__mocks__/fake-platform';

const host = vi.hoisted(() => ({ platform: undefined as FakePlatform | undefined }));

vi.mock('../../core/chat-panel', () => ({
  ChatPanelProvider: class {
    getVoiceService(): unknown { return {}; }
    getPanelManager(): unknown { return { onAllPanelsClosed: () => undefined }; }
    dispose(): Promise<void> { return Promise.resolve(); }
  },
  flushCoreWrites: () => Promise.resolve(),
}));
vi.mock('../platform', () => ({ createVsCodePlatform: () => host.platform }));
vi.mock('../panels/sidebar-view-provider', () => ({ SidebarViewProvider: class {} }));
vi.mock('../voice/status-bar', () => ({ createVoiceStatusBarItem: () => ({ dispose: () => undefined }) }));
vi.mock('../../core/voice/auto-disable', () => ({ setupAutoDisable: () => undefined }));
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

import { activate } from '../extension';

/** Whether activation finishes before a wall-clock bound far below any keyring read's. */
async function activatesPromptly(): Promise<boolean> {
  const bound = new Promise<'wedged'>((resolve) => setTimeout(() => resolve('wedged'), 1_000));
  return (await Promise.race([activate({ subscriptions: [] } as unknown as vscode.ExtensionContext).then(() => 'activated' as const), bound])) === 'activated';
}

describe('activate', () => {
  it('comes up while the keyring never answers', async () => {
    const platform = createFakePlatform();
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    vi.spyOn(platform.secrets, 'get').mockImplementation(never);
    vi.spyOn(platform.secrets, 'delete').mockImplementation(never);
    host.platform = platform;
    expect(await activatesPromptly()).toBe(true);
  });

  it('moves an enabled StepFun Explore to Step 5 Preview when the StepFun key is stored', async () => {
    host.platform = createFakePlatform({
      settings: { user: { 'damocles.explore.enabled': true, 'damocles.explore.provider': 'stepfun' } },
      secrets: { 'damocles.explore.apiKey.stepfun': 'sk-step' },
    });
    expect(await activatesPromptly()).toBe(true);
    expect(host.platform.settings.inspect('damocles.explore.model')).toStrictEqual({ userValue: 'step-5-preview' });
  });
});
