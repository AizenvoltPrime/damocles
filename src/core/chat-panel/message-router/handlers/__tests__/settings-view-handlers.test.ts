import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createSettingsHandlers } from '../settings-handlers';
import { createWorkspaceHandlers } from '../workspace-handlers';
import { WebviewPrompts } from '../../../webview-prompts';
import type { AttachedView } from '../../../types';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../../../shared/types/messages';
import type { PanelHost } from '../../../../../platform/window-service';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));
vi.mock('../openai-handlers', () => ({
  openaiAuthStatusMessage: async () => ({ type: 'openaiAuthStatusChanged', status: { chatgpt: { signedIn: true }, codex: { signedIn: false }, apikey: { configured: false } }, preferApiKey: false }),
}));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const folder = { key: '/ws', fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true };

describe('toggleTerminal', () => {
  it('runs the host\'s Toggle Terminal command for the chat header\'s toggle', () => {
    const platform = createFakePlatform({ capabilities: { windowLayout: true } });
    const posted: ExtensionToWebviewMessage[] = [];
    const handlers = createWorkspaceHandlers({ platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies);
    handlers.toggleTerminal!({ type: 'toggleTerminal' }, { host: {}, panelId: 'p1', folder } as unknown as HandlerContext);
    expect(platform.window.terminalToggles()).toBe(1);
    expect(posted).toEqual([]);
  });
});

describe('openAppSettings', () => {
  function setup(settingsInPanel: boolean) {
    const platform = createFakePlatform({ capabilities: { settingsInPanel } });
    const posted: ExtensionToWebviewMessage[] = [];
    const handlers = createWorkspaceHandlers({ platform, postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies);
    const open = (message: WebviewToExtensionMessage): unknown => handlers.openAppSettings!(message, { host: {}, panelId: 'p1', folder } as unknown as HandlerContext);
    return { platform, posted, open };
  }

  it('opens the host\'s settings surface at the section asked for', () => {
    const { platform, posted, open } = setup(false);
    open({ type: 'openAppSettings', section: 'integrations' });
    open({ type: 'openAppSettings' });
    expect(platform.window.appSettingsOpened).toEqual(['integrations', undefined]);
    expect(posted).toEqual([]);
  });

  it('asks the chat page to open its own modal at that section where the modal lives in the page', () => {
    const { platform, posted, open } = setup(true);
    open({ type: 'openAppSettings', section: 'voice' });
    open({ type: 'openAppSettings' });
    expect(posted).toEqual([{ type: 'openSettingsPanel', section: 'voice' }, { type: 'openSettingsPanel' }]);
    expect(platform.window.appSettingsOpened).toEqual([]);
  });

  it('passes on the account row a chat asks to expand, on both hosts', () => {
    const inPanel = setup(true);
    inPanel.open({ type: 'openAppSettings', section: 'accounts', account: 'openai' });
    expect(inPanel.posted).toEqual([{ type: 'openSettingsPanel', section: 'accounts', account: 'openai' }]);

    const outside = setup(false);
    const openAppSettings = vi.spyOn(outside.platform.window, 'openAppSettings');
    outside.open({ type: 'openAppSettings', section: 'accounts', account: 'openai' });
    expect(openAppSettings).toHaveBeenCalledWith('accounts', 'openai');
    expect(() => outside.open({ type: 'openAppSettings', section: 'accounts', account: 'nobody' } as unknown as WebviewToExtensionMessage)).toThrow('Unknown settings account');
  });

  it('refuses a section the modal does not have', () => {
    const { platform, posted, open } = setup(false);
    expect(() => open({ type: 'openAppSettings', section: 'nowhere' } as unknown as WebviewToExtensionMessage)).toThrow('Unknown settings section');
    expect(platform.window.appSettingsOpened).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe('requestSettingsState', () => {
  function makeView(): AttachedView & { posted: ExtensionToWebviewMessage[] } {
    const posted: ExtensionToWebviewMessage[] = [];
    return { posted, post: (message) => posted.push(message), detached: () => undefined };
  }

  async function setup() {
    const platform = createFakePlatform();
    const view = makeView();
    const host = { onDispose: () => ({ dispose: () => undefined }), reveal: () => undefined } as unknown as PanelHost;
    const prompts = new WebviewPrompts({ target: async () => ({ panelId: 'p1', host }), attachedView: () => view }, () => undefined);
    void prompts.inputBox({ prompt: 'API key' });
    await tick();
    view.posted.length = 0;
    const posted: ExtensionToWebviewMessage[] = [];
    const settingsManager = {
      sendCurrentSettings: vi.fn(async () => {}),
      sendModelForPanel: vi.fn(),
      sendThinkingForPanel: vi.fn(),
      sendAvailableModels: vi.fn(async () => {}),
      sendStepfunAuthStatus: vi.fn(async () => {}),
      sendDeepseekAuthStatus: vi.fn(async () => {}),
      sendExploreConfig: vi.fn(),
      sendExploreKeyStatus: vi.fn(async () => {}),
      sendMcpStatus: vi.fn(async () => {}),
      sendImageGenerationSettings: vi.fn(),
      sendVoiceConfig: vi.fn(async () => {}),
    };
    const postSettingsFileAvailability = vi.fn();
    const postClaudeAuthState = vi.fn(() => posted.push({ type: 'claudeAuthStatusChanged', mode: 'allowance' }));
    const deps = {
      platform,
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => posted.push(message),
      settingsManager,
      postWorkspaceFolderState: vi.fn(),
      webviewPrompts: prompts,
      getPanels: () => new Map(),
      postSettingsFileAvailability,
      postClaudeAuthState,
    } as unknown as HandlerDependencies;
    const ctx = { host: {}, panelId: 'p1', folder, permissionHandler: {}, session: { publishAccountInfo: vi.fn(), getToolStatus: () => ({ tools: [] }) } } as unknown as HandlerContext;
    const handlers = createSettingsHandlers(deps);
    const request = (extra: Partial<HandlerContext> = {}): unknown => handlers.requestSettingsState!({ type: 'requestSettingsState' }, { ...ctx, ...extra });
    return { view, posted, request, settingsManager, postSettingsFileAvailability };
  }

  it('posts the state a view renders and the host prompts that view shows', async () => {
    const { view, posted, request } = await setup();
    await request({ view });
    expect(posted.map((message) => message.type)).toEqual(expect.arrayContaining(['hostCapabilities', 'projectTrust']));
    expect(view.posted).toEqual([expect.objectContaining({ type: 'extensionUiRequest', kind: 'input', title: 'API key' })]);
  });

  it('answers with every account status and the settings files that apply, so no section asks on its own', async () => {
    const { posted, request, settingsManager, postSettingsFileAvailability } = await setup();
    await request();
    expect(posted[0]!.type).toBe('hostCapabilities');
    expect(posted.map((message) => message.type)).toEqual(expect.arrayContaining([
      'claudeAuthStatusChanged',
      'openaiAuthStatusChanged',
      'typesafeAuthStatusChanged',
      'openrouterAuthStatusChanged',
      'toolStatus',
      'voiceFilesSizeUpdate',
    ]));
    for (const send of [
      settingsManager.sendStepfunAuthStatus,
      settingsManager.sendDeepseekAuthStatus,
      settingsManager.sendExploreConfig,
      settingsManager.sendExploreKeyStatus,
      settingsManager.sendAvailableModels,
      settingsManager.sendMcpStatus,
      settingsManager.sendImageGenerationSettings,
      settingsManager.sendVoiceConfig,
    ]) expect(send).toHaveBeenCalledOnce();
    expect(postSettingsFileAvailability).toHaveBeenCalledOnce();
  });

  it('reposts nothing into a view for a request from the chat itself', async () => {
    const { view, request } = await setup();
    await request();
    expect(view.posted).toEqual([]);
  });
});
