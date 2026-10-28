// views.join on the daemon: a panel is named by its page's panel token, which the daemon learns from the first `ready` it
// forwards for the panel, or, for another device's view, by the stored session it holds. The daemon maps the name to core's
// panel, binds the joining view under a key of its own and forwards the request; core runs the join and replays the
// conversation to that view alone. Any number of clients' views may show one panel.
import type { MainEndpoint } from '../core-protocol';

export interface ViewKeys {
  // a `ready` the daemon forwarded: the page of core view viewId holds token
  record(viewId: string, token: string): void;
  viewOf(token: string): string | undefined;
  tokenOf(viewId: string): string | undefined;
  forget(viewId: string): void;
}

export function createViewKeys(): ViewKeys {
  const views = new Map<string, string>();
  return {
    record: (viewId, token) => {
      for (const [known, view] of views) if (view === viewId) views.delete(known);
      views.set(token, viewId);
    },
    viewOf: (token) => views.get(token),
    tokenOf: (viewId) => [...views].find(([, view]) => view === viewId)?.[0],
    forget: (viewId) => {
      for (const [token, view] of views) if (view === viewId) views.delete(token);
    },
  };
}

export interface ViewsJoinDeps {
  readonly keys: ViewKeys;
  readonly core: Pick<MainEndpoint, 'request'>;
  // the core view whose panel holds the stored session (the chats mirror)
  readonly viewOfSession: (sessionId: string) => string | undefined;
  // the joining client's view id now names core view viewId, answering the daemon's key of that view and whether this call
  // made the binding (a rejoin finds its own); unbind undoes it
  readonly bind: (clientViewId: string, viewId: string) => { readonly viewKey: string; readonly created: boolean };
  readonly unbind: (clientViewId: string) => void;
  readonly log: (line: string) => void;
}

/** Answers core's panel id for the joined view, or null when no panel of this core is named by the key or the session. */
export async function joinView(deps: ViewsJoinDeps, request: { readonly viewId: string; readonly viewKey: string; readonly sessionId?: string }, signal: AbortSignal): Promise<{ readonly panelId: string } | null> {
  const viewId = deps.keys.viewOf(request.viewKey) ?? (request.sessionId === undefined ? undefined : deps.viewOfSession(request.sessionId));
  const token = viewId === undefined ? undefined : deps.keys.tokenOf(viewId);
  if (viewId === undefined || token === undefined) return null;
  const joining = deps.bind(request.viewId, viewId);
  // a binding the client already had stays: it still shows the panel
  const undo = (): void => {
    if (joining.created) deps.unbind(request.viewId);
  };
  let joined: { readonly panelId: string } | null;
  try {
    joined = await deps.core.request('views.join', { viewId, viewKey: token, joining: joining.viewKey }, signal);
  } catch (err) {
    undo();
    throw err;
  }
  if (joined === null) {
    undo();
    deps.log(`[core-host] core holds no panel for the view key of ${viewId}`);
  }
  return joined;
}
