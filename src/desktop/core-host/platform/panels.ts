import { randomUUID } from 'node:crypto';
import { log } from '../../../core/logger';
import type { Disposable } from '../../../platform/disposable';
import type { PanelHost, PanelOptions } from '../../../platform/window-service';
import { APP_ORIGIN, appResourceUri, CHAT_WORKER_SRC } from '../../app-urls';
import type { CoreEndpoint, CoreInit, MirrorTopics, PanelCreate } from '../../core-protocol';
import { Listeners } from './listeners';

interface PanelProxy {
  readonly host: PanelHost;
  viewState(patch: MirrorTopics['panel']): void;
  message(message: unknown): void;
  disposed(error: string | undefined): void;
}

export interface CorePanels extends Disposable {
  create(options: PanelOptions): PanelHost;
  // a proxy for a chat view main created, by its view id; main forwards its messages once it asked core to attach
  attach(viewId: string): PanelHost;
  // the proxy for a view id while its panel is open, and back
  get(viewId: string): PanelHost | undefined;
  idOf(host: PanelHost): string | undefined;
}

export interface CorePanelsDeps {
  readonly endpoint: CoreEndpoint;
  readonly init: CoreInit;
  readonly resourceRoot: string;
}

const isBinary = (value: unknown): boolean => value instanceof ArrayBuffer || ArrayBuffer.isView(value);

/**
 * Every panel core holds is a proxy named by its view's id: one core creates gets a core-issued id at once and main creates
 * the view when the create envelope arrives; one main created is attached by the id main gave it. View state, the theme and
 * the page's messages come back from main; every call goes out as a panel envelope.
 */
export function createCorePanels(deps: CorePanelsDeps): CorePanels {
  const { endpoint, resourceRoot } = deps;
  const proxies = new Map<string, PanelProxy>();
  const ids = new WeakMap<PanelHost, string>();
  let themeCss = deps.init.mirrors.theme.css;

  const proxy = (panelId: string, kind: PanelOptions['kind']): PanelProxy => {
    let state: MirrorTopics['panel'] = { panelId, visible: false, active: false };
    let closed = false;
    const messages = new Listeners<[unknown]>('panel message');
    const disposes = new Listeners<[]>('panel dispose');
    const viewStates = new Listeners<[]>('panel view state');
    const post: CoreEndpoint['postPanel'] = (id, op, payload) => {
      if (!closed) endpoint.postPanel(id, op, payload);
    };
    const dispose = (error: string | undefined): void => {
      if (closed) return;
      closed = true;
      if (error !== undefined) log(`[core-host] main could not create the ${kind} view ${panelId}: ${error}`);
      proxies.delete(panelId);
      disposes.fire();
      messages.clear();
      disposes.clear();
      viewStates.clear();
    };
    const host: PanelHost = {
      get visible() {
        return !closed && state.visible;
      },
      get active() {
        return !closed && state.active;
      },
      // a hidden desktop view keeps its page running
      retainsContextWhenHidden: true,
      get column() {
        return state.column;
      },
      cspSource: APP_ORIGIN,
      ...(kind === 'chat' ? { workerSrc: CHAT_WORKER_SRC } : {}),
      themeCssSource: () => themeCss,
      setHtml: (html) => post(panelId, 'setHtml', { html }),
      postMessage: (message) => {
        if (closed) return Promise.resolve(false);
        // Binary travels only as a top-level field (a browser page's frame); JSON text would turn it into {}.
        const fields = typeof message === 'object' && message !== null ? Object.values(message) : [];
        if (fields.some(isBinary)) post(panelId, 'postBinary', { message });
        else post(panelId, 'post', { type: String((message as { type?: unknown } | null)?.type ?? ''), json: JSON.stringify(message) });
        return Promise.resolve(true);
      },
      onMessage: (listener) => messages.add(listener),
      onDispose: (listener) => (closed ? { dispose: () => undefined } : disposes.add(listener)),
      onDidChangeViewState: (listener) => viewStates.add(listener),
      asResourceUri: (absolutePath) => appResourceUri(resourceRoot, absolutePath),
      setIcon: (iconPath) => post(panelId, 'setIcon', iconPath !== undefined ? { path: iconPath } : {}),
      setTitle: (title) => post(panelId, 'setTitle', { title }),
      setFolderLabel: (label) => post(panelId, 'setFolderLabel', label !== undefined ? { label } : {}),
      reveal: (column) => post(panelId, 'reveal', column !== undefined ? { column } : {}),
      close: () => {
        post(panelId, 'close', {});
        dispose(undefined);
      },
    };
    ids.set(host, panelId);
    const entry: PanelProxy = {
      host,
      viewState: (patch) => {
        state = patch;
        viewStates.fire();
      },
      message: (message) => messages.fire(message),
      disposed: dispose,
    };
    proxies.set(panelId, entry);
    return entry;
  };

  const ownerOf = (owner: PanelHost): string => {
    const viewId = ids.get(owner);
    if (viewId === undefined) throw new Error('A browser page opens only in a loaded chat');
    return viewId;
  };

  const subscriptions = [
    endpoint.onPanel((panelId, envelope) => {
      // an envelope for a panel core already closed crossed its close
      const panel = proxies.get(panelId);
      if (!panel) return;
      if (envelope.op === 'message') panel.message(envelope.payload.message);
      else panel.disposed(envelope.payload.error);
    }),
    endpoint.onMirror('panel', (patch) => proxies.get(patch.panelId)?.viewState(patch)),
    endpoint.onMirror('theme', (patch) => {
      themeCss = patch.css;
    }),
  ];

  return {
    create: (options) => {
      const create: PanelCreate = {
        kind: options.kind,
        title: options.title,
        localResourceRoots: options.localResourceRoots,
        ...(options.column !== undefined ? { column: options.column } : {}),
        ...(options.owner !== undefined ? { owner: ownerOf(options.owner) } : {}),
      };
      const panel = proxy(randomUUID(), options.kind);
      const panelId = ids.get(panel.host)!;
      try {
        endpoint.postPanel(panelId, 'create', create);
      } catch (err) {
        panel.disposed(undefined);
        throw err;
      }
      // main answers on a later turn: a view it could not create disposes the host, which its owner sees as a close
      return panel.host;
    },
    // a view this core attached to earlier and has not closed keeps its proxy
    attach: (viewId) => proxies.get(viewId)?.host ?? proxy(viewId, 'chat').host,
    get: (viewId) => proxies.get(viewId)?.host,
    idOf: (host) => ids.get(host),
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
