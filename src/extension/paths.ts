import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

export const DAMOCLES_HOME_DIR: string = path.join(os.homedir(), ".damocles");

export const DAMOCLES_PLANS_DIR: string = path.join(DAMOCLES_HOME_DIR, "plans");
export const DAMOCLES_EXPLORES_DIR: string = path.join(DAMOCLES_HOME_DIR, "explores");

export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
}

export function getExploreSessionDir(workspacePath: string, sessionId: string): string {
  return path.join(DAMOCLES_EXPLORES_DIR, workspaceHash(workspacePath), sessionId);
}
