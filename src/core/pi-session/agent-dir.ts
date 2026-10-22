import * as fs from 'fs';
import * as path from 'path';
import { platform } from '../platform-host';
import type { CacheWarmingMode } from '../../shared/types/settings';
import { parseCacheWarmingMode } from '../../shared/types/constants';
import { stripBom } from '../config/bom';
import { DAMOCLES_HOME_DIR } from '../paths';
import { log } from '../logger';

/**
 * Damocles-owned pi config/data directory. pi defaults to `~/.pi/agent`; we point it
 * here instead so the embedded harness never inherits the user's pi CLI config (FR-9).
 * The directory is passed explicitly to every pi factory — the `PI_CODING_AGENT_DIR`
 * env var is deliberately NOT set, since one Node process hosts all VS Code extensions
 * and mutating `process.env` would leak into them (FR-12).
 */
export const PI_AGENT_DIR: string = path.join(DAMOCLES_HOME_DIR, 'pi', 'agent');

/** Subset of pi's global settings.json that Damocles seeds. */
interface SeededPiSettings {
  compaction?: { enabled?: boolean };
  images?: { blockImages?: boolean };
  /** Prompt-cache warming mode. pi reads it from `globalSettings` only, so this file is the startup seam. */
  cacheWarming?: CacheWarmingMode;
  [key: string]: unknown;
}

/**
 * The configured prompt-cache warming mode, read live. Sole reader for the two pi seams that need it:
 * the startup seed below and `PiSession`'s `setCacheWarmingMode` call.
 *
 * `damocles.cacheWarming` is `application`-scoped, so it has one user-level value and no per-resource
 * override. Passing a resource here would therefore resolve to the same value.
 */
export function cacheWarmingSetting(): CacheWarmingMode {
  return parseCacheWarmingMode(platform().settings.get('damocles.cacheWarming'));
}

type SettingsRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'parsed'; readonly settings: SeededPiSettings }
  | { readonly kind: 'unusable'; readonly reason: string };

/** Empty text is no settings, as in pi's `SettingsManager.loadFromStorage`; anything else must parse to a JSON object. */
function readSettings(settingsPath: string): SettingsRead {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unusable', reason: `it cannot be read (${code ?? String(err)})` };
  }
  if (raw === '') return { kind: 'parsed', settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    // The parser's message can quote the file's text, so only the fact reaches the log.
    return { kind: 'unusable', reason: 'it is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'unusable', reason: 'it does not hold a JSON object' };
  return { kind: 'parsed', settings: parsed as SeededPiSettings };
}

/**
 * Create the Damocles-owned pi agent directory (and its `extensions/` subdir) and seed
 * `settings.json` so pi auto-compaction is OFF, image input is allowed, and prompt-cache warming
 * runs in the configured mode. Merges into an existing file and is idempotent. A file it cannot read
 * or parse to a JSON object is left as it is: it also holds what pi and the user keep
 * there, such as `packages`. pi records a load error for invalid JSON and for a JSON string, number,
 * boolean or `null`, and then loads no settings from it and writes nothing to it; it loads a JSON array
 * with no error (`migrateSettings` makes only `in` checks, settings-manager.js:281-326) and rewrites it
 * as an object at its first settings write.
 *
 * Disabling compaction here is the durable half of blocker B3 (pi's `getCompactionEnabled()` defaults
 * to `true`), and it is durable only when the file holds it, which an unusable file does not. The runtime half is
 * `PiSession.applyCompactionConfig`, which sets `damocles.autoCompact` on the folder's settings manager
 * at bind, on a config change and after pi re-reads that manager; nested sessions get an in-memory
 * manager with compaction off (`FolderRuntime.createSubagentSession`).
 */
export function ensurePiAgentDir(agentDir: string, cacheWarming: CacheWarmingMode): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });

  const settingsPath = path.join(agentDir, 'settings.json');
  const read = readSettings(settingsPath);
  if (read.kind === 'unusable') {
    log('[PiAgentDir] Left %s unseeded: %s', settingsPath, read.reason);
    return;
  }
  const settings = read.kind === 'parsed' ? read.settings : {};

  const desiredCompaction = settings.compaction?.enabled === false;
  const desiredImages = settings.images?.blockImages === false;
  // `cacheWarming` is compared against the caller's value, not a constant: a user who changes the
  // mode must get the file rewritten, so this condition cannot be folded into the two above.
  const desiredWarming = settings.cacheWarming === cacheWarming;
  if (desiredCompaction && desiredImages && desiredWarming) return;

  const next: SeededPiSettings = {
    ...settings,
    compaction: { ...settings.compaction, enabled: false },
    images: { ...settings.images, blockImages: false },
    cacheWarming,
  };
  // pi guards this same file with a lock file. Writing the target in place would let a concurrently
  // starting pi read a truncated file, which permanently disables its global-settings saving for that
  // session, so the new content is published by an atomic same-directory rename instead.
  const pendingPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(pendingPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(pendingPath, settingsPath);
  log(
    '[PiAgentDir] Seeded %s (compaction.enabled=false, images.blockImages=false, cacheWarming=%s)',
    settingsPath,
    cacheWarming,
  );
}
