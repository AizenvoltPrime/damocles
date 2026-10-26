import { describe, expect, it } from 'vitest';
import { SettingsManager } from '..';
import { installFakePlatform } from '../../../../__mocks__/fake-platform';
import { getContextWindowForModel } from '../utils';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { PanelHost } from '../../../../platform/window-service';

const FOLDER = { key: '/repo', fsPath: '/repo', name: 'repo', label: 'repo', projectScope: true };
const HOST = {} as PanelHost;

function setup() {
  const platform = installFakePlatform({ settings: { user: { 'damocles.model': 'claude-opus-5-5' } } });
  const posted: ExtensionToWebviewMessage[] = [];
  const settings = new SettingsManager({ postMessage: (_host, message) => posted.push(message), platform, folders: () => [] });
  settings.initPanelModel('panel-1');
  const lastWindow = () =>
    posted.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'modelUpdate' }> => m.type === 'modelUpdate').at(-1)?.contextWindowSize;
  return { settings, lastWindow, posted };
}

describe("the context meter's window is the one of the model the session adopted", () => {
  it("posts the adopted model's window, not the static table's", () => {
    const { settings, lastWindow } = setup();
    expect(getContextWindowForModel('gpt-6.1-sol')).not.toBe(500_000);

    settings.adoptSessionModel(HOST, 'panel-1', FOLDER, 'gpt-6.1-sol', 500_000, true);

    expect(lastWindow()).toBe(500_000);
  });

  it('keeps the adopted window on every later model post', () => {
    const { settings, lastWindow } = setup();
    settings.adoptSessionModel(HOST, 'panel-1', FOLDER, 'gpt-6.1-sol', 500_000, true);

    settings.sendModelForPanel(HOST, 'panel-1');

    expect(lastWindow()).toBe(500_000);
  });

  it('updates the window when the same model is adopted with another one', () => {
    const { settings, lastWindow } = setup();
    settings.adoptSessionModel(HOST, 'panel-1', FOLDER, 'gpt-6.1-sol', 500_000, true);

    settings.adoptSessionModel(HOST, 'panel-1', FOLDER, 'gpt-6.1-sol', 272_000, true);

    expect(lastWindow()).toBe(272_000);
  });

  it("keeps the adopted window through a resumed conversation's recorded selection, which posts no model of its own", () => {
    const { settings, lastWindow, posted } = setup();
    settings.adoptSessionModel(HOST, 'panel-1', FOLDER, 'gpt-6.1-sol', 500_000, true);
    const before = posted.length;

    settings.restoreRecordedSelection('panel-1', 'gpt-6.1-sol', 'high');
    settings.sendModelForPanel(HOST, 'panel-1');

    expect(posted.slice(before).map((m) => m.type)).toEqual(['modelUpdate']);
    expect(lastWindow()).toBe(500_000);
  });

  it('forgets the window when the panel closes', () => {
    const { settings, lastWindow } = setup();
    settings.adoptSessionModel(HOST, 'panel-1', FOLDER, 'gpt-6.1-sol', 500_000, true);
    settings.cleanupPanelModel('panel-1');
    settings.initPanelModel('panel-1');

    settings.sendModelForPanel(HOST, 'panel-1');

    expect(lastWindow()).toBe(getContextWindowForModel('claude-opus-5-5'));
  });
});
