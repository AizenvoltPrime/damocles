import type { TrustService } from '../../../platform/trust-service';
import type { TrustStore } from '../trust-store';

// Trust is per folder on desktop: each call names the folder it acts for.
export function createDesktopTrustService(store: TrustStore): TrustService {
  return {
    isTrusted: (folderPath) => store.isTrusted(folderPath),
    onDidChangeTrust: (cb) => store.onDidChange(cb),
    requestTrust: (folderPath) => store.requestTrust(folderPath),
  };
}
