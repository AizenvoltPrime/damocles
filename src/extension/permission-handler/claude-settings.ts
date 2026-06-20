import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export interface FilePermissions {
  allow: string[];
  deny: string[];
  ask: string[];
}

function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.local.json");
}

function getProjectSettingsPath(): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return path.join(workspaceFolder.uri.fsPath, ".claude", "settings.local.json");
  }
  return null;
}

export function getClaudeSettingsPath(): string {
  return getProjectSettingsPath() ?? getUserSettingsPath();
}

export async function readClaudeSettings(): Promise<Record<string, unknown>> {
  const projectPath = getProjectSettingsPath();
  const userPath = getUserSettingsPath();

  if (projectPath) {
    try {
      const content = await fs.promises.readFile(projectPath, "utf-8");
      return JSON.parse(content);
    } catch {
      // Project file doesn't exist, fall back to user settings
    }
  }

  try {
    const content = await fs.promises.readFile(userPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readPermissionsFromPath(filePath: string): Promise<FilePermissions> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const settings = JSON.parse(content);
    const perms = settings?.permissions ?? {};
    return {
      allow: Array.isArray(perms.allow) ? perms.allow : [],
      deny: Array.isArray(perms.deny) ? perms.deny : [],
      ask: Array.isArray(perms.ask) ? perms.ask : [],
    };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

export async function loadPermissionsByPriority(
  workspacePath: string | null
): Promise<FilePermissions[]> {
  const result: FilePermissions[] = [];

  const paths = [
    workspacePath ? path.join(workspacePath, ".claude", "settings.local.json") : null,
    workspacePath ? path.join(workspacePath, ".claude", "settings.json") : null,
    path.join(os.homedir(), ".claude", "settings.local.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
  ].filter((p): p is string => p !== null);

  for (const filePath of paths) {
    const perms = await readPermissionsFromPath(filePath);
    if (perms.allow.length || perms.deny.length || perms.ask.length) {
      result.push(perms);
    }
  }

  return result;
}
