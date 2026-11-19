import type { Disposable } from './disposable';

/** The folders one trust change granted and the ones it took back (VS Code's onDidChangeTrust, per folder). */
export interface TrustChange {
  readonly granted: readonly string[];
  readonly revoked: readonly string[];
}

export interface TrustService {
  isTrusted(folderPath: string): boolean;
  // fires whenever an isTrusted answer changes, a worktree registry change that moves a working folder's answer included;
  // the lists may not name every folder whose trust changed (a remote client's attach), so a listener reads isTrusted again
  // for each folder it holds, in both directions
  onDidChangeTrust(cb: (change: TrustChange) => void): Disposable;
  requestTrust(folderPath: string): Promise<boolean>;
}
