import type { Disposable } from '../../../platform/disposable';
import type { ActiveEditorContext, EditorService } from '../../../platform/editor-service';
import type { ClientSnapshots } from '../../../platform/remote-host';
import { DIFF_TITLE_NAME, type CoreEndpoint, type CoreInit } from '../../core-protocol';
import { Listeners } from './listeners';

// Proxied, but for the active editor context, which main mirrors so a read stays synchronous. clients: a daemon's core, which
// reads each device's context from its clientEditor mirror.
export function createEditorProxy(endpoint: CoreEndpoint, init: CoreInit, clients: ClientSnapshots | undefined): EditorService & Disposable {
  let context: ActiveEditorContext | undefined = init.mirrors.editor.context;
  const changed = new Listeners<[ActiveEditorContext | undefined, string?]>('active editor');
  const detached = new Listeners<[string]>('client editor detach');
  const subscription = clients
    ? clients.onDidChange(({ topic, clientId, detached: gone }) => {
      if (topic !== 'clientEditor' || clientId === undefined) return;
      if (gone) detached.fire(clientId);
      else changed.fire(clients.editor(clientId), clientId);
    })
    : endpoint.onMirror('editor', (patch) => {
      context = patch.context;
      changed.fire(context);
    });
  return {
    openFile: (path, options) => endpoint.request('editor.openFile', { path, ...(options ? { options } : {}) }),
    openUntitled: (content, language, opts) => endpoint.request('editor.openUntitled', { content, language, ...(opts?.panelId !== undefined ? { panelId: opts.panelId } : {}) }),
    readText: (path) => endpoint.request('editor.readText', { path }),
    showDiff: async ({ title, ...req }) => {
      // the title is a function of the file's current name, so main gets it as a template it fills in
      const { viewId } = await endpoint.request('editor.showDiff', { ...req, titleTemplate: title(DIFF_TITLE_NAME) });
      return { close: () => endpoint.request('editor.closeDiff', { viewId }) };
    },
    showMarkdownPreview: (path, opts) => endpoint.request('editor.showMarkdownPreview', { path, ...(opts?.panelId !== undefined ? { panelId: opts.panelId } : {}), ...(opts?.content !== undefined ? { content: opts.content } : {}) }),
    getActiveContext: (clientId) => (clients ? (clientId === undefined ? undefined : clients.editor(clientId)) : context),
    onDidChangeActiveContext: (listener) => changed.add(listener),
    onDidDetachClient: (listener) => detached.add(listener),
    openHostSettings: (query, section) => endpoint.request('editor.openHostSettings', { ...(query !== undefined ? { query } : {}), ...(section !== undefined ? { section } : {}) }),
    openSettingsFile: (scope, opts) => endpoint.request('editor.openSettingsFile', { scope, ...(opts?.key !== undefined ? { key: opts.key } : {}) }),
    showChatReview: (panelId, scope) => endpoint.request('editor.showChatReview', { panelId, scope }),
    // desktop runs no host extensions
    isHostExtensionActive: () => false,
    searchHostExtensions: (query) => endpoint.request('editor.searchHostExtensions', { query }),
    dispose: () => {
      subscription.dispose();
      changed.clear();
      detached.clear();
    },
  };
}
