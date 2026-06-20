import { resolvePiSessionFile } from "../pi-session/session-store";

/**
 * Resolve a session's on-disk JSONL path in the pi tree store
 * (`~/.damocles/pi/agent/sessions/<cwd>/<ts>_<id>.jsonl`). Returns null when the file can't be located.
 */
export async function resolveSessionFilePath(workspacePath: string, sessionId: string): Promise<string | null> {
  return resolvePiSessionFile(workspacePath, sessionId);
}
