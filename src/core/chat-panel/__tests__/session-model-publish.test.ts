import { describe, expect, it, vi } from 'vitest';

let captured: { onModelChange?: (model: string) => void } | null = null;
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
import { createModelHandlers } from '../message-router/handlers/model-handlers';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import type { HandlerContext, HandlerDependencies } from '../message-router/types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PanelHost } from '../../../platform/window-service';

const FOLDER = { key: '/repo', fsPath: '/repo', name: 'repo', label: 'repo', projectScope: true };

function settingsWith(posted: ExtensionToWebviewMessage[]): SettingsManager {
  const platform = installFakePlatform({ settings: { user: { 'damocles.model': 'claude-opus-5-5' } } });
  const settings = new SettingsManager({ postMessage: (_host, message) => posted.push(message), platform, folders: () => [] });
  settings.initPanelModel('panel-1');
  return settings;
}

describe("the panel's model is the one its session committed", () => {
  it('reaches the panel settings through the session it starts', async () => {
    const adopt = vi.fn();
    const host = {} as PanelHost;
    const manager = new SessionManager({
      getMcpConfigLoaded: () => true,
      getEnabledMcpServers: () => ({ userUnion: {}, userVisible: [], folder: {} }),
      getActiveModelForPanel: () => 'claude-opus-5-5',
      getPreferOpenAIApiKey: () => false,
      resolveThinkingForPanel: () => ({ thinkingDisabled: false, effort: null }),
      restoreRecordedSelection: vi.fn(),
      adoptSessionModel: adopt,
      postMessage: vi.fn(),
      getMemoryService: () => null,
      getCompassService: () => null,
      getRawBrowserService: () => ({}),
      platform: createFakePlatform(),
    } as unknown as SessionManagerConfig);
    await manager.createSessionForPanel(host, { getPermissionMode: () => 'default' } as never, 'panel-1', FOLDER);

    captured!.onModelChange!('claude-haiku-5-5');

    expect(adopt).toHaveBeenCalledExactlyOnceWith(host, 'panel-1', FOLDER, 'claude-haiku-5-5');
  });

  it('posts the committed model and the thinking state for it', () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const settings = settingsWith(posted);

    settings.adoptSessionModel({} as PanelHost, 'panel-1', FOLDER, 'claude-haiku-5-5');

    expect(settings.getActiveModelForPanel('panel-1')).toBe('claude-haiku-5-5');
    expect(posted).toEqual([
      expect.objectContaining({ type: 'modelUpdate', activeModel: 'claude-haiku-5-5', defaultModel: 'claude-opus-5-5' }),
      expect.objectContaining({ type: 'panelThinkingUpdate', panelModel: 'claude-haiku-5-5' }),
    ]);
  });

  it('treats a pick as a request: the panel keeps its model and the session is asked every time', () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const settings = settingsWith(posted);
    const setModel = vi.fn(async () => undefined);
    const handlers = createModelHandlers({ settingsManager: settings, getPanels: () => new Map() } as unknown as HandlerDependencies);
    const ctx = { host: {}, panelId: 'panel-1', folder: FOLDER, session: { setModel } } as unknown as HandlerContext;

    void handlers.setActiveModel!({ type: 'setActiveModel', model: 'step-5-preview' }, ctx);
    void handlers.setActiveModel!({ type: 'setActiveModel', model: 'step-5-preview' }, ctx);

    expect(setModel.mock.calls).toEqual([['step-5-preview'], ['step-5-preview']]);
    expect(settings.getActiveModelForPanel('panel-1')).toBe('claude-opus-5-5');
    expect(posted).toEqual([]);
  });
});
