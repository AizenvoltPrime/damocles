import { randomInt } from 'node:crypto';
import * as path from 'node:path';
import { isHostEnvEntry, MAX_HOST_ENV_ENTRIES, parseHostMessage, type HostMessage, type HostRequest, type TerminalView } from '../../pty-host/protocol';
import {
  MAX_TERMINAL_ACK_CHARS,
  MAX_TERMINAL_GROUP_PANES,
  MAX_TERMINAL_SCREEN_MARKS,
  MAX_TRACKED_COMMANDS,
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
  type TerminalScreen,
  type TerminalSettings,
  type TerminalShellEvent,
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
} from '../../local-services/desktop-configuration';
import { terminalsToConfirm } from './kill-confirmation';
import { MAX_OVERLAY_LABEL_LENGTH } from '../../preload/overlay-channels';
import { cwdFolderName, newShellNonce, Osc633Stream, parseShellSequence, sanitizeDisplayText, sanitizeTitle } from './shell-integration';
import type { PtyHostProcess } from '../../workspace/host-starters';
import { NONCE_ENV } from '../../workspace/terminal/shell-integration-injection';
import type { LiveTerminal, TerminalBackend } from '../../workspace/terminal/terminal-backend';
import type { Workspaces } from '../workspace/workspaces';
import { linkPathStyle, type LinkBase, type LinkPathStyle } from './terminal-links';
import { pasteChunks } from './terminal-paste';
import { authorityKeyOfProject, targetFolderKeyOf } from '../../../shared/project-location';
import type { RemoteTerminalRecord } from '../remote/remote-state';
import type { TerminalAppearance } from '../terminal-pick';
import type { LaunchProfile } from './user-profiles';

export interface TerminalProject {
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
}

// A terminal as the window layout keeps it; restored at launch when its profile and project still exist.
export interface PersistedTerminal {
  readonly profileId: string;
  // null: the home folder
  readonly projectKey: string | null;
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
  // a live terminal's screen after the page loaded again, ahead of the terminal's next data
  screen(screen: TerminalScreen): void;
  // keyboard focus moves to the shell page, which focuses the terminal
  focus(id: string): void;
}

