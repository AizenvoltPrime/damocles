import * as path from "path";
import * as os from "os";
import type { Disposable } from "../../platform/disposable";
import type { FileWatcher } from "../../platform/file-watcher";
import type { Platform } from "../../platform/platform";
import type { CustomSlashCommandInfo, SkillInfo, WithheldRootInfo } from "../../shared/types/commands";
import { ASSET_SOURCE_PRECEDENCE_SETTING, assetSources } from "../asset-sources";
import {
  discoverCommands,
  discoverSkills,
  findAsset,
  isRunnable,
  LinkTargetWatchers,
  mergeAssets,
  SKILL_FILE,
  SKILL_IGNORE_FILES,
  toMenuCommand,
  toMenuRoot,
  toMenuSkill,
  type DiscoveryOptions,
} from "../assets";
import { userConfigBase } from "../config/local-config-path";
import { log } from "../logger";
import { initPiLoader } from "../pi-session/pi-loader";

/** One scan's menu rows and the rows of the roots it found withheld whole. */
interface Scan<T> {
  readonly rows: T[];
  readonly roots: WithheldRootInfo[];
}

/** The whole `/` menu from one scan of each kind. */
export interface SlashMenu {
  readonly commands: CustomSlashCommandInfo[];
  readonly skills: SkillInfo[];
  readonly withheldRoots: WithheldRootInfo[];
}

export class SlashCommandService {
  private cache: Scan<CustomSlashCommandInfo> | null = null;
  private skillCache: Scan<SkillInfo> | null = null;
  /** Bumped by every invalidation; a scan that started under an older value is stale. */
  private generation = 0;
  private watchers: FileWatcher[] = [];
  private commandDebounceTimer: NodeJS.Timeout | null = null;
  private skillDebounceTimer: NodeJS.Timeout | null = null;
  private onCacheInvalidate?: () => void;
  private trustListener: Disposable | null = null;
  private configListener: Disposable | null = null;
  private readonly platform: Platform;
  // the targets the last scan of each kind followed through links, which the root watchers do not see
  private readonly commandTargets: LinkTargetWatchers;
  private readonly skillTargets: LinkTargetWatchers;

  /** The folder whose project assets are listed, or null for a target with no project scope. */
  private workspacePath: string | null;

  constructor(workspacePath: string | null, platform: Platform) {
    this.workspacePath = workspacePath;
    this.platform = platform;
    this.commandTargets = new LinkTargetWatchers(platform.fileWatchers, () => this.invalidateCommands());
    this.skillTargets = new LinkTargetWatchers(platform.fileWatchers, () => this.invalidateSkills());
    this.setupFileWatchers();
    // Both caches bake the `untrusted` flag in at scan time, so a trust change has to re-scan.
    this.trustListener = platform.trust.onDidChangeTrust(() => {
      this.invalidateAll();
    });
    // Precedence decides which source claims a contested name, and the winner is already in the cache.
    this.configListener = platform.settings.onDidChange(ASSET_SOURCE_PRECEDENCE_SETTING, () => {
      this.invalidateAll();
    });
  }

  private invalidateAll(): void {
    this.generation++;
    this.cache = null;
    this.skillCache = null;
    this.onCacheInvalidate?.();
  }

  setOnCacheInvalidate(callback: () => void): void {
    this.onCacheInvalidate = callback;
  }

  private addWatcher(base: string, glob: string, onChange: () => void): void {
    const watcher = this.platform.fileWatchers.watch(base, glob);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    this.watchers.push(watcher);
  }

  private invalidateCommands(): void {
    if (this.commandDebounceTimer) {
      clearTimeout(this.commandDebounceTimer);
    }
    this.commandDebounceTimer = setTimeout(() => {
      this.generation++;
      this.cache = null;
      log("Slash command cache invalidated due to file change");
      this.onCacheInvalidate?.();
    }, 300);
  }

  private invalidateSkills(): void {
    if (this.skillDebounceTimer) {
      clearTimeout(this.skillDebounceTimer);
    }
    this.skillDebounceTimer = setTimeout(() => {
      this.generation++;
      this.skillCache = null;
      log("Skill cache invalidated due to file change");
      this.onCacheInvalidate?.();
    }, 300);
  }

