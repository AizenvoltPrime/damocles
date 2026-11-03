import type { Disposable } from '../../../platform/disposable';
import type { PanelHost } from '../../../platform/window-service';
import { APP_ORIGIN } from '../../app-urls';
import type { CoreEndpoint } from '../../core-protocol';
import { Listeners } from './listeners';

/**
 * Proxies on this computer's core for remote chats' views: the voice service records, transcribes and speaks here, and the
 * view's user-setting writes land here; both post to such a proxy, whose posts main delivers to that remote view after its
 * own checks; the browser opens the chat's pages in its authority's context with the proxy as their owner, so they show as
 * tabs of the remote chat and close with it. A proxy has no page, no session and no panel of this core.
 */
export interface ForeignViews extends Disposable {
  // idempotent for a view of the same authority; a view id another authority holds is refused
  attach(authority: string, viewId: string): PanelHost;
  detach(viewId: string): void;
  get(viewId: string): PanelHost | undefined;
  // the view id and authority of a proxy this holds
  viewIdOf(host: PanelHost): string | undefined;
  authorityOf(viewId: string): string | undefined;
}

const isBinary = (value: unknown): boolean => value instanceof ArrayBuffer || ArrayBuffer.isView(value);

export function createForeignViews(endpoint: CoreEndpoint): ForeignViews {
  const views = new Map<string, { readonly authority: string; readonly host: PanelHost; readonly close: () => void }>();

  const proxy = (viewId: string): { readonly host: PanelHost; readonly close: () => void } => {
    let closed = false;
    const disposes = new Listeners<[]>('foreign view dispose');
    const close = (): void => {
      if (closed) return;
      closed = true;
      views.delete(viewId);
      disposes.fire();
      disposes.clear();
    };
    const host: PanelHost = {
      get visible() {
        return !closed;
      },
      active: false,
      retainsContextWhenHidden: true,
      column: undefined,
      cspSource: APP_ORIGIN,
      themeCssSource: () => '',
      setHtml: () => {
        throw new Error('A remote chat view shows no page of this core');
      },
      postMessage: (message) => {
        if (closed) return Promise.resolve(false);
        // a post crosses as JSON-shaped data; the voice service sends audio as base64 text
        if (typeof message === 'object' && message !== null && Object.values(message).some(isBinary)) throw new Error('A remote chat view takes no binary post');
        endpoint.emit('panel.foreignPost', { viewId, message });
        return Promise.resolve(true);
      },
      onMessage: () => ({ dispose: () => undefined }),
      onDispose: (listener) => (closed ? { dispose: () => undefined } : disposes.add(listener)),
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      asResourceUri: () => {
        throw new Error('A remote chat view loads no resource of this computer');
      },
      setIcon: () => undefined,
      setTitle: () => undefined,
      setFolderLabel: () => undefined,
      reveal: () => undefined,
      close,
    };
    return { host, close };
  };

  return {
    attach: (authority, viewId) => {
      const known = views.get(viewId);
      if (known) {
        if (known.authority !== authority) throw new Error(`View ${viewId} is a view of another host`);
        return known.host;
      }
      const made = proxy(viewId);
      views.set(viewId, { authority, ...made });
      return made.host;
    },
    detach: (viewId) => views.get(viewId)?.close(),
    get: (viewId) => views.get(viewId)?.host,
    viewIdOf: (host) => [...views].find(([, view]) => view.host === host)?.[0],
    authorityOf: (viewId) => views.get(viewId)?.authority,
    dispose: () => {
      for (const view of [...views.values()]) view.close();
    },
  };
}
