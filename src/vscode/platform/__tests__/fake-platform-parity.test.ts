import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { __trustEmitter } from 'vscode';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createVsCodeTrustService } from '../trust-service';
import { createVsCodeLocalizationService } from '../localization-service';
import { formatMessage } from '../../../desktop/main/platform/localization-service';
import { VSCODE_HOST_CAPABILITIES } from '../../../shared/types/messages';

// Tests of core code trust the fake to deliver what the VS Code host delivers.
function setWorkspaceFolders(fsPaths: readonly string[]): void {
  const folders = fsPaths.map((fsPath) => ({ uri: { fsPath, scheme: 'file' }, name: fsPath }));
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = folders;
}

afterEach(() => {
  setWorkspaceFolders([]);
  __trustEmitter.clear();
  vscode.__setTrusted(true);
});

describe.each([
  ['two open folders', ['/a', '/b']],
  ['an empty window', []],
])('onDidGrantTrust payload parity: %s', (_name, fsPaths) => {
  it('the fake grantTrust() default equals the VS Code payload', () => {
    setWorkspaceFolders(fsPaths);
    const vsCodeCb = vi.fn();
    createVsCodeTrustService().onDidGrantTrust(vsCodeCb);
    __trustEmitter.fire();

    const fake = createFakePlatform({ trusted: false, folders: fsPaths.map((fsPath) => ({ fsPath, name: fsPath })) });
    const fakeCb = vi.fn();
    fake.trust.onDidGrantTrust(fakeCb);
    fake.trust.grantTrust();

    expect(fakeCb.mock.calls).toEqual(vsCodeCb.mock.calls);
    expect(fake.trust.isTrusted('/elsewhere')).toBe(true);
  });
});

describe('file watcher glob parity', () => {
  it('the fake matches a workspace glob relative to each open folder, as both hosts do', () => {
    const folder = path.resolve('/ws/a');
    const fake = createFakePlatform({ folders: [{ fsPath: folder, name: 'a' }] });
    const changed = vi.fn();
    fake.fileWatchers.watchWorkspace('.damocles/settings.json').onDidChange(changed);
    const watcher = fake.fileWatchers.workspaceWatcher('.damocles/settings.json');

    watcher.fireChange(path.join(folder, '.damocles', 'settings.json'));
    watcher.fireChange(path.join(folder, 'nested', '.damocles', 'settings.json'));
    watcher.fireChange(path.resolve('/elsewhere/.damocles/settings.json'));

    expect(changed.mock.calls).toEqual([[path.join(folder, '.damocles', 'settings.json')]]);
  });

  it('the fake matches a watch glob relative to its base', () => {
    const base = path.resolve('/home/u/.damocles');
    const fake = createFakePlatform();
    const created = vi.fn();
    fake.fileWatchers.watch(base, '*.json').onDidCreate(created);
    const watcher = fake.fileWatchers.watcher(base, '*.json');

    watcher.fireCreate(path.join(base, 'mcp.json'));
    watcher.fireCreate(path.join(base, 'sub', 'mcp.json'));
    watcher.fireCreate(path.join(base, 'notes.md'));

    expect(created.mock.calls).toEqual([[path.join(base, 'mcp.json')]]);
  });
});

describe('isTrusted parity', () => {
  it('both ignore the folder path and answer the window state', () => {
    vscode.__setTrusted(false);
    const fake = createFakePlatform({ trusted: false });
    expect([createVsCodeTrustService().isTrusted('/a'), fake.trust.isTrusted('/a')]).toEqual([false, false]);
    vscode.__setTrusted(true);
    fake.trust.setTrusted(true);
    expect([createVsCodeTrustService().isTrusted('/b'), fake.trust.isTrusted('/b')]).toEqual([true, true]);
  });
});

describe('localization parity', () => {
  it('the fake, VS Code and desktop all leave a placeholder with no argument as written', () => {
    const message = '{0} of {1}';
    const expected = 'one of {1}';
    expect(createFakePlatform().localization.t(message, 'one')).toBe(expected);
    expect(createVsCodeLocalizationService().t(message, 'one')).toBe(expected);
    expect(formatMessage(message, ['one'])).toBe(expected);
  });
});

describe('host capabilities parity', () => {
  it('the fake platform offers what the VS Code host offers', () => {
    expect(createFakePlatform().capabilities).toStrictEqual(VSCODE_HOST_CAPABILITIES);
  });

  it('VS Code keeps every affordance it had before the handshake, shows no setting sources and never loads Monaco', () => {
    expect(VSCODE_HOST_CAPABILITIES).toStrictEqual({
      voice: true,
      hostSpeechExtensions: true,
      hostSettingsEditor: true,
      diffReview: true,
      settingsSources: false,
      monaco: false,
      ideContext: true,
      damoclesTheme: false,
      settingsInPanel: true,
      historyInPanel: true,
      folderPickerInPanel: true,
      fileMentionDrop: false,
      windowLayout: false,
    });
  });
});
