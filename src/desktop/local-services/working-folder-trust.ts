import type { TrustChange } from '../../platform/trust-service';
import { folderKey } from '../../core/workspace-folders/folder-key';

interface Answer {
  readonly folder: string;
  readonly trusted: boolean;
}

/**
 * The trust answers of the live chat worktrees' working folders, which take their project's trust from the worktree
 * registry, so a registry change changes them with no grant or revoke (VS Code's workspaceTrust recomputes on a folder
 * change). The returned read takes every answer again and gives the folders whose answer changed since the previous read.
 * A folder that is no live working folder in one of the two reads answers `direct` there (its own grant), so call it on
 * every change of the grants and of the registry: between two reads only one of them may change.
 */
export function workingFolderTrust(liveWorkingFolders: () => readonly string[], isTrusted: (folder: string) => boolean, direct: (folder: string) => boolean): () => TrustChange {
  const read = (): Map<string, Answer> => new Map(liveWorkingFolders().map((folder) => [folderKey(folder), { folder, trusted: isTrusted(folder) }]));
  let answers = read();
  return () => {
    const before = answers;
    answers = read();
    const granted: string[] = [];
    const revoked: string[] = [];
    for (const key of new Set([...before.keys(), ...answers.keys()])) {
      const was = before.get(key);
      const now = answers.get(key);
      const folder = (now ?? was)!.folder;
      const trusted = now?.trusted ?? direct(folder);
      if ((was?.trusted ?? direct(folder)) !== trusted) (trusted ? granted : revoked).push(folder);
    }
    return { granted, revoked };
  };
}

/** Both changes' folders, each folder once per list. */
export function mergeTrustChanges(a: TrustChange, b: TrustChange): TrustChange {
  const merged = (lists: ReadonlyArray<readonly string[]>): string[] => [...new Map(lists.flat().map((folder) => [folderKey(folder), folder])).values()];
  return { granted: merged([a.granted, b.granted]), revoked: merged([a.revoked, b.revoked]) };
}

export function isEmptyTrustChange(change: TrustChange): boolean {
  return change.granted.length === 0 && change.revoked.length === 0;
}
