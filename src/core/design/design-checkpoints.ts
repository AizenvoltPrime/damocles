// Which checkpoints a design chat can rewind to (D71): a design fork's branch carries the original's records, whose folder repo
// is the original folder's, so only the records of the chat's own design folder are rewind points.
import { folderIdFor, getCheckpointEntries, type CheckpointEntry } from '../pi-session/checkpoints';
import { designRoleOf } from './design-entries';

/** The checkpoints on `branch` a rewind can restore: every one outside a design chat, its own design folder's in one. */
export function rewindableCheckpoints(branch: readonly unknown[]): readonly CheckpointEntry[] {
  const all = getCheckpointEntries(branch);
  const role = designRoleOf(branch);
  if (!role) return all;
  const own = folderIdFor(role.folder);
  return all.filter((cp) => cp.v === 3 && cp.folderId === own);
}
