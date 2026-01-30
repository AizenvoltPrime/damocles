import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  getClaudeSettingsPath,
  readClaudeSettings,
} from "../../claude-settings";
import { log } from "../../logger";

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
