import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  getClaudeSettingsPath,
  readClaudeSettings,
} from "../../claude-settings";
import { log } from "../../logger";
import type { PermissionUpdate, PermissionRuleValue, PermissionUpdateDestination } from "../../../shared/types/permissions";

const settingsWriteQueue = new Map<string, Promise<void>>();

async function queueSettingsWrite(
  settingsPath: string,
  writeFn: () => Promise<void>
): Promise<void> {
  const pending = settingsWriteQueue.get(settingsPath) ?? Promise.resolve();
  const newPromise = pending.then(writeFn, writeFn);
  settingsWriteQueue.set(settingsPath, newPromise);
  return newPromise;
}

export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

export function modelSupports1MContext(model: string): boolean {
  return /claude-sonnet-4/.test(model);
}

export async function updateConfigAtEffectiveScope<T>(
  section: string,
  key: string,
  value: T
): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  const inspection = config.inspect<T>(key);
  const target = inspection?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await config.update(key, value, target);
}

export async function syncDisabledServersToClaudeSettings(serverName: string, disabled: boolean): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = await readClaudeSettings();

  const disabledServers = Array.isArray(settings["disabledMcpjsonServers"])
    ? settings["disabledMcpjsonServers"] as string[]
    : [];

  if (disabled) {
    if (!disabledServers.includes(serverName)) {
      settings["disabledMcpjsonServers"] = [...disabledServers, serverName];
    }
  } else {
    settings["disabledMcpjsonServers"] = disabledServers.filter(s => s !== serverName);
  }

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  log("[McpManager] syncDisabledServersToClaudeSettings: wrote to", settingsPath);
}

export async function syncEnabledPluginsToClaudeSettings(pluginFullId: string, enabled: boolean): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  const settings = await readClaudeSettings();

  const enabledPlugins = (typeof settings["enabledPlugins"] === "object" && settings["enabledPlugins"] !== null)
    ? settings["enabledPlugins"] as Record<string, boolean>
    : {};

  enabledPlugins[pluginFullId] = enabled;
  settings["enabledPlugins"] = enabledPlugins;

  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  log("[PluginManager] syncEnabledPluginsToClaudeSettings: wrote to", settingsPath);
}

function formatPermissionPattern(rule: PermissionRuleValue): string {
  if (rule.ruleContent) {
    return `${rule.toolName}(${rule.ruleContent})`;
  }
  return rule.toolName;
}

function getSettingsPathForDestination(
  destination: PermissionUpdateDestination,
  workspacePath: string | null
): string {
  switch (destination) {
    case 'userSettings':
      return path.join(os.homedir(), ".claude", "settings.json");
    case 'projectSettings':
      if (workspacePath) {
        return path.join(workspacePath, ".claude", "settings.json");
      }
      return path.join(os.homedir(), ".claude", "settings.local.json");
    case 'localSettings':
    default:
      if (workspacePath) {
        return path.join(workspacePath, ".claude", "settings.local.json");
      }
      return path.join(os.homedir(), ".claude", "settings.local.json");
  }
}

async function readClaudeSettingsFromPath(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.promises.readFile(settingsPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function syncPermissionRulesToClaudeSettings(
  updates: PermissionUpdate[],
  workspacePath: string | null
): Promise<void> {
  for (const update of updates) {
    if (update.type !== 'addRules') continue;

    const settingsPath = getSettingsPathForDestination(update.destination, workspacePath);

    await queueSettingsWrite(settingsPath, async () => {
      const settings = await readClaudeSettingsFromPath(settingsPath);

      if (!settings['permissions'] || typeof settings['permissions'] !== 'object') {
        settings['permissions'] = {};
      }
      const permissions = settings['permissions'] as Record<string, unknown>;

      const arrayKey = update.behavior;
      if (!Array.isArray(permissions[arrayKey])) {
        permissions[arrayKey] = [];
      }
      const targetArray = permissions[arrayKey] as string[];

      for (const rule of update.rules) {
        const pattern = formatPermissionPattern(rule);
        if (!targetArray.includes(pattern)) {
          targetArray.push(pattern);
          log(`[PermissionSettings] Adding "${pattern}" to ${arrayKey} in ${settingsPath}`);
        }
      }

      await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      log(`[PermissionSettings] Wrote permissions to ${settingsPath}`);
    });
  }
}
