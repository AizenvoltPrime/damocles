import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { DiffView, EditorService } from '../../../platform/editor-service';
import type { WindowService } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { fileDocument, knownLanguageId, memoryDocument, readFileText, sideDocument } from './editor-document';

export interface ChatTabMessenger {
  // Posts to the requesting chat (or the fallback chat, opened when none is), reveals it, and resolves the core panel id it went to.
  show(panelId: string | undefined, message: ExtensionToWebviewMessage): Promise<string>;
  // Posts only to that chat, and only while it is loaded; never reveals or opens a chat.
  post(panelId: string, message: ExtensionToWebviewMessage): void;
}

// Editors render as read-only overlays in a chat's webview; the host builds every document, so the renderer never reads a file.
export function createDesktopEditorService(tabs: ChatTabMessenger, openAppSettings: WindowService['openAppSettings']): EditorService {
  const unavailable = (feature: string): Promise<never> => Promise.reject(new Error(`${feature} is not available in the desktop app yet`));
  const openFile: EditorService['openFile'] = async (filePath, opts) => {
    const line = opts?.line !== undefined && Number.isInteger(opts.line) && opts.line > 0 ? opts.line : undefined;
    const document = await fileDocument(filePath);
    await tabs.show(opts?.panelId, { type: 'editorOpenFile', viewId: randomUUID(), title: path.basename(filePath), document, ...(line !== undefined ? { line } : {}) });
  };
  return {
    openFile,
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
    // Opens in the asking chat's read-only editor, never through the OS, so a model-named file is not launched.
    showMarkdownPreview: (filePath, opts) => openFile(filePath, opts?.panelId !== undefined ? { panelId: opts.panelId } : undefined),
    getActiveContext: () => undefined,
    onDidChangeActiveContext: (): Disposable => ({ dispose: () => undefined }),
    // The app settings open at the section; their search box is the user's, so the query (a setting key) is not forwarded.
    openHostSettings: (_query, section) => {
      openAppSettings(section);
      return Promise.resolve();
    },
    isHostExtensionActive: () => false,
    searchHostExtensions: () => unavailable('Extension search'),
  };
}
