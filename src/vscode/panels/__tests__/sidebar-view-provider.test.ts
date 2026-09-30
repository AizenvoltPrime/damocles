import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../core/logger', () => ({ log: vi.fn() }));
vi.mock('../../../core/chat-panel/ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import * as vscode from 'vscode';
import { createHarness, folderEntry, type Harness } from '../../../core/chat-panel/__tests__/panel-manager-harness';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { SidebarViewProvider } from '../sidebar-view-provider';

const ROOT = path.resolve(os.tmpdir(), 'svp-root');
const A = path.join(ROOT, 'alpha');
const B = path.join(ROOT, 'beta');

let h: Harness;

afterEach(() => {
  h.dispose();
});

describe('SidebarViewProvider', () => {
  it('opens the sidebar view in the folder its webview state saved, so no session starts in the default', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const panel = vscode.window.createWebviewPanel('damocles.sidebarView', 'Damocles', 1);
    const view = {
      webview: panel.webview,
      visible: true,
      description: '',
      onDidDispose: panel.onDidDispose,
      onDidChangeVisibility: () => ({ dispose: () => undefined }),
      show: () => undefined,
    };

    await new SidebarViewProvider(h.manager).resolveWebviewView(
      view as unknown as vscode.WebviewView,
      { state: { sessionId: 's', workspaceFolderKey: folderKey(B) } },
      {} as vscode.CancellationToken,
    );

    expect(h.sessions.map((s) => s.cwd)).toEqual([B]);
    expect(h.initialMessageFolders).toEqual([folderKey(B)]);
  });

  it('lets the view load only the webview bundle and the resources, with scripts on', async () => {
    h = createHarness([folderEntry(A)]);
    const panel = vscode.window.createWebviewPanel('damocles.sidebarView', 'Damocles', 1);
    const view = {
      webview: panel.webview,
      visible: true,
      description: '',
      onDidDispose: panel.onDidDispose,
      onDidChangeVisibility: () => ({ dispose: () => undefined }),
      show: () => undefined,
    };

    await new SidebarViewProvider(h.manager).resolveWebviewView(
      view as unknown as vscode.WebviewView,
      { state: undefined },
      {} as vscode.CancellationToken,
    );

    const root = h.platform.paths.resourceRoot;
    expect(panel.webview.options).toEqual({
      enableScripts: true,
      localResourceRoots: [path.join(root, 'dist', 'webview'), path.join(root, 'resources')].map((p) => vscode.Uri.file(p)),
    });
    expect(panel.webview.html).toContain('<div id="app"');
  });
});
