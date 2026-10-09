import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Disposable } from '../../platform/disposable';
import type { ActiveEditorContext, DiffRequest, DiffSide, DiffView, EditorService, OpenFileOptions } from '../../platform/editor-service';

const DIFF_SCHEMES: Readonly<Record<DiffRequest['purpose'], string>> = {
  proposal: 'claude-diff',
  checkpoint: 'damocles-rewind',
};

// An editor on a webview document leaves the context unchanged.
const IGNORED_EDITOR_SCHEME = 'vscode-webview';

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  setContent(key: string, content: string): void {
    this.contents.set(key, content);
  }

  deleteContent(key: string): void {
    this.contents.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.contents.keys();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }
}

function editorContext(editor: vscode.TextEditor | undefined): ActiveEditorContext | undefined {
  if (!editor || editor.document.uri.scheme === IGNORED_EDITOR_SCHEME) return undefined;
  if (editor.document.uri.scheme !== 'file') return { filePath: undefined, selection: undefined };
  const selection = editor.selection;
  return {
    filePath: editor.document.uri.fsPath,
    selection: selection.isEmpty
      ? undefined
      : { startLine: selection.start.line + 1, endLine: selection.end.line + 1, text: editor.document.getText(selection) },
  };
}

function selectionAt(line: number): vscode.Range {
  return new vscode.Range(line - 1, 0, line - 1, 0);
}

function showOptions(opts: OpenFileOptions): vscode.TextDocumentShowOptions | undefined {
  const options: vscode.TextDocumentShowOptions = {
    ...(opts.preview !== undefined ? { preview: opts.preview } : {}),
    ...(opts.line !== undefined ? { selection: selectionAt(opts.line) } : {}),
    ...(opts.preserveFocus !== undefined ? { preserveFocus: opts.preserveFocus } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

// One content provider per diff scheme for the whole window; subscriptions receives the registrations.
export function createVsCodeEditorService(subscriptions: Disposable[]): EditorService {
  const providers: Readonly<Record<DiffRequest['purpose'], DiffContentProvider>> = {
    proposal: new DiffContentProvider(),
    checkpoint: new DiffContentProvider(),
  };
  for (const purpose of ['proposal', 'checkpoint'] as const) {
    subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEMES[purpose], providers[purpose]));
  }
  const checkpointScheme = DIFF_SCHEMES.checkpoint;
  const checkpoints = providers.checkpoint;

  subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((e) => {
    for (const closed of e.closed) {
      if (!(closed.input instanceof vscode.TabInputTextDiff)) continue;
      const original = closed.input.original;
      if (original.scheme !== checkpointScheme) continue;
      checkpoints.deleteContent(original.path);
    }
  }));

  const releaseClosedCheckpoints = (): void => {
    const openKeys = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
        if (tab.input.original.scheme !== checkpointScheme) continue;
        openKeys.add(tab.input.original.path);
      }
    }
    for (const key of [...checkpoints.keys()]) {
      if (!openKeys.has(key)) checkpoints.deleteContent(key);
    }
  };

  const sideUri = (side: DiffSide, scheme: string, provider: DiffContentProvider): vscode.Uri => {
    if ('path' in side) return vscode.Uri.file(side.path);
    const key = `/${side.name}`;
    provider.setContent(key, side.content);
    return vscode.Uri.from({ scheme, path: key });
  };

  return {
    openFile: async (path, opts = {}) => {
      const uri = vscode.Uri.file(path);
      if (opts.editor === 'text') {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, showOptions(opts));
        return;
      }
      await vscode.commands.executeCommand('vscode.open', uri, showOptions(opts));
    },

    openUntitled: async (content, language) => {
      const document = await vscode.workspace.openTextDocument({ content, language });
      await vscode.window.showTextDocument(document, { preview: true });
    },

    readText: async (path) => (await vscode.workspace.openTextDocument(vscode.Uri.file(path))).getText(),

    showDiff: async (req): Promise<DiffView> => {
      const scheme = DIFF_SCHEMES[req.purpose];
      const provider = providers[req.purpose];
      if (req.purpose === 'checkpoint') releaseClosedCheckpoints();
      const left = sideUri(req.left, scheme, provider);
      const right = sideUri(req.right, scheme, provider);
      const release = (): void => {
        if (left.scheme === scheme) provider.deleteContent(left.path);
        if (right.scheme === scheme) provider.deleteContent(right.path);
      };
      try {
        await vscode.commands.executeCommand('vscode.diff', left, right, req.title(path.basename(req.filePath)), {
          ...(req.column !== undefined ? { viewColumn: req.column } : {}),
          ...(req.preserveFocus !== undefined ? { preserveFocus: req.preserveFocus } : {}),
          ...(req.preview !== undefined ? { preview: req.preview } : {}),
        });
      } catch (err) {
        // No DiffView reaches the caller, so nothing else would ever release this text.
        release();
        throw err;
      }
      return {
        close: async () => {
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === right.toString()) {
                await vscode.window.tabGroups.close(tab);
                break;
              }
            }
          }
          release();
        },
      };
    },

    showMarkdownPreview: async (path) => {
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path));
    },

    getActiveContext: () => editorContext(vscode.window.activeTextEditor),

    onDidChangeActiveContext: (listener): Disposable => {
      const subscriptions = [
        vscode.window.onDidChangeActiveTextEditor((editor) => listener(editorContext(editor))),
        vscode.window.onDidChangeTextEditorSelection((event) => listener(editorContext(event.textEditor))),
      ];
      return { dispose: () => subscriptions.forEach((d) => d.dispose()) };
    },

    openHostSettings: async (query) => {
      await vscode.commands.executeCommand('workbench.action.openSettings', query);
    },

    // VS Code keeps its own settings, not the .damocles files (settingsSources is false).
    openSettingsFile: () => Promise.reject(new Error('VS Code has no Damocles settings files to edit')),

    isHostExtensionActive: (id) => vscode.extensions.getExtension(id)?.isActive ?? false,

    searchHostExtensions: async (query) => {
      await vscode.commands.executeCommand('workbench.extensions.search', query);
    },
  };
}
