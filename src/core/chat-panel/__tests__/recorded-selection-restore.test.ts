import { describe, expect, it, vi } from 'vitest';

let captured: { onRecordedSelection?: (model: string, thinkingLevel: string | undefined) => void } | null = null;
vi.mock('../../pi-session/pi-session', () => ({
  PiSession: class {
    constructor(options: typeof captured) {
      captured = options;
    }
  },
}));
vi.mock('../../logger', () => ({ log: vi.fn() }));

import { SessionManager, type SessionManagerConfig } from '../session-manager';
import { SettingsManager } from '../settings-manager';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PanelHost } from '../../../platform/window-service';

const FOLDER = { key: '/repo', fsPath: '/repo', name: 'repo', label: 'repo', projectScope: true };

describe("a resumed conversation's recorded model and effort become the panel's", () => {
  it('reaches the panel settings through the session it starts', async () => {
    const restore = vi.fn();
    const host = {} as PanelHost;
    const manager = new SessionManager({
      getMcpConfigLoaded: () => true,
      getEnabledMcpServers: () => ({ userUnion: {}, userVisible: [], folder: {} }),
      getActiveModelForPanel: () => 'claude-opus-5-5',
      getDefaultModel: () => 'claude-opus-5-5',
      getPreferOpenAIApiKey: () => false,
      resolveThinkingForPanel: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
      restoreRecordedSelection: restore,
      postMessage: vi.fn(),
      getMemoryService: () => null,
      getCompassService: () => null,
      getRawBrowserService: () => ({}),
      platform: createFakePlatform(),
    } as unknown as SessionManagerConfig);
    await manager.createSessionForPanel(host, { getPermissionMode: () => 'default' } as never, 'panel-1', FOLDER);

    captured!.onRecordedSelection!('claude-sonnet-5-5', 'xhigh');

    expect(restore).toHaveBeenCalledExactlyOnceWith(host, 'panel-1', FOLDER, 'claude-sonnet-5-5', 'xhigh');
  });

  it('sets the panel model and effort and posts both, leaving the default and other panels alone', () => {
    const platform = installFakePlatform({ settings: { user: { 'damocles.model': 'claude-opus-5-5' } } });
    const posted: ExtensionToWebviewMessage[] = [];
    const settings = new SettingsManager({ postMessage: (_host, message) => posted.push(message), platform, folders: () => [] });
    settings.initPanelModel('panel-1');
    settings.initPanelModel('panel-2');

    settings.restoreRecordedSelection({} as PanelHost, 'panel-1', FOLDER, 'claude-sonnet-5-5', 'xhigh');

    expect(settings.getActiveModelForPanel('panel-1')).toBe('claude-sonnet-5-5');
    expect(settings.getActiveModelForPanel('panel-2')).toBe('claude-opus-5-5');
    expect(settings.resolveThinkingEffort('panel-1', 'claude-sonnet-5-5', platform.settings, undefined)).toBe('xhigh');
    expect(posted).toEqual([
      expect.objectContaining({ type: 'modelUpdate', activeModel: 'claude-sonnet-5-5', defaultModel: 'claude-opus-5-5' }),
      expect.objectContaining({ type: 'panelThinkingUpdate', panelModel: 'claude-sonnet-5-5', panel: expect.objectContaining({ effort: 'xhigh' }) }),
    ]);
  });
});
