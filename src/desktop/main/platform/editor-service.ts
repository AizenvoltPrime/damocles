import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { DiffView, EditorService } from '../../../platform/editor-service';
import type { ShellService } from '../../../platform/shell-service';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { fileDocument, knownLanguageId, memoryDocument, readFileText, sideDocument } from './editor-document';

export interface ChatTabMessenger {
  // Posts to the requesting chat tab (or the fallback tab, opened when none is), reveals it, and resolves the core panel id it went to.
  show(panelId: string | undefined, message: ExtensionToWebviewMessage): Promise<string>;
  // Posts only to that chat tab, and only while it is open; never reveals or opens a tab.
  post(panelId: string, message: ExtensionToWebviewMessage): void;
}

// Editors render as read-only overlays in a chat tab's webview; the host builds every document, so the renderer never reads a file.
export function createDesktopEditorService(shell: ShellService, tabs: ChatTabMessenger): EditorService {
  const unavailable = (feature: string): Promise<never> => Promise.reject(new Error(`${feature} is not available in the desktop app yet`));
  return {
    openFile: async (filePath, opts) => {
      const line = opts?.line !== undefined && Number.isInteger(opts.line) && opts.line > 0 ? opts.line : undefined;
      const document = await fileDocument(filePath);
      await tabs.show(opts?.panelId, { type: 'editorOpenFile', viewId: randomUUID(), title: path.basename(filePath), document, ...(line !== undefined ? { line } : {}) });
    },
    openUntitled: async (content, language, opts) => {
      const languageId = knownLanguageId(language);
      const name = `untitled.${language}`;
      await tabs.show(opts?.panelId, { type: 'editorOpenFile', viewId: randomUUID(), title: name, document: memoryDocument(name, content, languageId), untitled: true });
    },
    // The desktop app keeps no unsaved editor text, so the file on disk is what the editor holds.
    readText: (filePath) => readFileText(filePath),
    showDiff: async (req): Promise<DiffView> => {
      const [original, modified] = await Promise.all([sideDocument(req.left), sideDocument(req.right)]);
      const viewId = randomUUID();
      const panelId = await tabs.show(req.panelId, {
        type: 'editorShowDiff',
        viewId,
        title: req.title,
        purpose: req.purpose,
        ...(req.purpose === 'proposal' && req.approvalId !== undefined ? { approvalId: req.approvalId } : {}),
        original,
        modified,
      });
      let closed = false;
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          tabs.post(panelId, { type: 'editorCloseView', viewId });
        },
      };
    },
    // markdownPreview is off on desktop, so no webview control requests this; revealing keeps a model-named file from being launched.
    showMarkdownPreview: (filePath) => shell.revealPath(filePath),
    getActiveContext: () => undefined,
    onDidChangeActiveContext: (): Disposable => ({ dispose: () => undefined }),
    // The in-app settings panel has no search box, so the query (a setting key) is not forwarded.
    openHostSettings: async () => {
      await tabs.show(undefined, { type: 'openSettingsPanel' });
    },
    isHostExtensionActive: () => false,
    searchHostExtensions: () => unavailable('Extension search'),
  };
}
