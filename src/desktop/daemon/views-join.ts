// views.join on the daemon: a client's view key is the page's panel token, which the
// daemon learns from the `ready` messages it forwards. It only maps the key to core's panel and forwards the request; core
// runs the join. One view per panel: a panel another client views is not joined.
import type { MainEndpoint } from '../core-protocol';

export interface ViewKeys {
  // a `ready` the daemon forwarded: the page of core view viewId holds token
  record(viewId: string, token: string): void;
  viewOf(token: string): string | undefined;
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
    forget: (viewId) => {
      for (const [token, view] of views) if (view === viewId) views.delete(token);
    },
  };
}

export interface ViewsJoinDeps {
  readonly keys: ViewKeys;
  readonly core: Pick<MainEndpoint, 'request'>;
  // whether a client views core view viewId now
  readonly viewed: (viewId: string) => boolean;
  // the joining client's view id now names core view viewId; unbind undoes it
  readonly bind: (clientViewId: string, viewId: string) => void;
  readonly unbind: (clientViewId: string) => void;
  readonly log: (line: string) => void;
}

/** Answers core's panel id for the joined view, or null when no panel of this core holds the key or another client views it. */
export async function joinView(deps: ViewsJoinDeps, request: { readonly viewId: string; readonly viewKey: string }, signal: AbortSignal): Promise<{ readonly panelId: string } | null> {
  const viewId = deps.keys.viewOf(request.viewKey);
  if (viewId === undefined || deps.viewed(viewId)) return null;
  deps.bind(request.viewId, viewId);
  let joined: { readonly panelId: string } | null;
  try {
    joined = await deps.core.request('views.join', { viewId, viewKey: request.viewKey }, signal);
  } catch (err) {
    deps.unbind(request.viewId);
    throw err;
  }
  if (joined === null) {
    deps.unbind(request.viewId);
    deps.log(`[core-host] core holds no panel for the view key of ${viewId}`);
  }
  return joined;
}
