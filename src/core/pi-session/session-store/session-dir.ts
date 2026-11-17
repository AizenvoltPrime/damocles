import * as fs from 'fs';
import * as path from 'path';
import { PI_AGENT_DIR } from '../agent-dir';
import { sessionsRootIn } from './session-file-path';

/**
 * The Damocles-owned pi session directory for a workspace.
 *
 * Replicates pi's internal `getDefaultSessionDir(cwd, agentDir)` encoding (which pi does not export
 * publicly) so the exact same path is passed to `SessionManager.create`/`.open`/`.list` and to the
 * file watcher. pi defaults sessions to `~/.pi/agent/sessions`; pinning `agentDir` to `PI_AGENT_DIR`
 * isolates Damocles' pi sessions under `~/.damocles/pi/agent/sessions/<encoded-cwd>/` (FR-1), away
 * from the user's pi CLI store.
 */
export function piSessionDir(cwd: string, agentDir: string = PI_AGENT_DIR): string {
  return path.join(piSessionsRoot(agentDir), piSessionDirName(cwd));
}

/** The name of `cwd`'s session directory by the path rules of `os`; lossy, so two folders can share one. */
export function piSessionDirName(cwd: string, os: NodeJS.Platform = process.platform): string {
  const resolvedCwd = (os === 'win32' ? path.win32 : path.posix).resolve(cwd);
  return `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** The folder every pi session dir lies directly in. */
export function piSessionsRoot(agentDir: string = PI_AGENT_DIR): string {
  return sessionsRootIn(agentDir);
}

/**
 * Resolve the pi session dir and ensure it exists. pi does NOT create an explicitly-passed
 * sessionDir (only the default-dir path mkdirs), so create/list/watch all route through here.
 */
export function ensurePiSessionDir(cwd: string, agentDir: string = PI_AGENT_DIR): string {
  const dir = piSessionDir(cwd, agentDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
