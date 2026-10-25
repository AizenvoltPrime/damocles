// The panel rule: a view detaching (a quit, a disconnect, a closed window) never disposes
// a panel with a running turn, a pending prompt or background agents; a panel with none of those and no view is disposed,
// and restored from its session file when a view opens it again; a user's close disposes at once. Runs come only from the
// run registry.
import type { Disposable } from '../../platform/disposable';
import type { RunRegistry } from './run-registry';

export interface PanelRetentionDeps {
  readonly registry: Pick<RunRegistry, 'hasPanelRun' | 'onChange'>;
  // core's PanelManager id of a core view, from the chats mirror
  readonly panelIdOf: (viewId: string) => string | undefined;
  // whether a client views it now
  readonly viewed: (viewId: string) => boolean;
  // sends core `disposed` for the view
  readonly dispose: (viewId: string, reason: 'user' | 'detach') => void;
  readonly log: (line: string) => void;
}

export interface PanelRetention extends Disposable {
  // the view's client let go of it; the caller has already dropped the view
  disposed(viewId: string, reason: 'user' | 'detach'): void;
  // chats.unload: false while a run keeps the panel, which core is then not asked
  mayUnload(viewId: string): boolean;
}

export function createPanelRetention(deps: PanelRetentionDeps): PanelRetention {
  const kept = new Set<string>();
  const running = (viewId: string): boolean => {
    const panelId = deps.panelIdOf(viewId);
    return panelId !== undefined && deps.registry.hasPanelRun(panelId);
  };
  const subscription = deps.registry.onChange(() => {
    for (const viewId of [...kept]) {
      if (deps.viewed(viewId)) {
        kept.delete(viewId);
        continue;
      }
      if (running(viewId)) continue;
      kept.delete(viewId);
      deps.log(`[core-host] disposing panel ${viewId}: its run ended with no view`);
      deps.dispose(viewId, 'detach');
    }
  });
  return {
    disposed: (viewId, reason) => {
      if (reason === 'detach' && running(viewId)) {
        kept.add(viewId);
        deps.log(`[core-host] keeping panel ${viewId} with no view: it has a run`);
        return;
      }
      kept.delete(viewId);
      deps.dispose(viewId, reason);
    },
    mayUnload: (viewId) => !running(viewId),
    dispose: () => subscription.dispose(),
  };
}
