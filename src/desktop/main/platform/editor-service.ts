import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { DiffView, EditorService } from '../../../platform/editor-service';
import type { WindowService } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { EditorPane } from '../editor-pane';
import { knownLanguageId, readFileText, sideDocument } from './editor-document';

export interface ChatTabMessenger {
  // Posts to the requesting chat (or the fallback chat, opened when none is) without revealing it, and resolves the core panel
  // id it went to: an agent sends these, so the selection and keyboard focus stay the user's.
  deliver(panelId: string | undefined, message: ExtensionToWebviewMessage): Promise<string>;
  // Posts only to that chat, and only while it is loaded; never reveals or opens a chat.
  post(panelId: string, message: ExtensionToWebviewMessage): void;
}

/**
 * D15: an approval diff (showDiff with approvalId) goes to the asking chat's Monaco overlay, held there until the permission
 * card's Open diff; every other open goes to the editor pane, taking focus only when the caller did not set preserveFocus.
 * The renderer never reads a file: main builds every document.
 */
export function createDesktopEditorService(tabs: ChatTabMessenger, pane: () => EditorPane, openAppSettings: WindowService['openAppSettings']): EditorService {
  const unavailable = (feature: string): Promise<never> => Promise.reject(new Error(`${feature} is not available in the desktop app yet`));
  return {
    openFile: (filePath, opts) => {
      const line = opts?.line !== undefined && Number.isInteger(opts.line) && opts.line > 0 ? opts.line : undefined;
      return pane().openPath(filePath, { focus: opts?.preserveFocus !== true, ...(line !== undefined ? { line } : {}) });
    },
    openUntitled: (content, language) => {
      pane().openUntitled(content, `untitled.${language}`, knownLanguageId(language), { focus: true });
      return Promise.resolve();
    },
    // The disk text: desktop's unsaved buffers are the user's, and the agent's tools read and write the disk.
    readText: (filePath) => readFileText(filePath),
    showDiff: async (req): Promise<DiffView> => {
      if (req.approvalId === undefined) {
        const view = await pane().showDiff(req.title, req.filePath, req.left, req.right, { focus: req.preserveFocus !== true });
        return { close: () => Promise.resolve(view.close()) };
      }
      const [original, modified] = await Promise.all([sideDocument(req.left), sideDocument(req.right)]);
      const viewId = randomUUID();
      const panelId = await tabs.deliver(req.panelId, {
        type: 'editorShowDiff',
        viewId,
        title: req.title(path.basename(req.filePath)),
        purpose: 'proposal',
        approvalId: req.approvalId,
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
    // A rendered preview tab in the pane, never the OS, so a model-named file is not launched.
    showMarkdownPreview: (filePath) => pane().openPath(filePath, { focus: true, preview: true }),
    getActiveContext: () => pane().activeContext(),
    onDidChangeActiveContext: (listener): Disposable => pane().onDidChangeActiveContext(listener),
    // The app settings open at the section; their search box is the user's, so the query (a setting key) is not forwarded.
    openHostSettings: (_query, section) => {
      openAppSettings(section);
      return Promise.resolve();
    },
    openSettingsFile: (scope, opts) => pane().openSettingsFile(scope, opts?.key),
    isHostExtensionActive: () => false,
    searchHostExtensions: () => unavailable('Extension search'),
  };
}
