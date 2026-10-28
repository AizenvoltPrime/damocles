import { randomUUID } from 'node:crypto';
import { partialStreamKey } from '../../../core/chat-panel/partial-stream';
import { log } from '../../../core/logger';
import type { Disposable } from '../../../platform/disposable';
import type { PanelHost, PanelOptions } from '../../../platform/window-service';
import { APP_ORIGIN, appResourceUri, CHAT_WORKER_SRC } from '../../app-urls';
import { currentActor, type CoreEndpoint, type MirrorTopics, type PanelCreate } from '../../core-protocol';
import { createForeignViews } from './foreign-views';
import { Listeners } from './listeners';

interface PanelProxy {
  readonly host: PanelHost;
  viewState(patch: MirrorTopics['panel']): void;
  message(message: unknown, viewKey: string | undefined): void;
  viewDetached(viewKey: string): void;
  disposed(error: string | undefined): void;
}

export interface CorePanels extends Disposable {
  create(options: PanelOptions): PanelHost;
  // a proxy for a chat view main created, by its view id; main forwards its messages once it asked core to attach
  attach(viewId: string): PanelHost;
  // the proxy for a view id while its panel is open, and back
  get(viewId: string): PanelHost | undefined;
  idOf(host: PanelHost): string | undefined;
  // a remote chat's view on this computer's core, whose voice service posts to it (foreign-views.ts)
  attachForeign(authority: string, viewId: string): PanelHost;
  detachForeign(viewId: string): void;
  foreign(viewId: string): PanelHost | undefined;
}

export interface CorePanelsDeps {
  readonly endpoint: CoreEndpoint;
  readonly resourceRoot: string;
}

const isBinary = (value: unknown): boolean => value instanceof ArrayBuffer || ArrayBuffer.isView(value);

// posted JSON characters after which a panel asks its host whether the queue toward its page is back within its flow window
export const PACE_CHARS: number = 1024 * 1024;

/**
 * Every panel core holds is a proxy named by its view's id: one core creates gets a core-issued id at once and main creates
 * the view when the create envelope arrives; one main created is attached by the id main gave it. View state and
 * the page's messages come back from main; every call goes out as a panel envelope.
 */
