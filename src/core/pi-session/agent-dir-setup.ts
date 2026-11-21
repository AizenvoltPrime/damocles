// Kept out of agent-dir.ts, which the ES-module e2e loader imports and so must not reach the link-policy stack (koffi's lazy require).
import * as fs from 'fs';
import * as path from 'path';
import type { CacheWarmingMode } from '../../shared/types/settings';
import { stripBom } from '../config/bom';
import { agentConfigBases, configLinkPolicy, noticeRefusedConfigRead } from '../config/local-config-path';
import { installedPlatform } from '../platform-host';
import { log } from '../logger';

/** Subset of pi's global settings.json that Damocles seeds. */
interface SeededPiSettings {
  compaction?: { enabled?: boolean };
  images?: { blockImages?: boolean };
  /** Prompt-cache warming mode. pi reads it from `globalSettings` only, so this file is the startup seam. */
  cacheWarming?: CacheWarmingMode;
  [key: string]: unknown;
}

type SettingsRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'parsed'; readonly settings: SeededPiSettings }
  | { readonly kind: 'unusable'; readonly reason: string }
  | { readonly kind: 'refused' };

/**
 * Empty text is no settings, as in pi's `SettingsManager.loadFromStorage`; anything else must parse to a JSON object. A file
 * pi's link policy refuses (`admits`) is not read.
 */
function readSettings(settingsPath: string, admits: (file: string) => boolean): SettingsRead {
  if (!admits(settingsPath)) return { kind: 'refused' };
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

// The kernel's own symlink hop limit on Linux.
const MAX_LINK_HOPS = 40;

// The file a symlinked file names, through every link and dangling or not; the file itself when it is no link.
function linkTarget(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let link = file;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    let destination: string;
    try {
      // eslint-disable-next-line damocles/no-sync -- ensurePiAgentDir is synchronous, run once per init before pi loads
      destination = fs.readlinkSync(link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EINVAL: the entry is not a link; ENOENT: nothing is there yet
      if (code === 'EINVAL' || code === 'ENOENT') return link;
      throw err;
    }
    link = path.resolve(path.dirname(link), destination);
  }
  throw Object.assign(new Error(`${file} goes through too many links`), { code: 'ELOOP' });
}

/**
 * Create the Damocles-owned pi agent directory (and its `extensions/` subdir) and seed
 * `settings.json` so pi auto-compaction is OFF, image input is allowed, and prompt-cache warming
 * runs in the configured mode. Merges into an existing file, through a symlink to the file it names, and is idempotent. A
 * file pi's link policy refuses is neither read nor written, nor is a folder on its path made. A file it cannot read
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
  const settingsPath = path.join(agentDir, 'settings.json');
  const admits = configLinkPolicy(agentConfigBases(agentDir));
  // judged before any mkdir, which already reaches a share a link on the folder's path leads onto
  const read = readSettings(settingsPath, admits);
  if (read.kind === 'refused') {
    log('[PiAgentDir] Left %s unseeded: it links to a network share or WSL path', settingsPath);
    noticeRefusedConfigRead(settingsPath, installedPlatform()?.notifications);
    return;
  }
  fs.mkdirSync(agentDir, { recursive: true });
  const extensions = path.join(agentDir, 'extensions');
  if (admits(extensions)) fs.mkdirSync(extensions, { recursive: true });

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
  // pi guards this same file with a lock file, which it retries only briefly, so this write takes none. Writing the target in
  // place would let a concurrently starting pi read a truncated file, which permanently disables its global-settings saving for
  // that session, so the new content is published by an atomic rename beside the file a symlinked settings.json names, keeping the link.
  const target = linkTarget(settingsPath);
  // a dangling link's folder, as writeJsonConfig makes it
  // eslint-disable-next-line damocles/no-sync -- ensurePiAgentDir is synchronous, run once per init before pi loads
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const pendingPath = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(pendingPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(pendingPath, target);
  log(
    '[PiAgentDir] Seeded %s (compaction.enabled=false, images.blockImages=false, cacheWarming=%s)',
    settingsPath,
    cacheWarming,
  );
}