export interface TerminalServiceDeps {
  // the workspace of each terminal's root key (null: the home folder), whose backend runs its pty host
  readonly workspaces: Workspaces;
  // the shells a terminal of this root key (null: the home folder) starts with, in quick pick order: this computer's visible
  // detected shells and valid user profiles, or a remote host's own detected shells
  readonly profiles: (projectKey: string | null) => readonly LaunchProfile[];
  // shell detection has settled (TerminalState.profilesReady)
  readonly profilesReady: () => boolean;
  // every folder a terminal may start in, by root key (folder-root.ts): the open projects and their chat worktrees
  readonly projects: () => readonly TerminalProject[];
  // the New Terminal picker's folders: the open projects, with the current root in place of its project's folder
  readonly pickerProjects: () => readonly TerminalProject[];
  // the selected project's shown folder (D31), where a new terminal starts
  readonly currentProjectKey: () => string | undefined;
  // variables a terminal of this root key adds to env(): a chat worktree's DAMOCLES_PROJECT_FOLDER and DAMOCLES_WORKTREE_INDEX
  readonly rootEnv: (projectKey: string) => Readonly<Record<string, string>>;
  // defaultProfile: a profile id, '' for the first detected
  readonly settings: () => TerminalServiceSettings;
  // a terminal's environment from its project's backend (null: the home folder), read at each spawn
  readonly env: (projectKey: string | null) => Promise<Record<string, string>>;
  // a remote project's OS, which its shells' paths and exit codes follow
  readonly osOf: (projectKey: string) => NodeJS.Platform;
  // the terminals on remote hosts, kept in remote-state.json; called on every change of the list
  readonly persistRemote: (terminals: readonly RemoteTerminalRecord[]) => void;
  // the skip list's accelerators (TerminalState.passKeys); splitActive: the active group has more than one pane
  readonly passKeys: (splitActive: boolean) => readonly string[];
  // Chromium's accessibility support (TerminalState.screenReader), read at each publish
  readonly screenReader: () => boolean;
  // TerminalInfo.windowsBuild: the conpty build of the host a terminal of this root key runs on; null off Windows
  readonly windowsBuild: (projectKey: string | null) => number | null;
  readonly persisted: () => PersistedTerminals;
  readonly persist: (terminals: PersistedTerminals) => void;
  // the list or the active terminal's status changed (menu enablement)
  readonly onDidChange: () => void;
  // a localized line the terminal shows when its shell could not start
  readonly spawnFailed: (message: string) => string;
  // the same for a Windows shell whose exit code is a CreateProcess error
  readonly launchFailed: (failure: WindowsLaunchFailure) => string;
  readonly log: (line: string) => void;
  // this computer's OS: how a local terminal's shell writes paths (terminal links)
  readonly platform: NodeJS.Platform;
  // the folder a terminal starts in while no project is open
  readonly homedir: string;
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
// Characters of a dropped environment variable's name the log keeps.
const MAX_LOGGED_ENV_NAME_CHARS = 100;

// One shell process's integration state; a restart starts a fresh one.
interface ShellSession {
  readonly nonce: string;
  // counts OSC 633 sequences as the pty host's screen does; a screen of output main never parsed sets its count again
  stream: Osc633Stream;
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
  // the spawn of this process was posted, so the pty host keeps its screen
  spawned: boolean;
  // the trusted events of each OSC 633 sequence by its index since the spawn, the latest MAX_TERMINAL_SCREEN_MARKS, which a
  // screen's marks name
  readonly marks: Map<number, TerminalShellEvent[]>;
}

interface Terminal {
  readonly id: string;
  // the backend whose pty host runs its process, looked up at each spawn since a remote host's workspace is a new one after
  // each reconnect; undefined until its first spawn is posted
  backend: TerminalBackend | undefined;
  // re-read from the listed profiles at each restart
  profile: LaunchProfile;
  // null: the home folder, where a terminal started while no project was open stays (VS Code keeps a terminal's folder)
  readonly projectKey: string | null;
  // the project or home folder, which titles and descriptions compare against
  readonly startCwd: string;
  // the folder each spawn starts in: startCwd, or for a split the folder its source reported
  readonly launchCwd: string;
  shell: ShellSession;
  // commandId → facts, insertion ordered, at most MAX_TRACKED_COMMANDS
  readonly commands: Map<number, CommandFacts>;
  nextCommandId: number;
  status: TerminalStatus;
  exitCode: number | null;
  cols: number;
  rows: number;
  name: string | null;
  customIcon: TerminalCustomIcon | null;
  color: TerminalColor | null;
  // input the host cannot take yet, posted in order once it can: for a restart still checking its folder, or typed while its
  // connection was away (keys already on their way when the tab turned reconnecting)
  held?: string[] | undefined;
  // requests posted while its spawn waits on the backend's environment and injection, sent right after the spawn
  pending?: HostRequest[] | undefined;
  // screens asked for since the shell page loaded again and not yet answered; data before the last one is in it, so dropped
  restoring: number;
  // a task tab main runs (the worktree Setup, D32): never persisted, split or restarted by itself
  task?: TerminalTask;
}

// A command list main runs in its own tab; key names the task, so starting it again reruns it in the same tab.
export interface TerminalTaskRequest {
  readonly key: string;
  readonly name: string;
  readonly file: string;
  readonly args: readonly string[];
  // a root key, which the tab belongs to and closes with
  readonly projectKey: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  // the process ended; null: it could not start or the host died
  readonly onExit: (exitCode: number | null) => void;
  // the tab's Restart, which the task's owner answers by starting it again
  readonly onRestart: () => void;
  // a command of the task started: its args frame each command with shell integration's C and D sequences, signed with the
  // nonce the task reads from NONCE_ENV
  readonly onCommandStart?: () => void;
}

interface TerminalTask {
  readonly key: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  onExit: (exitCode: number | null) => void;
  onRestart: () => void;
  onCommandStart?: () => void;
}

interface Host {
  readonly process: PtyHostProcess;
  readonly exited: Promise<void>;
  // a remote daemon's pty host, whose terminals outlive this app: closing and quitting detach from it, never kill
  readonly persistent: boolean;
}

function isRemoteKey(projectKey: string | null): boolean {
  return projectKey !== null && authorityKeyOfProject(projectKey) !== 'local';
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
  return { nonce: newShellNonce(), stream: new Osc633Stream(), integrated: false, commandLine: null, running: null, cwd, processName: null, spawned: false, marks: new Map() };
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
  // one pty host per backend, started on its first spawn
  private readonly hosts = new Map<TerminalBackend, Host>();
  private shell: TerminalShell | undefined;
  // The window layout's terminals as the window opened; a terminal started before restore() runs rewrites the saved list.
  private toRestore: PersistedTerminals | undefined;
  private nextId = 1;
  // the scrollback of every live terminal's screen in its pty host
  private scrollback: number;

  constructor(deps: TerminalServiceDeps) {
    this.deps = deps;
    this.listWidthRem = clampListWidth(deps.persisted().listWidthRem);
    this.scrollback = deps.settings().scrollback;
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
        restoring: terminal.restoring > 0,
        windowsBuild: this.deps.windowsBuild(terminal.projectKey),
        pathFlavor: this.osOf(terminal) === 'win32' ? 'win32' : 'posix',
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
      canCreate: this.canCreate(),
      profilesReady: this.deps.profilesReady(),
      passKeys: [...this.deps.passKeys(this.splitActive())],
      // the New Terminal dropdown's, which start in the current project
      profiles: this.profileOptions(this.deps.currentProjectKey() ?? null),
      screenReader: this.deps.screenReader(),
    };
  }

  /** A terminal can start: a profile is listed. Without a project it starts in the home folder. */
  canCreate(): boolean {
    return this.deps.profiles(null).length > 0;
  }

