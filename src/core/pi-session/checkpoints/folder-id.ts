// A folder's checkpoint repo id. Pure, so the relocation journal's fold computes ids without the resolver, which reads it.
import { createHash } from 'crypto';
import { folderKey } from '../../workspace-folders/folder-key';

/**
 * First 16 hex of sha256(folderKey(cwd)), or of folderKey(cwd) + '\0' + generation for a folder at a path a finished relocation
 * moved away (docs/invariants.md "Checkpoints"): the same folder always maps to the same repo, at a fixed path length.
 */
export function folderIdFor(cwd: string, generation?: number): string {
  const key = folderKey(cwd);
  return createHash('sha256').update(generation === undefined ? key : `${key}\0${generation}`).digest('hex').slice(0, 16);
}
