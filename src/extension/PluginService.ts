import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { PluginInfo } from "../shared/types/plugins";
import { log } from "./logger";

const PLUGINS_FOLDER = ".claude/plugins";
const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
}

interface InstalledPluginEntry {
  scope: "user" | "project";
  projectPath?: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  isLocal: boolean;
}

interface InstalledPluginsRegistry {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

export class PluginService {
  private cache: PluginInfo[] | null = null;
  private registryWatcher: vscode.FileSystemWatcher | null = null;
  private projectWatcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private onCacheInvalidate?: () => void;

  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.setupFileWatchers();
  }

  setOnCacheInvalidate(callback: () => void): void {
    this.onCacheInvalidate = callback;
  }

  private setupFileWatchers(): void {
    const invalidateCache = () => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.cache = null;
        log("Plugin cache invalidated due to file change");
        this.onCacheInvalidate?.();
      }, 300);
    };

    const registryPath = path.join(os.homedir(), PLUGINS_FOLDER, INSTALLED_PLUGINS_FILE);
    this.registryWatcher = vscode.workspace.createFileSystemWatcher(registryPath.replace(/\\/g, "/"));
    this.registryWatcher.onDidCreate(invalidateCache);
    this.registryWatcher.onDidChange(invalidateCache);
    this.registryWatcher.onDidDelete(invalidateCache);

    const projectPattern = new vscode.RelativePattern(
      this.workspacePath,
      `${PLUGINS_FOLDER}/**/${PLUGIN_MANIFEST}`
    );
    this.projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
    this.projectWatcher.onDidCreate(invalidateCache);
    this.projectWatcher.onDidChange(invalidateCache);
    this.projectWatcher.onDidDelete(invalidateCache);
  }

  async getPlugins(): Promise<PluginInfo[]> {
    if (this.cache) {
      return this.cache;
    }

    const plugins: PluginInfo[] = [];
    const seenNames = new Set<string>();

    const registryPlugins = await this.loadFromRegistry();
    for (const plugin of registryPlugins) {
      if (!seenNames.has(plugin.name)) {
        plugins.push(plugin);
        seenNames.add(plugin.name);
      }
    }

    const projectPluginsDir = path.join(this.workspacePath, PLUGINS_FOLDER);
    const manualPlugins = await this.scanManualPlugins(projectPluginsDir);
    for (const plugin of manualPlugins) {
      if (!seenNames.has(plugin.name)) {
        plugins.push(plugin);
        seenNames.add(plugin.name);
      }
    }

    plugins.sort((a, b) => a.name.localeCompare(b.name));

    this.cache = plugins;
    return plugins;
  }

  private async loadFromRegistry(): Promise<PluginInfo[]> {
    const plugins: PluginInfo[] = [];
    const registryPath = path.join(os.homedir(), PLUGINS_FOLDER, INSTALLED_PLUGINS_FILE);

    try {
      await fs.promises.access(registryPath, fs.constants.R_OK);
    } catch {
      return plugins;
    }

    try {
      const content = await fs.promises.readFile(registryPath, "utf-8");
      const registry = JSON.parse(content) as InstalledPluginsRegistry;

      for (const [fullName, entries] of Object.entries(registry.plugins)) {
        for (const entry of entries) {
          if (entry.scope === "project" && entry.projectPath !== this.workspacePath) {
            continue;
          }

          const manifestPath = path.join(entry.installPath, PLUGIN_MANIFEST);
          try {
            await fs.promises.access(manifestPath, fs.constants.R_OK);
            const manifestContent = await fs.promises.readFile(manifestPath, "utf-8");
            const manifest = JSON.parse(manifestContent) as PluginManifest;

            const shortName = fullName.split("@")[0] ?? fullName;
            const version = manifest.version || entry.version;
            plugins.push({
              name: manifest.name || shortName,
              fullId: fullName,
              path: entry.installPath,
              ...(version !== undefined ? { version } : {}),
              ...(manifest.description !== undefined ? { description: manifest.description } : {}),
            });
          } catch (err) {
            log(`Skipping plugin ${fullName}: ${err}`);
          }
        }
      }
    } catch (err) {
      log(`Error reading plugins registry: ${err}`);
    }

    return plugins;
  }

  private async scanManualPlugins(dir: string): Promise<PluginInfo[]> {
    const plugins: PluginInfo[] = [];

    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      return plugins;
    }

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "cache" || entry.name === "marketplaces") continue;

        const pluginDir = path.join(dir, entry.name);
        const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST);

        try {
          await fs.promises.access(manifestPath, fs.constants.R_OK);
          const manifestContent = await fs.promises.readFile(manifestPath, "utf-8");
          const manifest = JSON.parse(manifestContent) as PluginManifest;

          const pluginName = manifest.name || entry.name;
          plugins.push({
            name: pluginName,
            fullId: pluginName,
            path: pluginDir,
            ...(manifest.version !== undefined ? { version: manifest.version } : {}),
            ...(manifest.description !== undefined ? { description: manifest.description } : {}),
          });
        } catch {
          // Not a valid plugin directory, skip silently
        }
      }
    } catch (err) {
      log(`Error scanning manual plugins directory ${dir}: ${err}`);
    }

    return plugins;
  }

  dispose(): void {
    if (this.registryWatcher) {
      this.registryWatcher.dispose();
      this.registryWatcher = null;
    }
    if (this.projectWatcher) {
      this.projectWatcher.dispose();
      this.projectWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
