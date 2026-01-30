import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { CustomSlashCommandInfo, PluginSlashCommandInfo, SkillInfo, PluginSkillInfo } from "../shared/types/commands";
import { log } from "./logger";

const COMMANDS_FOLDER = ".claude/commands";
const SKILLS_FOLDER = ".claude/skills";
const SKILL_FILE = "SKILL.md";
const PLUGINS_FOLDER = ".claude/plugins";
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";
const VALID_COMMAND_NAME = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

interface ParsedMarkdownFile {
  description: string;
  argumentHint?: string;
  name?: string;
}

interface InstalledPluginEntry {
  scope: "user" | "project";
  projectPath?: string;
  installPath: string;
  version: string;
}

interface InstalledPluginsRegistry {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

export class SlashCommandService {
  private cache: CustomSlashCommandInfo[] | null = null;
  private pluginCache: PluginSlashCommandInfo[] | null = null;
  private skillCache: SkillInfo[] | null = null;
  private pluginSkillCache: PluginSkillInfo[] | null = null;
  private projectWatcher: vscode.FileSystemWatcher | null = null;
  private userWatcher: vscode.FileSystemWatcher | null = null;
  private pluginWatcher: vscode.FileSystemWatcher | null = null;
  private projectSkillWatcher: vscode.FileSystemWatcher | null = null;
  private userSkillWatcher: vscode.FileSystemWatcher | null = null;
  private projectSkillDirWatcher: vscode.FileSystemWatcher | null = null;
  private userSkillDirWatcher: vscode.FileSystemWatcher | null = null;
  private commandDebounceTimer: NodeJS.Timeout | null = null;
  private pluginDebounceTimer: NodeJS.Timeout | null = null;
  private skillDebounceTimer: NodeJS.Timeout | null = null;
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
      if (this.commandDebounceTimer) {
        clearTimeout(this.commandDebounceTimer);
      }
      this.commandDebounceTimer = setTimeout(() => {
        this.cache = null;
        log("Slash command cache invalidated due to file change");
        this.onCacheInvalidate?.();
      }, 300);
    };

    const invalidatePluginCache = () => {
      if (this.pluginDebounceTimer) {
        clearTimeout(this.pluginDebounceTimer);
      }
      this.pluginDebounceTimer = setTimeout(() => {
        this.pluginCache = null;
        this.pluginSkillCache = null;
        log("Plugin command/skill cache invalidated due to file change");
        this.onCacheInvalidate?.();
      }, 300);
    };

    const invalidateSkillCache = () => {
      if (this.skillDebounceTimer) {
        clearTimeout(this.skillDebounceTimer);
      }
      this.skillDebounceTimer = setTimeout(() => {
        this.skillCache = null;
        log("Skill cache invalidated due to file change");
        this.onCacheInvalidate?.();
      }, 300);
    };

    const projectPattern = new vscode.RelativePattern(
      this.workspacePath,
      `${COMMANDS_FOLDER}/**/*.md`
    );
    this.projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
    this.projectWatcher.onDidCreate(invalidateCache);
    this.projectWatcher.onDidChange(invalidateCache);
    this.projectWatcher.onDidDelete(invalidateCache);

    const userCommandsPath = path.join(os.homedir(), COMMANDS_FOLDER);
    const userPattern = `${userCommandsPath.replace(/\\/g, "/")}/**/*.md`;
    this.userWatcher = vscode.workspace.createFileSystemWatcher(userPattern);
    this.userWatcher.onDidCreate(invalidateCache);
    this.userWatcher.onDidChange(invalidateCache);
    this.userWatcher.onDidDelete(invalidateCache);

    const registryPath = path.join(os.homedir(), PLUGINS_FOLDER, INSTALLED_PLUGINS_FILE);
    this.pluginWatcher = vscode.workspace.createFileSystemWatcher(registryPath.replace(/\\/g, "/"));
    this.pluginWatcher.onDidCreate(invalidatePluginCache);
    this.pluginWatcher.onDidChange(invalidatePluginCache);
    this.pluginWatcher.onDidDelete(invalidatePluginCache);

    const projectSkillPattern = new vscode.RelativePattern(
      this.workspacePath,
      `${SKILLS_FOLDER}/**/${SKILL_FILE}`
    );
    this.projectSkillWatcher = vscode.workspace.createFileSystemWatcher(projectSkillPattern);
    this.projectSkillWatcher.onDidCreate(invalidateSkillCache);
    this.projectSkillWatcher.onDidChange(invalidateSkillCache);
    this.projectSkillWatcher.onDidDelete(invalidateSkillCache);

