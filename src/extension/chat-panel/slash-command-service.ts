import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import type { CustomSlashCommandInfo, SkillInfo } from "../../shared/types/commands";
import { compatSources } from "../asset-sources";
import { log } from "../logger";

const SKILL_FILE = "SKILL.md";
const VALID_COMMAND_NAME = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

interface ParsedMarkdownFile {
  description: string;
  argumentHint?: string;
  name?: string;
}

export class SlashCommandService {
  private cache: CustomSlashCommandInfo[] | null = null;
  private skillCache: SkillInfo[] | null = null;
  private watchers: vscode.FileSystemWatcher[] = [];
  private commandDebounceTimer: NodeJS.Timeout | null = null;
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

  private addWatcher(pattern: vscode.GlobPattern, onChange: () => void): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    this.watchers.push(watcher);
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

    // Watch the project (RelativePattern) and user (absolute glob) command/skill folders for every
    // compat source (`.claude` + `.codex`). Order is irrelevant here — every watcher just invalidates
    // the cache — so iteration follows whatever `compatSources()` returns.
    for (const source of compatSources()) {
      const userCommandsGlob = `${path.join(os.homedir(), source.commands).replace(/\\/g, "/")}/**/*.md`;
      this.addWatcher(new vscode.RelativePattern(this.workspacePath, `${source.commands}/**/*.md`), invalidateCache);
      this.addWatcher(userCommandsGlob, invalidateCache);

      const userSkillsDir = path.join(os.homedir(), source.skills).replace(/\\/g, "/");
      this.addWatcher(new vscode.RelativePattern(this.workspacePath, `${source.skills}/**/${SKILL_FILE}`), invalidateSkillCache);
      this.addWatcher(new vscode.RelativePattern(this.workspacePath, `${source.skills}/*`), invalidateSkillCache);
      this.addWatcher(`${userSkillsDir}/**/${SKILL_FILE}`, invalidateSkillCache);
      this.addWatcher(`${userSkillsDir}/*`, invalidateSkillCache);
    }
  }

  async getCommands(): Promise<CustomSlashCommandInfo[]> {
    if (this.cache) {
      return this.cache;
    }

    const commands: CustomSlashCommandInfo[] = [];

    // Source precedence is primary; within each source, project outranks user. First-wins de-dup by
    // name, so an earlier scope/source keeps a name an equally-named later one would otherwise claim.
    for (const source of compatSources()) {
      const projectDir = path.join(this.workspacePath, source.commands);
      const userDir = path.join(os.homedir(), source.commands);
      for (const scoped of [
        ...(await this.scanDirectory(projectDir, "project")),
        ...(await this.scanDirectory(userDir, "user")),
      ]) {
        if (!commands.some((c) => c.name === scoped.name)) {
          commands.push(scoped);
        }
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
            ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
            filePath,
            source,
            ...(namespace !== undefined ? { namespace } : {}),
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
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1] ?? "";
      const body = frontmatterMatch[2] ?? "";

      const trimmedBody = body.trim();
      let description = "";
      let argumentHint: string | undefined;

      const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descriptionMatch?.[1]) {
        description = descriptionMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      const argumentHintMatch = frontmatter.match(/^argument-hint:\s*(.+)$/m);
      if (argumentHintMatch?.[1]) {
        argumentHint = argumentHintMatch[1].trim().replace(/^["']|["']$/g, "");
      }

      if (!description) {
        description = this.extractFirstLine(trimmedBody);
      }

      return {
        description,
        ...(argumentHint !== undefined ? { argumentHint } : {}),
      };
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
      .replace(/(^|\s)__(.+?)__(?=\s|$)/g, "$1$2")
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  }

  async isSkill(name: string): Promise<boolean> {
    const skills = await this.getSkills();
    return skills.some(s => s.name === name);
  }

  async getSkills(): Promise<SkillInfo[]> {
    if (this.skillCache) {
      return this.skillCache;
    }

    const skills: SkillInfo[] = [];

    // Same ordering as commands: source precedence primary, project before user, first-wins by name.
    for (const source of compatSources()) {
      const projectDir = path.join(this.workspacePath, source.skills);
      const userDir = path.join(os.homedir(), source.skills);
      for (const scoped of [
        ...(await this.scanSkillsDirectory(projectDir, "project")),
        ...(await this.scanSkillsDirectory(userDir, "user")),
      ]) {
        if (!skills.some((s) => s.name === scoped.name)) {
          skills.push(scoped);
        }
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

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    if (this.commandDebounceTimer) {
      clearTimeout(this.commandDebounceTimer);
      this.commandDebounceTimer = null;
    }
    if (this.skillDebounceTimer) {
      clearTimeout(this.skillDebounceTimer);
      this.skillDebounceTimer = null;
    }
  }
}