  /** The listed profiles of a project's host, this computer's for null, the default marked. */
  profileOptions(projectKey: string | null = null): TerminalProfileOption[] {
    const fallback = this.defaultProfile(projectKey);
    return this.deps.profiles(projectKey).map((profile) => ({
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

  /**
   * The open projects for the quick pick, the current one first; none while no project is open (the home folder). Only the
   * current project's host's, since the pick's profiles are that host's shells.
   */
  projectOptions(): TerminalProjectOption[] {
    const current = this.deps.currentProjectKey();
    const host = current === undefined ? 'local' : authorityKeyOfProject(current);
    const options = this.deps.pickerProjects()
      .filter((project) => authorityKeyOfProject(project.key) === host)
      .map((project) => ({ key: project.key, name: project.name, path: project.fsPath, current: project.key === current }));
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
   * Starts a terminal with a detected profile, null for the default one, in its target's folder. focus: a user's action in
   * main, after which the new terminal takes keyboard focus.
   */
  create(request: TerminalCreateRequest, focus: boolean): TerminalCreateResult {
    const { target } = request;
    const projectKey = 'project' in target ? target.project : 'home' in target ? null : this.deps.currentProjectKey() ?? null;
    const started = this.start(request.profileId, projectKey);
    if (!started.ok) return started;
    this.groups.push(this.newGroup([started.id]));
    this.activeId = started.id;
    this.changed(true);
    if (focus) this.shell?.focus(started.id);
    return started;
  }

  /**
   * Runs a task in its own tab, which becomes active without taking focus; a task already running under the same key is
   * killed and its tab reruns. The tab shows the exit code when the process ends.
   */
  runTask(request: TerminalTaskRequest): string {
    const task: TerminalTask = { key: request.key, args: request.args, env: request.env, onExit: request.onExit, onRestart: request.onRestart, ...(request.onCommandStart ? { onCommandStart: request.onCommandStart } : {}) };
    const existing = this.terminals.find((terminal) => terminal.task?.key === request.key);
    if (existing) this.kill(existing.id);
    const terminal = this.launch(this.taskProfile(request), request.projectKey, request.cwd, request.cwd, task);
    terminal.name = request.name;
    this.groups.push(this.newGroup([terminal.id]));
    this.activeId = terminal.id;
    this.changed(true);
    return terminal.id;
  }

  // The task tab takes the icon of the profile running the same shell.
  private taskProfile(request: TerminalTaskRequest): LaunchProfile {
    const fold = (file: string): string => (this.deps.platform === 'win32' ? file.toLowerCase() : file);
    const icon = this.deps.profiles(request.projectKey).find((profile) => fold(profile.file) === fold(request.file))?.icon ?? 'shell';
    return { id: `task:${request.key}`, name: request.name, file: request.file, args: [], icon, source: 'detected', customIcon: null, color: null };
  }

  // A new terminal at the end of the terminal array, in no group yet, with its process starting; the caller groups it and
  // publishes the change. A null profileId is the default profile; a null projectKey the home folder.
  private start(profileId: string | null, projectKey: string | null): TerminalCreateResult {
    const profile = profileId === null ? this.defaultProfile(projectKey) : this.listedProfile(profileId, projectKey);
    if (!profile) return { ok: false, reason: profileId === null ? 'noProfile' : 'unknownProfile' };
    const folder = this.folderOf(projectKey);
    if (folder === undefined) return { ok: false, reason: 'unknownProject' };
    return { ok: true, id: this.launch(profile, projectKey, folder, folder).id };
  }

  // The folder a terminal of projectKey starts in: the open project's folder, or the home folder for null; undefined for a
  // project that is not open.
  private folderOf(projectKey: string | null): string | undefined {
    if (projectKey === null) return this.deps.homedir;
    return this.deps.projects().find((project) => project.key === projectKey)?.fsPath;
  }

  private launch(profile: LaunchProfile, projectKey: string | null, startCwd: string, launchCwd: string, task?: TerminalTask): Terminal {
    const terminal: Terminal = {
      ...(task ? { task } : {}),
      // a daemon's terminal ids are unique across its clients, so a remote terminal draws one no other client holds
      id: isRemoteKey(projectKey) ? `term-${randomInt(1e14, 2 ** 48)}` : `term-${this.nextId++}`,
      backend: undefined,
      profile,
      projectKey,
      startCwd,
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
      restoring: 0,
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
        const created = this.start(entry.profileId, entry.projectKey);
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

  /** The active terminal, starting one with the default profile in the current project (else the home folder) when there is none. */
  ensureTerminal(): string | undefined {
    if (this.activeId !== null) return this.activeId;
    const created = this.create({ profileId: null, target: { current: true } }, false);
    return created.ok ? created.id : undefined;
  }

  focus(id: string): void {
    if (this.terminals.some((terminal) => terminal.id === id)) this.shell?.focus(id);
  }

  input(id: string, data: string): void {
    if (this.takesInput(id)) this.send(id, data);
  }

  /** Prepared paste data; it goes to the pty in pieces the host accepts, unless the terminal stopped meanwhile. */
  write(id: string, data: string): void {
    if (!this.takesInput(id)) return;
    for (const chunk of pasteChunks(data)) this.send(id, chunk);
  }

  private send(id: string, data: string): void {
    const terminal = this.find(id);
    if (!terminal) return;
    if (terminal.held) terminal.held.push(data);
    else this.post(terminal, { type: 'input', id, data });
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

  /**
   * What the terminal's links resolve against: its project, its tracked working directory, and how its shell writes paths;
   * undefined for a home folder terminal, whose links resolve to nothing because main opens files only inside a project.
   */
  linkBase(id: string): LinkBase | undefined {
    const terminal = this.find(id);
    const project = terminal && terminal.projectKey !== null ? this.deps.projects().find((candidate) => candidate.key === terminal.projectKey) : undefined;
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
    const listed = this.toConfirm(ids);
    if (listed.length === 0) return true;
    return this.deps.confirmKill(listed);
  }

  /** Those of ids a kill asks about per damocles.desktop.terminal.confirmOnKill, for a question that asks about more. */
  toConfirm(ids: readonly string[]): KillListEntry[] {
    const terminals = ids.flatMap((id) => this.find(id) ?? []);
    const listed = terminalsToConfirm(this.deps.settings().confirmOnKill, terminals.map((terminal) => ({ terminal, status: terminal.status, running: this.running(terminal) })));
    return listed.map(({ terminal, running }) => ({ name: terminal.name ?? terminal.profile.name, command: running }));
  }

  /** Kill, Kill All and the list's Delete key: confirmed first, then each terminal still present is killed. */
  async requestKill(ids: readonly string[]): Promise<void> {
    if (await this.confirmKill(ids)) for (const id of ids) this.kill(id);
  }

  /** Every terminal's id, in list order. */
  ids(): string[] {
    return this.terminals.map((terminal) => terminal.id);
  }

  /** The terminals a quit ends: a remote one outlives the app, so the quit's question leaves it out. */
  quitIds(): string[] {
    return this.terminals.filter((terminal) => !isRemoteKey(terminal.projectKey)).map((terminal) => terminal.id);
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
   * reported, else its project or home folder; the sizes are shared equally, and the new pane is active and takes focus.
   */
  async split(id: string): Promise<void> {
    const found = this.find(id);
    if (!found || found.task || this.splitRefused(id)) return;
    const cwd = await this.splitCwd(found);
    // the source, its group, its profile or its project may have changed while the folder was checked
    const source = this.find(id);
    if (!source || this.splitRefused(id)) return;
    const group = this.groupOf(id)!;
    const profile = this.listedProfile(source.profile.id, source.projectKey);
    const open = this.folderOf(source.projectKey) !== undefined;
    if (!profile || !open) {
      this.deps.log(`[terminal] not splitting ${id}: ${profile ? 'its project is closed' : `its profile ${source.profile.id} is no longer listed`}`);
      return;
    }
    const pane = this.launch(profile, source.projectKey, source.startCwd, cwd);
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
    if (this.live(id)) this.post(terminal, { type: 'resize', id, cols, rows });
  }

  ack(id: string, chars: number): void {
    const terminal = this.find(id);
    if (terminal && this.live(id)) this.post(terminal, { type: 'ack', id, chars });
  }

  /** The menu's Clear, which the shell ran on its xterm; the screen the pty host keeps follows. */
  clear(id: string): void {
    const terminal = this.find(id);
    if (terminal && this.live(id)) this.post(terminal, { type: 'clear', id });
  }

  /**
   * Ends the terminal and takes it out of its group, which goes with its last pane; an active terminal hands over to its
   * group's next active pane, else to the next group's, else the previous group's.
   */
  kill(id: string): void {
    this.removeTerminal(id, true);
  }

  /** Closes the tab of a terminal on a remote host and leaves it running there, as closing the window does. */
  detach(id: string): void {
    const terminal = this.find(id);
    if (!terminal || !isRemoteKey(terminal.projectKey)) throw new Error("Only a remote host's terminal can be left running");
    this.removeTerminal(id, false);
  }

  private removeTerminal(id: string, end: boolean): void {
    const index = this.terminals.findIndex((terminal) => terminal.id === id);
    if (index < 0) return;
    const [terminal] = this.terminals.splice(index, 1);
    if (end && terminal!.status !== 'exited') {
      this.post(terminal!, { type: 'kill', id });
      terminal!.task?.onExit(null);
    }
    // the daemon stops sending this client the terminal its other clients may still view
    if (!end) this.post(terminal!, { type: 'detach', id });
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
   * A new process for an exited terminal, with its id, project and launch folder (its project or home folder once that is
   * gone, as a split falls back), while its profile is still listed.
   */
  async restart(id: string): Promise<void> {
    const terminal = this.find(id);
    if (!terminal || terminal.status !== 'exited') return;
    if (terminal.task) {
      terminal.task.onRestart();
      return;
    }
    const profile = this.listedProfile(terminal.profile.id, terminal.projectKey);
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
    for (const data of held) this.post(terminal, { type: 'input', id, data });
  }

  /** The tab running the task named key, kept after its process ended until the tab closes; undefined without one. */
  taskTerminal(key: string): string | undefined {
    return this.terminals.find((terminal) => terminal.task?.key === key)?.id;
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

  /**
   * A newly loaded shell page holds no terminal output, so nothing it was sent will be acknowledged. Each live terminal's
   * screen is asked for; its output until that screen arrives is in it, so the page gets the screen and the output after.
   */
  shellLoaded(): void {
    for (const terminal of this.terminals) {
      if (terminal.status === 'exited') continue;
      this.post(terminal, { type: 'clearAck', id: terminal.id });
      if (!terminal.shell.spawned) continue;
      terminal.restoring++;
      this.post(terminal, { type: 'serialize', id: terminal.id });
    }
    this.publish();
  }

  /**
   * The terminals a daemon kept while this window or app was away (remote-state.json): each one its backend still lists gets
   * its tab back, in a group of its own, and its screen through serialize, which attaches this client to it again (wezterm's
   * list then attach); one present only as exited takes its place back, in its group and with its name, icon and color, and one
   * already live is left alone.
   */
  async reattach(backend: TerminalBackend, records: readonly RemoteTerminalRecord[]): Promise<void> {
    this.adopt(backend, records, await backend.list());
  }

  /**
   * A terminal of the authority's host this window does not show, which another client may have started: its tab joins as a
   * reattach's does, active and focused, and remote-state.json keeps it from then on. Throws when the host no longer runs it,
   * did not record its view, or its folder is not open here.
   */
  async open(backend: TerminalBackend, authorityKey: string, id: string): Promise<void> {
    if (this.shownLive(id)) {
      this.select(id);
      this.shell?.focus(id);
      return;
    }
    const live = await backend.list();
    const record = this.viewRecord(authorityKey, live.find((terminal) => terminal.id === id));
    if (!record) throw new Error(`Terminal ${id} cannot be shown here: its host no longer runs it, or its folder is not open`);
    this.adopt(backend, [record], live);
    this.select(id);
    this.shell?.focus(id);
  }

  /** Whether open() adds a tab for this host terminal: it has no live tab here, its host recorded its view, its folder is open. */
  canOpen(authorityKey: string, terminal: LiveTerminal): boolean {
    return !this.shownLive(terminal.id) && this.viewRecord(authorityKey, terminal) !== undefined;
  }

  // A tab of the terminal that has not exited, which open() selects instead of opening another.
  private shownLive(id: string): boolean {
    const shown = this.find(id);
    return shown !== undefined && shown.status !== 'exited';
  }

  // Another client's terminal as this window keeps it, under the open root its view names; its look is this window's own.
  private viewRecord(authorityKey: string, terminal: LiveTerminal | undefined): RemoteTerminalRecord | undefined {
    const view = terminal?.view;
    const root = view && this.deps.projects().find((project) => authorityKeyOfProject(project.key) === authorityKey && targetFolderKeyOf(project.key) === view.root);
    if (!view || !root) return undefined;
    return { id: terminal.id, projectKey: root.key, profile: view.profile, startCwd: view.startCwd, nonce: view.nonce, name: null, customIcon: null, color: null };
  }

  private adopt(backend: TerminalBackend, records: readonly RemoteTerminalRecord[], listed: readonly LiveTerminal[]): void {
    const live = new Map(listed.map((terminal) => [terminal.id, terminal]));
    let added = false;
    for (const record of records) {
      const found = live.get(record.id);
      const existing = this.find(record.id);
      // a reconnecting tab whose terminal the daemon no longer has ended while its host was away
      if (!found && existing?.status === 'reconnecting') {
        if (existing.held?.length) this.deps.log(`[terminal] ${existing.id} ended while its host was away; ${existing.held.length} inputs typed meanwhile were not sent`);
        existing.held = undefined;
        existing.status = 'exited';
        added = true;
        continue;
      }
      const replaceable = !existing || existing.status === 'exited' || existing.status === 'reconnecting';
      if (!found || !replaceable || !this.deps.projects().some((project) => project.key === record.projectKey)) continue;
      const shell = { ...newShellSession(record.startCwd), nonce: record.nonce, spawned: true };
      const terminal: Terminal = {
        id: record.id,
        backend,
        profile: { ...record.profile, source: 'detected', customIcon: null, color: null },
        projectKey: record.projectKey,
        startCwd: record.startCwd,
        launchCwd: record.startCwd,
        shell,
        commands: new Map(),
        nextCommandId: 1,
        status: 'running',
        exitCode: null,
        cols: found.cols,
        rows: found.rows,
        name: existing ? existing.name : record.name,
        customIcon: existing ? existing.customIcon : record.customIcon,
        color: existing ? existing.color : record.color,
        restoring: 1,
      };
      this.ensureHost(backend, record.projectKey);
      if (existing) {
        this.terminals[this.terminals.indexOf(existing)] = terminal;
      } else {
        this.terminals.push(terminal);
        this.groups.push(this.newGroup([terminal.id]));
      }
      this.post(terminal, { type: 'clearAck', id: terminal.id });
      this.post(terminal, { type: 'serialize', id: terminal.id });
      // after the serialize, which attaches this client: the hub takes a scrollback and input only from an attached one
      this.post(terminal, { type: 'scrollback', id: terminal.id, scrollback: this.scrollback });
      if (existing) this.flushHeld(existing, terminal);
      added = true;
    }
    if (added) {
      this.order();
      this.activeId ??= this.terminals.at(-1)?.id ?? null;
    }
    // the kept list drops the terminals that ended while away
    if (records.length > 0) this.changed(true);
  }

  /**
   * A launch's remote terminals whose host is not connected yet: each gets its tab back as reconnecting, with its name, icon
   * and color, until the host reattaches it (reattach) or reports it gone.
   */
  showReconnecting(records: readonly RemoteTerminalRecord[]): void {
    let added = false;
    for (const record of records) {
      if (this.find(record.id) || !this.deps.projects().some((project) => project.key === record.projectKey)) continue;
      this.terminals.push({
        id: record.id,
        backend: undefined,
        profile: { ...record.profile, source: 'detected', customIcon: null, color: null },
        projectKey: record.projectKey,
        startCwd: record.startCwd,
        launchCwd: record.startCwd,
        shell: { ...newShellSession(record.startCwd), nonce: record.nonce, spawned: true },
        commands: new Map(),
        nextCommandId: 1,
        status: 'reconnecting',
        exitCode: null,
        cols: 80,
        rows: 24,
        name: record.name,
        customIcon: record.customIcon,
        color: record.color,
        restoring: 0,
      });
      this.groups.push(this.newGroup([record.id]));
      added = true;
    }
    if (!added) return;
    this.order();
    this.activeId ??= this.terminals.at(-1)?.id ?? null;
    this.changed(false);
  }

  /**
   * The authority's connection dropped: its terminals go on running on the host, and their tabs show reconnecting, taking no
   * input, until the connection resumes (connectionResumed) or a fresh connection reattaches them (reattach).
   */
  connectionLost(authorityKey: string): void {
    let changed = false;
    for (const terminal of this.terminals) {
      if (terminal.projectKey === null || authorityKeyOfProject(terminal.projectKey) !== authorityKey) continue;
      if (terminal.status !== 'running' && terminal.status !== 'starting') continue;
      terminal.status = 'reconnecting';
      terminal.held ??= [];
      changed = true;
    }
    if (changed) this.changed(false);
  }

  /** The dropped connection resumed with nothing lost: its replay carries each terminal's output on from where it stopped. */
  connectionResumed(authorityKey: string): void {
    let changed = false;
    for (const terminal of this.terminals) {
      // a launch's placeholder has no backend yet; only a reattach gives it one
      if (terminal.backend === undefined || terminal.projectKey === null || authorityKeyOfProject(terminal.projectKey) !== authorityKey || terminal.status !== 'reconnecting') continue;
      terminal.status = 'running';
      this.flushHeld(terminal, terminal);
      changed = true;
    }
    if (changed) this.changed(false);
  }

  /**
   * The open projects are now projectKeys: the terminals of every other project are killed, home folder terminals stay, and
   * the state, which names each terminal's project, is published again.
   */
  projectsChanged(projectKeys: readonly string[]): void {
    const keep = new Set(projectKeys);
    const gone = this.terminals.filter((terminal) => terminal.projectKey !== null && !keep.has(terminal.projectKey));
    for (const terminal of gone) this.kill(terminal.id);
    this.publish();
  }

  /** The window closed: every terminal is killed, and the window layout keeps the list for the next window or launch. */
  closeWindow(): void {
    const live = new Set(this.terminals.filter((terminal) => terminal.status !== 'exited').flatMap((terminal) => terminal.backend ?? []));
    for (const backend of live) {
      const host = this.hosts.get(backend);
      if (host && !host.persistent) host.process.postMessage({ type: 'killAll' });
    }
    // a remote host keeps its terminals for the next window, which reattaches them
    for (const [backend, host] of [...this.hosts]) {
      if (!host.persistent) continue;
      this.hosts.delete(backend);
      host.process.kill();
    }
    for (const terminal of this.terminals) if (terminal.status !== 'exited') terminal.task?.onExit(null);
    // a spawn still waiting on its environment is never posted
    for (const terminal of this.terminals) terminal.pending = undefined;
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

  /**
   * Settings › Terminal changed: the views apply it, and each screen a pty host keeps is told the new scrollback; a daemon's
   * shared screen keeps the largest its attached clients asked for.
   */
  settingsChanged(): void {
    const { scrollback } = this.deps.settings();
    if (scrollback !== this.scrollback) {
      this.scrollback = scrollback;
      for (const terminal of this.terminals) if (this.live(terminal.id) && terminal.shell.spawned) this.post(terminal, { type: 'scrollback', id: terminal.id, scrollback });
    }
    this.publish();
  }

  /** Quit: each host kills every pty and ends; one that does not end in time is killed. */
  async dispose(): Promise<void> {
    this.shell = undefined;
    for (const host of this.hosts.values()) if (host.persistent) host.process.kill();
    await Promise.all([...this.hosts.values()].filter((host) => !host.persistent).map(async (host) => {
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
    }));
  }

  private defaultProfile(projectKey: string | null): LaunchProfile | undefined {
    const profiles = this.deps.profiles(projectKey);
    const configured = this.deps.settings().defaultProfile;
    return profiles.find((profile) => profile.id === configured) ?? profiles[0];
  }

  // A profile is launched only while its host lists it, so a hidden, removed or now-invalid one never starts again.
  private listedProfile(id: string, projectKey: string | null): LaunchProfile | undefined {
    return this.deps.profiles(projectKey).find((profile) => profile.id === id);
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

  // Whether a folder a shell reported still exists; never blocks main on a slow share. forProject throws while a remote
  // project's host is not connected.
  private isDirectory(terminal: Terminal, folder: string): Promise<boolean> {
    return Promise.resolve().then(() => this.deps.workspaces.forProject(terminal.projectKey).files.isDirectory(folder)).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.deps.log(`[terminal] cannot read the folder a shell reported: ${code ?? (err instanceof Error ? err.message : String(err))}`);
      return false;
    });
  }

  // The folder the source's shell last reported while it still exists, else the source's project or home folder.
  private async splitCwd(source: Terminal): Promise<string> {
    const reported = source.shell.cwd;
    if (reported !== null && (await this.isDirectory(source, reported))) return reported;
    this.deps.log(`[terminal] starting a split of ${source.id} in its start folder: ${reported === null ? 'the folder its shell reported was refused' : `${reported} no longer exists`}`);
    return source.startCwd;
  }

  private async restartCwd(terminal: Terminal): Promise<string> {
    if (terminal.launchCwd === terminal.startCwd || (await this.isDirectory(terminal, terminal.launchCwd))) return terminal.launchCwd;
    this.deps.log(`[terminal] restarting ${terminal.id} in its start folder: ${terminal.launchCwd} no longer exists`);
    return terminal.startCwd;
  }

  private live(id: string): boolean {
    const status = this.find(id)?.status;
    return status === 'starting' || status === 'running';
  }

  // A reconnecting tab holds what reaches main before the shell page turned its input off.
  private takesInput(id: string): boolean {
    const terminal = this.find(id);
    return this.live(id) || (terminal?.status === 'reconnecting' && terminal.held !== undefined);
  }

  // What from held, typed while the connection was away, now goes to target's host.
  private flushHeld(from: Terminal, target: Terminal): void {
    const held = from.held ?? [];
    from.held = undefined;
    for (const data of held) this.post(target, { type: 'input', id: target.id, data });
  }

  // The shell starts with its integration script when the setting allows and VS Code's rules inject into it.
  // The environment and the injection come from the terminal's backend, a daemon's over its connection, so what is posted
  // meanwhile waits in pending and follows the spawn.
  private spawn(terminal: Terminal, cwd: string = terminal.launchCwd): void {
    const { shell } = terminal;
    shell.spawned = true;
    const pending: HostRequest[] = [];
    terminal.pending = pending;
    // a kill posted meanwhile follows the spawn, so it finds its pty; a restart or a host exit meanwhile drops the spawn
    const current = (): boolean => terminal.pending === pending && terminal.shell === shell && terminal.status !== 'exited';
    // forProject throws while a remote project's host is not connected, which fails this spawn as a start error
    Promise.resolve().then(async () => {
      const backend = this.deps.workspaces.forProject(terminal.projectKey).terminals;
      return { backend, request: await this.spawnRequest(terminal, backend, cwd) };
    }).then(({ backend, request }) => {
      if (!current()) return;
      terminal.pending = undefined;
      terminal.backend = backend;
      this.ensureHost(backend, terminal.projectKey);
      this.post(terminal, request);
      for (const message of pending) this.post(terminal, message);
    }, (err: unknown) => {
      if (!current()) return;
      terminal.pending = undefined;
      const message = err instanceof Error ? err.message : String(err);
      this.apply(terminal, { type: 'error', id: terminal.id, message });
    });
  }

  private async spawnRequest(terminal: Terminal, backend: TerminalBackend, cwd: string): Promise<HostRequest> {
    const env = { ...(await this.deps.env(terminal.projectKey)), ...(terminal.projectKey !== null ? this.deps.rootEnv(terminal.projectKey) : {}), ...terminal.task?.env };
    const { scrollback, shellIntegration } = this.deps.settings();
    const view = this.viewOf(terminal);
    if (terminal.task) {
      return { type: 'spawn', id: terminal.id, file: terminal.profile.file, args: [...terminal.task.args], cwd, env: { ...this.hostEnv(terminal, env, 1), [NONCE_ENV]: terminal.shell.nonce }, cols: terminal.cols, rows: terminal.rows, scrollback, ...view };
    }
    const injection = shellIntegration ? await backend.injection({ file: terminal.profile.file, args: terminal.profile.args, nonce: terminal.shell.nonce, env }) : undefined;
    return {
      type: 'spawn',
      id: terminal.id,
      file: terminal.profile.file,
      args: [...(injection?.args ?? terminal.profile.args)],
      cwd,
      env: { ...this.hostEnv(terminal, env, Object.keys(injection?.env ?? {}).length), ...injection?.env },
      cols: terminal.cols,
      rows: terminal.rows,
      scrollback,
      ...view,
    };
  }

  // What a daemon lists so its other clients can show a remote terminal; a local pty host has no other client.
  private viewOf(terminal: Terminal): { view: TerminalView } | Record<string, never> {
    const root = terminal.projectKey === null ? undefined : targetFolderKeyOf(terminal.projectKey);
    if (root === undefined) return {};
    const { id, name, file, args, icon } = terminal.profile;
    return { view: { root, profile: { id, name, file, args: [...args], icon }, startCwd: terminal.startCwd, nonce: terminal.shell.nonce } };
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
    return linkPathStyle(this.osOf(terminal), terminal.profile.file);
  }

  // The OS the terminal's shell runs on: this computer's, or its remote project's.
  private osOf(terminal: Terminal): NodeJS.Platform {
    return terminal.projectKey !== null && isRemoteKey(terminal.projectKey) ? this.deps.osOf(terminal.projectKey) : this.deps.platform;
  }

  // What runs: the command between a trusted C and its D; without integration on macOS and Linux, a foreground process
  // other than the shell. cmd.exe and an idle shell report nothing.
  private running(terminal: Terminal): string | null {
    const { shell } = terminal;
    if (terminal.status === 'exited') return null;
    if (terminal.task) return terminal.name ?? terminal.profile.name;
    if (shell.integrated) return shell.running && (sanitizeTitle(shell.running.commandLine) ?? '');
    if (shell.processName === null || shell.processName === shellName(terminal.profile.file, this.osOf(terminal))) return null;
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
    // Output the screen being restored already holds never reaches the page, so it is acknowledged here too.
    const unseen = parsed.stripped + (terminal.restoring > 0 ? parsed.data.length : 0);
    for (let left = unseen; left > 0; left -= MAX_TERMINAL_ACK_CHARS) this.post(terminal, { type: 'ack', id: terminal.id, chars: Math.min(left, MAX_TERMINAL_ACK_CHARS) });
    const events: TerminalShellEventAt[] = [];
    const before = JSON.stringify([this.title(terminal), this.description(terminal), this.running(terminal), shell.integrated]);
    const now = this.deps.now ?? Date.now;
    for (const { offset, fields, index } of parsed.sequences) {
      const sequence = parseShellSequence(fields, shell.nonce, this.pathStyle(terminal));
      if (!sequence) continue;
      shell.integrated = true;
      const firstEvent = events.length;
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
          if (terminal.commands.size > MAX_TRACKED_COMMANDS) terminal.commands.delete(terminal.commands.keys().next().value!);
          events.push({ offset, event: { kind: 'commandExecuted', commandId, commandLine, time: now() } });
          terminal.task?.onCommandStart?.();
          break;
        }
        case 'commandFinished':
          events.push({ offset, event: this.finish(terminal, sequence.exitCode, now()) });
          break;
        case 'cwd':
          shell.cwd = sequence.cwd;
          break;
      }
      if (events.length > firstEvent) this.recordMarks(shell, index, events.slice(firstEvent).map(({ event }) => event));
    }
    if (terminal.restoring === 0 && (parsed.data.length > 0 || events.length > 0)) this.shell?.data({ id: terminal.id, data: parsed.data, ...(events.length > 0 ? { events } : {}) });
    if (JSON.stringify([this.title(terminal), this.description(terminal), this.running(terminal), shell.integrated]) !== before) this.changed(false);
  }

  private finish(terminal: Terminal, exitCode: number | null, time: number): Extract<TerminalShellEventAt['event'], { kind: 'commandFinished' }> {
    const { running } = terminal.shell;
    terminal.shell.running = null;
    if (running && terminal.commands.has(running.id)) terminal.commands.set(running.id, { commandLine: running.commandLine, exitCode });
    return { kind: 'commandFinished', commandId: running?.id ?? null, exitCode, time };
  }

  // The latest MAX_TERMINAL_SCREEN_MARKS sequences with events, oldest first.
  private recordMarks(shell: ShellSession, index: number, events: TerminalShellEvent[]): void {
    shell.marks.set(index, events);
    if (shell.marks.size > MAX_TERMINAL_SCREEN_MARKS) shell.marks.delete(shell.marks.keys().next().value!);
  }

  // A screen the page asked for: an older one, asked before another reload, is dropped as its output was.
  // A screen nobody asked for comes from a daemon that stopped sending this client a terminal's live data while it lagged:
  // it replaces the view as a reattach does.
  private restored(terminal: Terminal, message: Extract<HostMessage, { type: 'screen' }>): void {
    const { shell } = terminal;
    // A reattach or a lag screen holds output main never parsed, so main's count restarts at the screen's, in ground state.
    if (shell.stream.next !== message.sequences) shell.stream = new Osc633Stream(message.sequences);
    if (terminal.restoring > 0) terminal.restoring--;
    if (terminal.restoring > 0) return;
    const { marks } = shell;
    this.shell?.screen({
      id: terminal.id,
      data: message.data,
      cols: message.cols,
      rows: message.rows,
      marks: message.marks.flatMap(({ index, line }) => (marks.get(index) ?? []).map((event) => ({ line, event }))),
    });
    this.publish();
  }

  private post(terminal: Terminal, message: HostRequest): void {
    if (terminal.pending) terminal.pending.push(message);
    else if (terminal.backend) this.hosts.get(terminal.backend)?.process.postMessage(message);
  }

  private ensureHost(backend: TerminalBackend, projectKey: string | null): Host {
    const running = this.hosts.get(backend);
    if (running) return running;
    const process: PtyHostProcess = backend.startHost();
    let ended: () => void = () => undefined;
    const host: Host = { process, exited: new Promise((resolve) => { ended = resolve; }), persistent: isRemoteKey(projectKey) };
    this.hosts.set(backend, host);
    process.onMessage((raw) => {
      if (this.hosts.get(backend) === host) this.receive(host, backend, raw);
    });
    process.onExit((exit) => {
      ended();
      if (this.hosts.get(backend) !== host) return;
      this.hosts.delete(backend);
      const reason = exit.reason === null ? '' : ` (${exit.reason})`;
      const error = exit.error === null ? '' : `; last error: ${JSON.stringify(exit.error)}`;
      this.deps.log(`[terminal] the pty host exited with code ${exit.code}${reason}${error}`);
      for (const terminal of this.terminals) {
        if (terminal.backend !== backend || terminal.status === 'exited') continue;
        // a dropped connection's terminals still run on the host, and the next connection reattaches them
        if (host.persistent && terminal.status === 'reconnecting') continue;
        terminal.status = 'exited';
        terminal.exitCode = null;
        terminal.restoring = 0;
        terminal.task?.onExit(null);
      }
      this.changed(false);
    });
    this.deps.log('[terminal] started the pty host');
    return host;
  }

  // The host is main's own code: a message outside the contract is a bug, and stopping it marks every terminal exited.
  private receive(host: Host, backend: TerminalBackend, raw: unknown): void {
    const message = parseHostMessage(raw);
    if (!message) {
      this.deps.log('[terminal] stopping the pty host: it sent a message outside the contract');
      host.process.kill();
      return;
    }
    // Output, an exit or an error of a terminal that was killed meanwhile.
    const terminal = this.find(message.id);
    if (!terminal || terminal.backend !== backend || terminal.status === 'exited') return;
    this.apply(terminal, message);
  }

  private apply(terminal: Terminal, message: HostMessage): void {
    switch (message.type) {
      case 'data':
        this.output(terminal, message.data);
        return;
      case 'screen':
        this.restored(terminal, message);
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
        const reason = this.osOf(terminal) === 'win32' && terminal.status === 'starting' && Object.hasOwn(WINDOWS_LAUNCH_ERRORS, message.exitCode)
          ? WINDOWS_LAUNCH_ERRORS[message.exitCode as keyof typeof WINDOWS_LAUNCH_ERRORS]
          : undefined;
        terminal.status = 'exited';
        terminal.exitCode = message.exitCode;
        terminal.restoring = 0;
        terminal.task?.onExit(message.exitCode);
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
        terminal.restoring = 0;
        terminal.task?.onExit(null);
        this.shell?.data({ id: terminal.id, data: `${this.deps.spawnFailed(message.message)}\r\n` });
        this.changed(false);
        return;
    }
  }

  // persist: the list, its groups, the active terminal or the list width changed, which the window layout keeps.
  private changed(persist: boolean): void {
    if (persist) {
      // a task tab is always alone in its group and never restored; a remote terminal is kept in remote-state.json, never in
      // window-layout.json, and reattached in a new window with its group of one
      const isKept = (terminal: Terminal | undefined): boolean => terminal !== undefined && !terminal.task && !isRemoteKey(terminal.projectKey);
      const groups = this.groups.filter((group) => group.paneIds.every((id) => isKept(this.find(id))));
      const kept = groups.flatMap((group) => group.paneIds.map((id) => this.find(id)!));
      this.deps.persistRemote(this.terminals.filter((terminal) => !terminal.task && isRemoteKey(terminal.projectKey)).map((terminal) => ({
        id: terminal.id,
        projectKey: terminal.projectKey!,
        profile: { id: terminal.profile.id, name: terminal.profile.name, file: terminal.profile.file, args: [...terminal.profile.args], icon: terminal.profile.icon },
        startCwd: terminal.startCwd,
        nonce: terminal.shell.nonce,
        name: terminal.name,
        customIcon: terminal.customIcon,
        color: terminal.color,
      })));
      const active = kept.findIndex((terminal) => terminal.id === this.activeId);
      this.deps.persist({
        terminals: kept.map((terminal) => ({
          profileId: terminal.profile.id,
          projectKey: terminal.projectKey,
          name: terminal.name,
          customIcon: terminal.customIcon,
          color: terminal.color,
        })),
        active: active < 0 ? null : active,
        listWidthRem: this.listWidthRem,
        groups: groups.map((group) => ({ panes: group.paneIds.length, activePane: group.paneIds.indexOf(group.activePaneId), sizes: [...group.sizes] })),
      });
    }
    this.publish();
    this.deps.onDidChange();
  }
}
