import type { Disposable } from './disposable';

export interface TrustService {
  isTrusted(folderPath: string): boolean;
  onDidGrantTrust(cb: (folderPaths: readonly string[]) => void): Disposable;
  requestTrust(folderPath: string): Promise<boolean>;
}
