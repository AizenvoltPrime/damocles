import { describe, expect, it, vi } from 'vitest';

let captured: { model?: string; onModelChange?: (model: string, contextWindow: number, committed: boolean) => void } | null = null;
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
      getConfiguredModelForPanel: () => 'claude-opus-5-5',
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
    await manager.createSessionForPanel(host, { getPermissionMode: () => 'default', turnPermissionMode: () => 'default' } as never, 'panel-1', FOLDER);

    captured!.onModelChange!('claude-haiku-5-5', 200_000, true);
    captured!.onModelChange!('claude-opus-5-5', 1_000_000, false);

    expect(adopt.mock.calls).toEqual([
      [host, 'panel-1', FOLDER, 'claude-haiku-5-5', 200_000, true],
      [host, 'panel-1', FOLDER, 'claude-opus-5-5', 1_000_000, false],
    ]);
  });

  // Only a session given no model may replace it with a signed-in one.
  it('gives the session no model only while the panel holds none and damocles.model is unset in every scope', async () => {
    const manager = new SessionManager({
      getMcpConfigLoaded: () => true,
      getEnabledMcpServers: () => ({ userUnion: {}, userVisible: [], folder: {} }),
      getConfiguredModelForPanel: () => undefined,
      getPreferOpenAIApiKey: () => false,
      resolveThinkingForPanel: () => ({ thinkingDisabled: false, effort: null }),
      restoreRecordedSelection: vi.fn(),
      adoptSessionModel: vi.fn(),
      postMessage: vi.fn(),
      getMemoryService: () => null,
      getCompassService: () => null,
      getRawBrowserService: () => ({}),
      platform: createFakePlatform(),
    } as unknown as SessionManagerConfig);
    await manager.createSessionForPanel({} as PanelHost, { getPermissionMode: () => 'default', turnPermissionMode: () => 'default' } as never, 'panel-1', FOLDER);
    expect(captured).not.toHaveProperty('model');

    const unset = new SettingsManager({ postMessage: () => undefined, platform: installFakePlatform({ settings: {} }), folders: () => [] });
    unset.initPanelModel('panel-1');
    expect(unset.getConfiguredModelForPanel('panel-1')).toBeUndefined();
    expect(unset.getActiveModelForPanel('panel-1')).toBe('claude-opus-5-5');
    unset.adoptSessionModel({} as PanelHost, 'panel-1', FOLDER, 'deepseek-flash', 1_000_000, true);
    expect(unset.getConfiguredModelForPanel('panel-1')).toBe('deepseek-flash');

    const configured = new SettingsManager({ postMessage: () => undefined, platform: installFakePlatform({ settings: { project: { 'damocles.model': 'muse-spark-1.3' } } }), folders: () => [] });
    configured.initPanelModel('panel-1');
    expect(configured.getConfiguredModelForPanel('panel-1')).toBe('muse-spark-1.3');
  });

  // Holding none would let the panel's next session, after a folder switch, fall back to another model.
  it('holds a committed model that equals the default, so the next session for the panel starts on it', () => {
    const settings = new SettingsManager({ postMessage: () => undefined, platform: installFakePlatform({ settings: {} }), folders: () => [] });
    settings.initPanelModel('panel-1');
    expect(settings.getConfiguredModelForPanel('panel-1')).toBeUndefined();

    settings.adoptSessionModel({} as PanelHost, 'panel-1', FOLDER, 'claude-opus-5-5', 1_000_000, true);

    expect(settings.getConfiguredModelForPanel('panel-1')).toBe('claude-opus-5-5');
  });

  // A held factory default would reach the next session as configured, which then neither falls back nor refuses as for the factory default.
  it('holds no factory default the session only shows, and posts it as the model the chat shows', async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const platform = installFakePlatform({ settings: {} });
    const settings = new SettingsManager({ postMessage: (_host, message) => posted.push(message), platform, folders: () => [] });
    settings.initPanelModel('panel-1');

    settings.adoptSessionModel({} as PanelHost, 'panel-1', FOLDER, 'claude-opus-5-5', 1_000_000, false);

    expect(settings.getConfiguredModelForPanel('panel-1')).toBeUndefined();
    expect(settings.getActiveModelForPanel('panel-1')).toBe('claude-opus-5-5');
    expect(posted).toEqual([
      expect.objectContaining({ type: 'modelUpdate', activeModel: 'claude-opus-5-5', contextWindowSize: 1_000_000 }),
      expect.objectContaining({ type: 'panelThinkingUpdate', panelModel: 'claude-opus-5-5' }),
    ]);

    // A default set later is the next session's model; the running chat still shows the one it runs.
    await platform.settings.update('damocles.model', 'claude-sonnet-5-5', 'user');
    settings.sendModelForPanel({} as PanelHost, 'panel-1');
    expect(settings.getConfiguredModelForPanel('panel-1')).toBe('claude-sonnet-5-5');
    expect(posted.at(-1)).toEqual(expect.objectContaining({ type: 'modelUpdate', activeModel: 'claude-opus-5-5', defaultModel: 'claude-sonnet-5-5' }));
  });

  it("starts the panel's next session, as a folder switch does, on the factory default until the shown one is committed", async () => {
    const settings = new SettingsManager({ postMessage: () => undefined, platform: installFakePlatform({ settings: {} }), folders: () => [] });
    settings.initPanelModel('panel-1');
    const manager = new SessionManager({
      getMcpConfigLoaded: () => true,
      getEnabledMcpServers: () => ({ userUnion: {}, userVisible: [], folder: {} }),
      getConfiguredModelForPanel: settings.getConfiguredModelForPanel.bind(settings),
      getPreferOpenAIApiKey: () => false,
      resolveThinkingForPanel: () => ({ thinkingDisabled: false, effort: null }),
      restoreRecordedSelection: vi.fn(),
      adoptSessionModel: settings.adoptSessionModel.bind(settings),
      postMessage: vi.fn(),
      getMemoryService: () => null,
      getCompassService: () => null,
      getRawBrowserService: () => ({}),
      platform: createFakePlatform(),
    } as unknown as SessionManagerConfig);
    const nextSession = async () => {
      await manager.createSessionForPanel({} as PanelHost, { getPermissionMode: () => 'default', turnPermissionMode: () => 'default' } as never, 'panel-1', FOLDER);
      return captured!;
    };

    const first = await nextSession();
    expect(first).not.toHaveProperty('model');
    first.onModelChange!('claude-opus-5-5', 1_000_000, false);

    const afterSwitch = await nextSession();
    expect(afterSwitch).not.toHaveProperty('model');
    afterSwitch.onModelChange!('claude-opus-5-5', 1_000_000, true);

    expect((await nextSession()).model).toBe('claude-opus-5-5');
  });

  it('posts the committed model and the thinking state for it', () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const settings = settingsWith(posted);

    settings.adoptSessionModel({} as PanelHost, 'panel-1', FOLDER, 'claude-haiku-5-5', 200_000, true);

    expect(settings.getActiveModelForPanel('panel-1')).toBe('claude-haiku-5-5');
    expect(posted).toEqual([
      expect.objectContaining({ type: 'modelUpdate', activeModel: 'claude-haiku-5-5', defaultModel: 'claude-opus-5-5', contextWindowSize: 200_000 }),
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
