import type { CacheWarmingMode } from '../../shared/types/settings';
import { parseCacheWarmingMode } from '../../shared/types/constants';
import { platform } from '../platform-host';
import { DAMOCLES_HOME_DIR } from '../paths';
import { piAgentDirIn } from './session-store/session-file-path';

/**
 * Damocles-owned pi config/data directory. pi defaults to `~/.pi/agent`; we point it
 * here instead so the embedded harness never inherits the user's pi CLI config (FR-9).
 * The directory is passed explicitly to every pi factory — the `PI_CODING_AGENT_DIR`
 * env var is deliberately NOT set, since one Node process hosts all VS Code extensions
 * and mutating `process.env` would leak into them (FR-12).
 */
export const PI_AGENT_DIR: string = piAgentDirIn(DAMOCLES_HOME_DIR);

/**
 * The configured prompt-cache warming mode, read live. Sole reader for the two pi seams that need it:
 * the startup seed (`ensurePiAgentDir`, agent-dir-setup.ts) and `PiSession`'s `setCacheWarmingMode` call.
 *
 * `damocles.cacheWarming` is `application`-scoped, so it has one user-level value and no per-resource
 * override. Passing a resource here would therefore resolve to the same value.
 */
export function cacheWarmingSetting(): CacheWarmingMode {
  return parseCacheWarmingMode(platform().settings.get('damocles.cacheWarming'));
}
