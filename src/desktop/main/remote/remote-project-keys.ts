// The project keys a core sends or receives, rewritten at main's client for that core: a remote core's native folder key
// gains `<authorityKey>|` toward the shell and loses it toward core, and no key of another authority crosses either way.
import type { StoredSession } from '../../../shared/types/session';
import { authorityKeyOfProject, isAbsoluteFolderKey, targetFolderKeyOf } from '../../../shared/project-location';
import type { ChatEntry, FolderTargetEntry, MentionTargetData, ScmMirrorPatch } from '../../core-protocol';

export interface ProjectKeys {
  readonly authorityKey: string;
  // a key core sent, as the shell names it; throws for a key that already carries an authority prefix
  toShell(nativeKey: string): string;
  // a key the shell names, as core knows it; throws for a key of another authority
  toCore(shellKey: string): string;
}

export class ForeignProjectKeyError extends Error {}

const foreign = (key: string, side: string): ForeignProjectKeyError =>
  new ForeignProjectKeyError(`${side} named a project key of another authority (${JSON.stringify(key.slice(0, 64))})`);

/** The local core's keys are the shell's, and no key of a remote authority crosses to it. */
export const LOCAL_PROJECT_KEYS: ProjectKeys = {
  authorityKey: 'local',
  toShell: (key) => {
    if (authorityKeyOfProject(key) !== 'local') throw foreign(key, 'The local core');
    return key;
  },
  toCore: (key) => {
    if (authorityKeyOfProject(key) !== 'local') throw foreign(key, 'A request for the local core');
    return key;
  },
};

/** A remote authority's keys; onForeign hears of a key core sent that already carried a prefix, before the throw. */
export function authorityProjectKeys(authorityKey: string, onForeign: (error: ForeignProjectKeyError) => void): ProjectKeys {
  if (authorityKey === 'local') throw new Error('The local authority has no key prefix');
  return {
    authorityKey,
    toShell: (nativeKey) => {
      if (authorityKeyOfProject(nativeKey) !== 'local' || !isAbsoluteFolderKey(nativeKey)) {
        const error = foreign(nativeKey, `The core on ${authorityKey}`);
        onForeign(error);
        throw error;
      }
      return `${authorityKey}|${nativeKey}`;
    },
    toCore: (shellKey) => {
      const target = targetFolderKeyOf(shellKey);
      if (target === undefined || !isAbsoluteFolderKey(target) || authorityKeyOfProject(shellKey) !== authorityKey) throw foreign(shellKey, `A request for ${authorityKey}`);
      return target;
    },
  };
}

export function folderTargetToShell(keys: ProjectKeys, entry: FolderTargetEntry): FolderTargetEntry {
  return { ...entry, key: keys.toShell(entry.key), ...(entry.ownerKey !== undefined ? { ownerKey: keys.toShell(entry.ownerKey) } : {}) };
}

export function chatEntryToShell(keys: ProjectKeys, entry: ChatEntry): ChatEntry {
  return { ...entry, folder: folderTargetToShell(keys, entry.folder) };
}

export function storedSessionToShell(keys: ProjectKeys, row: StoredSession): StoredSession {
  return {
    ...row,
    ...(row.workspaceFolder ? { workspaceFolder: { ...row.workspaceFolder, key: keys.toShell(row.workspaceFolder.key) } } : {}),
    ...(row.listedFrom !== undefined ? { listedFrom: keys.toShell(row.listedFrom) } : {}),
  };
}

// A project view and a repository snapshot also name their project inside.
const withProjectKey = (keys: ProjectKeys, value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'projectKey')) return value;
  const key = (value as { projectKey: unknown }).projectKey;
  return typeof key === 'string' ? { ...value, projectKey: keys.toShell(key) } : value;
};

export function scmPatchToShell(keys: ProjectKeys, patch: ScmMirrorPatch): ScmMirrorPatch {
  switch (patch.kind) {
    case 'view':
      return { ...patch, projectKey: keys.toShell(patch.projectKey), ...(patch.view !== undefined ? { view: withProjectKey(keys, patch.view) } : {}) };
    case 'repository':
      if (patch.repository === undefined) return patch;
      return { ...patch, repository: { ...patch.repository, projectKey: keys.toShell(patch.repository.projectKey), snapshot: withProjectKey(keys, patch.repository.snapshot) } };
    case 'decorations':
      return { ...patch, projectKey: keys.toShell(patch.projectKey) };
    case 'repositoryState':
    case 'clone':
      return patch;
  }
}

/** A ScmService event (scm.changed): its projectKey, where it has one. */
export function scmEventToShell(keys: ProjectKeys, event: unknown): unknown {
  return withProjectKey(keys, event);
}

// A file named by its path on this computer never reaches a remote core.
export function mentionToCore(keys: ProjectKeys, target: MentionTargetData): MentionTargetData {
  if ('projectKey' in target) return { ...target, projectKey: keys.toCore(target.projectKey) };
  if (keys.authorityKey !== 'local') throw new ForeignProjectKeyError(`A file of this computer cannot be mentioned in a chat on ${keys.authorityKey}`);
  return target;
}
