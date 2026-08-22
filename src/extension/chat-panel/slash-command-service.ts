import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { ASSET_SEGMENT_RE, INVOCABLE_ASSET_NAME_RE } from "../../shared/asset-names";
import type { CustomSlashCommandInfo, SkillInfo } from "../../shared/types/commands";
import { assetSourceDirs, assetSources } from "../asset-sources";
import { log } from "../logger";

const SKILL_FILE = "SKILL.md";

/**
 * One frontmatter scalar, or undefined when the key is absent or its value is blank. The key's own
 * regex must keep its horizontal-space class off `\s`, since `\s` spans the line break and would take
 * the next key's line as this key's value.
 */
function scalar(match: RegExpMatchArray | null): string | undefined {
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
  return value === undefined || value === "" ? undefined : value;
}

interface ParsedMarkdownFile {
  description: string;
  argumentHint?: string;
  /** The frontmatter `name:`, which overrides the on-disk name. */
  name?: string;
}

export class SlashCommandService {
  private cache: CustomSlashCommandInfo[] | null = null;
  private skillCache: SkillInfo[] | null = null;
  private watchers: vscode.FileSystemWatcher[] = [];
  private commandDebounceTimer: NodeJS.Timeout | null = null;
  private skillDebounceTimer: NodeJS.Timeout | null = null;
  private onCacheInvalidate?: () => void;
  private trustListener: vscode.Disposable | null = null;
  private configListener: vscode.Disposable | null = null;

  /** The open workspace folder, or null when none is open, in which case there is no project scope. */
  private workspacePath: string | null;

