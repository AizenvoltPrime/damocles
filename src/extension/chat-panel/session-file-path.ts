import { getSessionFilePath } from "../session";
import { getEffectiveHarness } from "../pi-session/harness";
import { resolvePiSessionFile } from "../pi-session/session-store";

/**
 * Resolve a session's on-disk JSONL path for the ACTIVE harness — the pi tree store
 * (`~/.damocles/pi/agent/sessions/<cwd>/<ts>_<id>.jsonl`) on the pi path, the SDK store
 * (`~/.claude/projects/...`) otherwise. Returns null when the file can't be located. Use this
 * instead of `getSessionFilePath` directly anywhere a live session's transcript path is needed,
 * so the pi path never points at the (non-existent) SDK location (FR-1).
 */
export async function resolveSessionFilePath(workspacePath: string, sessionId: string): Promise<string | null> {
  if (getEffectiveHarness() === "pi") {
    return resolvePiSessionFile(workspacePath, sessionId);
  }
  return getSessionFilePath(workspacePath, sessionId);
}
