import * as fs from 'fs';
import * as path from 'path';
import { DAMOCLES_HOME_DIR } from '../auth/paths';
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
  [key: string]: unknown;
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
 * `settings.json` so pi auto-compaction is OFF and image input is allowed. Merges into any
 * existing file rather than clobbering it, and is idempotent.
 *
 * Disabling compaction here is the durable half of blocker B3 — pi's `getCompactionEnabled()`
 * defaults to `true`, so without this seed the harness would auto-compact inside the loop.
 * Callers should also assert `session.setAutoCompactionEnabled(false)` at runtime (defense in
 * depth). Returns the resolved agent directory.
 */
export function ensurePiAgentDir(agentDir: string = PI_AGENT_DIR): string {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });

  const settingsPath = path.join(agentDir, 'settings.json');
  const settings = readSettings(settingsPath);

  const desiredCompaction = settings.compaction?.enabled === false;
  const desiredImages = settings.images?.blockImages === false;
  const desiredTelemetry = settings.enableInstallTelemetry === false;
  if (desiredCompaction && desiredImages && desiredTelemetry) return agentDir;

  const next: SeededPiSettings = {
    ...settings,
    compaction: { ...settings.compaction, enabled: false },
    images: { ...settings.images, blockImages: false },
    enableInstallTelemetry: false,
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log(
    '[PiAgentDir] Seeded %s (compaction.enabled=false, images.blockImages=false, enableInstallTelemetry=false)',
    settingsPath,
  );
  return agentDir;
}
