import * as vscode from "vscode";
import type { PluginService } from "../../../PluginService";
import type { PluginConfig, PluginStatusInfo } from "../../../../shared/types/plugins";
import type { PostMessageFn, PluginEntry } from "../types";
import { syncEnabledPluginsToClaudeSettings } from "../utils";
import { readClaudeSettings } from "../../../claude-settings";
import { log } from "../../../logger";

export class PluginManager {
  private entries: PluginEntry[] = [];
  private configLoaded = false;
  private toggleLock: Promise<void> = Promise.resolve();
  private readonly postMessage: PostMessageFn;

  constructor(postMessage: PostMessageFn) {
    this.postMessage = postMessage;
  }

  async setPluginEnabled(pluginFullId: string, enabled: boolean): Promise<void> {
    const previousLock = this.toggleLock;
    let releaseLock: () => void;
    this.toggleLock = new Promise(resolve => { releaseLock = resolve; });

    try {
      await previousLock;

      await syncEnabledPluginsToClaudeSettings(pluginFullId, enabled);

      const entry = this.entries.find(e => e.fullId === pluginFullId);
      if (entry) {
        entry.enabled = enabled;
      } else {
        log("[PluginManager] setPluginEnabled: entry not found for", pluginFullId);
      }
    } finally {
      releaseLock!();
    }
  }

  getEnabledPlugins(): PluginConfig[] {
    return this.entries
      .filter(entry => entry.enabled)
      .map(entry => ({ type: "local" as const, path: entry.path }));
  }

  getEnabledPluginIds(): Set<string> {
    return new Set(
      this.entries
        .filter(entry => entry.enabled)
        .map(entry => entry.fullId)
    );
  }

  getPluginsForUI(): PluginStatusInfo[] {
    return this.entries.map(entry => ({
      name: entry.name,
      fullId: entry.fullId,
      path: entry.path,
      status: entry.enabled ? "idle" : "disabled",
      enabled: entry.enabled,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    }));
  }

  getConfigLoaded(): boolean {
    return this.configLoaded;
  }

  async loadConfig(pluginService: PluginService): Promise<void> {
    const plugins = await pluginService.getPlugins();
    const claudeSettings = await readClaudeSettings();
    const enabledPlugins = (typeof claudeSettings["enabledPlugins"] === "object" && claudeSettings["enabledPlugins"] !== null)
      ? claudeSettings["enabledPlugins"] as Record<string, boolean>
      : {};

    this.entries = plugins.map(plugin => ({
      name: plugin.name,
      fullId: plugin.fullId,
      path: plugin.path,
      ...(plugin.version !== undefined ? { version: plugin.version } : {}),
      ...(plugin.description !== undefined ? { description: plugin.description } : {}),
      enabled: enabledPlugins[plugin.fullId] !== false,
    }));
    this.configLoaded = true;
  }

  sendConfig(panel: vscode.WebviewPanel): void {
    this.postMessage(panel, { type: "pluginConfigUpdate", plugins: this.getPluginsForUI() });
  }
}
