import * as path from 'node:path';
import { isHostEnvEntry, MAX_HOST_ENV_ENTRIES, parseHostMessage, type HostMessage, type HostRequest } from '../../pty-host/protocol';
import {
  MAX_TERMINAL_ACK_CHARS,
  MAX_TERMINAL_GROUP_PANES,
  MAX_TERMINAL_NAME_LENGTH,
  MIN_TERMINAL_PANE_FRACTION,
  TERMINAL_COLORS,
  TERMINAL_CUSTOM_ICONS,
  TERMINAL_LIST_DEFAULT_REM,
  TERMINAL_LIST_MAX_REM,
  TERMINAL_LIST_MIN_REM,
  TERMINAL_PANE_SIZES_EPSILON,
  type TerminalColor,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalCustomIcon,
  type TerminalData,
  type TerminalGroupInfo,
  type TerminalInfo,
  type TerminalProfileOption,
  type TerminalProjectOption,
  type TerminalSettings,
  type TerminalShellEventAt,
  type TerminalState,
  type TerminalStatus,
} from '../../preload/terminal-channels';
import type { SettingsStore } from '../../../platform/settings-store';
import {
  DESKTOP_CONFIGURATION,
  isDesktopSettingValue,
  TERMINAL_CONFIRM_ON_KILL_SETTING,
  TERMINAL_CURSOR_BLINKING_SETTING,
  TERMINAL_CURSOR_STYLE_SETTING,
  TERMINAL_DECORATIONS_SETTING,
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_FONT_FAMILY_SETTING,
  TERMINAL_FONT_SIZE_SETTING,
  TERMINAL_LINE_HEIGHT_SETTING,
  TERMINAL_MAC_OPTION_IS_META_SETTING,
  TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING,
  TERMINAL_SCROLLBACK_SETTING,
  TERMINAL_SHELL_INTEGRATION_SETTING,
  type TerminalConfirmOnKill,
  type TerminalCursorStyle,
  type TerminalMultiLinePasteWarning,
} from '../desktop-configuration';
import { terminalsToConfirm } from './kill-confirmation';
import { MAX_OVERLAY_LABEL_LENGTH } from '../../preload/overlay-channels';
import { cwdFolderName, newShellNonce, Osc633Stream, parseShellSequence, sanitizeDisplayText, sanitizeTitle } from './shell-integration';
import { shellIntegrationInjection } from './shell-integration-injection';
import { linkPathStyle, type LinkBase, type LinkPathStyle } from './terminal-links';
import { pasteChunks } from './terminal-paste';
import type { TerminalAppearance } from '../terminal-pick';
import type { LaunchProfile } from './user-profiles';

/** How the pty host ended: its exit code, the reason Electron gave for an abnormal exit, and the last error it printed. */
export interface PtyHostExit {
  readonly code: number;
  readonly reason: string | null;
  readonly error: string | null;
}

/** The pty host's utility process as main sees it; pty-host-process.ts adapts Electron's UtilityProcess. */
export interface PtyHostProcess {
  postMessage(message: HostRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exit: PtyHostExit) => void): void;
  kill(): void;
}

export interface TerminalProject {
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
}

// A terminal as the window layout keeps it; restored at launch when its profile and project still exist.
export interface PersistedTerminal {
  readonly profileId: string;
  readonly projectKey: string;
  readonly name: string | null;
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
}

// Control, separator, format (bidi, zero-width, tags) and lone surrogate characters, which would hide, reorder or corrupt a
// name's text; ZWNJ and ZWJ stay for scripts and emoji that need them.
const NAME_REFUSED = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** A name from Rename or the window layout, trimmed; null restores the automatic title; undefined: refused. */
export function parseTerminalName(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  if (name.length === 0) return null;
  return name.length <= MAX_TERMINAL_NAME_LENGTH && !NAME_REFUSED.test(name) ? name : undefined;
}

export function isTerminalCustomIcon(value: unknown): value is TerminalCustomIcon {
  return (TERMINAL_CUSTOM_ICONS as readonly unknown[]).includes(value);
}

export function isTerminalColor(value: unknown): value is TerminalColor {
  return (TERMINAL_COLORS as readonly unknown[]).includes(value);
}

// A split group as the window layout keeps it: the next `panes` terminals of the list, in order.
export interface PersistedTerminalGroup {
  readonly panes: number;
  // index into the group's panes
  readonly activePane: number;
  // index-aligned with the panes, as TerminalGroupInfo.sizes
  readonly sizes: readonly number[];
}

export interface PersistedTerminals {
  readonly terminals: readonly PersistedTerminal[];
  // index into terminals
  readonly active: number | null;
  readonly listWidthRem: number;
  // in list order; their panes add up to terminals.length
  readonly groups: readonly PersistedTerminalGroup[];
}

export const DEFAULT_PERSISTED_TERMINALS: PersistedTerminals = { terminals: [], active: null, listWidthRem: TERMINAL_LIST_DEFAULT_REM, groups: [] };

/** Equal shares for count panes, as VS Code's Sizing.Distribute leaves them after a split or a removal. */
export function equalPaneSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** Pane sizes the group may take: one finite share per pane, each at least the minimum, summing to 1 within epsilon; rescaled to sum to 1. */
export function parsePaneSizes(sizes: readonly unknown[], panes: number): number[] | undefined {
  if (sizes.length !== panes || !sizes.every((size): size is number => typeof size === 'number' && Number.isFinite(size))) return undefined;
  const sum = (sizes as number[]).reduce((total, size) => total + size, 0);
  if (Math.abs(sum - 1) > TERMINAL_PANE_SIZES_EPSILON) return undefined;
  const scaled = (sizes as number[]).map((size) => size / sum);
  return scaled.every((size) => size >= MIN_TERMINAL_PANE_FRACTION - TERMINAL_PANE_SIZES_EPSILON) ? scaled : undefined;
}

