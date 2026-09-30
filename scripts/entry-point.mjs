import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the script Node was started with. Node resolves the entry to its real path, so a raw
 * `process.argv[1]` comparison misses it in a symlinked or junctioned checkout and the script silently does nothing.
 */
export function isEntryPoint(moduleUrl) {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(moduleUrl);
}