export function createCorePanels(deps: CorePanelsDeps): CorePanels {
  const { endpoint, resourceRoot } = deps;
  const proxies = new Map<string, PanelProxy>();
  const ids = new WeakMap<PanelHost, string>();
  const foreignViews = createForeignViews(endpoint);

  const proxy = (panelId: string, kind: PanelOptions['kind']): PanelProxy => {
    let state: MirrorTopics['panel'] = { panelId, visible: false, active: false };
    let closed = false;
    const messages = new Listeners<[unknown, string | undefined]>('panel message');
    const disposes = new Listeners<[]>('panel dispose');
    const viewStates = new Listeners<[]>('panel view state');
    const post: CoreEndpoint['postPanel'] = (id, op, payload) => {
      if (!closed) endpoint.postPanel(id, op, payload);
    };
    // One poster per audience: the whole panel, or one view of it (a daemon's client); each is paced by its own views.drained.
    const poster = (viewKey: string | undefined): { send(message: unknown, except?: readonly string[]): void; drained(): Promise<void> } => {
      // characters posted since the last views.drained, and that request while it is out
      let unpaced = 0;
      let pacing: Promise<void> | undefined;
      // partials that arrived while a request was out, in order of their latest arrival
      const heldPartials = new Map<string, { readonly message: unknown; readonly except: readonly string[] | undefined }>();
      const flushHeld = (): void => {
        const held = [...heldPartials.values()];
        heldPartials.clear();
        for (const entry of held) postNow(entry.message, entry.except);
      };
      const postNow = (message: unknown, except: readonly string[] | undefined): void => {
        const audience = { ...(viewKey !== undefined ? { viewKey } : {}), ...(except !== undefined && except.length > 0 ? { except } : {}) };
        // Binary travels only as a top-level field (a browser page's frame); JSON text would turn it into {}.
        const fields = typeof message === 'object' && message !== null ? Object.values(message) : [];
        if (fields.some(isBinary)) {
          post(panelId, 'postBinary', { message, ...audience });
          return;
        }
        const json = JSON.stringify(message);
        post(panelId, 'post', { type: String((message as { type?: unknown } | null)?.type ?? ''), json, ...audience });
        unpaced += json.length;
        if (unpaced < PACE_CHARS || pacing || closed) return;
        unpaced = 0;
        // a failed ask ends the pause as an answer does, so a replay awaiting drained() goes on
        pacing = endpoint.request('views.drained', { viewId: panelId, ...(viewKey !== undefined ? { viewKey } : {}) })
          .catch((err: unknown) => log(`[core-host] pacing view ${panelId} failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            pacing = undefined;
            flushHeld();
          });
      };
      return {
        send: (message, except) => {
          const key = pacing ? partialStreamKey(message) : undefined;
          if (key !== undefined) {
            heldPartials.delete(key);
            heldPartials.set(key, { message, except });
            return;
          }
          flushHeld();
          postNow(message, except);
        },
        drained: () => pacing ?? Promise.resolve(),
      };
    };
    const everyView = poster(undefined);
    const viewHosts = new Map<string, PanelHost>();
    // each view key core heard from, with the client it came from (the actor of its first message or join)
    const viewClients = new Map<string, string | undefined>();
    const heardFrom = (viewKey: string): void => {
      if (!viewClients.has(viewKey)) viewClients.set(viewKey, currentActor());
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
      // main builds every page with its own theme (showPage)
      themeCssSource: () => '',
      setHtml: () => {
        throw new Error('Desktop pages are built by main: use showPage');
      },
      showPage: (page) => post(panelId, 'showPage', { page }),
      postMessage: (message) => {
        if (closed) return Promise.resolve(false);
        everyView.send(message);
        return Promise.resolve(true);
      },
      postMessageExcept: (message, viewKeys) => {
        if (closed) return Promise.resolve(false);
        everyView.send(message, viewKeys);
        return Promise.resolve(true);
      },
      drained: () => everyView.drained(),
      views: () => [...viewClients].map(([viewKey, clientId]) => ({ viewKey, ...(clientId !== undefined ? { clientId } : {}) })),
      viewHost: (viewKey) => {
        heardFrom(viewKey);
        let view = viewHosts.get(viewKey);
        if (!view) {
          const toView = poster(viewKey);
          // the panel host's members, its getters read live, with posts to this view alone
          view = Object.assign(Object.create(host) as PanelHost, {
            panelHost: host,
            postMessage: (message: unknown) => {
              if (closed) return Promise.resolve(false);
              toView.send(message);
              return Promise.resolve(true);
            },
            drained: () => toView.drained(),
          });
          Object.defineProperty(view, 'clientId', { get: () => viewClients.get(viewKey), enumerable: true });
          viewHosts.set(viewKey, view);
        }
        return view;
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
      message: (message, viewKey) => {
        if (viewKey !== undefined) heardFrom(viewKey);
        messages.fire(message, viewKey);
      },
      viewDetached: (viewKey) => {
        viewClients.delete(viewKey);
        viewHosts.delete(viewKey);
      },
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
      if (envelope.op === 'message') panel.message(envelope.payload.message, envelope.payload.viewKey);
      else if (envelope.op === 'viewDetached') panel.viewDetached(envelope.payload.viewKey);
      else panel.disposed(envelope.payload.error);
    }),
    endpoint.onMirror('panel', (patch) => proxies.get(patch.panelId)?.viewState(patch)),
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
    attachForeign: (authority, viewId) => foreignViews.attach(authority, viewId),
    detachForeign: (viewId) => foreignViews.detach(viewId),
    foreign: (viewId) => foreignViews.get(viewId),
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      foreignViews.dispose();
    },
  };
}