/** The window's shell page; each push is dropped while the page is not loaded, and the page's load asks for the state again. */
export interface TerminalShell {
  state(state: TerminalState): void;
  data(data: TerminalData): void;
  // keyboard focus moves to the shell page, which focuses the terminal
  focus(id: string): void;
}

export interface TerminalServiceDeps {
  readonly spawnHost: () => PtyHostProcess;
  // the visible detected shells and the valid user profiles, in quick pick order
  readonly profiles: () => readonly LaunchProfile[];
  // whether a folder a shell reported still exists, for a split that starts in it; never blocks main on a slow share
  readonly isDirectory: (folder: string) => Promise<boolean>;
  readonly projects: () => readonly TerminalProject[];
  readonly currentProjectKey: () => string | undefined;
  // defaultProfile: a profile id, '' for the first detected
  readonly settings: () => TerminalServiceSettings;
  // a terminal's environment, read at each spawn
  readonly env: () => Record<string, string>;
  // the skip list's accelerators (TerminalState.passKeys); splitActive: the active group has more than one pane
  readonly passKeys: (splitActive: boolean) => readonly string[];
  // Chromium's accessibility support (TerminalState.screenReader), read at each publish
  readonly screenReader: () => boolean;
  // TerminalState.windowsBuild
  readonly windowsBuild: number;
  readonly persisted: () => PersistedTerminals;
  readonly persist: (terminals: PersistedTerminals) => void;
  // the list or the active terminal's status changed (menu enablement)
  readonly onDidChange: () => void;
  // a localized line the terminal shows when its shell could not start
  readonly spawnFailed: (message: string) => string;
  // the same for a Windows shell whose exit code is a CreateProcess error
  readonly launchFailed: (failure: WindowsLaunchFailure) => string;
  readonly log: (line: string) => void;
  // picks how a terminal's shell writes paths (terminal links)
  readonly platform: NodeJS.Platform;
  // the app's own shell-integration scripts (resources, unpacked); the user's home, the default ZDOTDIR
  readonly scriptsDir: string;
  readonly homedir: string;
  // zsh's ZDOTDIR in the user's app data, and the synchronous copy of its startup files there (throws on failure)
  readonly zshDotDir: string;
  readonly copyFiles: (files: ReadonlyArray<{ readonly source: string; readonly dest: string }>) => void;
  // the one D41 question before a kill; resolves true to kill
  readonly confirmKill: (terminals: readonly KillListEntry[]) => Promise<boolean>;
  readonly now?: () => number;
  readonly shutdownTimeoutMs?: number;
}

// node-pty creates a Windows process after spawn returns, and reports a CreateProcess failure as the exit code of a process
// that printed nothing (VS Code's parseExitResult maps 267 and 1260 too). 193 is ERROR_BAD_EXE_FORMAT.
const WINDOWS_LAUNCH_ERRORS = { 193: 'notAnExecutable', 267: 'invalidDirectory', 1260: 'blockedByPolicy' } as const;
export type WindowsLaunchError = (typeof WINDOWS_LAUNCH_ERRORS)[keyof typeof WINDOWS_LAUNCH_ERRORS];

export interface WindowsLaunchFailure {
  readonly reason: WindowsLaunchError;
  readonly file: string;
  readonly cwd: string;
}

// A terminal a kill asks about: its name (the user's, else the profile's) and what runs in it, sanitized; null for an idle one.
export interface KillListEntry {
  readonly name: string;
  readonly command: string | null;
}

// A command main recorded from its integration sequences, for a label built from main's own facts.
export interface CommandFacts {
  readonly commandLine: string;
  readonly exitCode: number | null;
}

// The shell's settings plus those only main reads.
export type TerminalServiceSettings = TerminalSettings & {
  readonly defaultProfile: string;
  readonly multiLinePasteWarning: TerminalMultiLinePasteWarning;
  readonly shellIntegration: boolean;
  readonly confirmOnKill: TerminalConfirmOnKill;
};

// A host that does not end within this long after shutdown is killed.
export const HOST_SHUTDOWN_TIMEOUT_MS = 2000;
// The size a pty starts at until the shell reports its own.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Commands per terminal whose line and exit code main keeps for Add to Chat labels; the oldest leaves first.
export const TRACKED_COMMANDS = 100;
// Characters of a dropped environment variable's name the log keeps.
const MAX_LOGGED_ENV_NAME_CHARS = 100;

// One shell process's integration state; a restart starts a fresh one.
interface ShellSession {
  readonly nonce: string;
  readonly stream: Osc633Stream;
  // a trusted sequence arrived
  integrated: boolean;
  // the last trusted E, until its C
  commandLine: string | null;
  // the running command (trusted C until D)
  running: { readonly id: number; readonly commandLine: string } | null;
  // the last reported working directory; null when the shell reported one main refused
  cwd: string | null;
  // node-pty's foreground process name (macOS and Linux)
  processName: string | null;
}

interface Terminal {
  readonly id: string;
  // re-read from the listed profiles at each restart
  profile: LaunchProfile;
  readonly projectKey: string;
  // the project folder, which titles and descriptions compare against
  readonly startCwd: string;
  // the folder each spawn starts in: the project folder, or for a split the folder its source reported
  readonly launchCwd: string;
  shell: ShellSession;
  // commandId → facts, insertion ordered, at most TRACKED_COMMANDS
  readonly commands: Map<number, CommandFacts>;
  nextCommandId: number;
  status: TerminalStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
  name: string | null;
  customIcon: TerminalCustomIcon | null;
  color: TerminalColor | null;
  // input for a restart still checking its folder, which the host would drop before the spawn
  held?: string[] | undefined;
}

interface Host {
  readonly process: PtyHostProcess;
  readonly exited: Promise<void>;
}

// A tab of side-by-side panes (VS Code's TerminalGroup); every terminal is in exactly one.
interface Group {
  readonly id: string;
  paneIds: string[];
  activePaneId: string;
  sizes: number[];
}

