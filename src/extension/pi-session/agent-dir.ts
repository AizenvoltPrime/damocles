import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CacheWarmingMode } from '../../shared/types/settings';
import { parseCacheWarmingMode } from '../../shared/types/constants';
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
  /** US-021: disable pi's install telemetry so extension installs make no network ping (pi defaults true). */
  enableInstallTelemetry?: boolean;
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
  return parseCacheWarmingMode(vscode.workspace.getConfiguration('damocles').get('cacheWarming'));
}

function readSettings(settingsPath: string): SeededPiSettings {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SeededPiSettings;
  } catch {
    // Missing or corrupt — fall through to a fresh object. The file is a regenerable
    // cache we fully own, so discarding an unreadable one is safe.
  }
  return {};
}

/**
 * Create the Damocles-owned pi agent directory (and its `extensions/` subdir) and seed
 * `settings.json` so pi auto-compaction is OFF, image input is allowed, and prompt-cache warming
 * runs in the configured mode. Merges into any existing file rather than clobbering it, and is
 * idempotent.
 *
 * Disabling compaction here is the durable half of blocker B3 — pi's `getCompactionEnabled()`
 * defaults to `true`, so without this seed the harness would auto-compact inside the loop.
 * Callers should also assert `session.setAutoCompactionEnabled(false)` at runtime (defense in
 * depth). Returns the resolved agent directory.
 */
export function ensurePiAgentDir(agentDir: string, cacheWarming: CacheWarmingMode): string {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });

  const settingsPath = path.join(agentDir, 'settings.json');
  const settings = readSettings(settingsPath);

  const desiredCompaction = settings.compaction?.enabled === false;
  const desiredImages = settings.images?.blockImages === false;
  const desiredTelemetry = settings.enableInstallTelemetry === false;
  // `cacheWarming` is compared against the caller's value, not a constant: a user who changes the
  // mode must get the file rewritten, so this condition cannot be folded into the three above.
  const desiredWarming = settings.cacheWarming === cacheWarming;
  if (desiredCompaction && desiredImages && desiredTelemetry && desiredWarming) return agentDir;

  const next: SeededPiSettings = {
    ...settings,
    compaction: { ...settings.compaction, enabled: false },
    images: { ...settings.images, blockImages: false },
    enableInstallTelemetry: false,
    cacheWarming,
  };
  // pi guards this same file with a lock file. Writing the target in place would let a concurrently
  // starting pi read a truncated file, which permanently disables its global-settings saving for that
  // session, so the new content is published by an atomic same-directory rename instead.
  const pendingPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(pendingPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(pendingPath, settingsPath);
  log(
    '[PiAgentDir] Seeded %s (compaction.enabled=false, images.blockImages=false, enableInstallTelemetry=false, cacheWarming=%s)',
    settingsPath,
    cacheWarming,
  );
  return agentDir;
}
