import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { DiffRequest, DiffView, EditorService } from '../../../platform/editor-service';
import type { WindowService } from '../../../platform/window-service';
import type { ChatReviewScope, ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { EditorPane } from '../editor-pane';
import { knownLanguageId, readFileText, sideDocument } from './editor-document';
import type { LocalizedText } from '../../../shared/localized-text';

export interface ChatTabMessenger {
  // Posts to the requesting chat (or the fallback chat, opened when none is) without revealing it, and resolves the core panel
  // id it went to: an agent sends these, so the selection and keyboard focus stay the user's.
  deliver(panelId: string | undefined, message: ExtensionToWebviewMessage): Promise<string>;
  // Posts only to that chat, and only while it is loaded; never reveals or opens a chat.
  post(panelId: string, message: ExtensionToWebviewMessage): void;
}

/** A diff main shows: closed settles once it is gone, its tab closed by the user or by close(). */
export interface HostDiffView extends DiffView {
  readonly closed: Promise<void>;
}

export interface DesktopEditorService extends EditorService {
  showDiff(req: DiffRequest): Promise<HostDiffView>;
  // the project key of the document getActiveContext describes, read in the same turn as it; undefined outside every project
  activeProjectKey(): string | undefined;
}

/**
 * D15: an approval diff (showDiff with approvalId) goes to the asking chat's Monaco overlay, held there until the permission
 * card's Open diff; every other open goes to the editor pane, taking focus only when the caller did not set preserveFocus.
 * The renderer never reads a file: main builds every document.
 */
export function createDesktopEditorService(
  tabs: ChatTabMessenger,
  pane: () => EditorPane,
  openAppSettings: WindowService['openAppSettings'],
  showChatReview: (panelId: string, scope: ChatReviewScope) => Promise<void>,
  render: (text: LocalizedText) => string,
): DesktopEditorService {
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
    showDiff: async (req): Promise<HostDiffView> => {
      if (req.approvalId === undefined) {
        const view = await pane().showDiff((fileName) => render(req.title(fileName)), req.filePath, req.left, req.right, { focus: req.preserveFocus !== true });
        return { close: () => Promise.resolve(view.close()), closed: view.closed };
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
      // The chat's overlay deciding nothing, an approval diff goes only when core closes it.
      let settle!: () => void;
      const closed = new Promise<void>((resolve) => (settle = resolve));
      let closing = false;
      return {
        close: async () => {
          if (closing) return;
          closing = true;
          tabs.post(panelId, { type: 'editorCloseView', viewId });
          settle();
        },
        closed,
      };
    },
    // A rendered preview tab in the pane, never the OS, so a model-named file is not launched.
    showMarkdownPreview: (filePath) => pane().openPath(filePath, { focus: true, preview: true }),
    getActiveContext: () => pane().activeContext(),
    activeProjectKey: () => pane().activeProjectKey(),
    onDidChangeActiveContext: (listener): Disposable => pane().onDidChangeActiveContext(listener),
    // The app settings open at the section; their search box is the user's, so the query (a setting key) is not forwarded.
    openHostSettings: (_query, section) => {
      openAppSettings(section);
      return Promise.resolve();
    },
    openSettingsFile: (scope, opts) => pane().openSettingsFile(scope, opts?.key),
    showChatReview,
    isHostExtensionActive: () => false,
    searchHostExtensions: () => unavailable('Extension search'),
  };
}
