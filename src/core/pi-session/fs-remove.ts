import { rm } from 'fs/promises';

/**
 * Recursively remove a directory in a way that survives Windows sharing violations. Node's `rm`
 * with `{ force: true }` only suppresses ENOENT — it does NOT retry the EPERM/EBUSY thrown when a
 * transient handle (Search indexer, antivirus, or a lingering git child right after a fresh clone)
 * still holds a file in the tree. With `recursive: true`, `maxRetries` makes Node retry those
 * sharing violations with linear backoff (and its built-in rimraf clears git's read-only pack files
 * via chmod). Resolves once the path is gone (or was already absent); rejects only if it still
 * exists after every retry.
 */
export function forceRemoveDir(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
