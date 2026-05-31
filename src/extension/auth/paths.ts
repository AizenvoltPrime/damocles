import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

export const DAMOCLES_HOME_DIR: string = path.join(os.homedir(), ".damocles");
export const DAMOCLES_CONFIG_DIR: string = path.join(DAMOCLES_HOME_DIR, "auth");
export const DAMOCLES_CREDENTIALS_FILENAME: string = ".credentials.json";
export const DAMOCLES_CREDENTIALS_PATH: string = path.join(DAMOCLES_CONFIG_DIR, DAMOCLES_CREDENTIALS_FILENAME);
export const CLAUDE_CONFIG_FILENAME: string = ".claude.json";
export const CLI_CONFIG_DIR: string = path.join(os.homedir(), ".claude");

/**
 * Damocles-owned Anthropic OAuth grant store. The bundled `claude` binary never
 * reads or writes this file — it is the source of truth on Linux, where the
 * binary cannot persist a real token to a custom `CLAUDE_CONFIG_DIR` (no
 * secure-store backend). Holds the same `{ claudeAiOauth: {...} }` shape the
 * binary would otherwise write to `.credentials.json`.
 */
export const DAMOCLES_ANTHROPIC_GRANT_FILENAME: string = "anthropic-grant.json";
export const DAMOCLES_ANTHROPIC_GRANT_PATH: string = path.join(DAMOCLES_CONFIG_DIR, DAMOCLES_ANTHROPIC_GRANT_FILENAME);

/**
 * Prefix for the ephemeral `HOME` used to capture a real token at `/login` on
 * Linux. Placed under the OS temp dir (not `~/.damocles/auth/`) so the
 * config-dir bootstrap's stale-entry sweep never touches it. `fs.mkdtempSync`
 * appends random suffix for a unique, atomic directory.
 */
export const DAMOCLES_LOGIN_CAPTURE_PREFIX: string = path.join(os.tmpdir(), "damocles-login-");
export const DAMOCLES_PLANS_DIR: string = path.join(DAMOCLES_CONFIG_DIR, "plans");
export const DAMOCLES_EXPLORES_DIR: string = path.join(DAMOCLES_HOME_DIR, "explores");

export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
}

export function getExploreSessionDir(workspacePath: string, sessionId: string): string {
  return path.join(DAMOCLES_EXPLORES_DIR, workspaceHash(workspacePath), sessionId);
}
