import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { log } from "../logger";

export interface FilePermissions {
  allow: string[];
  deny: string[];
  ask: string[];
}

const NO_PERMISSIONS: FilePermissions = { allow: [], deny: [], ask: [] };

/**
 * One settings file's permission rules, or none if it is absent, empty or unusable.
 *
 * A malformed file is logged rather than silently treated as absent. This fails OPEN — a trailing
 * comma makes every `deny` in that file vanish and the agent proceeds to ask or allow — so the one
 * signal the user gets must not be nothing. The path is logged and never the parser's message, which
 * quotes the offending source line.
 */
async function readPermissionsFromPath(filePath: string): Promise<FilePermissions> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log(`[PermissionSettings] ${filePath} could not be read (${code ?? "unknown error"}); its rules were skipped`);
    }
    return NO_PERMISSIONS;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch {
    log(`[PermissionSettings] ${filePath} is not valid JSON; its rules were skipped`);
    return NO_PERMISSIONS;
  }

  if (!settings || typeof settings !== "object") return NO_PERMISSIONS;
  const perms = (settings as { permissions?: unknown }).permissions;
  if (!perms || typeof perms !== "object") return NO_PERMISSIONS;

  const { allow, deny, ask } = perms as Record<string, unknown>;
  return {
    allow: Array.isArray(allow) ? allow : [],
    deny: Array.isArray(deny) ? deny : [],
    ask: Array.isArray(ask) ? ask : [],
  };
}

/**
 * Reads permission files most-specific first: `local > project > global`, and within each tier
 * `.damocles` before `.claude` (Claude Code's files are read as a courtesy, so a Damocles rule at
 * the same tier must be able to override one). With no workspace the four workspace paths drop out.
 * Files that yield no rules are omitted so an empty file cannot occupy a precedence slot.
 */
export async function loadPermissionsByPriority(
  workspacePath: string | null
): Promise<FilePermissions[]> {
  const result: FilePermissions[] = [];
  const home = os.homedir();

  const paths = [
    workspacePath ? path.join(workspacePath, ".damocles", "settings.local.json") : null,
    workspacePath ? path.join(workspacePath, ".claude", "settings.local.json") : null,
    workspacePath ? path.join(workspacePath, ".damocles", "settings.json") : null,
    workspacePath ? path.join(workspacePath, ".claude", "settings.json") : null,
    path.join(home, ".damocles", "settings.local.json"),
    path.join(home, ".claude", "settings.local.json"),
    path.join(home, ".damocles", "settings.json"),
    path.join(home, ".claude", "settings.json"),
  ].filter((p): p is string => p !== null);

  // Read concurrently: precedence comes from the array index below, not from completion order, so
  // eight serial round-trips on every cache miss buy nothing.
  const all = await Promise.all(paths.map(readPermissionsFromPath));

  for (const perms of all) {
    if (perms.allow.length || perms.deny.length || perms.ask.length) {
      result.push(perms);
    }
  }

  return result;
}