function readSetting<T>(settings: SettingsStore, key: string): T {
  const value = settings.get<unknown>(key);
  return (isDesktopSettingValue(key, value) ? value : DESKTOP_CONFIGURATION[key]!.default) as T;
}

/** damocles.desktop.terminal.*, each out-of-range or mistyped value read as its default. */
export function terminalSettings(settings: SettingsStore): TerminalServiceSettings {
  return {
    defaultProfile: readSetting<string>(settings, TERMINAL_DEFAULT_PROFILE_SETTING),
    fontSize: readSetting<number>(settings, TERMINAL_FONT_SIZE_SETTING),
    scrollback: readSetting<number>(settings, TERMINAL_SCROLLBACK_SETTING),
    cursorStyle: readSetting<TerminalCursorStyle>(settings, TERMINAL_CURSOR_STYLE_SETTING),
    fontFamily: readSetting<string>(settings, TERMINAL_FONT_FAMILY_SETTING),
    lineHeight: readSetting<number>(settings, TERMINAL_LINE_HEIGHT_SETTING),
    cursorBlinking: readSetting<boolean>(settings, TERMINAL_CURSOR_BLINKING_SETTING),
    macOptionIsMeta: readSetting<boolean>(settings, TERMINAL_MAC_OPTION_IS_META_SETTING),
    decorationsEnabled: readSetting<boolean>(settings, TERMINAL_DECORATIONS_SETTING),
    multiLinePasteWarning: readSetting<TerminalMultiLinePasteWarning>(settings, TERMINAL_MULTI_LINE_PASTE_WARNING_SETTING),
    shellIntegration: readSetting<boolean>(settings, TERMINAL_SHELL_INTEGRATION_SETTING),
    confirmOnKill: readSetting<TerminalConfirmOnKill>(settings, TERMINAL_CONFIRM_ON_KILL_SETTING),
  };
}

function newShellSession(cwd: string): ShellSession {
  return { nonce: newShellNonce(), stream: new Osc633Stream(), integrated: false, commandLine: null, running: null, cwd, processName: null };
}

// The shell's own executable name, which a foreground process name equal to it means idle.
function shellName(file: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.win32.basename(file) : path.posix.basename(file);
}

/** Clamps a list width to the terminal list's range. */
export function clampListWidth(rem: number): number {
  return Math.min(TERMINAL_LIST_MAX_REM, Math.max(TERMINAL_LIST_MIN_REM, rem));
}

/**
 * The window's terminals (AD6): main issues their ids, resolves each cwd from a project key, and talks to the one pty host,
 * started on the first spawn. The shell sees only ids, profile ids and project keys.
 */
export class TerminalService {
  private readonly deps: TerminalServiceDeps;
  // in list order: group by group, pane by pane (order() keeps it so)
  private terminals: Terminal[] = [];
  private groups: Group[] = [];
  private activeId: string | null = null;
  private nextGroupId = 1;
  private listWidthRem: number;
  private host: Host | undefined;
  private shell: TerminalShell | undefined;
  // The window layout's terminals as the window opened; a terminal started before restore() runs rewrites the saved list.
  private toRestore: PersistedTerminals | undefined;
  private nextId = 1;

  constructor(deps: TerminalServiceDeps) {
    this.deps = deps;
    this.listWidthRem = clampListWidth(deps.persisted().listWidthRem);
  }

  state(): TerminalState {
    const projects = this.deps.projects();
    const settings = this.deps.settings();
    return {
      terminals: this.terminals.map((terminal): TerminalInfo => ({
        id: terminal.id,
        title: this.title(terminal),
        name: terminal.name,
        profileId: terminal.profile.id,
        icon: terminal.profile.icon,
        customIcon: terminal.customIcon,
        color: terminal.color,
        projectKey: terminal.projectKey,
        projectName: projects.find((project) => project.key === terminal.projectKey)?.name ?? '',
        status: terminal.status,
        exitCode: terminal.exitCode,
        description: this.description(terminal),
        running: this.running(terminal),
        integrated: terminal.status !== 'exited' && terminal.shell.integrated,
      })),
      groups: this.groups.map((group): TerminalGroupInfo => ({ id: group.id, paneIds: [...group.paneIds], activePaneId: group.activePaneId, sizes: [...group.sizes] })),
      activeId: this.activeId,
      listWidthRem: this.listWidthRem,
      settings: {
        fontSize: settings.fontSize,
        scrollback: settings.scrollback,
        cursorStyle: settings.cursorStyle,
        fontFamily: settings.fontFamily,
        lineHeight: settings.lineHeight,
        cursorBlinking: settings.cursorBlinking,
        macOptionIsMeta: settings.macOptionIsMeta,
        decorationsEnabled: settings.decorationsEnabled,
      },
      canCreate: this.deps.profiles().length > 0 && projects.length > 0,
      passKeys: [...this.deps.passKeys(this.splitActive())],
      profiles: this.profileOptions(),
      screenReader: this.deps.screenReader(),
      windowsBuild: this.deps.windowsBuild,
    };
  }

  /** The listed profiles for the quick pick and Settings › Terminal, the default marked. */
  profileOptions(): TerminalProfileOption[] {
    const fallback = this.defaultProfile();
    return this.deps.profiles().map((profile) => ({
      id: profile.id,
      name: profile.name,
      // display copies: a file or argument name may hold bidi or control characters; spawn uses profile.file and args
      path: sanitizeDisplayText(profile.file, MAX_OVERLAY_LABEL_LENGTH) ?? '',
      args: profile.args.map((arg) => sanitizeTitle(arg) ?? ''),
      source: profile.source,
      icon: profile.icon,
      customIcon: profile.customIcon,
      color: profile.color,
      isDefault: profile.id === fallback?.id,
    }));
  }

  /** The open projects for the quick pick, the current one first. */
  projectOptions(): TerminalProjectOption[] {
    const current = this.deps.currentProjectKey();
    const options = this.deps.projects().map((project) => ({ key: project.key, name: project.name, path: project.fsPath, current: project.key === current }));
    return [...options.filter((option) => option.current), ...options.filter((option) => !option.current)];
  }