  private setupFileWatchers(): void {
    const invalidateCache = () => this.invalidateCommands();
    const invalidateSkillCache = () => this.invalidateSkills();

    // Project watchers stay registered in an untrusted workspace: the entries are still listed, just
    // badged, so an edit must still refresh the menu. A commands glob matches every entry, since a namespace link (commands/gs)
    // has no .md suffix and no watch enters a link.
    const workspacePath = this.workspacePath;
    // the skill walks read these at every level, so an ignore file's edit changes the skills listed
    const skillFiles = `{${[SKILL_FILE, ...SKILL_IGNORE_FILES].join(",")}}`;
    for (const source of assetSources()) {
      if (workspacePath !== null) {
        this.addWatcher(workspacePath, `${source.commands}/**`, invalidateCache);
        this.addWatcher(workspacePath, `${source.skills}/**/${skillFiles}`, invalidateSkillCache);
        this.addWatcher(workspacePath, `${source.skills}/*`, invalidateSkillCache);
      }

      // The user dirs sit outside every workspace folder, so only a watcher of their own fires. Each is based at the dir's
      // network-rule base (D10: the home folder or the Damocles data folder), so the watcher judges a link on its path.
      const home = os.homedir();
      const commandsBase = userConfigBase(path.join(home, source.commands), home);
      const skillsBase = userConfigBase(path.join(home, source.skills), home);
      const commandsDir = path.relative(commandsBase, path.join(home, source.commands)).split(path.sep).join("/");
      const skillsDir = path.relative(skillsBase, path.join(home, source.skills)).split(path.sep).join("/");
      this.addWatcher(commandsBase, `${commandsDir}/**`, invalidateCache);
      this.addWatcher(skillsBase, `${skillsDir}/**/${skillFiles}`, invalidateSkillCache);
      this.addWatcher(skillsBase, `${skillsDir}/*`, invalidateSkillCache);
    }
  }

  async getCommands(): Promise<CustomSlashCommandInfo[]> {
    return (await this.scanCommands()).rows;
  }

  private async scanCommands(): Promise<Scan<CustomSlashCommandInfo>> {
    if (this.cache) {
      return this.cache;
    }
    const generation = this.generation;
    const { commands, withheldRoots, followed } = await discoverCommands(await this.discoveryOptions());
    // An invalidation during the scan (a trust grant or revoke, a file change) leaves its result and its targets out of date.
    if (generation !== this.generation) return this.scanCommands();
    this.commandTargets.sync([...followed.project, ...followed.user]);
    this.cache = {
      rows: mergeAssets(commands).map(toMenuCommand).sort((a, b) => a.name.localeCompare(b.name)),
      roots: withheldRoots.map((root) => toMenuRoot(root, "commands")),
    };
    return this.cache;
  }

  /** The commands, the skills, and one row for each commands or skills folder a link withholds whole, each kind from one scan. */
  async getMenu(): Promise<SlashMenu> {
    const commands = await this.scanCommands();
    const skills = await this.scanSkills();
    return { commands: commands.rows, skills: skills.rows, withheldRoots: [...commands.roots, ...skills.roots] };
  }

  async getWithheldRoots(): Promise<WithheldRootInfo[]> {
    return (await this.getMenu()).withheldRoots;
  }

  private async discoveryOptions(): Promise<DiscoveryOptions> {
    const pi = await initPiLoader();
    if (pi === null) throw new Error("pi failed to load, so commands and skills cannot be read");
    return {
      workspacePath: this.workspacePath,
      homeDir: os.homedir(),
      trusted: this.workspacePath === null || this.platform.trust.isTrusted(this.workspacePath),
      parseFrontmatter: pi.parseFrontmatter,
      log: (line) => log("%s", line),
    };
  }

  async findSkill(name: string): Promise<SkillInfo | undefined> {
    const wanted = name.toLowerCase();
    const skills = await this.getSkills();
    return skills.find((s) => s.name.toLowerCase() === wanted);
  }

  /** The description of the runnable skill named name, as the menu shows it, for the skill approval prompt. */
  async describeSkill(name: string): Promise<string | undefined> {
    const skill = await this.findSkill(name);
    return skill !== undefined && isRunnable(skill) ? skill.description : undefined;
  }

  /** The command named name, or the withheld row of the namespace folder a namespaced name falls in. */
  async findCommand(name: string): Promise<CustomSlashCommandInfo | undefined> {
    return findAsset(await this.getCommands(), name);
  }

  async getSkills(): Promise<SkillInfo[]> {
    return (await this.scanSkills()).rows;
  }

  private async scanSkills(): Promise<Scan<SkillInfo>> {
    if (this.skillCache) {
      return this.skillCache;
    }
    const generation = this.generation;
    const { skills, withheldRoots, followed } = await discoverSkills(await this.discoveryOptions());
    if (generation !== this.generation) return this.scanSkills();
    this.skillTargets.sync([...followed.project, ...followed.user]);
    this.skillCache = {
      rows: mergeAssets(skills).map(toMenuSkill).sort((a, b) => a.name.localeCompare(b.name)),
      roots: withheldRoots.map((root) => toMenuRoot(root, "skills")),
    };
    return this.skillCache;
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.commandTargets.dispose();
    this.skillTargets.dispose();
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
