import * as fs from 'fs';
import * as path from 'path';
import { PI_AGENT_DIR } from '../agent-dir';

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
  const resolvedCwd = path.resolve(cwd);
  const resolvedAgentDir = path.resolve(agentDir);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(resolvedAgentDir, 'sessions', safePath);
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
