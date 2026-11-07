// Fork from here in a design chat (PD-36): a new, unlinked design whose folder starts as the fork point's checkpoint, or as a
// copy of the current files when that point has none. The original design's folder and state folder are only ever read.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from '../config/json-config-write';
import { log } from '../logger';
import { materializeCheckpoint, type FolderRepoHandle } from '../pi-session/checkpoints';
import type { DesignRole } from './design-entries';
import { listDesignFiles, readManifest } from './design-files';
import { designFolderOf, designStateDirOf, forkDesignId, MANIFEST_FILE } from './design-paths';
import { createForkDesignLink, writeJsonAtomic } from './design-state';

/** Where a design fork's files come from: the fork point's before-commit, or the original folder as it is now. */
export type DesignForkSource = { readonly kind: 'checkpoint'; readonly handle: FolderRepoHandle; readonly commit: string } | { readonly kind: 'copy' };

/** Copies the design files of `source` (regular files only, as a design holds) into `target`, which must not exist yet. */
async function copyDesignFolder(source: string, target: string): Promise<void> {
  const files = await listDesignFiles(source);
  const parent = path.dirname(target);
  // A leading dot keeps the staging folder from ever reading as a design id (`isSafeAgentPathId`).
  const staging = path.join(parent, `.copy-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const file of files) {
      const to = path.join(staging, ...file.path.split('/'));
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(path.join(source, ...file.path.split('/')), to, fs.constants.COPYFILE_EXCL);
    }
    await renameWithRetry(staging, target);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Fork `forkSessionId`'s role: `<designId>-f<id8>`, no parent. Throws for an id that is not one safe path segment (PD-23). */
export function forkDesignRole(role: DesignRole, forkSessionId: string): DesignRole {
  const designId = forkDesignId(role.designId, forkSessionId);
  return { designId, folder: designFolderOf(designId), parentSessionId: null, ruleSet: role.ruleSet, title: role.title };
}

/**
 * Makes fork `forkSessionId`'s own design from `role`'s (`forkDesignRole`): its folder from `source`, and a state folder whose
 * link names the fork and no parent. A failure removes the folder this call created.
 */
export async function forkDesign(role: DesignRole, forkSessionId: string, source: DesignForkSource): Promise<DesignRole> {
  const fork = forkDesignRole(role, forkSessionId);
  const { designId, folder } = fork;
  const stateDir = designStateDirOf(designId);
  if (await exists(folder)) throw new Error(`the design folder ${folder} already exists`);
  if (source.kind === 'checkpoint') await materializeCheckpoint(source.handle, source.commit, folder);
  else await copyDesignFolder(role.folder, folder);
  try {
    // The files came with the original's manifest; the fork's names its own id, no plan and no version yet (PD-24).
    const manifest = await readManifest(folder, role.designId);
    await writeJsonAtomic(path.join(folder, MANIFEST_FILE), { ...manifest, designId, plan: null, status: 'draft', version: null, updatedAt: new Date().toISOString() });
    await createForkDesignLink(stateDir, forkSessionId, { designId, folder, title: role.title });
  } catch (err) {
    await fs.rm(folder, { recursive: true, force: true }).catch((rmErr: unknown) => log('[design-fork] removing the new design folder %s failed: %O', folder, rmErr));
    throw err;
  }
  return fork;
}