    const projectSkillDirPattern = new vscode.RelativePattern(
      this.workspacePath,
      `${SKILLS_FOLDER}/*`
    );
    this.projectSkillDirWatcher = vscode.workspace.createFileSystemWatcher(projectSkillDirPattern);
    this.projectSkillDirWatcher.onDidCreate(invalidateSkillCache);
    this.projectSkillDirWatcher.onDidDelete(invalidateSkillCache);

    const userSkillsPath = path.join(os.homedir(), SKILLS_FOLDER);
    const userSkillPattern = `${userSkillsPath.replace(/\\/g, "/")}/**/${SKILL_FILE}`;
    this.userSkillWatcher = vscode.workspace.createFileSystemWatcher(userSkillPattern);
    this.userSkillWatcher.onDidCreate(invalidateSkillCache);
    this.userSkillWatcher.onDidChange(invalidateSkillCache);
    this.userSkillWatcher.onDidDelete(invalidateSkillCache);

    const userSkillDirPattern = `${userSkillsPath.replace(/\\/g, "/")}/*`;
    this.userSkillDirWatcher = vscode.workspace.createFileSystemWatcher(userSkillDirPattern);
    this.userSkillDirWatcher.onDidCreate(invalidateSkillCache);
    this.userSkillDirWatcher.onDidDelete(invalidateSkillCache);
  }

  async getCommands(): Promise<CustomSlashCommandInfo[]> {
    if (this.cache) {
      return this.cache;
    }

    const commands: CustomSlashCommandInfo[] = [];

    const projectCommandsDir = path.join(this.workspacePath, COMMANDS_FOLDER);
    const projectCommands = await this.scanDirectory(projectCommandsDir, "project");
    commands.push(...projectCommands);

    const userCommandsDir = path.join(os.homedir(), COMMANDS_FOLDER);
    const userCommands = await this.scanDirectory(userCommandsDir, "user");

    for (const userCmd of userCommands) {
      const exists = commands.some((c) => c.name === userCmd.name);
      if (!exists) {
        commands.push(userCmd);
      }
    }

    commands.sort((a, b) => a.name.localeCompare(b.name));

    this.cache = commands;
    return commands;
  }

  private async scanDirectory(
    dir: string,
    source: "project" | "user"
  ): Promise<CustomSlashCommandInfo[]> {
    const commands: CustomSlashCommandInfo[] = [];

    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      return commands;
    }

    const rootCommands = await this.scanDirectoryFiles(dir, source, undefined);
    commands.push(...rootCommands);

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subdir = path.join(dir, entry.name);
          const subdirCommands = await this.scanDirectoryFiles(
            subdir,
            source,
            entry.name
          );
          commands.push(...subdirCommands);
        }
      }
    } catch (err) {
      log(`Error scanning subdirectories in ${dir}: ${err}`);
    }

    return commands;
  }

  private async scanDirectoryFiles(
    dir: string,
    source: "project" | "user",
    namespace: string | undefined
  ): Promise<CustomSlashCommandInfo[]> {
    const commands: CustomSlashCommandInfo[] = [];

    try {
      const files = await fs.promises.readdir(dir);

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const commandName = file.replace(/\.md$/, "");
        if (!VALID_COMMAND_NAME.test(commandName)) {
          log(`Skipping invalid command name: ${commandName}`);
          continue;
        }

        const filePath = path.join(dir, file);

        try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          const parsed = this.parseMarkdownFile(content);

          commands.push({
            name: namespace ? `${namespace}:${commandName}` : commandName,
            description: parsed.description,
            argumentHint: parsed.argumentHint,
            filePath,
            source,
            namespace,
          });
        } catch (err) {
          log(`Error reading command file ${filePath}: ${err}`);
        }
      }
    } catch (err) {
      log(`Error scanning directory ${dir}: ${err}`);
    }

    return commands;
  }

  private parseMarkdownFile(content: string): ParsedMarkdownFile {
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const body = frontmatterMatch[2].trim();

      let description = "";
      let argumentHint: string | undefined;

      const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descriptionMatch) {
        description = descriptionMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      const argumentHintMatch = frontmatter.match(/^argument-hint:\s*(.+)$/m);
      if (argumentHintMatch) {
        argumentHint = argumentHintMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      if (!description) {
        description = this.extractFirstLine(body);
      }

      return { description, argumentHint };
    }

    const body = content.trim();
    const description = this.extractFirstLine(body);
    return { description };
  }

  private extractFirstLine(content: string): string {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return this.stripMarkdownFormatting(trimmed).slice(0, 100);
      }
    }
    return "No description";
  }

  private stripMarkdownFormatting(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/_(.+?)_/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }

  async getPluginCommands(enabledPluginIds?: Set<string>): Promise<PluginSlashCommandInfo[]> {
    if (!this.pluginCache) {
      const commands: PluginSlashCommandInfo[] = [];
      const registryPath = path.join(os.homedir(), PLUGINS_FOLDER, INSTALLED_PLUGINS_FILE);

      try {
        const content = await fs.promises.readFile(registryPath, "utf-8");
        const registry = JSON.parse(content) as InstalledPluginsRegistry;

        for (const [fullName, entries] of Object.entries(registry.plugins)) {
          for (const entry of entries) {
            if (entry.scope === "project" && entry.projectPath !== this.workspacePath) {
              continue;
            }

            const pluginCommands = await this.scanPluginCommands(entry.installPath, fullName);
            commands.push(...pluginCommands);
          }
        }
      } catch (err) {
        const isFileNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        if (!isFileNotFound) {
          log(`Error reading plugins registry for commands: ${err}`);
        }
      }

      commands.sort((a, b) => a.name.localeCompare(b.name));
      this.pluginCache = commands;
    }

    if (enabledPluginIds) {
      return this.pluginCache.filter(cmd => enabledPluginIds.has(cmd.pluginFullId));
    }
    return this.pluginCache;
  }

  private async scanPluginCommands(pluginPath: string, pluginFullId: string): Promise<PluginSlashCommandInfo[]> {
    const pluginShortName = pluginFullId.split("@")[0];
    const commandsDir = path.join(pluginPath, "commands");
    return this.scanPluginCommandsDir(commandsDir, pluginShortName, pluginFullId);
  }

  private async scanPluginCommandsDir(dir: string, pluginShortName: string, pluginFullId: string): Promise<PluginSlashCommandInfo[]> {
    const commands: PluginSlashCommandInfo[] = [];

    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      return commands;
    }

    try {
      const files = await fs.promises.readdir(dir);

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const commandName = file.replace(/\.md$/, "");
        if (!VALID_COMMAND_NAME.test(commandName)) {
          continue;
        }

        const filePath = path.join(dir, file);

        try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          const parsed = this.parseMarkdownFile(content);

          commands.push({
            name: `${pluginShortName}:${commandName}`,
            description: parsed.description,
            argumentHint: parsed.argumentHint,
            filePath,
            source: "plugin",
            pluginName: pluginShortName,
            pluginFullId,
          });
        } catch (err) {
          log(`Error reading plugin command file ${filePath}: ${err}`);
        }
      }
    } catch (err) {
      log(`Error scanning plugin commands directory ${dir}: ${err}`);
    }

    return commands;
  }

  async isSkill(name: string, enabledPluginIds?: Set<string>): Promise<boolean> {
    const skills = await this.getSkills();
    const pluginSkills = await this.getPluginSkills(enabledPluginIds);
    return skills.some(s => s.name === name) || pluginSkills.some(s => s.name === name);
  }

  async getSkills(): Promise<SkillInfo[]> {
    if (this.skillCache) {
      return this.skillCache;
    }

    const skills: SkillInfo[] = [];

    const projectSkillsDir = path.join(this.workspacePath, SKILLS_FOLDER);
    const projectSkills = await this.scanSkillsDirectory(projectSkillsDir, "project");
    skills.push(...projectSkills);

    const userSkillsDir = path.join(os.homedir(), SKILLS_FOLDER);
    const userSkills = await this.scanSkillsDirectory(userSkillsDir, "user");

    for (const userSkill of userSkills) {
      const exists = skills.some((s) => s.name === userSkill.name);
      if (!exists) {
        skills.push(userSkill);
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));

    this.skillCache = skills;
    return skills;
  }

  private async scanSkillsDirectory(
    dir: string,
    source: "project" | "user"
  ): Promise<SkillInfo[]> {
    const skills: SkillInfo[] = [];

    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      return skills;
    }

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!VALID_COMMAND_NAME.test(entry.name)) continue;

        const skillFilePath = path.join(dir, entry.name, SKILL_FILE);

        try {
          const content = await fs.promises.readFile(skillFilePath, "utf-8");
          const parsed = this.parseMarkdownFile(content);

          skills.push({
            name: entry.name,
            description: parsed.description,
            filePath: skillFilePath,
            source,
          });
        } catch {
          // SKILL.md doesn't exist or isn't readable - skip
        }
      }
    } catch (err) {
      log(`Error scanning skills directory ${dir}: ${err}`);
    }

    return skills;
  }

  async getPluginSkills(enabledPluginIds?: Set<string>): Promise<PluginSkillInfo[]> {
    if (!this.pluginSkillCache) {
      const skills: PluginSkillInfo[] = [];
      const registryPath = path.join(os.homedir(), PLUGINS_FOLDER, INSTALLED_PLUGINS_FILE);

      try {
        const content = await fs.promises.readFile(registryPath, "utf-8");
        const registry = JSON.parse(content) as InstalledPluginsRegistry;

        for (const [fullName, entries] of Object.entries(registry.plugins)) {
          for (const entry of entries) {
            if (entry.scope === "project" && entry.projectPath !== this.workspacePath) {
              continue;
            }

            const pluginSkills = await this.scanPluginSkills(entry.installPath, fullName);
            skills.push(...pluginSkills);
          }
        }
      } catch (err) {
        const isFileNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        if (!isFileNotFound) {
          log(`Error reading plugins registry for skills: ${err}`);
        }
      }

      skills.sort((a, b) => a.name.localeCompare(b.name));
      this.pluginSkillCache = skills;
    }

    if (enabledPluginIds) {
      return this.pluginSkillCache.filter(skill => enabledPluginIds.has(skill.pluginFullId));
    }
    return this.pluginSkillCache;
  }

  private async scanPluginSkills(pluginPath: string, pluginFullId: string): Promise<PluginSkillInfo[]> {
    const skills: PluginSkillInfo[] = [];
    const pluginShortName = pluginFullId.split("@")[0];
    const skillsDir = path.join(pluginPath, "skills");

    try {
      await fs.promises.access(skillsDir, fs.constants.R_OK);
    } catch {
      return skills;
    }

    try {
      const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!VALID_COMMAND_NAME.test(entry.name)) continue;

        const skillFilePath = path.join(skillsDir, entry.name, SKILL_FILE);

        try {
          const content = await fs.promises.readFile(skillFilePath, "utf-8");
          const parsed = this.parseMarkdownFile(content);

          skills.push({
            name: `${pluginShortName}:${entry.name}`,
            description: parsed.description,
            filePath: skillFilePath,
            source: "plugin",
            pluginName: pluginShortName,
            pluginFullId,
          });
        } catch {
          // SKILL.md doesn't exist or isn't readable - skip
        }
      }
    } catch (err) {
      log(`Error scanning plugin skills directory ${skillsDir}: ${err}`);
    }

    return skills;
  }

  dispose(): void {
    if (this.projectWatcher) {
      this.projectWatcher.dispose();
      this.projectWatcher = null;
    }
    if (this.userWatcher) {
      this.userWatcher.dispose();
      this.userWatcher = null;
    }
    if (this.pluginWatcher) {
      this.pluginWatcher.dispose();
      this.pluginWatcher = null;
    }
    if (this.projectSkillWatcher) {
      this.projectSkillWatcher.dispose();
      this.projectSkillWatcher = null;
    }
    if (this.userSkillWatcher) {
      this.userSkillWatcher.dispose();
      this.userSkillWatcher = null;
    }
    if (this.projectSkillDirWatcher) {
      this.projectSkillDirWatcher.dispose();
      this.projectSkillDirWatcher = null;
    }
    if (this.userSkillDirWatcher) {
      this.userSkillDirWatcher.dispose();
      this.userSkillDirWatcher = null;
    }
    if (this.commandDebounceTimer) {
      clearTimeout(this.commandDebounceTimer);
      this.commandDebounceTimer = null;
    }
    if (this.pluginDebounceTimer) {
      clearTimeout(this.pluginDebounceTimer);
      this.pluginDebounceTimer = null;
    }
    if (this.skillDebounceTimer) {
      clearTimeout(this.skillDebounceTimer);
      this.skillDebounceTimer = null;
    }
  }
}
