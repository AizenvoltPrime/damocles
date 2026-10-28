// A target out of inotify watches: docs/invariants.md "Remote daemon and wire", a watcher that runs out of watches.
import type { Disposable } from '../../../platform/disposable';
import type { Endpoint } from '../../core-protocol/endpoint';
import type { HostNotice } from '../../preload/overlay-channels';
import { pathFor } from '../../../shared/project-location';
import type { ClientToWorkspace, WorkspaceToClient } from '../../workspace/messages';

// VS Code's documented value, and the probe's threshold (stage1-posix.sh SUGGESTED_WATCHES)
export const SUGGESTED_WATCHES = 524288;
export const WATCH_LIMIT_COMMAND: string = `sudo sysctl fs.inotify.max_user_watches=${SUGGESTED_WATCHES}`;
// the daemon reports its watcher's limit (files.watchLimit, files.watchLimits)
export const WATCH_LIMIT_FEATURE = 'files.watchLimit';

export interface WatchLimitConnection {
  readonly features: readonly string[];
  readonly workspace: Pick<Endpoint<ClientToWorkspace, WorkspaceToClient>, 'request' | 'onEvent'>;
}

export interface WatchLimitDeps {
  // this computer's projects on the authority, their folders native to the host
  readonly projects: (authorityKey: string) => ReadonlyArray<{ readonly name: string; readonly fsPath: string; readonly os: NodeJS.Platform }>;
  readonly notify: (authorityKey: string, project: string) => void;
  // the host card's notices changed
  readonly changed: (authorityKey: string) => void;
  readonly log: (line: string) => void;
}

export interface WatchLimits {
  // hears the connection's reports, its earlier ones first, until disposed
  watch(authorityKey: string, connection: WatchLimitConnection): Disposable;
  // the host card's notice while connection is the one whose watcher ran out
  notice(authorityKey: string, connection: object | undefined): HostNotice | undefined;
}

export function createWatchLimits(deps: WatchLimitDeps): WatchLimits {
  const reached = new Map<string, { readonly connection: object; readonly notice: HostNotice }>();

  // The project whose folder holds root; another device's project on the host is not this computer's to name.
  const projectAt = (authorityKey: string, root: string): string | undefined => deps.projects(authorityKey).find((project) => {
    const flavor = pathFor(project);
    const relative = flavor.relative(project.fsPath, root);
    return relative !== '..' && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative);
  })?.name;

  const report = (authorityKey: string, connection: object, root: string, limit: number | null): void => {
    const project = projectAt(authorityKey, root);
    deps.log(`[remote] ${authorityKey}: ${root} ran out of inotify watches (limit ${limit ?? 'unknown'})${project === undefined ? ', outside this computer\'s projects' : ''}`);
    if (project === undefined || reached.get(authorityKey)?.connection === connection) return;
    const params = { project, suggested: SUGGESTED_WATCHES, ...(limit !== null ? { limit } : {}) };
    reached.set(authorityKey, { connection, notice: { code: 'watchLimit', params } });
    deps.notify(authorityKey, project);
    deps.changed(authorityKey);
  };

  return {
    watch(authorityKey, connection) {
      if (!connection.features.includes(WATCH_LIMIT_FEATURE)) return { dispose: () => undefined };
      let live = true;
      const subscription = connection.workspace.onEvent('files.watchLimit', ({ root, limit }) => report(authorityKey, connection, root, limit));
      connection.workspace.request('files.watchLimits', {}).then(({ roots, limit }) => {
        if (live) for (const root of roots) report(authorityKey, connection, root, limit);
      }, (err: unknown) => deps.log(`[remote] ${authorityKey}: reading the watcher's inotify limits failed: ${err instanceof Error ? err.message : String(err)}`));
      return {
        dispose: () => {
          live = false;
          subscription.dispose();
        },
      };
    },
    notice(authorityKey, connection) {
      const entry = reached.get(authorityKey);
      return entry && connection !== undefined && entry.connection === connection ? entry.notice : undefined;
    },
  };
}