  constructor(workspacePath: string | null) {
    this.workspacePath = workspacePath;
    this.setupFileWatchers();
    // Both caches bake the `untrusted` flag in at scan time, so granting trust has to re-scan for the
    // badges to clear.
    this.trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.invalidateAll();
    });
    // Precedence decides which source claims a contested name, and the winner is already in the cache.
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("damocles.assetSourcePrecedence")) return;
      this.invalidateAll();
    });
  }

  private invalidateAll(): void {
    this.cache = null;
    this.skillCache = null;
    this.onCacheInvalidate?.();
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

    // Project watchers stay registered in an untrusted workspace: the entries are still listed, just
    // badged, so an edit must still refresh the menu.
    const workspacePath = this.workspacePath;
    for (const source of assetSources()) {
      if (workspacePath !== null) {
        this.addWatcher(new vscode.RelativePattern(workspacePath, `${source.commands}/**/*.md`), invalidateCache);
        this.addWatcher(new vscode.RelativePattern(workspacePath, `${source.skills}/**/${SKILL_FILE}`), invalidateSkillCache);
        this.addWatcher(new vscode.RelativePattern(workspacePath, `${source.skills}/*`), invalidateSkillCache);
      }

      // The user dirs sit outside every workspace folder, and a plain string glob reports no event
      // from there. Anchoring the pattern on the dir's own Uri is what makes these fire.
      const userCommandsDir = vscode.Uri.file(path.join(os.homedir(), source.commands));
      const userSkillsDir = vscode.Uri.file(path.join(os.homedir(), source.skills));
      this.addWatcher(new vscode.RelativePattern(userCommandsDir, "**/*.md"), invalidateCache);
      this.addWatcher(new vscode.RelativePattern(userSkillsDir, `**/${SKILL_FILE}`), invalidateSkillCache);
      this.addWatcher(new vscode.RelativePattern(userSkillsDir, "*"), invalidateSkillCache);
    }
  }

  async getCommands(): Promise<CustomSlashCommandInfo[]> {
    if (this.cache) {
      return this.cache;
    }

    const byName = new Map<string, CustomSlashCommandInfo>();
    const untrusted = !vscode.workspace.isTrusted;

    // `assetSourceDirs` fixes the order (source-major, project before user). De-dup is first-wins on
    // the lowercased name, since a case-insensitive filesystem would otherwise hand out two rows for
    // one file. One exception to first-wins: an untrusted entry is inert, so it must not displace a
    // working one a later source or scope provides, though it still claims the name when nothing
    // unflagged does.
    for (const { dir, scope } of assetSourceDirs("commands", {
      workspacePath: this.workspacePath,
      homeDir: os.homedir(),
    })) {
      for (const scoped of await this.scanDirectory(dir, scope, untrusted && scope === "project")) {
        const key = scoped.name.toLowerCase();
        const claimed = byName.get(key);
        if (claimed === undefined || (claimed.untrusted === true && scoped.untrusted !== true)) {
          byName.set(key, scoped);
        }
      }
    }

    const commands = [...byName.values()];
    commands.sort((a, b) => a.name.localeCompare(b.name));

    this.cache = commands;
    return commands;
  }

  private async scanDirectory(
    dir: string,
    source: "project" | "user",
    untrusted: boolean
  ): Promise<CustomSlashCommandInfo[]> {
    const commands: CustomSlashCommandInfo[] = [];

    try {
      await fs.promises.access(dir, fs.constants.R_OK);
    } catch {
      return commands;
    }

    const rootCommands = await this.scanDirectoryFiles(dir, source, untrusted, undefined);
    commands.push(...rootCommands);

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subdir = path.join(dir, entry.name);
          const subdirCommands = await this.scanDirectoryFiles(
            subdir,
            source,
            untrusted,
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
    untrusted: boolean,
    namespace: string | undefined
  ): Promise<CustomSlashCommandInfo[]> {
    const commands: CustomSlashCommandInfo[] = [];

    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const file = entry.name;
        if (!file.endsWith(".md")) continue;
        // The menu runs against untrusted content, so it never reads through a link out of the tree.
        if (entry.isSymbolicLink() || !entry.isFile()) continue;

        const stem = file.replace(/\.md$/, "");
        const commandName = namespace ? `${namespace}:${stem}` : stem;
        if (!INVOCABLE_ASSET_NAME_RE.test(commandName)) {
          log(`Skipping invalid command name: ${commandName}`);
          continue;
        }

        const filePath = path.join(dir, file);

        try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          const parsed = this.parseMarkdownFile(content);

          commands.push({
            name: commandName,
            description: parsed.description,
            ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
            filePath,
            source,
            ...(untrusted ? { untrusted: true } : {}),
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

      const argumentHint = scalar(frontmatter.match(/^argument-hint:[ \t]*(.+)$/m));
      const name = scalar(frontmatter.match(/^name:[ \t]*(.+)$/m));
      const description =
        scalar(frontmatter.match(/^description:[ \t]*(.+)$/m)) ?? this.extractFirstLine(trimmedBody);

      return {
        description,
        ...(argumentHint !== undefined ? { argumentHint } : {}),
        ...(name !== undefined ? { name } : {}),
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

  async findSkill(name: string): Promise<SkillInfo | undefined> {
    const wanted = name.toLowerCase();
    const skills = await this.getSkills();
    return skills.find((s) => s.name.toLowerCase() === wanted);
  }

  async findCommand(name: string): Promise<CustomSlashCommandInfo | undefined> {
    const wanted = name.toLowerCase();
    const commands = await this.getCommands();
    return commands.find((c) => c.name.toLowerCase() === wanted);
  }

  async getSkills(): Promise<SkillInfo[]> {
    if (this.skillCache) {
      return this.skillCache;
    }

    const byName = new Map<string, SkillInfo>();
    const untrusted = !vscode.workspace.isTrusted;

    // Same ordering and de-dup rule as commands, including the untrusted exception.
    for (const { dir, scope } of assetSourceDirs("skills", {
      workspacePath: this.workspacePath,
      homeDir: os.homedir(),
    })) {
      for (const scoped of await this.scanSkillsDirectory(dir, scope, untrusted && scope === "project")) {
        const key = scoped.name.toLowerCase();
        const claimed = byName.get(key);
        if (claimed === undefined || (claimed.untrusted === true && scoped.untrusted !== true)) {
          byName.set(key, scoped);
        }
      }
    }

    const skills = [...byName.values()];
    skills.sort((a, b) => a.name.localeCompare(b.name));

    this.skillCache = skills;
    return skills;
  }

  private async scanSkillsDirectory(
    dir: string,
    source: "project" | "user",
    untrusted: boolean
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
        if (!ASSET_SEGMENT_RE.test(entry.name)) continue;

        const skillFilePath = path.join(dir, entry.name, SKILL_FILE);

        try {
          // Reading through a link here would put a file from outside the skills tree in the menu.
          const stat = await fs.promises.lstat(skillFilePath);
          if (!stat.isFile()) continue;

          const content = await fs.promises.readFile(skillFilePath, "utf-8");
          const parsed = this.parseMarkdownFile(content);
          // The agent loads the skill under its frontmatter name, so the menu has to pre-approve and
          // invoke it under that same name or the two disagree.
          const name = parsed.name ?? entry.name;
          if (!ASSET_SEGMENT_RE.test(name)) {
            log(`Skipping skill in ${entry.name}: invalid name "${name}"`);
            continue;
          }

          skills.push({
            name,
            description: parsed.description,
            filePath: skillFilePath,
            source,
            ...(untrusted ? { untrusted: true } : {}),
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
    this.trustListener?.dispose();
    this.trustListener = null;
    this.configListener?.dispose();
    this.configListener = null;
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
