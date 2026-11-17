// What this computer holds of a remote project that its host's core moved (docs/invariants.md "Project relocation"): the
// remote core never writes here, so main re-keys this computer's copies itself, each step idempotent.
import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { projectKeyOf, type Authority } from '../../../shared/project-location';
import type { ShellPlatform } from '../../preload/shell-channels';
import type { RelocateStateDeps } from '../relocate-project-state';
import type { HostStore } from './host-store';
import type { SessionMirror } from './session-mirror';

export interface RemoteRelocationDeps {
  readonly authority: Authority;
  readonly authorityKey: string;
  // the host store's id, which names its session mirror and its /stats rows; undefined for the loopback daemon, which keeps none
  readonly hostId: string | undefined;
  readonly os: ShellPlatform;
  readonly store: Pick<HostStore, 'replaceProject' | 'relocated'>;
  readonly mirror: (hostId: string) => Pick<SessionMirror, 'relocateProject'>;
  // this computer's core: forge.relocateProject on the remote project keys, and projects.addHostAlias
  readonly relocateBindings: (fromKey: string, toKey: string) => Promise<void>;
  readonly addHostAlias: (alias: { readonly hostId: string; readonly from: string; readonly to: string; readonly startedAt?: number }) => Promise<void>;
}

/** The host part's steps that differ for a remote project: its keys, this computer's copies, and its list entry. */
export function remoteRelocation(deps: RemoteRelocationDeps): Pick<RelocateStateDeps, 'keyOf' | 'applied' | 'applyHostState' | 'relocateList' | 'relocateOrder'> {
  const folderKeyOf = (fsPath: string): string => folderKeyOn(deps.os, fsPath);
  return {
    keyOf: (fsPath) => projectKeyOf(deps.authority, folderKeyOf(fsPath)),
    applied: (id) => deps.store.relocated(deps.authorityKey, id),
    applyHostState: async (view, from, to) => {
      await deps.relocateBindings(from.key, to.key);
      if (deps.hostId === undefined) return;
      await deps.mirror(deps.hostId).relocateProject(folderKeyOf(from.fsPath), folderKeyOf(to.fsPath));
      await deps.addHostAlias({ hostId: deps.hostId, from: from.fsPath, to: to.fsPath, ...(view.startedAt !== undefined ? { startedAt: view.startedAt } : {}) });
    },
    relocateList: (from, to, id) => deps.store.replaceProject(deps.authorityKey, {
      id,
      fromFolderKey: folderKeyOf(from.fsPath),
      fromKey: from.key,
      to: { path: to.fsPath, folderKey: folderKeyOf(to.fsPath), os: deps.os },
      toKey: to.key,
    }),
    // replaceProject moves the order slot in the list's own write
    relocateOrder: async () => undefined,
  };
}