  has(id: string): boolean {
    return this.find(id) !== undefined;
  }

  hasTerminals(): boolean {
    return this.terminals.length > 0;
  }

  activeTerminal(): string | null {
    return this.activeId;
  }

  activeStatus(): TerminalStatus | undefined {
    return this.terminals.find((terminal) => terminal.id === this.activeId)?.status;
  }

  /** The window's shell page, or undefined once the window closed. */
  attach(shell: TerminalShell | undefined): void {
    this.shell = shell;
    if (shell) this.toRestore = this.deps.persisted();
  }

  /**
   * Starts a terminal in a known project with a detected profile; null picks the default profile and the current project.
   * focus: a user's action in main, after which the new terminal takes keyboard focus.
   */
  create(request: TerminalCreateRequest, focus: boolean): TerminalCreateResult {
    const started = this.start(request);
    if (!started.ok) return started;
    this.groups.push(this.newGroup([started.id]));
    this.activeId = started.id;
    this.changed(true);
    if (focus) this.shell?.focus(started.id);
    return started;
  }

  // A new terminal at the end of the terminal array, in no group yet, with its process starting; the caller groups it and
  // publishes the change.
  private start(request: TerminalCreateRequest): TerminalCreateResult {
    const profile = request.profileId === null ? this.defaultProfile() : this.listedProfile(request.profileId);
    if (!profile) return { ok: false, reason: request.profileId === null ? 'noProfile' : 'unknownProfile' };
    const projectKey = request.projectKey ?? this.deps.currentProjectKey();
    if (projectKey === undefined) return { ok: false, reason: 'noProject' };
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project) return { ok: false, reason: 'unknownProject' };
    return { ok: true, id: this.launch(profile, project, project.fsPath).id };
  }

  private launch(profile: LaunchProfile, project: TerminalProject, launchCwd: string): Terminal {
    const terminal: Terminal = {
      id: `term-${this.nextId++}`,
      profile,
      projectKey: project.key,
      startCwd: project.fsPath,
      launchCwd,
      shell: newShellSession(launchCwd),
      commands: new Map(),
      nextCommandId: 1,
      status: 'starting',
      exitCode: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      name: null,
      customIcon: profile.customIcon,
      color: profile.color,
    };
    this.terminals.push(terminal);
    this.spawn(terminal);
    return terminal;
  }

  /**
   * Recreates the window layout's terminals and groups as the window opened, ahead of any started since, skipping those whose
   * profile or project is gone (their group's sizes are shared again); none takes focus, and a terminal started since stays
   * active.
   */
  restore(): void {
    const saved = this.toRestore;
    this.toRestore = undefined;
    if (!saved) return;
    const startedGroups = this.groups;
    this.groups = [];
    let active: string | null = null;
    let index = 0;
    for (const savedGroup of saved.groups) {
      const paneIds: string[] = [];
      const sizes: number[] = [];
      let activePaneId: string | undefined;
      for (let pane = 0; pane < savedGroup.panes; pane++, index++) {
        const entry = saved.terminals[index]!;
        const created = this.start({ profileId: entry.profileId, projectKey: entry.projectKey });
        if (!created.ok) {
          this.deps.log(`[terminal] not restoring a ${entry.profileId} terminal: ${created.reason}`);
          continue;
        }
        const terminal = this.find(created.id)!;
        terminal.name = entry.name;
        terminal.customIcon = entry.customIcon;
        terminal.color = entry.color;
        paneIds.push(created.id);
        sizes.push(savedGroup.sizes[pane]!);
        if (pane === savedGroup.activePane) activePaneId = created.id;
        if (index === saved.active) active = created.id;
      }
      if (paneIds.length === 0) continue;
      const group = this.newGroup(paneIds);
      group.activePaneId = activePaneId ?? paneIds[Math.min(savedGroup.activePane, paneIds.length - 1)]!;
      if (paneIds.length === savedGroup.panes) group.sizes = sizes;
      this.groups.push(group);
    }
    const restoredLast = this.groups.at(-1)?.activePaneId;
    this.groups.push(...startedGroups);
    this.order();
    this.activeId ??= active ?? restoredLast ?? null;
    if (this.activeId !== null) this.groupOf(this.activeId)!.activePaneId = this.activeId;
    this.changed(true);
  }

  /** The active terminal, starting one with the default profile in the current project when there is none. */
  ensureTerminal(): string | undefined {
    if (this.activeId !== null) return this.activeId;
    const created = this.create({ profileId: null, projectKey: null }, false);
    return created.ok ? created.id : undefined;
  }

  focus(id: string): void {
    if (this.terminals.some((terminal) => terminal.id === id)) this.shell?.focus(id);
  }

  input(id: string, data: string): void {
    if (this.live(id)) this.send(id, data);
  }

  /** Prepared paste data; it goes to the pty in pieces the host accepts, unless the terminal stopped meanwhile. */
  write(id: string, data: string): void {
    if (!this.live(id)) return;
    for (const chunk of pasteChunks(data)) this.send(id, chunk);
  }

  private send(id: string, data: string): void {
    const held = this.find(id)?.held;
    if (held) held.push(data);
    else this.post({ type: 'input', id, data });
  }

  /** The user's name for the terminal; null restores the automatic title. */
  rename(id: string, name: string | null): void {
    const terminal = this.find(id);
    if (!terminal || terminal.name === name) return;
    terminal.name = name;
    this.changed(true);
  }

  setCustomIcon(id: string, customIcon: TerminalCustomIcon | null): void {
    const terminal = this.find(id);
    if (!terminal || terminal.customIcon === customIcon) return;
    terminal.customIcon = customIcon;
    this.changed(true);
  }

  setColor(id: string, color: TerminalColor | null): void {
    const terminal = this.find(id);
    if (!terminal || terminal.color === color) return;
    terminal.color = color;
    this.changed(true);
  }

  appearance(id: string): TerminalAppearance | undefined {
    const terminal = this.find(id);
    return terminal && { icon: terminal.profile.icon, customIcon: terminal.customIcon, color: terminal.color };
  }

  /** What the terminal's links resolve against: its project, its tracked working directory, and how its shell writes paths. */
  linkBase(id: string): LinkBase | undefined {
    const terminal = this.find(id);
    const project = terminal && this.deps.projects().find((candidate) => candidate.key === terminal.projectKey);
    return terminal && project && { project, baseDir: terminal.shell.cwd, style: this.pathStyle(terminal) };
  }

  /** The working directory the shell last reported (else the one it started in); null when it reported one main refused. */
  cwdOf(id: string): string | null | undefined {
    return this.find(id)?.shell.cwd;
  }

  /** Main's record of a command the integration script reported, for a label; undefined once it is no longer tracked. */
  commandFacts(id: string, commandId: number): CommandFacts | undefined {
    return this.find(id)?.commands.get(commandId);
  }

  /** The automatic or user title main shows for the terminal. */
  titleOf(id: string): string | undefined {
    const terminal = this.find(id);
    return terminal && this.title(terminal);
  }

  /**
   * Asks once, per damocles.desktop.terminal.confirmOnKill, about those of ids that need it (G22); true when they may be
   * killed, with no question when none needs one.
   */
  async confirmKill(ids: readonly string[]): Promise<boolean> {
    const terminals = ids.flatMap((id) => this.find(id) ?? []);
    const listed = terminalsToConfirm(this.deps.settings().confirmOnKill, terminals.map((terminal) => ({ terminal, status: terminal.status, running: this.running(terminal) })));
    if (listed.length === 0) return true;
    return this.deps.confirmKill(listed.map(({ terminal, running }) => ({ name: terminal.name ?? terminal.profile.name, command: running })));
  }

  /** Kill, Kill All and the list's Delete key: confirmed first, then each terminal still present is killed. */
  async requestKill(ids: readonly string[]): Promise<void> {
    if (await this.confirmKill(ids)) for (const id of ids) this.kill(id);
  }

  /** Every terminal's id, in list order. */
  ids(): string[] {
    return this.terminals.map((terminal) => terminal.id);
  }

  /** The ids of the terminals in projectKey. */
  idsIn(projectKey: string): string[] {
    return this.terminals.filter((terminal) => terminal.projectKey === projectKey).map((terminal) => terminal.id);
  }

  /** The active pane of the group delta places from the active group, wrapping (VS Code's setActiveGroupToNext); undefined without terminals. */
  relative(delta: 1 | -1): string | undefined {
    if (this.groups.length === 0) return undefined;
    const index = this.groups.findIndex((group) => group.paneIds.includes(this.activeId ?? ''));
    return this.groups[(index + delta + this.groups.length) % this.groups.length]!.activePaneId;
  }

  /** The active group has more than one pane (VS Code's splitTerminalActive). */
  splitActive(): boolean {
    return this.activeId !== null && this.groupOf(this.activeId)!.paneIds.length > 1;
  }

  /**
   * Split Terminal (VS Code's terminalGroup.ts addInstance): a new pane right of id with its profile, in the folder its shell
   * reported, else its project folder; the sizes are shared equally, and the new pane is active and takes focus.
   */
  async split(id: string): Promise<void> {
    const found = this.find(id);
    if (!found || this.splitRefused(id)) return;
    const cwd = await this.splitCwd(found);
    // the source, its group, its profile or its project may have changed while the folder was checked
    const source = this.find(id);
    if (!source || this.splitRefused(id)) return;
    const group = this.groupOf(id)!;
    const profile = this.listedProfile(source.profile.id);
    const project = this.deps.projects().find((candidate) => candidate.key === source.projectKey);
    if (!profile || !project) {
      this.deps.log(`[terminal] not splitting ${id}: ${profile ? 'its project is closed' : `its profile ${source.profile.id} is no longer listed`}`);
      return;
    }
    const pane = this.launch(profile, project, cwd);
    group.paneIds.splice(group.paneIds.indexOf(id) + 1, 0, pane.id);
    group.sizes = equalPaneSizes(group.paneIds.length);
    group.activePaneId = pane.id;
    this.activeId = pane.id;
    this.order();
    this.changed(true);
    this.shell?.focus(pane.id);
  }

  /** Unsplit (VS Code's unsplitInstance): the pane leaves its multi-pane group for a new group at the end of the list. */
  unsplit(id: string): void {
    const group = this.groupOf(id);
    if (!group || group.paneIds.length < 2) return;
    this.removePane(group, id);
    this.groups.push(this.newGroup([id]));
    this.order();
    this.changed(true);
  }

  /** Focus Previous or Next Pane: the pane delta places from the active one in the active group, wrapping, takes focus. */
  focusPane(delta: 1 | -1): void {
    if (this.activeId === null) return;
    const { paneIds, activePaneId } = this.groupOf(this.activeId)!;
    const target = paneIds[(paneIds.indexOf(activePaneId) + delta + paneIds.length) % paneIds.length]!;
    this.select(target);
    this.shell?.focus(target);
  }

  /** A sash drag's end or a keyboard step from the shell; sizes parsePaneSizes refuses leave the group as it was. */
  resizePanes(groupId: string, sizes: readonly number[]): void {
    const group = this.groups.find((candidate) => candidate.id === groupId);
    const parsed = group && parsePaneSizes(sizes, group.paneIds.length);
    if (!group || !parsed) {
      this.deps.log(`[terminal] refusing pane sizes for ${group ? groupId : 'an unknown group'}`);
      return;
    }
    group.sizes = parsed;
    this.changed(true);
  }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.find(id);
    if (!terminal) return;
    terminal.cols = cols;
    terminal.rows = rows;
    if (this.live(id)) this.post({ type: 'resize', id, cols, rows });
  }

  ack(id: string, chars: number): void {
    if (this.live(id)) this.post({ type: 'ack', id, chars });
  }

  /**
   * Ends the terminal and takes it out of its group, which goes with its last pane; an active terminal hands over to its
   * group's next active pane, else to the next group's, else the previous group's.
   */
  kill(id: string): void {
    const index = this.terminals.findIndex((terminal) => terminal.id === id);
    if (index < 0) return;
    const [terminal] = this.terminals.splice(index, 1);
    if (terminal!.status !== 'exited') this.post({ type: 'kill', id });
    const group = this.groupOf(id)!;
    const groupIndex = this.groups.indexOf(group);
    this.removePane(group, id);
    if (group.paneIds.length === 0) this.groups.splice(groupIndex, 1);
    if (this.activeId === id) {
      const next = group.paneIds.length > 0 ? group : (this.groups[groupIndex] ?? this.groups[groupIndex - 1]);
      this.activeId = next?.activePaneId ?? null;
    }
    this.changed(true);
  }

  /**
   * A new process for an exited terminal, with its id, project and launch folder (its project folder once that is gone, as
   * a split falls back), while its profile is still listed.
   */
  async restart(id: string): Promise<void> {
    const terminal = this.find(id);
    if (!terminal || terminal.status !== 'exited') return;
    const profile = this.listedProfile(terminal.profile.id);
    if (!profile) {
      this.deps.log(`[terminal] not restarting ${id}: its profile ${terminal.profile.id} is no longer listed`);
      return;
    }
    terminal.profile = profile;
    terminal.status = 'starting';
    terminal.exitCode = null;
    const shell = newShellSession(terminal.launchCwd);
    terminal.shell = shell;
    const held: string[] = [];
    terminal.held = held;
    this.changed(false);
    const cwd = await this.restartCwd(terminal);
    if (terminal.held === held) terminal.held = undefined;
    // a kill, a host exit or another restart while the folder was checked
    if (this.find(id) !== terminal || terminal.shell !== shell || terminal.status !== 'starting') return;
    shell.cwd = cwd;
    this.spawn(terminal, cwd);
    for (const data of held) this.post({ type: 'input', id, data });
  }

  /** The terminal becomes active, as its group's active pane, and its group the active group. */
  select(id: string): void {
    const group = this.groupOf(id);
    if (!group || this.activeId === id) return;
    group.activePaneId = id;
    this.activeId = id;
    this.changed(true);
  }

  setListWidth(rem: number): void {
    const width = clampListWidth(rem);
    if (width === this.listWidthRem) return;
    this.listWidthRem = width;
    this.changed(true);
  }

  /** A newly loaded shell page holds no terminal output, so nothing it was sent will be acknowledged. */
  shellLoaded(): void {
    for (const terminal of this.terminals) if (terminal.status !== 'exited') this.post({ type: 'clearAck', id: terminal.id });
    this.publish();
  }

  /** Kills the terminals of every project not in projectKeys, as when a project is removed. */
  retain(projectKeys: readonly string[]): void {
    const keep = new Set(projectKeys);
    const gone = this.terminals.filter((terminal) => !keep.has(terminal.projectKey));
    for (const terminal of gone) this.kill(terminal.id);
  }

  /** The window closed: every terminal is killed, and the window layout keeps the list for the next window or launch. */
  closeWindow(): void {
    if (this.terminals.some((terminal) => terminal.status !== 'exited')) this.post({ type: 'killAll' });
    this.terminals = [];
    this.groups = [];
    this.activeId = null;
    this.shell = undefined;
    this.deps.onDidChange();
  }

  /** Settings or Chromium's accessibility support changed. */
  publish(): void {
    this.shell?.state(this.state());
  }

  /** Quit: the host kills every pty and ends; one that does not end in time is killed. */
  async dispose(): Promise<void> {
    const host = this.host;
    this.shell = undefined;
    if (!host) return;
    host.process.postMessage({ type: 'shutdown' });
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = this.deps.shutdownTimeoutMs ?? HOST_SHUTDOWN_TIMEOUT_MS;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    if (await Promise.race([host.exited.then(() => false), timedOut])) {
      this.deps.log(`[terminal] the pty host did not end within ${timeoutMs} ms; killing it`);
      host.process.kill();
    }
    clearTimeout(timer);
  }

  private defaultProfile(): LaunchProfile | undefined {
    const profiles = this.deps.profiles();
    const configured = this.deps.settings().defaultProfile;
    return profiles.find((profile) => profile.id === configured) ?? profiles[0];
  }

  // A profile is launched only while it is listed, so a hidden, removed or now-invalid one never starts again.
  private listedProfile(id: string): LaunchProfile | undefined {
    return this.deps.profiles().find((profile) => profile.id === id);
  }

  private find(id: string): Terminal | undefined {
    return this.terminals.find((terminal) => terminal.id === id);
  }

  private groupOf(id: string): Group | undefined {
    return this.groups.find((group) => group.paneIds.includes(id));
  }

  private newGroup(paneIds: string[]): Group {
    return { id: `group-${this.nextGroupId++}`, paneIds, activePaneId: paneIds[0]!, sizes: equalPaneSizes(paneIds.length) };
  }

  // VS Code's _removeInstance: an active pane hands over to the pane at its index, else the last; the sizes are shared again.
  private removePane(group: Group, id: string): void {
    const index = group.paneIds.indexOf(id);
    group.paneIds.splice(index, 1);
    if (group.paneIds.length === 0) return;
    group.sizes = equalPaneSizes(group.paneIds.length);
    if (group.activePaneId === id) group.activePaneId = group.paneIds[Math.min(index, group.paneIds.length - 1)]!;
  }

  // The terminal array in list order: group by group, pane by pane.
  private order(): void {
    const byId = new Map(this.terminals.map((terminal) => [terminal.id, terminal]));
    this.terminals = this.groups.flatMap((group) => group.paneIds.map((id) => byId.get(id)!));
  }

  private splitRefused(id: string): boolean {
    if (this.groupOf(id)!.paneIds.length < MAX_TERMINAL_GROUP_PANES) return false;
    this.deps.log(`[terminal] not splitting ${id}: its group has ${MAX_TERMINAL_GROUP_PANES} panes`);
    return true;
  }

  // The folder the source's shell last reported while it still exists, else the source's project folder.
  private async splitCwd(source: Terminal): Promise<string> {
    const reported = source.shell.cwd;
    if (reported !== null && (await this.deps.isDirectory(reported))) return reported;
    this.deps.log(`[terminal] starting a split of ${source.id} in its project folder: ${reported === null ? 'the folder its shell reported was refused' : `${reported} no longer exists`}`);
    return source.startCwd;
  }

  private async restartCwd(terminal: Terminal): Promise<string> {
    if (terminal.launchCwd === terminal.startCwd || (await this.deps.isDirectory(terminal.launchCwd))) return terminal.launchCwd;
    this.deps.log(`[terminal] restarting ${terminal.id} in its project folder: ${terminal.launchCwd} no longer exists`);
    return terminal.startCwd;
  }

  private live(id: string): boolean {
    const status = this.find(id)?.status;
    return status === 'starting' || status === 'running';
  }

  // The shell starts with its integration script when the setting allows and VS Code's rules inject into it.
  private spawn(terminal: Terminal, cwd: string = terminal.launchCwd): void {
    const env = this.deps.env();
    let injection = this.deps.settings().shellIntegration
      ? shellIntegrationInjection({
        platform: this.deps.platform,
        file: terminal.profile.file,
        args: terminal.profile.args,
        scriptsDir: this.deps.scriptsDir,
        zshDotDir: this.deps.zshDotDir,
        nonce: terminal.shell.nonce,
        env,
        homedir: this.deps.homedir,
      })
      : undefined;
    if (injection?.filesToCopy) {
      try {
        this.deps.copyFiles(injection.filesToCopy);
      } catch (err) {
        this.deps.log(`[terminal] starting ${terminal.profile.file} without shell integration: its startup files could not be copied: ${err instanceof Error ? err.message : String(err)}`);
        injection = undefined;
      }
    }
    this.ensureHost().process.postMessage({
      type: 'spawn',
      id: terminal.id,
      file: terminal.profile.file,
      args: [...(injection?.args ?? terminal.profile.args)],
      cwd,
      env: { ...this.hostEnv(terminal, env, Object.keys(injection?.env ?? {}).length), ...injection?.env },
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }

  // The host ends on a spawn outside its limits, which would end every terminal, so a variable it refuses (or one past its
  // count, leaving room for reserved integration variables) is dropped and named in the log; values are never logged.
  private hostEnv(terminal: Terminal, env: Readonly<Record<string, string>>, reserved: number): Record<string, string> {
    const result: Record<string, string> = {};
    const dropped: string[] = [];
    let count = 0;
    for (const [key, value] of Object.entries(env)) {
      if (isHostEnvEntry(key, value) && count < MAX_HOST_ENV_ENTRIES - reserved) {
        result[key] = value;
        count++;
      } else {
        dropped.push(JSON.stringify(key.slice(0, MAX_LOGGED_ENV_NAME_CHARS)));
      }
    }
    if (dropped.length > 0) this.deps.log(`[terminal] starting ${terminal.profile.file} without ${dropped.length} environment variables the pty host refuses: ${dropped.join(', ')}`);
    return result;
  }

  private pathStyle(terminal: Terminal): LinkPathStyle {
    return linkPathStyle(this.deps.platform, terminal.profile.file);
  }

  // What runs: the command between a trusted C and its D; without integration on macOS and Linux, a foreground process
  // other than the shell. cmd.exe and an idle shell report nothing.
  private running(terminal: Terminal): string | null {
    const { shell } = terminal;
    if (terminal.status === 'exited') return null;
    if (shell.integrated) return shell.running && (sanitizeTitle(shell.running.commandLine) ?? '');
    if (shell.processName === null || shell.processName === shellName(terminal.profile.file, this.deps.platform)) return null;
    return sanitizeTitle(shell.processName) ?? '';
  }

  // G11: the user's name, else the running command line, else (without integration) the foreground process, else the profile.
  private title(terminal: Terminal): string {
    if (terminal.name !== null) return terminal.name;
    const { shell } = terminal;
    const live = terminal.status !== 'exited';
    if (live && shell.integrated && shell.running) return sanitizeTitle(shell.running.commandLine) ?? terminal.profile.name;
    if (live && !shell.integrated && shell.processName !== null) return sanitizeTitle(shell.processName) ?? terminal.profile.name;
    return terminal.profile.name;
  }

  private description(terminal: Terminal): string | null {
    const { shell } = terminal;
    if (!shell.integrated || shell.cwd === null) return null;
    return cwdFolderName(shell.cwd, terminal.startCwd, this.pathStyle(terminal));
  }

  // The batch without its 633 sequences, the trusted ones applied in order; stripped characters are acknowledged here,
  // since the shell never sees them.
  private output(terminal: Terminal, data: string): void {
    const { shell } = terminal;
    const parsed = shell.stream.push(data);
    for (let left = parsed.stripped; left > 0; left -= MAX_TERMINAL_ACK_CHARS) this.post({ type: 'ack', id: terminal.id, chars: Math.min(left, MAX_TERMINAL_ACK_CHARS) });
    const events: TerminalShellEventAt[] = [];
    const before = JSON.stringify([this.title(terminal), this.description(terminal), this.running(terminal), shell.integrated]);
    const now = this.deps.now ?? Date.now;
    for (const { offset, fields } of parsed.sequences) {
      const sequence = parseShellSequence(fields, shell.nonce, this.pathStyle(terminal));
      if (!sequence) continue;
      shell.integrated = true;
      switch (sequence.type) {
        case 'promptStart':
          // a prompt while a command still runs: its D never arrived
          if (shell.running) events.push({ offset, event: this.finish(terminal, null, now()) });
          events.push({ offset, event: { kind: 'promptStart' } });
          break;
        case 'commandStart':
          events.push({ offset, event: { kind: 'commandStart' } });
          break;
        case 'commandLine':
          shell.commandLine = sequence.commandLine;
          break;
        case 'commandExecuted': {
          const commandId = terminal.nextCommandId++;
          const commandLine = shell.commandLine ?? '';
          shell.commandLine = null;
          shell.running = { id: commandId, commandLine };
          terminal.commands.set(commandId, { commandLine, exitCode: null });
          if (terminal.commands.size > TRACKED_COMMANDS) terminal.commands.delete(terminal.commands.keys().next().value!);
          events.push({ offset, event: { kind: 'commandExecuted', commandId, commandLine, time: now() } });
          break;
        }
        case 'commandFinished':
          events.push({ offset, event: this.finish(terminal, sequence.exitCode, now()) });
          break;
        case 'cwd':
          shell.cwd = sequence.cwd;
          break;
      }
    }
    if (parsed.data.length > 0 || events.length > 0) this.shell?.data({ id: terminal.id, data: parsed.data, ...(events.length > 0 ? { events } : {}) });
    if (JSON.stringify([this.title(terminal), this.description(terminal), this.running(terminal), shell.integrated]) !== before) this.changed(false);
  }

  private finish(terminal: Terminal, exitCode: number | null, time: number): Extract<TerminalShellEventAt['event'], { kind: 'commandFinished' }> {
    const { running } = terminal.shell;
    terminal.shell.running = null;
    if (running && terminal.commands.has(running.id)) terminal.commands.set(running.id, { commandLine: running.commandLine, exitCode });
    return { kind: 'commandFinished', commandId: running?.id ?? null, exitCode, time };
  }

  private post(message: HostRequest): void {
    this.host?.process.postMessage(message);
  }

  private ensureHost(): Host {
    if (this.host) return this.host;
    const process = this.deps.spawnHost();
    let ended: () => void = () => undefined;
    const host: Host = { process, exited: new Promise((resolve) => { ended = resolve; }) };
    this.host = host;
    process.onMessage((raw) => {
      if (this.host === host) this.receive(host, raw);
    });
    process.onExit((exit) => {
      ended();
      if (this.host !== host) return;
      this.host = undefined;
      const reason = exit.reason === null ? '' : ` (${exit.reason})`;
      const error = exit.error === null ? '' : `; last error: ${JSON.stringify(exit.error)}`;
      this.deps.log(`[terminal] the pty host exited with code ${exit.code}${reason}${error}`);
      for (const terminal of this.terminals) {
        if (terminal.status === 'exited') continue;
        terminal.status = 'exited';
        terminal.exitCode = null;
      }
      this.changed(false);
    });
    this.deps.log('[terminal] started the pty host');
    return host;
  }

  // The host is main's own code: a message outside the contract is a bug, and stopping it marks every terminal exited.
  private receive(host: Host, raw: unknown): void {
    const message = parseHostMessage(raw);
    if (!message) {
      this.deps.log('[terminal] stopping the pty host: it sent a message outside the contract');
      host.process.kill();
      return;
    }
    // Output, an exit or an error of a terminal that was killed meanwhile.
    const terminal = this.find(message.id);
    if (!terminal || terminal.status === 'exited') return;
    this.apply(terminal, message);
  }

  private apply(terminal: Terminal, message: HostMessage): void {
    switch (message.type) {
      case 'data':
        this.output(terminal, message.data);
        return;
      case 'process': {
        // Linux reports argv[0], which may be a path; macOS the command name.
        const name = path.posix.basename(message.name);
        const processName = name === '' ? null : name;
        if (terminal.shell.processName === processName) return;
        terminal.shell.processName = processName;
        if (!terminal.shell.integrated) this.changed(false);
        return;
      }
      case 'ready':
        terminal.status = 'running';
        this.changed(false);
        return;
      case 'exit': {
        // still starting: a Windows pty reports ready only with its first output
        const reason = this.deps.platform === 'win32' && terminal.status === 'starting' && Object.hasOwn(WINDOWS_LAUNCH_ERRORS, message.exitCode)
          ? WINDOWS_LAUNCH_ERRORS[message.exitCode as keyof typeof WINDOWS_LAUNCH_ERRORS]
          : undefined;
        terminal.status = 'exited';
        terminal.exitCode = message.exitCode;
        if (reason !== undefined) {
          const cwd = terminal.shell.cwd ?? terminal.launchCwd;
          this.deps.log(`[terminal] ${terminal.profile.file} could not start in ${cwd}: Windows error ${message.exitCode}`);
          this.shell?.data({ id: terminal.id, data: `${this.deps.launchFailed({ reason, file: terminal.profile.file, cwd })}\r\n` });
        }
        this.changed(false);
        return;
      }
      case 'error':
        this.deps.log(`[terminal] ${terminal.profile.file} could not start: ${message.message}`);
        terminal.status = 'exited';
        terminal.exitCode = null;
        this.shell?.data({ id: terminal.id, data: `${this.deps.spawnFailed(message.message)}\r\n` });
        this.changed(false);
        return;
    }
  }

  // persist: the list, its groups, the active terminal or the list width changed, which the window layout keeps.
  private changed(persist: boolean): void {
    if (persist) {
      const active = this.terminals.findIndex((terminal) => terminal.id === this.activeId);
      this.deps.persist({
        terminals: this.terminals.map((terminal) => ({
          profileId: terminal.profile.id,
          projectKey: terminal.projectKey,
          name: terminal.name,
          customIcon: terminal.customIcon,
          color: terminal.color,
        })),
        active: active < 0 ? null : active,
        listWidthRem: this.listWidthRem,
        groups: this.groups.map((group) => ({ panes: group.paneIds.length, activePane: group.paneIds.indexOf(group.activePaneId), sizes: [...group.sizes] })),
      });
    }
    this.publish();
    this.deps.onDidChange();
  }
}
