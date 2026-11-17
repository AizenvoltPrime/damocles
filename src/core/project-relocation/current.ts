// This process's view of the relocation journal, for readers with no owning object to be handed it (checkpoint ids,
// sweeps). ProjectRelocations installs it from its store; before that, and in a worker thread, it is empty.
import * as path from 'node:path';
import { folderIdFor } from '../pi-session/checkpoints/folder-id';
import { folderKey } from '../workspace-folders/folder-key';
import { foldAliases, NO_ALIASES, type AliasSource, type HostAlias, type RelocationAliases } from './aliases';
import type { RelocationRecord } from './types';

export interface RelocationsSnapshot {
  readonly aliases: RelocationAliases;
  /** folderKeys every pending relocation names, from and to, another app version's included. */
  readonly pendingKeys: ReadonlySet<string>;
  /** The folder pairs of every pending relocation this version reads. */
  readonly pendingPairs: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /**
   * The folder pairs of every abandoned relocation whose sessions step is not done: a chat may be in the old folder's dir though
   * its registration names the new one.
   */
  readonly stoppedPairs: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** folderKey to the folder repo new checkpoints of a folder at that path go to, where it is not folderIdFor(path). */
  readonly checkpointBindings: ReadonlyMap<string, string>;
  /** folderKey to every folder repo whose entries belong to the folder at that path now, for each path a relocation named. */
  readonly checkpointRepos: ReadonlyMap<string, ReadonlySet<string>>;
}

const EMPTY: RelocationsSnapshot = { aliases: NO_ALIASES, pendingKeys: new Set(), pendingPairs: [], stoppedPairs: [], checkpointBindings: new Map(), checkpointRepos: new Map() };

let current: RelocationsSnapshot = EMPTY;

export function currentRelocations(): RelocationsSnapshot {
  return current;
}

export function installRelocations(snapshot: RelocationsSnapshot | undefined): void {
  current = snapshot ?? EMPTY;
}

/** Whether a relocation still has its run ahead: running or paused, neither finished nor abandoned. */
export function isPendingRecord(record: Pick<RelocationRecord, 'state'>): boolean {
  return record.state === 'running' || record.state === 'paused';
}

/**
 * The checkpoint ids follow docs/invariants.md "Checkpoints", the relocated folder rule; an abandoned relocation places the repos
 * as a finished one once its checkpoints step is done, and none before. `foreignPending`: another version's pending relocations;
 * `journal`: the journal's id.
 */
export function relocationsSnapshot(records: readonly RelocationRecord[], aliasSources: readonly AliasSource[], hostAliases: readonly HostAlias[] = [], foreignPending: readonly AliasSource[] = [], journal?: string): RelocationsSnapshot {
  const pendingKeys = new Set<string>(foreignPending.flatMap((source) => source.folders.flatMap((folder) => [folderKey(folder.from), folderKey(folder.to)])));
  const pendingPairs: Array<{ readonly from: string; readonly to: string }> = [];
  const stoppedPairs: Array<{ readonly from: string; readonly to: string }> = [];
  const bound = new Map<string, string>();
  const generations = new Map<string, number>();
  const carried = new Map<string, Set<string>>();
  const ownId = (key: string): string => folderIdFor(key, generations.get(key));
  const repoIds = (key: string): Set<string> => new Set([ownId(key), bound.get(key) ?? ownId(key), ...(carried.get(key) ?? [])]);
  for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
    const abandoned = record.state === 'abandoned';
    if (abandoned && record.steps.checkpoints.state !== 'done') continue;
    for (const folder of record.folders) {
      if (isPendingRecord(record)) {
        pendingKeys.add(folderKey(folder.from));
        pendingKeys.add(folderKey(folder.to));
        pendingPairs.push({ from: folder.from, to: folder.to });
      }
      if (abandoned && record.steps.sessions.state !== 'done') stoppedPairs.push({ from: folder.from, to: folder.to });
      const fromKey = folderKey(folder.from);
      const toKey = folderKey(folder.to);
      // a chat worktree's folder stays where it is, with its repos
      if (fromKey === toKey) continue;
      carried.set(toKey, new Set([...(carried.get(toKey) ?? []), ...repoIds(fromKey)]));
      carried.delete(fromKey);
      bound.delete(fromKey);
      if (folder.checkpointRepo !== undefined) bound.set(toKey, folder.checkpointRepo);
      if (!isPendingRecord(record)) generations.set(fromKey, record.seq);
    }
  }
  const keys = new Set([...bound.keys(), ...generations.keys(), ...carried.keys()]);
  const checkpointBindings = new Map<string, string>();
  const checkpointRepos = new Map<string, ReadonlySet<string>>();
  for (const key of keys) {
    const writes = bound.get(key) ?? ownId(key);
    if (writes !== folderIdFor(key)) checkpointBindings.set(key, writes);
    checkpointRepos.set(key, repoIds(key));
  }
  return { aliases: foldAliases(aliasSources, hostAliases, journal), pendingKeys, pendingPairs, stoppedPairs, checkpointBindings, checkpointRepos };
}

/** Whether a pending relocation names `folder`, a folder holding it, or a folder it holds. */
export function isRelocationPending(folder: string): boolean {
  const key = folderKey(folder);
  return [...current.pendingKeys].some((pending) => within(key, pending) || within(pending, key));
}

function within(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
}
