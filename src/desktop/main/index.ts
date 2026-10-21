import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, clipboard, dialog, Menu, powerMonitor, screen, session, shell as electronShell, webContents, WebContentsView, type WebContents } from 'electron';
import { installLogSink, log, showLog } from '../../core/logger';
import { processProfiler, StallMonitor } from '../local-services/stall-monitor';
import { getRipgrepSearchOptions, resolveRgPath } from '../../core/chat-panel/ripgrep';
import { locateSettingsFile, saveSettingsFileText } from '../../core/chat-panel/settings-file-editor';
import type { MentionTarget } from '../../core/chat-panel/mention-resolver';
import { installPlatform } from '../../core/platform-host';
import type { ChatActivity } from '../../core/pi-session/session-state';
import { LANGUAGE_PREFERENCE_KEY } from '../../shared/language-preference';
import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import { runLegacySettingsMigrations } from '../../core/config/legacy-settings-migrations';
import { movePreferApiKeyToGlobalState } from '../../core/pi-session/openai-auth';
import { deleteRetiredSecrets } from '../../core/config/retired-secrets';
import { providerKeyStored } from '../../core/pi-session/custom-providers';
import { PROVIDER_SECRET_KEYS } from '../../core/pi-session/explore-providers';
import { DAMOCLES_HOME_DIR } from '../../core/paths';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { homeDirectory } from '../../core/workspace-folders/folder-registry';
import type { Disposable } from '../../platform/disposable';
import type { InputBoxOptions } from '../../platform/dialog-service';
import type { PanelOptions } from '../../platform/window-service';
import type { ChatPermissions, PanelCreate } from '../core-protocol';
import type { RelayView } from './core-services/host-services';
import type { StoredSession } from '../../shared/types/session';
import type { ChatAttachmentInput } from '../../shared/types/chat-attachment';
import { MAX_OVERLAY_TAGS, OVERLAY_CHANNELS, type OverlayAnswer, type OverlayRequest } from '../preload/overlay-channels';
import type { NotificationProject } from '../preload/notifications';
import { canCheck, type UpdateSnapshot, type VersionInfo } from '../preload/updates';
import {
  MAX_TAG_LENGTH,
  moveGridPane,
  NEW_CHAT_ID_PREFIX,
  toggleGridMaximize,
  toggleGridPane,
  type GridPane,
  type GridSlot,
  type ShellGridLayout,
  type ChatMutationResult,
  type ChatStatus,
  type FileRef,
  type FilesDeleteResult,
  type FilesListResult,
  type FilesMutationResult,
  type RemoveProjectResult,
  type SelectChatResult,
  type ShellChat,
  type ShellChatList,
  type ShellFocusPart,
  type ShellProject,
  type ShellState,
  type ShellWindowState,
} from '../preload/shell-channels';
import type { QuickOpenMode, QuickOpenScope } from '../preload/overlay-channels';
import type { ChatCommand, ChatReviewScope } from '../../shared/types/messages';
import { ChatReviewHost } from './chat-review-host';
import { handleAboutChannels, runUpdateAction, type AboutDeps } from './about-channels';
import { ActivationFocus, onWindowActivated, onWindowDeactivated } from './activation-focus';
import { trayIcon, windowIcon } from './app-icon';
import { startDesktopCore, type CoreConnectionDeps, type DesktopCore } from './bootstrap';
import { CORE_READY_TIMEOUT_MS, restartDecision, RESTART_LIMIT } from './core-process';
import type { CoreClient } from './core-client';
import { BrowserTabs } from './browser-tabs';
import { chatsToUnload, ChatWorkQueue } from './chat-pool';
import { chatProjectKey } from './chat-project';
import { isActiveActivity } from '../../shared/chat-retention';
import { storedTitle } from './chat-title';
import { parseUserDataDir } from './cli';
import { CoreHost } from './core-host';
import { QuitLifecycle, shutDown } from './shutdown';
import {
  DEFAULT_FILES_EXCLUDE,
  DEFAULT_SEARCH_EXCLUDE,
  FILES_EXCLUDE_SETTING,
  GIT_BLAME_EDITOR_DECORATION_SETTING,
  SEARCH_EXCLUDE_SETTING,
  isDesktopSettingValue,
  NOTIFICATION_SOUND_SETTING,
  NOTIFICATIONS_SETTING,
  UPDATE_CHECK_AUTOMATICALLY_SETTING,
  RESTORE_LAYOUT_SETTING,
  SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING,
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_PROFILES_SETTING,
  THEME_SETTING,
  type DesktopLanguageSetting,
} from '../local-services/desktop-configuration';
import { BackupStore } from './documents/backups';
import type { Project } from '../local-services/confine';
import { DocumentService } from './documents/document-service';
import { EditorPane, editorSettings } from './editor-pane';
import { FormatService } from './formatting/format-service';
import { FormatterHosts, PRETTIER_INSTALL_GLOB } from './formatting/formatter-hosts';
import { spawnFormatterHost } from './formatting/formatter-process';
import { FileTree } from './files/file-tree';
import { filesFailureMessage, settleFilesAction, type FilesAction, type FilesFailed } from './files/files-failure';
import { QuickOpenIndex, QuickOpenPicker } from './quick-open';
import { CommandPalette, desktopCommands } from './commands';
import { pickDefaultProfile, pickNewTerminal, pickTerminalColor, pickTerminalIcon } from './terminal-pick';
import { detectProfiles, systemProfileProbe, windowsBuildNumber } from './terminal/profiles';
import { profileFileKind, TerminalProfileCatalog } from './terminal/user-profiles';
import { spawnPtyHost } from './terminal/pty-host-process';
import { terminalEnvironment } from './terminal/terminal-env';
import { TerminalService, terminalSettings } from './terminal/terminal-service';
import { killQuestion } from './terminal/kill-confirmation';
import { folderLinkAction, TerminalLinks } from './terminal/terminal-links';
import { pasteText, TerminalPasteGate } from './terminal/terminal-paste';
import { askShellMenu, GestureGrant } from './clipboard-gestures';
import { TERMINAL_LIST_DEFAULT_REM, type TerminalProfileReport, type TerminalAction, type TerminalAddToChat, type TerminalColor, type TerminalCustomIcon, type TerminalOpenLink } from '../preload/terminal-channels';
import { capTerminalText, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES } from '../preload/terminal-attachment-cap';
import { excludeSettingGlobs } from './search/rg-args';
import { SearchHost, shellSearchSettings } from './search/search-host';
import type { SearchFolder } from './search/search-service';
import {
  installApplicationMenu,
  installedTerminalPassKeys,
  popupApplicationMenu,
  shellShortcutLabels,
  updateMenuState,
  type FocusPart,
  type MenuActions,
  type MenuState,
} from './menu';
import { createAskpassBridge, type AskCredential } from './askpass-bridge';
import { createMessageAsker, type AskMessage } from './message-dialog';
import { DO_NOT_DISTURB_KEY, handleCenterChannels, NotificationCenter, runEntryAction, type ChatKey, type ChatRef, type EntryActionDeps, type StickyNotice } from './notification-center';
import { NotifierHost } from './notifier';
import { createInputAsker, createQuickPickAsker, OverlayHost, overlayHtml } from './overlay';
import { OverlaySettings, writeDesktopSetting } from './overlay-settings';
import type { SettingsTarget } from '../../shared/settings-sections';
import { PanelStateStore } from './panel-state-store';
import { createDesktopPlatform, type DesktopPlatform } from './platform';
import { askpassPaths, coreHostEntryPath, createDesktopAppPaths, ptyHostPaths, quickOpenWorkerPath, unpackagedResourceRoot, watchWorkerPath, type DesktopLayout } from './platform/app-paths';
import type { ChatTabMessenger } from './platform/editor-service';
import { createDesktopKeyValueState, type DesktopKeyValueState } from './platform/key-value-state';
import { createDesktopLocalizationService, launchLanguage, readLanguageSetting, type DesktopLocalizationService } from '../local-services/localization-service';
import { createDesktopLogSinkFactory, logFileName } from '../local-services/log-sink';
import { Emitter } from '../local-services/emitter';
import { createDesktopNotificationService } from './platform/notification-service';
import { logUncaughtErrors } from '../local-services/process-errors';
import { ProjectList } from './projects';
import { announceInstalledVersion, ReleaseNotesSource } from './release-notes';
import { appResourceUri, handleAppProtocol, registerAppScheme } from './protocol';
import { restrictPermissions, hardenWebContents } from './security';
import { reportFailure, ShellHost, shellHtml, type ShellActions } from './shell';
import { mergeLoginShellEnv, probeGit, type GitProbe } from './shell-env';
import { NO_SCM_MENU_STATE, ScmHost, type ScmWorktreeDeps } from './scm/scm-host';
import type { ScmWorktreeChat } from '../preload/scm-channels';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns, processLauncher, type Launcher } from '../../core/process-launcher';
import { allJsonConfigWritesSettled } from '../../core/config/json-config-write';
import { createScmClient, type ScmClient } from './scm/scm-client';
import { SUBCALL_USAGE_LEDGER_PATH } from '../../core/paths';
import { TaskbarBadges } from './taskbar-badges';
import { TaskbarCounter } from './taskbar-counter';
import { currentTheme, currentThemeKind, followThemeSettings, LIGHT_THEME, onThemeChange, THEME_BACKGROUND } from './theme';
import { AppTray } from './tray';
import { TrustStore } from './trust-store';
import { loadAutoUpdater, shellPlatform, UpdateService } from './updater';
import type { ChatWorktreeRecord, WorktreeRecord } from '../../core/worktrees/registry';
import { worktreeEnvironment } from '../../core/worktrees/environment';
import { worktreeEngine, type WorktreeEngine } from './worktrees/engine';
import { WorktreeRecords } from './worktrees/records';
import { SCM_SETTING_KEYS } from '../../core/scm/settings-keys';
import type { WorktreeStateData } from '../../shared/types/messages';
import type { UserContentBlock } from '../../shared/types/content';
import { parseRootKey, rootKey } from '../preload/folder-root';
import type { ChatsWorktreeOptions, NewChatInWorktreeRequest, NewChatWorktree, ShowFolderRequest, WorktreeFinishAction, WorktreeFinishRequest } from '../preload/shell-channels';
import { RootSet, WorktreeRoots, type RootProject } from './worktrees/roots';
import { closeWorktreeRoot, type CloseOutcome } from './worktrees/close-worktree';
import { HeldPrompts } from './held-prompts';
import { KeptPermissions } from './kept-permissions';
import { removeProject, type WaitingChat } from './remove-project';
import { ShownFolderState } from './worktrees/shown-folder';
import { setupTaskKey, WorktreeController } from './worktrees/worktree-controller';
import { createWorktreeDialogAsker, type AskWorktreeDialog } from './worktrees/worktree-dialogs';
import type { WorktreeDialog } from '../preload/overlay-channels';
import { setupShell } from './worktrees/setup-terminal';
import { chatRowWorktree } from './worktrees/chat-rows';
import { UsageWarningStore } from './usage-warning-store';
import { PanelViews, type DesktopPanel, type ShowFocus } from './views';
import {
  boundsToPersist,
  clampToWorkAreas,
  defaultWindowBounds,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WindowLayoutStore,
  type AppliedBounds,
  type Rect,
} from './window-layout-store';

// electron-builder.yml appId: the Windows AppUserModelID, the macOS bundle id and the update identity. The unpackaged app's own
// ID keeps its taskbar button group, and any Start Menu shortcut or pin carrying that ID, apart from an installed copy's.
const APP_ID = app.isPackaged ? 'io.github.aizenvoltprime.damocles' : 'io.github.aizenvoltprime.damocles.dev';
// The packaged package.json name. The unpackaged app sets it too, or Electron names it "Electron" and it shares its
// userData folder and safeStorage key with every other unpackaged Electron app.
// The unpackaged app never shares userData, the safeStorage key or the single-instance lock with an installed copy.
const APP_NAME = app.isPackaged ? 'damocles' : 'damocles-dev';
const DISPOSE_TIMEOUT_MS = 10_000;
// within DISPOSE_TIMEOUT_MS: the wait for the window to close and its pages' requests to settle
const CLOSE_TIMEOUT_MS = 3_000;
const CHAT_PANEL: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [] };
// Playwright's hooks (globalThis.__damoclesE2e and core's e2e.* requests), in the unpackaged app only.
const E2E_HOOKS = !app.isPackaged && process.env['DAMOCLES_E2E_HOOKS'] === '1';
const BROWSER_ENABLED_KEY = 'damocles.browser.enabled';
// What a shell call answers once main has reported its failure to the user.
const CHAT_CHANGE_FAILED: ChatMutationResult = { ok: false, reason: 'failed' };
const OVERLAY_DISMISSED: OverlayAnswer = { kind: 'dismissed' };

function runtimeProblem(): string | undefined {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) return `Damocles needs Electron's Node 24 runtime, but this build runs Node ${process.versions.node}.`;
  if (process.getBuiltinModule('node:sqlite') === undefined) return 'The node:sqlite module is not available in this Electron build, and memory, usage and Compass need it.';
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isShellTag(tag: string | undefined): tag is string {
  return tag !== undefined && tag.trim().length > 0 && tag.length <= MAX_TAG_LENGTH;
}

function windowStateOf(window: BrowserWindow | undefined): ShellWindowState {
  if (!window || window.isDestroyed()) return 'normal';
  if (window.isFullScreen()) return 'fullScreen';
  return window.isMaximized() ? 'maximized' : 'normal';
}

// Position and content size: getBounds reads a frameless Windows window a DIP larger than setBounds made it at 150%
// (electron/electron#51572), its content size exactly.
function normalBoundsOf(window: BrowserWindow): Rect {
  const [x = 0, y = 0] = window.getPosition();
  const [width = 0, height = 0] = window.getContentSize();
  return { x, y, width, height };
}

// The bounds main applied to a window and its last read while neither maximized, minimized nor full screen.
interface WindowBoundsTracker {
  applied: AppliedBounds | undefined;
  normal: Rect;
}

// Every placement main makes ends here, once the window is at `bounds`' position: the constructor and setBounds size a
// frameless Windows window up to 4 DIP off its request at 150% (electron/electron#51572), and setContentSize sizes it exactly.
function sizeExactly(window: BrowserWindow, bounds: Rect, tracker: WindowBoundsTracker): void {
  window.setContentSize(bounds.width, bounds.height);
  const read = normalBoundsOf(window);
  tracker.applied = { bounds, read };
  tracker.normal = read;
}

// Read on every save as well as on 'resize' and 'move': X11 applies setBounds asynchronously, so those events can carry the
// new position with the old size, and Linux emits no 'resized' or 'moved' to correct it.
function refreshNormalBounds(window: BrowserWindow, tracker: WindowBoundsTracker): void {
  if (!window.isMaximized() && !window.isMinimized() && !window.isFullScreen()) tracker.normal = normalBoundsOf(window);
}

// A chat's worktree state as PanelManager.onDidChangeWorktreeState reports it.
interface WorktreeEvent {
  readonly panelId: string;
  readonly sessionId?: string;
  readonly projectPath: string;
  readonly worktreeId?: string;
  readonly workingFolder: string;
  readonly state: WorktreeStateData;
  readonly busy: boolean;
}

function statusOf(activity: ChatActivity | undefined): ChatStatus {
  if (activity?.state === 'requires_action') return 'waiting';
  return activity?.state === 'running' || activity?.background === true ? 'running' : 'idle';
}

const layout: DesktopLayout = app.isPackaged
  ? { packaged: true, asarPath: app.getAppPath() }
  : { packaged: false, repoRoot: unpackagedResourceRoot(__dirname) };
const resourceRoot = layout.packaged ? layout.asarPath : layout.repoRoot;

class DesktopApp {
  private readonly userDataDir = app.getPath('userData');
  private readonly logsDir = path.join(this.userDataDir, 'logs');
  // D36: Show Log opens a log sink's file as a read-only editor tab.
  private readonly logSinks = createDesktopLogSinkFactory(this.logsDir, !app.isPackaged, (filePath, preserveFocus) => this.openLogTab(filePath, preserveFocus));
  private readonly logSink = this.logSinks.create('Damocles');
  private readonly states: PanelStateStore;
  private readonly windowLayout: WindowLayoutStore;
  private readonly projects: ProjectList;
  private readonly state: DesktopKeyValueState;
  private readonly trust: TrustStore;
  private readonly usageWarnings: UsageWarningStore;
  // Every desktop question: the overlay's dialog, else the OS message box (D41).
  private readonly askMessage = createMessageAsker({
    overlay: () => this.overlay,
    window: () => this.window,
    focused: () => webContents.getFocusedWebContents() ?? undefined,
    closing: () => this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done',
    log: (line) => log(line),
  });
  // A close or quit asks in a window it shows first, since one hidden to the tray or minimized hides the question.
  private readonly ask: AskMessage = (question, signal) => {
    if (this.lifecycle.releasing) this.revealWindow();
    return this.askMessage(question, signal);
  };
  private readonly lifecycle = new QuitLifecycle({
    app,
    release: () => this.releaseForClose(),
    dispose: () => this.disposeAll(),
    log: (line) => log(line),
  });
  // D52: the taskbar badge, drawn by the overlay page.
  private readonly taskbarBadges = new TaskbarBadges({
    rasterize: (art) => this.overlay?.rasterize(art) ?? Promise.resolve(undefined),
    scaleFactor: () => screen.getPrimaryDisplay().scaleFactor,
    // White on red in every theme; the light palette's pair is the one at AA.
    colors: { fill: LIGHT_THEME['--d-danger']!, text: LIGHT_THEME['--d-on-danger']! },
    log: (line) => log(line),
  });
  // D52: popups in a window of the app's own outside the main window, which the OS notification settings do not hold back.
  private readonly notifier: NotifierHost = new NotifierHost({
    platform: process.platform,
    preloadPath: path.join(__dirname, 'preload-overlay.js'),
    state: () => ({ locale: this.requireLocalization().language, platform: shellPlatform(process.platform) }),
    // A popup's action brings the window forward before it runs.
    resolveToast: (id, action) => {
      if (action !== undefined) this.showWindow();
      this.notificationCenter.resolveToast(id, action);
    },
    holdToast: (id, held) => this.notificationCenter.holdToast(id, held),
    leave: () => this.leavePopups(),
    blurred: () => {
      this.toastFocusOrigin = undefined;
    },
    pendingToasts: () => this.notificationCenter.pendingToasts(),
    log: (line) => log(line),
  });
  private readonly taskbar = new TaskbarCounter({
    platform: process.platform,
    window: () => this.window,
    badge: (label) => this.taskbarBadges.badge(label),
    setBadgeCount: (count) => app.setBadgeCount(count),
    describe: (count) => {
      const { t } = this.requireLocalization();
      return count === 1 ? t('1 new notification') : t('{0} new notifications', String(count));
    },
    log: (line) => log(line),
  });
  private readonly notificationCenter: NotificationCenter = new NotificationCenter({
    doNotDisturb: () => this.state.global.get<boolean>(DO_NOT_DISTURB_KEY, false) === true,
    setDoNotDisturb: (on) => this.state.global.update(DO_NOT_DISTURB_KEY, on),
    popupsEnabled: () => this.platform?.settings.get<boolean>(NOTIFICATIONS_SETTING, true) !== false,
    windowFocused: () => this.window?.isFocused() ?? false,
    chatSelected: (corePanelId) => {
      const selected = this.views?.selected();
      return selected !== undefined && selected === this.panelOfCore(corePanelId);
    },
    viewedChat: () => this.viewedChat(),
    flash: (on) => this.flash('notifications', on),
    describeChat: (corePanelId) => this.describeChat(corePanelId),
    // Only while the main window exists, so the popup window never keeps the app running; from its closed event on it reports destroyed.
    popups: () => (this.window && !this.window.isDestroyed() ? this.notifier.sink() : undefined),
    chime: (tone) => {
      if (this.platform?.settings.get<boolean>(NOTIFICATION_SOUND_SETTING, true) !== false) this.notifier.chime(tone);
    },
    usageWarningShown: (crossing) => this.usageWarnings.shown(crossing),
    recordUsageWarning: (crossing) => {
      void this.usageWarnings.record(crossing);
    },
    run: (action) => {
      runEntryAction(action, this.entryActionDeps).catch(this.report('A notification action'));
    },
    changed: () => this.notificationsChanged(),
    log: (line) => log(line),
  });
  private readonly notifications = createDesktopNotificationService({
    notice: (severity, message, actions) => this.notificationCenter.notice(severity, message, actions),
    ask: this.ask,
    t: (message) => this.requireLocalization().t(message),
    log: (line) => log(line),
  });
  private readonly core = new CoreHost<DesktopCore>({
    start: () => this.startCoreServices(),
    openTabs: (afterRestart) => this.openInitialChats(afterRestart),
    retainTabStates: (retain) => {
      if (retain) this.heldPrompts.keep();
      this.views?.retainStatesOnClose(retain);
    },
    log: (line) => log(line),
    drainTimeoutMs: CLOSE_TIMEOUT_MS,
    haltedChanged: () => this.engineHaltChanged(),
  });
  // the error notice a halt raised, offering Restart until the engine runs again
  private haltNotice: StickyNotice | undefined;
  private localization: DesktopLocalizationService | undefined;
  private window: BrowserWindow | undefined;
  private views: PanelViews | undefined;
  private browserTabs: BrowserTabs | undefined;
  private shell: ShellHost | undefined;
  private overlay: OverlayHost | undefined;
  private overlaySettings: OverlaySettings | undefined;
  private quickOpenPicker: QuickOpenPicker | undefined;
  private readonly backups = new BackupStore(this.userDataDir, (line) => log(line));
  // Files' trash and permanent delete; the e2e hooks replace them to fail on demand.
  private trashEntry = (absolutePath: string): Promise<void> => electronShell.trashItem(absolutePath);
  private removeEntry = (absolutePath: string): Promise<void> => fs.promises.rm(absolutePath, { recursive: true });
  // Runs as a quit's store flush begins; the e2e hooks hold it open.
  private beforeStoreFlush = (): Promise<void> => Promise.resolve();
  // Runs as a core dispose begins; the e2e hooks hold it open.
  private beforeCoreDispose = (): Promise<void> => Promise.resolve();
  // Runs as each restore recorded in chatRestores begins; the e2e hooks hold it open or fail it.
  private beforeChatRestore = (): Promise<void> => Promise.resolve();
  // Runs as each Graph history request begins; the e2e hooks hold it open.
  private beforeHistory = (): Promise<void> => Promise.resolve();
  // The browser page restores main asked core for, while the e2e hooks count them.
  private e2ePageRestores: { count: number } | undefined;
  // Settles once the launch reopened its chats, restores and page restores included, or found it should not.
  private launchTabs: Promise<void> = Promise.resolve();
  // Settles once core finished restoring or setting up a chat, whether core registered the chat or not; every chat has one.
  private readonly chatRestores = new WeakMap<DesktopPanel, Promise<void>>();
  private fileTree: FileTree | undefined;
  private quickOpenIndex: QuickOpenIndex | undefined;
  private search: SearchHost | undefined;
  private scm: ScmHost | undefined;
  // core's ScmService as ScmHost reads and calls it; one per app run, each core attaches
  private scmClient: ScmClient | undefined;
  // the overlay's credential prompts core's askpass server asks for
  private askCredential: AskCredential | undefined;
  // the git probeGit found at startup; core's source control spawns its absolute path
  private gitProbe: GitProbe = { available: false, reason: '' };
  // the e2e hooks' stand-in for the commit-message model (DAMOCLES_E2E_HOOKS, unpackaged only)
  private palette: CommandPalette | undefined;
  private editorPane: EditorPane | undefined;
  private formatter: FormatService | undefined;
  private formatterHosts: FormatterHosts | undefined;
  private terminals: TerminalService | undefined;
  private readonly terminalLinks = new TerminalLinks((line) => log(line));
  private terminalProfiles: TerminalProfileCatalog | undefined;
  // settles once the shells were detected and the user's profiles validated, after which the window restores its terminals
  private profilesDetected: Promise<void> = Promise.resolve();
  // profilesDetected has settled, so an empty profile list means no shell was found
  private profilesReady = false;
  // settles once the window restored the window layout's terminals
  private terminalsRestored: Promise<void> = Promise.resolve();
  // damocles.desktop.language as read at launch; a change applies after a restart (D23)
  private languageSetting: DesktopLanguageSetting = 'system';
  // damocles.desktop.restoreLayout as read at launch
  private restoreAtLaunch = true;
  private tray: AppTray | undefined;
  private platform: DesktopPlatform | undefined;
  // main's own process launcher pool (search, Quick Open, terminal profiles, the login shell and git probes)
  private launcher: Launcher | undefined;
  // what each Damocles Core is forked and connected with
  private coreDeps: CoreConnectionDeps | undefined;
  // the times (performance.now) of core's crashes the restart policy counts (restartDecision)
  private coreCrashes: readonly number[] = [];
  // the times of the reloads core asked for, which the same policy bounds
  private coreReloads: readonly number[] = [];
  // the cores that ended in this app run without releasing their session leases (a crash, or a kill after core.shutdown
  // failed or timed out) and when main saw each end; the next core takes those leases over at once
  private readonly endedCores: { pid: number; endedAt: number }[] = [];
  // the open window's bounds tracker, which a placement main makes records what it applied in
  private windowBounds: WindowBoundsTracker | undefined;
  private updates: UpdateService | undefined;
  private releaseNotes: ReleaseNotesSource | undefined;
  private readonly disposables: Disposable[] = [];
  // Settles once the window is gone and the requests its shell and overlay pages made were answered.
  private windowClosed: Promise<void> = Promise.resolve();
  // The user agreed to kill the running terminals in the close or quit under way (releaseForClose).
  private terminalsReleased = false;
  // The selected project; the selected chat belongs to it once one is selected.
  private selectedProjectKey: string | undefined;
  // ShellState.layoutRevision
  private layoutRevision = 0;
  // In memory only: the chat id last viewed in each project, which selecting the project selects again.
  private readonly lastChatByProject = new Map<string, string>();
  // The project a chat was opened in, until core reports the chat's folder.
  private readonly openedInProject = new WeakMap<DesktopPanel, string>();
  private readonly lastViewed = new WeakMap<DesktopPanel, number>();
  private viewCount = 0;
  // Latest activity by core panel id; pruned when retention runs.
  private readonly activity = new Map<string, ChatActivity>();
  // the chats' review tabs and draft comments (D60)
  private readonly chatReviews = new ChatReviewHost({
    session: (panelId) => this.core.current()?.client.reviewSession(panelId),
    sessionId: (panelId) => this.core.current()?.client.chat(panelId)?.sessionId,
    title: (panelId) => {
      const panel = this.panelOfCore(panelId);
      return panel ? this.titleOf(panel) : '';
    },
    editorPane: () => this.requireEditorPane(),
    warn: (message) => void this.requirePlatform().notifications.warn(message),
    t: (message, ...args) => this.requirePlatform().localization.t(message, ...args),
    menuChanged: () => this.refreshMenuState(),
    log: (line) => log(line),
  });
  // Each project's stored sessions from its last catalog read, for titles outside a list request.
  private readonly catalogRows = new Map<string, readonly StoredSession[]>();
  private readonly chatWork = new ChatWorkQueue();
  // Worktree chats (slice 12a): core's registry as its worktrees mirror shows it, kept across a core restart.
  private readonly worktreeRecords = new WorktreeRecords(path.join(DAMOCLES_HOME_DIR, 'worktrees'), (line) => log(line));
  // core's worktree git and registry work, on the running core
  private readonly worktreeEngine: WorktreeEngine = worktreeEngine((method, args) => this.core.run(`Worktree ${method}`, (core) => core.client.worktreeCall(method, args)));
  private readonly roots = new WorktreeRoots({ projects: () => this.desktopProjects(), registry: () => this.worktreeRecords });
  private worktrees: WorktreeController | undefined;
  private askWorktreeDialog: AskWorktreeDialog | undefined;
  // core's last worktree state by core panel id
  private readonly worktreeStates = new Map<string, WorktreeEvent>();
  private readonly shownFolders = new ShownFolderState({
    roots: this.roots,
    selectedChat: (projectKey) => this.selectedChatPlace(projectKey),
    finish: (root) => this.finishStateOf(root.worktree!),
    newChatIn: (record) => this.newChatInTarget(record),
  });
  // the roots terminals, the file tree, Quick Open and the formatter hosts last followed
  private readonly rootSet = new RootSet();
  // the root keys of the editor tabs, from the editor's last state
  private editorRootKeys: ReadonlySet<string> = new Set();
  private readonly heldPrompts = new HeldPrompts({
    chats: () => (this.views?.chats() ?? []).map((chat) => ({ panelId: chat.panelId, corePanelId: this.corePanelIdOf(chat) })),
    held: (corePanelId) => this.core.current()?.client.chat(corePanelId)?.heldPrompt as readonly UserContentBlock[] | undefined,
    store: { setHeldPrompt: (panelId, held) => this.states.setHeldPrompt(panelId, held) },
  });
  private readonly keptPermissions = new KeptPermissions();
  // worktree roots source control keeps open while a flow needs their repository (Push branch)
  private readonly pinnedScmRoots = new Set<string>();
  // chats a worktree delete unloads, whose close selects no other chat
  private readonly closingForWorktree = new WeakSet<DesktopPanel>();
  // new chats that show once core holds their worktree opt-in
  private readonly openingInWorktree = new WeakSet<DesktopPanel>();
  private retentionScheduled = false;
  private readonly chatFoldersChanged = new Emitter<[]>('chat-folders', (line) => log(line));
  private shellFocusedPart: ShellFocusPart | null = null;
  // Whether focus in the terminal pane is an xterm's own input, as the shell reports; it only routes the user's Edit › Paste.
  private terminalInputFocused = false;
  // A context-menu click or key in the shell page, which a shell menu with clipboard items takes.
  private readonly shellMenuGrant = new GestureGrant<true>();
  private readonly terminalPaste = new TerminalPasteGate({
    activeTerminal: () => this.terminals?.activeTerminal() ?? null,
    terminalFocused: () => this.focusedPart() === 'terminal',
    read: (source) => {
      const board = source === 'selection' ? clipboard.selection : clipboard;
      if (!board) throw new Error('This platform has no selection clipboard');
      return board.readText();
    },
    paste: (text, request) => {
      const platform = this.requirePlatform();
      const terminals = this.requireTerminals();
      return pasteText(text, request.bracketedPasteMode, {
        setting: terminalSettings(platform.settings).multiLinePasteWarning,
        ask: this.ask,
        t: (message, ...args) => platform.localization.t(message, ...args),
        write: (data) => terminals.write(request.id, data),
      });
    },
    log: (line) => log(line),
  });
  // The part F6 moved keyboard focus from into the desktop popups, until focus is anywhere else or the popup window loses it.
  private toastFocusOrigin: FocusPart | undefined;
  // What the main window focuses once it gains focus (a part left from the popups, or an overlay popup opened while it was
  // unfocused), until a later focusOn places focus, that popup closes or the window does.
  private focusOnActivation: FocusPart | 'overlay' | undefined;
  private readonly activationFocus = new ActivationFocus<WebContents>((contents) => contents === this.window?.webContents);
  // Why the taskbar button flashes: an entry waiting on the user, or an overlay popup waiting for the window to activate.
  private readonly flashReasons = new Set<'notifications' | 'overlay'>();

  // The stores log what they skip while reading their files, so they are read only once the log sink is installed.
  constructor() {
    installLogSink(this.logSink);
    logUncaughtErrors(process, 'main', (line) => log(line));
    this.states = new PanelStateStore(this.userDataDir, (line) => log(line));
    this.windowLayout = new WindowLayoutStore(this.userDataDir, (line) => log(line));
    this.projects = new ProjectList(this.userDataDir, (line) => log(line));
    this.state = createDesktopKeyValueState(this.userDataDir, (line) => log(line));
    this.trust = new TrustStore(this.userDataDir, this.ask, (message, ...args) => this.requireLocalization().t(message, ...args), (line) => log(line));
    this.usageWarnings = new UsageWarningStore(this.userDataDir, (line) => log(line));
  }

  private startStallMonitor(bootLog: (line: string) => void): StallMonitor | undefined {
    try {
      const monitor = new StallMonitor({ process: 'main', dir: path.join(this.logsDir, 'stalls'), log: bootLog, startProfile: processProfiler(process.platform) });
      this.disposables.push(monitor);
      return monitor;
    } catch (err) {
      bootLog(`[stall] the main process stall monitor could not start: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async start(): Promise<void> {
    const bootLog = (line: string): void => log(line);
    const stalls = this.startStallMonitor(bootLog);
    // Chromium fixes its UI locale at launch, so the switch goes in before the app is ready.
    this.languageSetting = readLanguageSetting(path.join(DAMOCLES_HOME_DIR, 'settings.json'), bootLog);
    if (this.languageSetting !== 'system') app.commandLine.appendSwitch('lang', this.languageSetting);
    app.on('second-instance', () => this.showWindow());
    app.on('web-contents-created', (_event, contents) => {
      hardenWebContents(contents, (url) => this.requirePlatform().shell.openExternal(url), bootLog);
      // Menu items enable by the focused part, and only main sees focus move between views.
      contents.on('focus', () => {
        if (!this.notifier.owns(contents)) this.toastFocusOrigin = undefined;
        this.views?.focused(contents);
        if (contents === this.window?.webContents || this.windowView(contents)) this.activationFocus.focused(contents);
        this.refreshMenuState();
      });
      contents.on('blur', () => this.refreshMenuState());
      // The user's first key or click drops a launch's focus and decides an activation's; page script's synthetic events never reach these.
      contents.on('before-input-event', (_event, input) => {
        if (input.type !== 'keyDown') return;
        this.views?.userInput();
        this.activationFocus.userInput();
      });
      contents.on('before-mouse-event', (_event, mouse) => {
        if (mouse.type !== 'mouseDown') return;
        this.views?.userInput();
        this.activationFocus.userInput();
      });
    });

    // Before the first process start, the login shell read; its workers share process.env, so they see what the read merges.
    const appPaths = createDesktopAppPaths(layout);
    lockThreadSpawns();
    this.launcher = createLauncherPool({ workerPath: appPaths.workerEntry('processLauncher'), sentinelPath: appPaths.workerEntry('sentinel') });
    installProcessLauncher(this.launcher);
    await mergeLoginShellEnv(processLauncher(), bootLog);
    await app.whenReady();
    if (stalls) {
      const suspend = (): void => stalls.suspend();
      const resume = (): void => stalls.resume();
      powerMonitor.on('suspend', suspend);
      powerMonitor.on('resume', resume);
      this.disposables.push({ dispose: () => {
        powerMonitor.removeListener('suspend', suspend);
        powerMonitor.removeListener('resume', resume);
      } });
    }
    const problem = runtimeProblem();
    if (problem !== undefined) {
      dialog.showErrorBox('Damocles cannot start', problem);
      app.exit(1);
      return;
    }
    // The Language setting replaces the language the chat webview stored, so the webview follows it too.
    if (this.languageSetting !== 'system' && this.state.global.get<string>(LANGUAGE_PREFERENCE_KEY) !== undefined) {
      await this.state.global.update(LANGUAGE_PREFERENCE_KEY, undefined);
    }
    const localization = createDesktopLocalizationService(resourceRoot, this.preferredLanguage(), bootLog);
    this.localization = localization;
    const git = await probeGit(bootLog, (message, ...args) => localization.t(message, ...args));
    this.gitProbe = git;
    restrictPermissions(session.defaultSession);
    handleAppProtocol(resourceRoot, {
      panel: (panelId) => this.views?.htmlFor(panelId),
      shell: () => shellHtml(currentTheme()),
      overlay: () => overlayHtml(currentTheme()),
      // The overlay bundle, which shows only its toast stack at this path.
      notifier: () => overlayHtml(currentTheme()),
    });

    this.platform = createDesktopPlatform({
      userDataDir: this.userDataDir,
      layout,
      logSinks: this.logSinks,
      localization,
      state: this.state,
      notifications: this.notifications,
      projects: this.projects,
      trust: this.trust,
      window: () => this.window,
      showChatReview: (panelId, scope) => this.showChatReview(panelId, scope),
      openAppSettings: (section, account) => this.openSettings({ ...(section !== undefined ? { section } : {}), ...(account !== undefined ? { account } : {}) }),
      toggleTerminal: () => this.toggleTerminal(false),
      terminalToggle: () => this.terminalToggle(),
      chatTabs: this.chatTabs,
      editorPane: () => this.requireEditorPane(),
      chatFolders: {
        folders: () => (this.core.current()?.client.chats() ?? []).flatMap((chat) => chat.settingsFolder ?? []),
        onDidChange: (cb) => this.chatFoldersChanged.add(cb),
      },
      reload: () => this.coreRequestedReload(),
      log: bootLog,
    });
    installPlatform(this.platform);
    const worktrees = this.startWorktrees();
    this.startEditor(this.platform, localization);
    // After the editor pane, whose active context core mirrors.
    const worker = (name: Parameters<typeof appPaths.workerEntry>[0]): string => appPaths.workerEntry(name);
    this.coreDeps = {
      platform: this.platform,
      trust: this.trust,
      theme: { css: () => currentTheme().css, onDidChange: (listener) => onThemeChange((theme) => listener(theme.css)) },
      terminalToggle: () => this.terminalToggle(),
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      createView: (panelId, create) => this.createCoreView(panelId, create),
      git: git.available ? { available: true, path: git.path, version: git.version } : { available: false, reason: git.reason },
      e2eHooks: E2E_HOOKS,
      paths: {
        resourceRoot: appPaths.resourceRoot,
        unpackedRoot: appPaths.unpackedRoot,
        workers: {
          compass: worker('compass'),
          usageStats: worker('usageStats'),
          sentinel: worker('sentinel'),
          processLauncher: worker('processLauncher'),
          memoryIntegrity: worker('memoryIntegrity'),
          sessionMetaIndex: worker('sessionMetaIndex'),
          voiceExtract: worker('voiceExtract'),
        },
        watchWorker: watchWorkerPath(appPaths),
        // core's process.execPath is this same executable
        askpass: askpassPaths(appPaths, process.execPath),
      },
      logs: { dir: this.logsDir, echo: !app.isPackaged },
      language: { current: () => localization.language, onDidChange: (listener) => localization.onDidChangeLanguage(() => listener()) },
      power: {
        onSuspend: (listener) => {
          powerMonitor.on('suspend', listener);
          return { dispose: () => powerMonitor.removeListener('suspend', listener) };
        },
        onResume: (listener) => {
          powerMonitor.on('resume', listener);
          return { dispose: () => powerMonitor.removeListener('resume', listener) };
        },
      },
      ui: {
        showLog: (name, preserveFocus) => this.openLogTab(path.join(this.logsDir, logFileName(name)), preserveFocus),
        trash: (absolutePath) => this.trashEntry(absolutePath),
        ask: (question, signal) => this.ask(question, signal),
        askpass: (prompt, signal) => {
          if (!this.askCredential) throw new Error('Source control used before startup finished');
          return this.askCredential(prompt, signal);
        },
        worktrees: worktrees.ui(),
      },
      entry: coreHostEntryPath(appPaths),
      echo: !app.isPackaged,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      readyTimeoutMs: CORE_READY_TIMEOUT_MS,
      log: bootLog,
    };
    this.terminals = this.createTerminals(this.platform, localization);
    log(`Damocles desktop starting (version ${this.platform.appInfo.version}, Electron ${process.versions.electron}, userData ${this.userDataDir})`);
    const version = this.platform.appInfo.version;
    // The desktop build copies CHANGELOG.md next to main.js (D56).
    this.releaseNotes = new ReleaseNotesSource(path.join(__dirname, 'CHANGELOG.md'), version, (line) => log(line));
    const updates = new UpdateService({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      version,
      notifications: this.platform.notifications,
      shell: this.platform.shell,
      state: this.state.global,
      checkAutomatically: () => this.platform?.settings.get<boolean>(UPDATE_CHECK_AUTOMATICALLY_SETTING, true) !== false,
      onResume: (listener) => {
        powerMonitor.on('resume', listener);
        return { dispose: () => powerMonitor.removeListener('resume', listener) };
      },
      t: (message, ...args) => localization.t(message, ...args),
      log: bootLog,
      showLog: () => showLog(),
      load: loadAutoUpdater,
      quit: () => this.lifecycle.quit(),
    });
    this.updates = updates;
    this.disposables.push(updates, updates.onDidChange((snapshot) => this.updateChanged(snapshot)));

    // Before the window exists, which takes its background from the effective theme.
    this.disposables.push(
      followThemeSettings(this.platform.settings),
      onThemeChange((theme) => {
        this.views?.broadcastTheme(theme);
        this.shell?.sendTheme(theme);
        this.overlay?.sendTheme(theme);
        this.notifier.sendTheme(theme);
        this.shellStateChanged();
      }),
      this.projects.onDidChange(() => {
        this.adoptOpenWorktrees().catch(this.report('Recording adopted worktrees'));
        this.terminalLinks.clear();
        this.installMenu();
        this.shellStateChanged();
        this.worktreesChanged();
      }),
      this.shownFolders.onDidChange((shown, rootChanged) => {
        this.shell?.shownFolderChanged(shown);
        // a running search and the selected repository follow the folder shown, never its worktree's chats working
        if (rootChanged && shown.projectKey === this.selectedProjectKey) {
          this.search?.stopAll();
          this.scm?.selectedProjectChanged();
        }
        this.refreshScmRoots();
        this.refreshMenuState();
        this.shellStateChanged();
      }),
      this.trust.onDidGrant(() => {
        this.shownFolders.refresh();
        this.shellStateChanged();
      }),
      this.platform.settings.onDidChange('damocles', (change) => {
        if (change.affects(BROWSER_ENABLED_KEY)) {
          this.browserTabs?.enabledChanged();
          this.refreshMenuState();
        }
        if (change.affects(NOTIFICATIONS_SETTING)) this.notificationCenter.popupPolicyChanged();
        if (change.affects(UPDATE_CHECK_AUTOMATICALLY_SETTING)) this.updates?.checkAutomaticallyChanged();
        if (change.affects(FILES_EXCLUDE_SETTING)) {
          this.fileTree?.excludeChanged();
          this.quickOpenIndex?.invalidate();
        }
        if (change.affects(SEARCH_EXCLUDE_SETTING)) this.quickOpenIndex?.invalidate();
        if (change.affects('damocles.desktop.search') || change.affects('damocles.desktop.searchEditor') || change.affects('damocles.desktop.sidebar')) this.shellStateChanged();
        if (change.affects('damocles.desktop.terminal')) this.terminals?.publish();
        if (change.affects(TERMINAL_PROFILES_SETTING)) this.terminalProfiles?.refresh().catch((err: unknown) => log(`[terminal] validating the user's profiles failed: ${errorText(err)}`));
      }),
      this.platform.settings.onDidChange('search', () => this.quickOpenIndex?.invalidate()),
      this.state.onDidChange('global', LANGUAGE_PREFERENCE_KEY, () => localization.setLanguage(this.preferredLanguage())),
      localization.onDidChangeLanguage(() => {
        this.installMenu();
        this.tray?.relocalize();
        this.shellStateChanged();
        this.overlay?.stateChanged();
        this.notifier.stateChanged();
        // The overlay icon's description is localized.
        this.taskbar.reapply();
        this.chatsChanged();
      }),
      this.onScaleChange(() => this.taskbar.reapply()),
    );
    this.installMenu();

    app.on('before-quit', (event) => this.lifecycle.onBeforeQuit(event));
    app.on('window-all-closed', () => {
      // A quit closes the window itself and quits once it has disposed everything.
      if (this.lifecycle.phase === 'disposing') return;
      log('[window] all windows closed');
      if (process.platform !== 'darwin') app.quit();
    });
    // The last main-process event of a quit, so the log covers the whole shutdown.
    app.on('will-quit', () => {
      log('[shutdown] will-quit');
      this.logSink.dispose();
    });
    app.on('activate', () => this.showWindow());
    // A screen reader starting or stopping turns xterm's screenReaderMode on or off in every terminal.
    app.on('accessibility-support-changed', () => this.terminals?.publish());

    const secrets = this.platform.secrets;
    await runLegacySettingsMigrations(this.platform.settings, () => providerKeyStored((key) => secrets.get(key), PROVIDER_SECRET_KEYS.stepfun));
    await movePreferApiKeyToGlobalState(this.platform.state);
    void deleteRetiredSecrets(secrets);
    this.restoreAtLaunch = this.platform.settings.get<boolean>(RESTORE_LAYOUT_SETTING, true);
    if (!this.restoreAtLaunch) {
      this.windowLayout.clear();
      for (const chat of this.states.list()) this.states.delete(chat.panelId);
    }
    // Saved tabs come back with "Reopen where I left off"; a backup comes back either way, since it holds text the user never discarded.
    await this.requireEditorPane().restore(this.windowLayout.editor(), await this.backups.list());
    const launched = this.core.start();
    this.createWindow();
    this.tray = new AppTray(trayIcon(resourceRoot), {
      windowVisible: () => this.window?.isVisible() ?? false,
      toggleWindow: () => {
        if (this.window?.isVisible()) this.window.hide();
        else this.showWindow();
      },
      newChat: () => {
        this.showWindow();
        this.newChat(undefined).catch(this.report('New Chat'));
      },
      quit: () => app.quit(),
    }, localization);
    this.launchTabs = this.openTabsAtLaunch(launched);
    await this.launchTabs;
    await this.adoptOpenWorktrees().catch(this.report('Recording adopted worktrees'));
    this.requireWorktrees().scanAtStartup(this.desktopProjects().map((project) => project.fsPath)).catch(this.report('Scanning for leftover worktrees'));

    if (!git.available) void this.platform.notifications.warn(git.reason);
    updates.start();
    announceInstalledVersion({
      version,
      state: this.state.global,
      notifications: this.platform.notifications,
      t: (message, ...args) => localization.t(message, ...args),
      openWhatsNew: (release) => this.openSettings({ section: 'about', release }),
      log: bootLog,
    }).catch(this.report('Announcing the installed version'));
  }

  // The launch's chats reopen into the first core once it is ready. A quit that began meanwhile opens nothing, and a core that
  // ended before it was ready took the crash path, whose reload reopens them into the next core.
  private async openTabsAtLaunch(launched: DesktopCore): Promise<void> {
    const ready = await launched.ready.then(() => true, () => false);
    if (!ready || this.lifecycle.phase === 'disposing' || this.lifecycle.phase === 'done' || this.core.started() !== launched) return;
    await this.core.openTabs();
  }

  // The webview normalizes what it stores.
  private preferredLanguage(): 'en' | 'el' {
    return launchLanguage(this.languageSetting, this.state.global.get<string>(LANGUAGE_PREFERENCE_KEY), app.getLocale());
  }

  private report(action: string): (err: unknown) => void {
    return (err) => log(`[desktop] ${action} failed: ${errorText(err)}`);
  }

  private requirePlatform(): DesktopPlatform {
    if (!this.platform) throw new Error('Desktop platform used before startup finished');
    return this.platform;
  }

  private requireCoreDeps(): CoreConnectionDeps {
    if (!this.coreDeps) throw new Error('Damocles Core started before startup finished');
    return this.coreDeps;
  }

  private requireScmClient(): ScmClient {
    if (!this.scmClient) throw new Error('Source control used before startup finished');
    return this.scmClient;
  }

  // The running core's client; undefined before startup finished and while a reload replaces the core.
  private client(): CoreClient | undefined {
    return this.core.current()?.client;
  }

  private requireLocalization(): DesktopLocalizationService {
    if (!this.localization) throw new Error('Localization used before startup finished');
    return this.localization;
  }

  // The primary display's scale factor changed; the taskbar badge is drawn at it.
  private onScaleChange(listener: () => void): Disposable {
    const changed = (_event: Electron.Event, display: Electron.Display, metrics: string[]): void => {
      if (metrics.includes('scaleFactor') && display.id === screen.getPrimaryDisplay().id) listener();
    };
    screen.on('display-metrics-changed', changed);
    return { dispose: () => screen.removeListener('display-metrics-changed', changed) };
  }

  private requireViews(): PanelViews {
    if (!this.views) throw new Error('No window to open a panel in');
    return this.views;
  }

  private browserEnabled(): boolean {
    return this.requirePlatform().settings.get<boolean>(BROWSER_ENABLED_KEY, false);
  }

  // Only for callers that cannot run while a reload replaces the core; a page's request runs through this.core.run instead.
  private requireCore(): DesktopCore {
    const core = this.core.current();
    if (!core) throw new Error('Core services used before startup finished or while they reload');
    return core;
  }

  private requireTerminals(): TerminalService {
    if (!this.terminals) throw new Error('Terminals used before startup finished');
    return this.terminals;
  }

  private createTerminals(platform: DesktopPlatform, localization: DesktopLocalizationService): TerminalService {
    const host = ptyHostPaths(platform.paths);
    const zshDotDir = path.join(this.userDataDir, 'shell-integration', 'zsh');
    const shellEnv = (): Record<string, string> => terminalEnvironment(process.env, { locale: app.getLocale(), zshDotDir });
    const catalog = new TerminalProfileCatalog({
      setting: () => platform.settings.get<unknown>(TERMINAL_PROFILES_SETTING),
      context: { platform: process.platform, env: shellEnv(), kind: (file) => profileFileKind(file, process.platform, (line) => log(line)) },
      log: (line) => log(line),
      onDidChange: () => {
        this.terminals?.publish();
        this.refreshMenuState();
        this.overlaySettings?.terminalProfilesChanged();
      },
    });
    this.terminalProfiles = catalog;
    // A detection that fails still validates the user's own profiles, against no detected shell.
    this.profilesDetected = detectProfiles(systemProfileProbe(process.env, (line) => log(line))).catch((err: unknown) => {
      log(`[terminal] detecting the shells failed: ${errorText(err)}`);
      return [];
    }).then((profiles) => {
      log(`[terminal] detected shells: ${profiles.map((profile) => profile.id).join(', ') || 'none'}`);
      return catalog.setDetected(profiles);
    }).catch((err: unknown) => log(`[terminal] validating the user's terminal profiles failed: ${errorText(err)}`)).finally(() => {
      this.profilesReady = true;
      this.terminals?.publish();
    });
    return new TerminalService({
      spawnHost: () => spawnPtyHost(host.script, host.nodePty),
      profiles: () => catalog.profiles(),
      profilesReady: () => this.profilesReady,
      isDirectory: (folder) => fs.promises.stat(folder).then((stat) => stat.isDirectory(), (err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') log(`[terminal] cannot read the folder a shell reported: ${code ?? errorText(err)}`);
        return false;
      }),
      projects: () => this.roots.all(),
      pickerProjects: () => this.pickerRoots(),
      currentProjectKey: () => this.currentProjectKey(),
      rootEnv: (key) => {
        const record = this.roots.resolve(key)?.worktree;
        return record ? worktreeEnvironment(record) : {};
      },
      settings: () => terminalSettings(platform.settings),
      env: shellEnv,
      passKeys: (splitActive) => installedTerminalPassKeys(splitActive),
      screenReader: () => app.isAccessibilitySupportEnabled(),
      windowsBuild: windowsBuildNumber(),
      persisted: () => this.windowLayout.terminals(),
      persist: (terminals) => this.windowLayout.setTerminals(terminals),
      onDidChange: () => this.refreshMenuState(),
      spawnFailed: (message) => localization.t('The shell could not start: {0}', message),
      launchFailed: ({ reason, file, cwd }) => {
        if (reason === 'invalidDirectory') return localization.t('The shell could not start in {0}: the folder does not exist.', cwd);
        if (reason === 'notAnExecutable') return localization.t('The shell could not start: {0} is not a program Windows can run.', file);
        return localization.t('The shell could not start: a software restriction policy blocks {0}.', file);
      },
      log: (line) => log(line),
      platform: process.platform,
      scriptsDir: host.shellIntegration,
      // the chats' home target, so a terminal started with no project open is in the folder the breadcrumb names
      homedir: homeDirectory(),
      zshDotDir,
      // A few kilobytes, copied only as a zsh starts, as VS Code does; the folder is the user's alone.
      copyFiles: (files) => {
        for (const { source, dest } of files) {
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          fs.copyFileSync(source, dest);
        }
      },
      confirmKill: async (entries) => (await this.ask(killQuestion(entries, (message, ...args) => localization.t(message, ...args)))) === 0,
    });
  }

  // The selected project, else the first one; undefined with no project open.
  private currentProjectKey(): string | undefined {
    const projects = this.desktopProjects();
    const selected = this.selectedProjectKey ?? this.client()?.defaultTarget()?.key;
    const key = projects.find((project) => project.key === selected)?.key ?? projects[0]?.key;
    // a new terminal starts in the project's shown folder (D31)
    return key === undefined ? undefined : this.shownFolders.rootKeyOf(key);
  }

  // The New Terminal picker's folders: each open project, the current one as its shown folder.
  private pickerRoots(): RootProject[] {
    const current = this.currentProjectKey();
    return this.desktopProjects().map((project) => {
      const shown = current !== undefined && parseRootKey(current)?.projectKey === project.key ? this.roots.resolve(current) : undefined;
      return shown ?? { ...project, root: { projectKey: project.key } };
    });
  }

  // Quick Open's roots (D31): the selected project's shown folder, and the other projects' folders.
  private quickOpenRoots(): RootProject[] {
    const selected = this.selectedProjectKey ?? this.client()?.defaultTarget()?.key;
    return this.desktopProjects().map((project) => (project.key === selected ? this.roots.resolve(this.shownFolders.rootKeyOf(project.key)) : undefined) ?? { ...project, root: { projectKey: project.key } });
  }

  private startCoreServices(): DesktopCore {
    // core's exit is reported on a later turn, once hosted exists
    const core = startDesktopCore(this.requireCoreDeps(), {
      endedCores: [...this.endedCores],
      // a new core's registry serves them while registry.json does not parse, as the one before it did
      worktreeRecords: [...this.worktreeRecords.records()],
      crashed: (pid, how) => this.coreCrashed(hosted, pid, how),
      leftLeases: (pid) => this.endedCores.push({ pid, endedAt: Date.now() }),
    });
    const { client } = core;
    // The previous core's chats closed with it.
    for (const corePanelId of this.activity.keys()) {
      this.notificationCenter.panelClosed(corePanelId);
      void this.chatReviews.panelClosed(corePanelId).catch(this.report('Closing a chat review'));
    }
    this.activity.clear();
    this.worktreeStates.clear();
    this.catalogRows.clear();
    const subscriptions = [
      client.onWorktreeState((event) => this.onWorktreeState(event)),
      client.onFoldersChanged(() => {
        this.followSelectedChat();
        this.shellStateChanged();
      }),
      client.onAllChatsClosed(() => log('[chats] the last loaded chat closed')),
      client.onActivity((panelId, activity) => this.onChatActivity(panelId, activity)),
      client.onChatChanges((panelId, totals, generation) => this.chatReviews.chatChanged(panelId, totals, generation)),
      client.onTurnSettled((panelId, outcome) => {
        const panel = this.panelOfCore(panelId);
        if (panel) this.chatsChanged(this.projectOf(panel));
        this.notificationCenter.turnSettled(panelId, outcome);
        this.scheduleRetention();
      }),
      client.onUsageThreshold((crossing) => this.notificationCenter.usageThreshold(crossing)),
      client.onCatalogChanged((projectKey) => {
        if (projectKey === undefined) this.catalogRows.clear();
        else this.catalogRows.delete(projectKey);
        this.chatsChanged(projectKey);
        this.refreshSelectedCatalog();
      }),
      // the user chose Open here on a lease refusal: the selection goes through the same path that was refused
      client.onTakeover((sessionId) => {
        if (this.views) this.selectChat(sessionId).catch(this.report('Opening a conversation here'));
      }),
      client.onWorktreeRecords((records) => this.worktreeRecords.apply(records)),
      client.onNewChatInWorktree((projectPath, worktreeId) => {
        this.newChatInWorktree({ projectKey: folderKey(projectPath), worktreeId }).catch(this.newChatInWorktreeFailure());
      }),
      client.onNewChatInProject((projectPath) => {
        this.newChat(folderKey(projectPath)).catch(this.shellFailure('New Chat', 'Damocles could not open a new conversation: {0}'));
      }),
      this.requireScmClient().attach(client),
    ];
    const hosted: DesktopCore = {
      client,
      pid: core.pid,
      terminalToggleChanged: () => core.terminalToggleChanged(),
      ready: core.ready,
      isReady: () => core.isReady(),
      hasEnded: () => core.hasEnded(),
      dispose: async () => {
        this.overlaySettings?.coreEnded();
        await this.beforeCoreDispose();
        for (const subscription of subscriptions) subscription.dispose();
        const views = this.views?.chats() ?? [];
        this.keptPermissions.coreEnded(views.map((view) => view.panelId), (viewId) => client.chatOfView(viewId)?.permissions);
        // A chat whose restore waits for a stale lease keeps that session as its restore target for the next core.
        for (const chat of client.chats()) {
          if (chat.restoring !== undefined) views.find((view) => view.panelId === chat.viewId)?.keepRestoreTarget(chat.restoring);
        }
        await core.dispose();
      },
    };
    return hosted;
  }

  // Core asks for a reload (lifecycle.reload, the chat's Reload after an extension change): bounded as crashes are, so a core
  // cannot fork cores without end.
  private coreRequestedReload(): Promise<void> {
    const decision = restartDecision(this.coreReloads, performance.now());
    this.coreReloads = decision.crashes;
    if (!decision.restart) {
      log(`[core] refused a reload core asked for: ${RESTART_LIMIT} in 5 minutes already`);
      return Promise.reject(new Error('The Damocles engine asked to restart too often'));
    }
    return this.core.reload();
  }

  // Core's process ended without main asking: VS Code's extension host policy restarts it at most RESTART_LIMIT times in
  // RESTART_WINDOW_MS, then leaves it down with a notice whose Restart starts it again (docs/invariants.md "Desktop host").
  private coreCrashed(core: DesktopCore, pid: number | undefined, how: string): void {
    // The quit stopped the host, which neither restarts nor halts the engine now.
    const phase = this.lifecycle.phase;
    if (phase === 'disposing' || phase === 'done') {
      log(`[core] stopped unexpectedly (pid ${pid ?? 'unknown'}, ${how}) during the quit`);
      return;
    }
    const decision = restartDecision(this.coreCrashes, performance.now());
    this.coreCrashes = decision.crashes;
    const { t } = this.requireLocalization();
    if (decision.restart) {
      log(`[core] stopped unexpectedly (pid ${pid ?? 'unknown'}, ${how}); restarting (${decision.count} of ${RESTART_LIMIT} in 5 minutes)`);
      void this.notifications.info(t('The Damocles engine stopped unexpectedly and was restarted.'));
      this.core.restart(core).catch(this.report('Restarting the engine'));
      return;
    }
    log(`[core] stopped unexpectedly (pid ${pid ?? 'unknown'}, ${how}); not restarting after ${RESTART_LIMIT} restarts in 5 minutes`);
    this.core.halt().catch(this.report('Stopping the engine'));
    const restart = t('Restart');
    this.haltNotice?.withdraw();
    const notice = this.notificationCenter.stickyNotice('error', t('The Damocles engine stopped unexpectedly {0} times in 5 minutes, so it was not restarted.', RESTART_LIMIT + 1), [restart]);
    this.haltNotice = notice;
    notice.answer.then((choice) => {
      if (choice === restart) this.restartEngine();
    }, this.report('The engine notice'));
  }

  // Restart Engine and the halt notice's Restart: the crash count starts again, and a new core replaces the running or
  // halted one.
  private restartEngine(): void {
    this.coreCrashes = [];
    this.core.reload().catch(this.report('Restarting the engine'));
  }

  // The title bar's pill and the menu follow the halt; once the engine runs again the halt notice offers Restart no more.
  private engineHaltChanged(): void {
    if (!this.core.halted()) {
      this.haltNotice?.withdraw();
      this.haltNotice = undefined;
    }
    this.shellStateChanged();
  }

  // The view for a panel core creates: a chat core opens itself, or a browser page of a loaded chat.
  private createCoreView(panelId: string, create: Omit<PanelCreate, 'owner'> & { readonly owner?: RelayView }): RelayView {
    const { owner, ...rest } = create;
    const options: PanelOptions = { ...rest, localResourceRoots: [...rest.localResourceRoots], ...(owner ? { owner } : {}) };
    if (options.kind === 'chat') return this.openCoreChat(options, panelId);
    return this.requireViews().create({ options, panelId });
  }

  private createWindow(): void {
    this.states.unseal();
    this.windowLayout.unseal();
    const placement = this.windowLayout.window();
    const restored = placement && clampToWorkAreas(placement.bounds, screen.getAllDisplays().map((display) => display.workArea));
    const bounds = restored ?? defaultWindowBounds(screen.getPrimaryDisplay().workArea);
    const mac = process.platform === 'darwin';
    const window = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      title: 'Damocles',
      ...(mac ? {} : { icon: windowIcon(resourceRoot) }),
      backgroundColor: THEME_BACKGROUND[currentThemeKind()],
      // AD7: frameless. macOS draws its traffic lights; on Windows and Linux the shell's title bar draws the window controls,
      // since native ones (titleBarOverlay) paint above every view and the overlay's scrim cannot cover them.
      titleBarStyle: 'hidden',
      ...(mac ? { trafficLightPosition: { x: 12, y: 13 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload-shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const tracker: WindowBoundsTracker = { applied: undefined, normal: bounds };
    sizeExactly(window, bounds, tracker);
    this.windowBounds = tracker;
    const trackNormal = (): void => refreshNormalBounds(window, tracker);
    window.on('resize', trackNormal);
    window.on('move', trackNormal);
    // The menu's accelerators keep working with the menu bar hidden; the title bar logo pops the menu up.
    if (!mac) window.setMenuBarVisibility(false);
    if (placement?.maximized) window.maximize();
    if (placement?.fullScreen) window.setFullScreen(true);
    const overlay = new OverlayHost({
      window,
      preloadPath: path.join(__dirname, 'preload-overlay.js'),
      state: () => ({ locale: this.requireLocalization().language, platform: shellPlatform(process.platform) }),
      focusOutside: () => this.focusOn('chat'),
      // Activation is asynchronous on X11 and Electron focuses the window's own page as it activates, so the overlay takes
      // focus from the window's focus event.
      awaitActivation: () => {
        this.focusOnActivation = 'overlay';
        this.flash('overlay', true);
      },
      popupsClosed: () => {
        if (this.focusOnActivation === 'overlay') this.focusOnActivation = undefined;
        this.flash('overlay', false);
      },
      // A badge drawn while the page could not draw is a dot.
      canRasterize: () => this.taskbar.reapply(),
      log: (line) => log(line),
    });
    handleCenterChannels(overlay, this.notificationCenter);
    handleAboutChannels(overlay, this.aboutDeps());
    // the New menu's options and the Merge dialog's Generate answer for the request open in this overlay
    overlay.handleWhileOpen(OVERLAY_CHANNELS.worktreeOptions, () => overlay.isOpen('newChatMenu'), () => {
      const open = overlay.openRequestOf('newChatMenu');
      if (!open) throw new Error('No New menu is open');
      return this.worktreeOptions(open.projectKey);
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.continueWorktrees, () => overlay.isOpen('newChatMenu'), () => {
      const open = overlay.openRequestOf('newChatMenu');
      if (!open) throw new Error('No New menu is open');
      return this.requireWorktrees().continueWorktrees(this.projectByKey(open.projectKey));
    });
    overlay.handleWhileOpen(OVERLAY_CHANNELS.worktreeGenerateMessage, () => overlay.openRequestOf('worktreeDialog')?.dialog === 'mergeMessage', () => this.requireWorktrees().generateForOpenDialog());
    const quickOpenPicker = new QuickOpenPicker(
      overlay,
      this.requireQuickOpenIndex(),
      () => ({ currentProjectKey: this.currentProjectKey(), recent: this.requireEditorPane().recentFiles() }),
      { capture: () => this.menuState(), list: (context) => this.requirePalette().list(context) },
      (line) => log(line),
    );
    const browserTabs = new BrowserTabs({
      editor: this.requireEditorPane(),
      window,
      setPages: (chatPanelId, pages) => this.states.setPages(chatPanelId, pages),
      retainingStates: () => views.retainingStates,
      browserEnabled: () => this.browserEnabled(),
      newPage: (chat) => this.core.run('New Browser Page', (core) => core.client.newBrowserPage(chat.panelId)),
      openExternal: (url) => this.requirePlatform().shell.openExternal(url),
      openExternalFailed: () => void this.notifications.error(this.requireLocalization().t('Damocles could not open the page in the system browser.')),
      copy: (text) => this.requirePlatform().clipboard.writeText(text),
      // After the editor's republish, so the shell focuses the tab that took the page tab's place.
      focusAway: () => setImmediate(() => this.focusOn(this.windowLayout.sidebar().grid.visible.editor && this.editorPane?.hasTabs() ? 'editor' : 'chat')),
    });
    const views: PanelViews = new PanelViews(
      {
        window,
        preloadPath: path.join(__dirname, 'preload-panel.js'),
        states: this.states,
        pages: browserTabs,
        log: (line) => log(line),
        onChange: () => this.viewsChanged(),
        onRestack: () => overlay.restack(),
        onReveal: (chat) => this.showChat(chat, { focus: true }),
        onRendererGaveUp: (panel) => this.chatGaveUp(panel),
        onSavedSessionChange: (chat) => this.chatChanged(chat),
        popupOpen: () => overlay.mode === 'full',
      },
      (absolutePath) => appResourceUri(resourceRoot, absolutePath),
    );
    overlay.restack();
    const overlaySettings = new OverlaySettings({
      overlay,
      settings: this.requirePlatform().settings,
      core: () => this.client(),
      targetPanel: () => this.settingsTarget(),
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      relaunch: () => {
        void this.lifecycle.relaunch();
      },
      resetLayout: () => this.resetLayout(),
      terminalProfiles: () => this.terminalProfileReport(),
      log: (line) => log(line),
      languageAtLaunch: this.languageSetting,
    });
    const shell: ShellHost = new ShellHost(window, this.shellActions(views, browserTabs, overlay, window), (line) => log(line), () => this.shellGaveUp(shell));
    const terminals = this.requireTerminals();
    terminals.attach({ state: (state) => shell.terminalState(state), data: (data) => shell.terminalData(data), focus: (id) => shell.focusTerminal(id) });
    // A restored shell's first output (its banner and prompt) is pushed only to a loaded page, after ShellHost's own load handler.
    const firstLoad = new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));
    // Toggle Terminal awaits it, so it always resolves.
    this.terminalsRestored = Promise.all([this.profilesDetected, firstLoad]).then(() => {
      if (this.shell === shell) terminals.restore();
    }).catch((err: unknown) => log(`[terminal] restoring the window layout's terminals failed: ${errorText(err)}`));
    const savePlacement = (): void => this.saveWindowPlacement(window, tracker);
    for (const event of ['resized', 'moved', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      window.on(event as 'resized', savePlacement);
    }
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      window.on(event as 'maximize', () => this.shellStateChanged());
    }
    // Closing the window closes its chats but keeps their state, so the next window or launch restores them. Unsaved editors
    // go first: kept as backups with "Reopen where I left off", else the user saves or discards them, or cancels the close.
    // Running terminals are asked about first (G22): that question changes nothing, so a cancel leaves the editors untouched.
    window.on('close', (event) => {
      const editor = this.editorPane;
      if (!this.terminalsReleased || (editor && !editor.isReleased)) {
        event.preventDefault();
        this.lifecycle.release().then((close) => {
          if (close && !window.isDestroyed()) window.close();
        }, (err: unknown) => log(`[window] keeping the window open: ${errorText(err)}`));
        return;
      }
      overlaySettings.close();
      this.sealPersistedState(window, tracker);
      views.retainStatesOnClose(true);
      for (const panelId of views.panelIds()) views.panel(panelId)?.close();
    });
    let closed!: (requests: Promise<void>) => void;
    this.windowClosed = new Promise<void>((resolve) => (closed = resolve));
    window.on('closed', () => {
      log('[window] closed');
      // Nothing waits for this window to activate any more; the next window starts with no pending focus.
      this.focusOnActivation = undefined;
      this.flash('overlay', false);
      // A window left open would keep the app from quitting on Windows and Linux.
      this.notifier.dispose();
      this.search?.stopAll();
      this.terminals?.closeWindow();
      shell.dispose();
      overlaySettings.dispose();
      overlay.dispose();
      if (this.window === window) {
        this.window = undefined;
        this.views = undefined;
        this.browserTabs = undefined;
        this.shell = undefined;
        this.overlay = undefined;
        this.overlaySettings = undefined;
        this.quickOpenPicker = undefined;
      }
      this.tray?.relocalize();
      closed(Promise.all([shell.settled(), overlay.settled()]).then(() => undefined));
    });
    window.on('show', () => this.tray?.relocalize());
    window.on('hide', () => this.tray?.relocalize());
    onWindowActivated(window, () => {
      this.notificationCenter.windowFocused();
      this.flash('overlay', false);
      const viewed = this.viewedChat();
      if (viewed) this.notificationCenter.chatViewed(viewed);
      const restore = this.activationFocus.activated();
      if (this.focusOnActivation !== undefined) this.focusOn(this.focusOnActivation);
      else if (restore && !restore.isDestroyed() && this.windowView(restore)?.getVisible()) restore.focus();
    });
    onWindowDeactivated(window, () => this.activationFocus.deactivated());
    this.window = window;
    this.terminalsReleased = false;
    this.notificationCenter.windowOpened();
    this.taskbar.reapply();
    this.views = views;
    this.browserTabs = browserTabs;
    this.shell = shell;
    this.overlay = overlay;
    this.overlaySettings = overlaySettings;
    this.quickOpenPicker = quickOpenPicker;
    this.editorPane?.reopened();
    overlay.load();
    shell.load();
  }

  /** Shows the settings modal in the overlay, attached to the selected chat (plan AD2); a closed window opens first. */
  private openSettings(target: SettingsTarget): void {
    this.showWindow();
    const overlay = this.overlay;
    const settings = this.overlaySettings;
    if (!overlay || !settings) return;
    overlay.whenLoaded().then(() => settings.show(target)).catch(this.report('Settings'));
  }

  private requireUpdates(): UpdateService {
    if (!this.updates) throw new Error('Updates used before startup finished');
    return this.updates;
  }

  private versionInfo(): VersionInfo {
    return {
      version: this.requirePlatform().appInfo.version,
      packaged: app.isPackaged,
      platform: shellPlatform(process.platform),
      arch: process.arch,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    };
  }

  private aboutDeps(): AboutDeps {
    const releaseNotes = this.releaseNotes;
    if (!releaseNotes) throw new Error('Release notes used before startup finished');
    return {
      updates: this.requireUpdates(),
      releaseNotes,
      versionInfo: () => this.versionInfo(),
      clipboard: this.requirePlatform().clipboard,
      showLog: () => showLog(),
      openSettings: (target) => this.openSettings(target),
    };
  }

  // The shell's pill follows every change; the About section only while the settings show.
  private updateChanged(snapshot: UpdateSnapshot): void {
    this.shell?.updateChanged(snapshot);
    if (this.overlay?.isOpen('settings')) this.overlay.send(OVERLAY_CHANNELS.updateState, snapshot);
    this.refreshMenuState();
  }

  // The selected chat's core panel once core has set it up, else the chat a host prompt would use: one being opened, or a
  // new one on the default project.
  private settingsTarget(): Promise<string | undefined> {
    return this.core.run('Settings', async (core) => {
      const selected = this.views?.selected();
      if (selected) return (await this.restoredCorePanel(selected)).corePanelId;
      return core.client.promptTarget();
    });
  }

  // Restore default layout: window-layout.json back to its defaults, applied to this window now.
  private resetLayout(): void {
    this.windowLayout.reset();
    this.layoutRevision += 1;
    const window = this.window;
    if (window && !window.isDestroyed()) {
      if (window.isFullScreen()) window.setFullScreen(false);
      if (window.isMaximized()) window.unmaximize();
      const bounds = defaultWindowBounds(screen.getDisplayMatching(window.getBounds()).workArea);
      window.setBounds(bounds);
      if (this.windowBounds) sizeExactly(window, bounds, this.windowBounds);
    }
    this.terminals?.setListWidth(TERMINAL_LIST_DEFAULT_REM);
    this.shellStateChanged();
    this.postTerminalShown();
  }

  // VS Code's onBeforeShutdown saves the window state, and a closing window does not rewrite it (windowsStateHandler.ts).
  private sealPersistedState(window: BrowserWindow, tracker: WindowBoundsTracker): void {
    this.saveWindowPlacement(window, tracker);
    this.heldPrompts.keep();
    this.states.seal();
    this.windowLayout.seal();
  }

  // Normal bounds, so a maximized window restores to the size it had before it was maximized.
  private saveWindowPlacement(window: BrowserWindow, tracker: WindowBoundsTracker): void {
    if (window.isDestroyed()) return;
    refreshNormalBounds(window, tracker);
    const bounds = boundsToPersist(tracker.applied, tracker.normal);
    this.windowLayout.setWindow({ bounds, maximized: window.isMaximized(), fullScreen: window.isFullScreen() });
  }

  private chatGaveUp(panel: DesktopPanel): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Chat');
    this.notifications.error(t('A chat stopped working because its page kept crashing.'), reload).then((answer) => {
      if (answer !== reload || panel.isDisposed) return;
      // Reload Chat is the user's choice: the reloaded chat takes focus once its page has loaded, when it is still selected,
      // since focus given to a page whose renderer is still starting is lost.
      panel.webContents.once('did-finish-load', () => {
        if (!panel.isDisposed && this.views?.selected() === panel) this.views.focusChat();
      });
      panel.restart();
    }, this.report('Reporting a crashed chat'));
  }

  // The window's own page draws the title bar and sidebar, so the overlay's dialog asks, which falls back to the OS box.
  private shellGaveUp(shell: ShellHost): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Window');
    this.notifications.error(t('The Damocles window stopped working because its page kept crashing.'), { modal: true }, reload).then((answer) => {
      if (answer === reload) shell.restart();
    }, this.report('Reporting a crashed window'));
  }

  // A second launch, a tray click or a macOS dock click: focus the window, or reopen it with its chats when it was closed,
  // which needs a running engine.
  private showWindow(): void {
    // A quit past its last question has closed the window for good.
    const phase = this.lifecycle.phase;
    if (phase === 'disposing' || phase === 'done') return;
    if (!this.window) {
      if (!this.core.current()) return;
      this.createWindow();
      this.core.openTabs().catch(this.report('Reopening chats'));
      return;
    }
    this.revealWindow();
  }

  // VS Code's windowImpl.ts:460 doFocusWindow.
  private revealWindow(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  // Every saved chat loads again; the saved selection, else a saved chat of the saved project, else the first, is shown
  // before any of them loads. With none saved, the saved (else default) project gets a new chat. The shown chat takes
  // keyboard focus once its page is ready, unless the user acted first; a reopened window and a host reload do the same.
  // Only CoreHost calls this, so a reload never disposes the core it reopens the chats into; it runs only once that core is
  // ready (openTabsAtLaunch, the reload path), and creates the views before its first await, so a request a reload held
  // finds them. After a restart each chat gets the permissions the ended core published for it.
  private async openInitialChats(afterRestart: boolean): Promise<void> {
    const core = this.requireCore();
    const views = this.requireViews();
    const kept = this.keptPermissions.reopening(afterRestart);
    const persisted = this.states.list();
    const selection = this.states.selected();
    const savedProject = selection && this.isKnownProject(selection.projectKey, core) ? selection.projectKey : undefined;
    if (persisted.length === 0) {
      await this.newChatIn(core, this.restoreAtLaunch ? savedProject : undefined, { focus: 'whenReady' });
      return;
    }
    const restored = persisted.map((saved) => {
      const host = views.create({ options: CHAT_PANEL, restore: { panelId: saved.panelId, state: saved.state } });
      this.trackChat(host, host.savedFolderKey ?? this.defaultProjectKey(core));
      // A chat whose saved pages are on their way back is active, so retention keeps it until they arrive.
      if (saved.browser.pages.length > 0) this.browserTabs?.setRestoring(host, true);
      if (saved.heldPrompt) this.heldPrompts.restoring(saved.panelId);
      this.lastViewed.set(host, ++this.viewCount);
      return { host, saved };
    });
    const selected = restored.find(({ saved }) => saved.panelId === selection?.panelId)
      ?? restored.find(({ host }) => selection?.sessionId !== undefined && host.savedSessionId === selection.sessionId)
      ?? restored.find(({ host }) => this.projectOf(host) === savedProject)
      ?? restored[0];
    if (selected) this.showChat(selected.host, { focus: 'whenReady' });
    const ordered = selected ? [selected, ...restored.filter((entry) => entry !== selected)] : restored;
    // One at a time, each chat's restore recorded before any starts, so a request for a chat still queued waits for it too.
    let previous: Promise<void> = Promise.resolve();
    for (const { host, saved } of ordered) {
      const restore = previous.then(async () => {
        await this.restoreInCore(core, host, host.savedFolderKey, kept.get(saved.panelId));
        this.restorePages(core, host, saved.browser.pages, saved.browser.activePage);
        this.restoreHeldPrompt(core, host, saved.heldPrompt);
      });
      this.chatRestores.set(host, restore);
      previous = restore.catch(this.report('Restoring a chat'));
    }
    await previous;
    this.scheduleRetention();
  }

  private async restoreInCore(core: DesktopCore, chat: DesktopPanel, folderKey: string | undefined, permissions?: ChatPermissions): Promise<void> {
    await this.beforeChatRestore();
    // A chat closed meanwhile (dropped while an earlier one loaded, or by the quit) is gone; setting up a session for it would leak one.
    if (chat.isDisposed) return;
    await core.client.restoreChat(chat, folderKey, permissions);
  }

  // Every chat main creates outside openInitialChats is restored here, so a request for it can wait until core registered it.
  private restoreChat(core: DesktopCore, chat: DesktopPanel, folderKey: string | undefined): Promise<void> {
    const restore = this.restoreInCore(core, chat, folderKey);
    this.chatRestores.set(chat, restore);
    return restore;
  }

  // The chat's core panel id once core finished restoring it; failed when core restored it without registering it.
  private async restoredCorePanel(chat: DesktopPanel): Promise<{ readonly corePanelId: string | undefined; readonly failed: boolean }> {
    const restore = this.chatRestores.get(chat);
    await restore?.catch(() => undefined);
    const corePanelId = this.corePanelIdOf(chat);
    return { corePanelId, failed: corePanelId === undefined && restore !== undefined && !chat.isDisposed };
  }

  // A prompt the chat held for its worktree when the window closed goes back into its composer, once.
  private restoreHeldPrompt(core: DesktopCore, chat: DesktopPanel, held: readonly UserContentBlock[] | undefined): void {
    const corePanelId = this.corePanelIdOf(chat);
    if (!held || corePanelId === undefined) return;
    core.client.restoreDraft(corePanelId, held).then(
      () => this.heldPrompts.restored(chat.panelId),
      this.report('Putting a held prompt back in its composer'),
    );
  }

  // Reopens a chat's saved pages as its tabs once the browser relaunches, which the remaining chats and the updater do not
  // wait for; the active editor tab stays as restored meanwhile and no page takes focus.
  private restorePages(core: DesktopCore, chat: DesktopPanel, urls: readonly string[], activePage: number | undefined): void {
    // A chat the quit closed while core restored it has no tabs left to restore into.
    if (urls.length === 0 || chat.isDisposed) return;
    const browserTabs = this.browserTabs;
    if (this.e2ePageRestores) this.e2ePageRestores.count += 1;
    core.client.restorePages(chat.panelId, urls, activePage)
      .catch(this.report('Restoring browser pages'))
      .finally(() => browserTabs?.setRestoring(chat, false));
  }

  // Every chat main or core creates passes through here once, before it is shown.
  private trackChat(panel: DesktopPanel, projectKey: string): void {
    this.openedInProject.set(panel, projectKey);
    panel.onDispose(() => this.chatClosed(panel));
  }

  // A chat core opens itself (Open Chat, a fork, a dialog with no chat loaded) lands in the selected project,
  // which core uses as its default folder.
  private openCoreChat(options: PanelOptions, panelId: string): DesktopPanel {
    const core = this.requireCore();
    const views = this.requireViews();
    const host = views.create({ options, panelId });
    this.trackChat(host, this.selectedProjectKey ?? this.defaultProjectKey(core));
    // Core sets the chat up once this returns; a mention or Add to Chat waits for that as for a chat main restores.
    this.chatRestores.set(host, this.beforeChatRestore().then(() => core.client.whenSetUp(host.panelId)));
    this.showChat(host, { focus: true });
    return host;
  }

  // worktree: the New menu's opt-in (D30), checked against fresh options; plain New Chat and Ctrl+N never pass one
  private newChat(projectKey: string | undefined, worktree?: NewChatWorktree): Promise<void> {
    return this.core.run('New Chat', (core) => this.newChatIn(core, projectKey, { focus: true }, worktree));
  }

  private async newChatIn(core: DesktopCore, projectKey: string | undefined, options: { readonly focus: ShowFocus } = { focus: true }, worktree?: NewChatWorktree): Promise<void> {
    const views = this.requireViews();
    const key = projectKey ?? this.selectedProjectKey ?? this.defaultProjectKey(core);
    if (!this.isKnownProject(key, core)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    if (worktree && !(await this.requireWorktrees().checkOptIn(this.projectByKey(key), worktree.startRef, worktree.bringChanges))) {
      throw new Error(this.requireLocalization().t('The worktree options changed. Open the New menu again.'));
    }
    const host = views.create({ options: CHAT_PANEL });
    this.trackChat(host, key);
    if (!worktree) {
      this.showChat(host, options);
      await this.restoreChat(core, host, key);
      return;
    }
    // The chat shows only once core holds the opt-in, so its first send can never reach the project folder; until then
    // retention leaves it alone.
    this.openingInWorktree.add(host);
    try {
      await this.restoreChat(core, host, key);
      const corePanelId = this.corePanelIdOf(host);
      if (corePanelId === undefined) throw new Error(this.requireLocalization().t('The chat closed before it could use a worktree.'));
      await core.client.setWorktreeOptIn(corePanelId, worktree.startRef, worktree.bringChanges);
    } catch (err) {
      if (!host.isDisposed) host.close();
      throw err;
    } finally {
      this.openingInWorktree.delete(host);
    }
    this.showChat(host, options);
  }

  // Core binds the new chat to the worktree before its first session exists, and it shows only once bound.
  private newChatInWorktree(target: NewChatInWorktreeRequest | undefined): Promise<void> {
    return this.core.run('New Chat in This Worktree', async (core) => {
      const { t } = this.requireLocalization();
      const request = target ?? this.menuState().newChatInWorktree;
      if (!request) throw new Error(t('The selected chat does not work in a worktree.'));
      const live = this.newChatInTarget(this.worktreeRecords.get(request.worktreeId));
      if (live?.projectKey !== request.projectKey) throw new Error(t('The worktree is no longer a worktree of this project.'));
      const host = this.requireViews().create({ options: CHAT_PANEL });
      this.trackChat(host, request.projectKey);
      this.openingInWorktree.add(host);
      const started = this.beforeChatRestore().then(async () => {
        if (host.isDisposed) throw new Error(t('The chat closed before it could use a worktree.'));
        await core.client.startInWorktree(host, request.projectKey, request.worktreeId);
      });
      this.chatRestores.set(host, started);
      try {
        await started;
      } catch (err) {
        if (!host.isDisposed) host.close();
        throw err;
      } finally {
        this.openingInWorktree.delete(host);
      }
      this.showChat(host, { focus: true });
    });
  }

  private newChatInWorktreeFailure(): (err: unknown) => void {
    return this.shellFailure('New Chat in This Worktree', 'Damocles could not open a new conversation: {0}');
  }

  private worktreeOptions(projectKey: string): Promise<ChatsWorktreeOptions> {
    return this.requireWorktrees().options(this.projectByKey(projectKey));
  }

  private showFolder(request: ShowFolderRequest): void {
    this.projectByKey(request.projectKey);
    this.shownFolders.show(request.projectKey, request.show);
  }

  // A worktree main lists for the project, never one another project or a renderer names by path.
  private async worktreeFinish(request: WorktreeFinishRequest): Promise<void> {
    const root = this.roots.resolve(rootKey({ projectKey: request.projectKey, worktreeId: request.worktreeId }));
    if (!root?.worktree) {
      void this.notifications.info(this.requireLocalization().t('This worktree no longer exists.'));
      return;
    }
    await this.requireWorktrees().finish(request.worktreeId, request.action);
  }

  private async addProject(): Promise<void> {
    const platform = this.requirePlatform();
    const folder = await platform.dialogs.pickFolder({ title: platform.localization.t('Add Project') });
    if (folder === undefined) return;
    await this.addProjectAt(folder);
  }

  // A folder joins the project list untrusted unless trusted already; the trust question follows, then a chat opens there.
  private async addProjectAt(folder: string): Promise<void> {
    await this.projects.add(folder);
    if (!this.trust.isTrusted(folder)) await this.trust.requestTrust(folder);
    await this.newChat(folderKey(folder));
  }

  // Keys from the shell are matched against the project list; a renderer string is never used as a path.
  private projectByKey(key: string): { fsPath: string; name: string } {
    const project = this.projects.folders().find((folder) => folderKey(folder.fsPath) === key);
    if (!project) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    return project;
  }

  // A project of the list, or the folder chats open in while the list is empty.
  private isKnownProject(key: string, core: DesktopCore): boolean {
    if (this.projects.folders().some((folder) => folderKey(folder.fsPath) === key)) return true;
    return core.client.defaultTarget()?.key === key;
  }

  // The folder chats open in when none is named; core publishes its folder targets as it starts.
  private defaultProjectKey(core: DesktopCore): string {
    const key = core.client.defaultTarget()?.key;
    if (key === undefined) throw new Error('Damocles Core has not reported its folders yet');
    return key;
  }

  // The chat's core panel id once core registered it.
  private corePanelIdOf(panel: DesktopPanel): string | undefined {
    return this.client()?.chatOfView(panel.panelId)?.panelId;
  }

  private panelOfCore(corePanelId: string): DesktopPanel | undefined {
    const viewId = this.client()?.chat(corePanelId)?.viewId;
    return viewId === undefined ? undefined : this.views?.chats().find((chat) => chat.panelId === viewId);
  }

  private boundSessionIdOf(panel: DesktopPanel): string | undefined {
    return this.client()?.chatOfView(panel.panelId)?.sessionId;
  }

  // The session a restore its lease refused opens once the lease turns stale (a crashed core's, after a restart).
  private restoreRetryOf(panel: DesktopPanel): string | undefined {
    return this.client()?.chatOfView(panel.panelId)?.restoring;
  }

  // The chat's stored session: the one core bound, else, while it restores, the one a lease retry or its saved state names.
  private sessionIdOf(panel: DesktopPanel): string | undefined {
    return this.boundSessionIdOf(panel) ?? this.restoreRetryOf(panel) ?? panel.savedSessionId;
  }

  // Core binds a restored chat's saved session only in its webview's `ready`, well after it registers the chat, and a
  // refused restore only once its retry runs.
  private isRestoring(panel: DesktopPanel): boolean {
    return this.boundSessionIdOf(panel) === undefined && (this.restoreRetryOf(panel) !== undefined || panel.savedSessionId !== undefined);
  }

  private activityOf(panel: DesktopPanel): ChatActivity | undefined {
    const corePanelId = this.corePanelIdOf(panel);
    return corePanelId === undefined ? undefined : this.activity.get(corePanelId);
  }

  // A chat core has registered that has no conversation and no session file, bound or being restored.
  private isEmpty(panel: DesktopPanel): boolean {
    const chat = this.client()?.chatOfView(panel.panelId);
    if (!chat) return false;
    return !chat.hasConversation && this.sessionIdOf(panel) === undefined;
  }

  private chatIdOf(panel: DesktopPanel): string {
    return this.sessionIdOf(panel) ?? `${NEW_CHAT_ID_PREFIX}${panel.panelId}`;
  }

  private projectOf(panel: DesktopPanel): string | undefined {
    const client = this.client();
    const key = client?.chatOfView(panel.panelId)?.folder.key ?? this.openedInProject.get(panel);
    if (key === undefined || !client) return key;
    return chatProjectKey(key, client, (candidate) => this.projects.folders().some((folder) => folderKey(folder.fsPath) === candidate));
  }

  private loadedChat(chatId: string): DesktopPanel | undefined {
    const views = this.views;
    if (!views) return undefined;
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) {
      const panel = views.panel(chatId.slice(NEW_CHAT_ID_PREFIX.length));
      return panel && views.chats().includes(panel) ? panel : undefined;
    }
    return views.chats().find((chat) => this.sessionIdOf(chat) === chatId);
  }

  // The stored session with this id in the project's catalog, else in any other project's.
  private async storedChat(core: DesktopCore, sessionId: string): Promise<{ readonly session: StoredSession; readonly projectKey: string } | undefined> {
    const keys = [...new Set([this.selectedProjectKey, ...this.projects.folders().map((folder) => folderKey(folder.fsPath))])];
    // The shown lists first, which hold a clicked row; only a miss waits for the rows still being parsed.
    for (const read of [(key: string) => core.client.listSessions(key), (key: string) => core.client.listSessions(key, true)]) {
      for (const key of keys) {
        if (key === undefined) continue;
        const session = (await read(key)).find((row) => row.id === sessionId);
        if (session) return { session, projectKey: key };
      }
    }
    return undefined;
  }

  private async catalogList(core: DesktopCore, projectKey: string): Promise<readonly StoredSession[]> {
    const rows = await core.client.listSessions(projectKey);
    this.catalogRows.set(projectKey, rows);
    return rows;
  }

  private refreshSelectedCatalog(): void {
    const key = this.selectedProjectKey;
    if (key === undefined || this.catalogRows.has(key) || !this.core.current()) return;
    this.core.read('Read Chat List', (core) => this.catalogList(core, key)).then(() => this.shellStateChanged(), this.report('Reading the chat list'));
  }

  private showChat(panel: DesktopPanel, options: { readonly focus: ShowFocus }): void {
    const views = this.views;
    if (!views || panel.isDisposed) return;
    views.show(panel.panelId, options);
    this.lastViewed.set(panel, ++this.viewCount);
    this.selectionChanged(panel);
    this.scheduleRetention();
  }

  // Records the selected chat's project, its place in the project memory and panels.json.
  private selectionChanged(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    if (projectKey === undefined) return;
    const projectChanged = projectKey !== this.selectedProjectKey;
    this.selectedProjectKey = projectKey;
    if (projectChanged) {
      this.search?.stopAll();
      this.scm?.selectedProjectChanged();
    }
    this.lastChatByProject.set(projectKey, this.chatIdOf(panel));
    const sessionId = this.sessionIdOf(panel);
    this.states.select({ projectKey, panelId: panel.panelId, ...(sessionId !== undefined ? { sessionId } : {}) });
    const client = this.client();
    if (projectChanged && client && client.defaultTarget()?.key !== projectKey) {
      client.setDefaultFolder(projectKey).catch(this.report('Following the selected project'));
    }
    this.refreshSelectedCatalog();
    this.shownFolders.refresh();
    this.chatsChanged(projectKey);
    this.shellStateChanged();
    const viewed = this.viewedChat();
    if (viewed) this.notificationCenter.chatViewed(viewed);
  }

  private selectChat(chatId: string): Promise<SelectChatResult> {
    return this.core.run('Select Chat', (core) => this.selectChatIn(core, chatId));
  }

  private async selectChatIn(core: DesktopCore, chatId: string): Promise<SelectChatResult> {
    const loaded = this.loadedChat(chatId);
    if (loaded) {
      this.showChat(loaded, { focus: true });
      return { ok: true };
    }
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.missingChat();
    return this.chatWork.run(chatId, async () => {
      const again = this.loadedChat(chatId);
      if (again) {
        this.showChat(again, { focus: true });
        return { ok: true };
      }
      const stored = await this.storedChat(core, chatId);
      if (!stored) return this.missingChat();
      // Another Damocles process holds the conversation: the selection stays where it is, and core offers a takeover.
      if (await core.client.leaseRefused(chatId, true)) return { ok: false, reason: 'leased' };
      const views = this.requireViews();
      const host = views.create({ options: CHAT_PANEL, restore: { panelId: randomUUID(), state: { sessionId: chatId, workspaceFolderKey: stored.projectKey } } });
      this.trackChat(host, stored.projectKey);
      this.showChat(host, { focus: true });
      await this.restoreChat(core, host, stored.projectKey);
      return { ok: true };
    });
  }

  private missingChat(): { ok: false; reason: 'missing' } {
    void this.notifications.info(this.requireLocalization().t('This chat no longer exists.'));
    return { ok: false, reason: 'missing' };
  }

  // The project's last viewed chat when it still exists, else a new chat in it.
  private selectProject(key: string): Promise<void> {
    return this.core.run('Select Project', (core) => this.selectProjectIn(core, key));
  }

  private async selectProjectIn(core: DesktopCore, key: string): Promise<void> {
    if (!this.isKnownProject(key, core)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    const remembered = this.lastChatByProject.get(key);
    if (remembered !== undefined) {
      const loaded = this.loadedChat(remembered);
      if (loaded) {
        this.showChat(loaded, { focus: false });
        return;
      }
      if (!remembered.startsWith(NEW_CHAT_ID_PREFIX) && (await this.storedChat(core, remembered))?.projectKey === key) {
        const result = await this.selectChatIn(core, remembered);
        if (result.ok) return;
      }
    }
    await this.newChatIn(core, key);
  }

  private selectRelativeChat(delta: 1 | -1): Promise<void> {
    return this.core.run('Select Chat', (core) => this.selectRelativeChatIn(core, delta));
  }

  private async selectRelativeChatIn(core: DesktopCore, delta: 1 | -1): Promise<void> {
    const key = this.selectedProjectKey;
    const selected = this.views?.selected();
    if (key === undefined || !selected) return;
    const ids = (await this.listChatsIn(core, key)).chats.map((chat) => chat.id);
    if (ids.length < 2) return;
    const current = ids.indexOf(this.chatIdOf(selected));
    if (current < 0) return;
    const target = ids[(current + delta + ids.length) % ids.length];
    if (target !== undefined) await this.selectChatIn(core, target);
  }

  // undefined: projectKey is not a project of the list
  private listChats(projectKey: string): Promise<ShellChatList | undefined> {
    return this.core.read('List Chats', async (core) => (this.isKnownProject(projectKey, core) ? this.listChatsIn(core, projectKey) : undefined));
  }

  private async listChatsIn(core: DesktopCore, projectKey: string): Promise<ShellChatList> {
    if (!this.isKnownProject(projectKey, core)) throw new Error('Unknown project');
    return this.chatList(projectKey, await this.catalogList(core, projectKey), true);
  }

  private searchChats(projectKey: string, query: string): Promise<ShellChatList | undefined> {
    return this.core.read('Search Chats', async (core) => {
      if (!this.isKnownProject(projectKey, core)) return undefined;
      if (query.trim() === '') return this.listChatsIn(core, projectKey);
      return this.chatList(projectKey, await core.client.searchSessions(projectKey, query), false);
    });
  }

  // Loaded chats the catalog does not list lead the list (last viewed first), then the stored sessions as the catalog orders them.
  private chatList(projectKey: string, rows: readonly StoredSession[], withNewChats: boolean): ShellChatList {
    const loaded = this.views?.chats().filter((chat) => this.projectOf(chat) === projectKey) ?? [];
    const bySession = new Map<string, DesktopPanel>();
    const listed = new Set(rows.map((row) => row.id));
    // A chat with no session file yet, or one whose first write the catalog has not listed yet, still shows.
    const unlisted: DesktopPanel[] = [];
    for (const chat of loaded) {
      const sessionId = this.sessionIdOf(chat);
      if (sessionId !== undefined) bySession.set(sessionId, chat);
      if (sessionId === undefined || !listed.has(sessionId)) unlisted.push(chat);
    }
    const chats: ShellChat[] = withNewChats
      ? unlisted.sort((a, b) => (this.lastViewed.get(b) ?? 0) - (this.lastViewed.get(a) ?? 0)).map((chat) => ({
        id: this.chatIdOf(chat),
        title: '',
        timestamp: Date.now(),
        status: statusOf(this.activityOf(chat)),
        loaded: true,
        ...this.rowWorktree(chat, undefined),
      }))
      : [];
    const tags = new Set<string>();
    for (const row of rows) {
      const chat = bySession.get(row.id);
      // A tag stored before tags were bounded never reaches the shell, which hands tags back in overlay requests.
      const tag = isShellTag(row.tag) ? row.tag : undefined;
      if (tag !== undefined) tags.add(tag);
      chats.push({
        id: row.id,
        title: storedTitle(row),
        timestamp: row.timestamp,
        ...(tag !== undefined ? { tag } : {}),
        ...(row.model ? { model: { provider: row.model.provider, id: row.model.id } } : {}),
        status: chat ? statusOf(this.activityOf(chat)) : 'idle',
        loaded: chat !== undefined,
        ...this.rowWorktree(chat, row),
      });
    }
    return { projectKey, chats, tags: [...tags].sort((a, b) => a.localeCompare(b)).slice(0, MAX_OVERLAY_TAGS) };
  }

  // A Chats row's worktree badge and read-only state (AD12 Listing).
  private rowWorktree(chat: DesktopPanel | undefined, row: StoredSession | undefined): Pick<ShellChat, 'worktree' | 'readOnly'> {
    const registry = this.worktreeRecords;
    const event = chat ? this.worktreeEventOf(chat) : undefined;
    const found = chatRowWorktree(
      {
        ...(event ? { live: { ...(event.worktreeId !== undefined ? { worktreeId: event.worktreeId } : {}), state: event.state } } : {}),
        ...(row ? { stored: { ...(row.worktree ? { worktree: row.worktree } : {}), ...(row.listedFrom !== undefined ? { listedFrom: row.listedFrom } : {}) } } : {}),
      },
      { registry, finish: (record) => this.finishStateOf(record), baseBranch: (record) => this.scm?.rootRepository(folderKey(record.projectPath))?.branch },
    );
    const newChatIn = found.worktree?.status === 'live' ? this.newChatInTarget(found.worktree.worktreeId === undefined ? undefined : registry.get(found.worktree.worktreeId)) : undefined;
    return { ...(found.worktree ? { worktree: { ...found.worktree, ...(newChatIn ? { newChatIn } : {}) } } : {}), readOnly: found.readOnly };
  }

  // Catalog results become the shell's; every refusal reaches the user as exactly one toast (core shows the lease one).
  private mutationResult(result: CatalogResult, failure: string): ChatMutationResult {
    if (result.ok) return { ok: true };
    const { t } = this.requireLocalization();
    if (result.reason === 'leased') return { ok: false, reason: 'leased' };
    if (!('message' in result)) return this.missingChat();
    log(`[chats] ${failure} ${result.reason}: ${result.message}`);
    // An invalid request's message is already localized for the user; a failure's is error detail.
    void this.notifications.error(result.reason === 'invalid' ? result.message : t('Damocles could not change the session: {0}', result.message));
    return { ok: false, reason: 'failed' };
  }

  private unwrittenChat(): ChatMutationResult {
    void this.notifications.info(this.requireLocalization().t('This chat has no saved conversation yet.'));
    return { ok: false, reason: 'failed' };
  }

  private async renameChat(chatId: string, name: string): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.loadedChat(chatId) ? this.unwrittenChat() : this.missingChat();
    return this.core.run('Rename Chat', (core) => this.chatWork.run(chatId, async () => this.mutationResult(await core.client.renameSession(chatId, name), 'rename')));
  }

  private async tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.loadedChat(chatId) ? this.unwrittenChat() : this.missingChat();
    return this.core.run('Tag Chat', (core) => this.chatWork.run(chatId, async () => this.mutationResult(await core.client.tagSession(chatId, tag), 'tag')));
  }

  // Core deletes lease first and detaches every holder; the detached chat then unloads like any other.
  private async deleteChat(chatId: string): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) {
      const chat = this.loadedChat(chatId);
      if (!chat) return this.missingChat();
      chat.close();
      return { ok: true };
    }
    const deleted = await this.core.run('Delete Chat', (core) => this.chatWork.run(chatId, async () => {
      const holder = this.loadedChat(chatId);
      const worktreeId = (holder ? this.worktreeEventOf(holder)?.worktreeId : undefined) ?? (await this.storedChat(core, chatId))?.session.worktree?.worktreeId;
      const result = this.mutationResult(await core.client.deleteSession(chatId), 'delete');
      if (result.ok && holder && !holder.isDisposed) {
        const corePanelId = this.corePanelIdOf(holder);
        if (corePanelId !== undefined) this.worktreeStates.delete(corePanelId);
        holder.close();
      }
      return { result, worktreeId };
    }));
    // D33: deleting the last chat that uses a worktree asks whether to delete the worktree too
    if (deleted.result.ok && deleted.worktreeId !== undefined) this.requireWorktrees().afterChatDeleted(deleted.worktreeId).catch(this.report('Offering the worktree delete'));
    return deleted.result;
  }

  // A chat left memory: by retention, Delete, or the window or core closing (which keep the saved selection).
  private chatClosed(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    this.chatsChanged(projectKey);
    const views = this.views;
    if (this.closingForWorktree.has(panel)) return;
    if (!views || views.retainingStates || this.lifecycle.phase !== 'running' || views.selected() !== undefined) return;
    const key = projectKey ?? this.client()?.defaultTarget()?.key;
    if (key !== undefined) this.selectProject(key).catch(this.report('Selecting a chat after a close'));
  }

  private onChatActivity(corePanelId: string, activity: ChatActivity): void {
    // Fires on every session bind, a folder switch's included.
    this.chatFoldersChanged.fire();
    const previous = this.activity.get(corePanelId);
    this.activity.set(corePanelId, activity);
    this.notificationCenter.activity(corePanelId, activity);
    const panel = this.panelOfCore(corePanelId);
    if (!panel) return;
    if (statusOf(previous) !== statusOf(activity)) this.shellStateChanged();
    this.chatChanged(panel);
  }

  // The chat's session, status or conversation may have changed.
  private chatChanged(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    if (projectKey !== undefined) {
      // A chat remembered before its first file write is remembered by its session id once it has one.
      if (this.lastChatByProject.get(projectKey) === `${NEW_CHAT_ID_PREFIX}${panel.panelId}`) this.lastChatByProject.set(projectKey, this.chatIdOf(panel));
      if (panel === this.views?.selected()) this.selectionChanged(panel);
    }
    this.chatsChanged(projectKey);
    this.scheduleRetention();
  }

  private scheduleRetention(): void {
    if (this.retentionScheduled) return;
    this.retentionScheduled = true;
    setImmediate(() => {
      this.retentionScheduled = false;
      this.applyRetention();
    });
  }

  // Unloads what chat-pool says. Each unload waits in the chat's work queue behind any select or catalog write on it, and
  // runs only if the pool still says so then.
  private applyRetention(): void {
    const views = this.views;
    if (!views || !this.core.current() || views.retainingStates || this.lifecycle.phase !== 'running') return;
    const client = this.requireCore().client;
    for (const corePanelId of [...this.worktreeStates.keys()]) if (!client.chat(corePanelId)) this.worktreeStates.delete(corePanelId);
    for (const corePanelId of [...this.activity.keys()]) {
      if (client.chat(corePanelId)) continue;
      this.activity.delete(corePanelId);
      this.notificationCenter.panelClosed(corePanelId);
      void this.chatReviews.panelClosed(corePanelId).catch(this.report('Closing a chat review'));
    }
    for (const panelId of this.chatsToUnload()) {
      const chat = views.panel(panelId);
      if (!chat) continue;
      this.chatWork.run(this.chatIdOf(chat), async () => {
        if (chat.isDisposed || !this.chatsToUnload().includes(chat.panelId)) return;
        // core closes it only while it is still idle and, unloaded as empty, still empty
        log(`[chats] unloading chat ${chat.panelId}`);
        if (!(await client.unload(chat.panelId, this.isEmpty(chat)))) log(`[chats] core kept chat ${chat.panelId} loaded`);
      }).catch(this.report('Unloading a chat'));
    }
  }

  private chatsToUnload(): string[] {
    const views = this.views;
    if (!views || !this.core.current() || views.retainingStates || this.lifecycle.phase !== 'running') return [];
    const selected = views.selected();
    return chatsToUnload(views.chats().flatMap((chat) => {
      // A chat whose session core is still setting up is neither idle nor empty yet.
      if (this.corePanelIdOf(chat) === undefined || this.openingInWorktree.has(chat)) return [];
      return [{
        id: chat.panelId,
        selected: chat === selected,
        active: isActiveActivity(this.activityOf(chat)) || this.browserTabs?.holdsPages(chat) === true,
        restoring: this.isRestoring(chat),
        hasSession: this.sessionIdOf(chat) !== undefined,
        empty: this.isEmpty(chat),
        lastViewed: this.lastViewed.get(chat) ?? 0,
        ...(this.worktreeEventOf(chat) ? { worktreePhase: this.worktreeEventOf(chat)!.state.phase } : {}),
      }];
    }));
  }

  private shellFailure(action: string, message: string): (err: unknown) => void {
    return (err) => {
      log(`[shell] ${action} failed: ${errorText(err)}`);
      void this.notifications.error(this.requireLocalization().t(message, errorMessage(err)));
    };
  }

  // Every Files action main refused or that failed (the disk changed after the shell's checks, a name files.exclude hides, a
  // locked file) is one toast naming the entry; a create or rename's name box closes either way.
  private async runFilesAction<T extends FilesMutationResult | FilesDeleteResult | FilesListResult>(action: FilesAction, file: FileRef, run: () => Promise<T>, newName?: string): Promise<T | FilesFailed> {
    const result = await settleFilesAction(run, (line) => log(line));
    const name = file.relativePath === '' ? this.roots.resolve(file.projectKey)?.name ?? '' : path.posix.basename(file.relativePath);
    const message = filesFailureMessage((text, ...args) => this.requireLocalization().t(text, ...args), action, name, result, newName);
    if (message !== undefined) void this.notifications.error(message);
    return result;
  }

  // A refusal or failure comes back as the reason the project list shows under the project. Removing the project kills its
  // terminals and its worktrees' (AD6), so running ones are asked about first (G22).
  private async removeProject(key: string): Promise<RemoveProjectResult> {
    try {
      const project = this.projectByKey(key);
      const terminals = this.requireTerminals();
      return await removeProject(key, {
        project: () => project,
        busy: (projectKey) => this.projectBusy(projectKey),
        waitingChats: (projectKey) => this.waitingChats(projectKey),
        terminals: {
          idsIn: (projectKey) => this.roots.all().filter((root) => root.root.projectKey === projectKey).flatMap((root) => terminals.idsIn(root.key)),
          setupTerminal: (worktreeId) => terminals.taskTerminal(setupTaskKey(worktreeId)),
          toConfirm: (ids) => terminals.toConfirm(ids),
          confirmKill: (ids) => terminals.confirmKill(ids),
        },
        ask: this.ask,
        discard: (chats) => this.discardWaitingChats(chats),
        remove: async () => {
          this.unloadWorktreeChats(key);
          await this.projects.remove(project.fsPath);
        },
        t: (message, ...args) => this.requireLocalization().t(message, ...args),
      });
    } catch (err) {
      log(`[shell] removing a project failed: ${errorText(err)}`);
      return { ok: false, reason: errorMessage(err) };
    }
  }

  // D33's busy rule over the project's loaded chats, those working in its owned folders (worktrees) included. A halted
  // engine runs nothing; a restart or reload under way still answers from the core it starts.
  private projectBusy(projectKey: string): Promise<boolean> {
    if (this.core.halted()) return Promise.resolve(false);
    return this.core.run('Project Busy', (core) => core.client.projectBusy(projectKey));
  }

  // The loaded chats of the project, its worktrees' included, that hold their first prompt for their worktree (rule 6).
  private waitingChats(projectKey: string): WaitingChat[] {
    return (this.client()?.chats() ?? []).flatMap((chat): WaitingChat[] => {
      const corePanelId = chat.panelId;
      const prompt = (chat.folder.ownerKey ?? chat.folder.key) === projectKey ? chat.heldPrompt as UserContentBlock[] | undefined : undefined;
      if (prompt === undefined) return [];
      const panel = this.panelOfCore(corePanelId);
      const worktreeId = this.worktreeStates.get(corePanelId)?.worktreeId;
      return [{ corePanelId, title: panel ? this.titleOf(panel) : '', prompt, ...(worktreeId !== undefined ? { worktreeId } : {}) }];
    });
  }

  // Each chat closes, as Delete closes one, which drops its hold and panels.json entry; core discards its unused worktree.
  private async discardWaitingChats(chats: readonly WaitingChat[]): Promise<void> {
    const client = this.requireCore().client;
    await Promise.all(chats.map((chat) => {
      const panel = this.panelOfCore(chat.corePanelId);
      if (panel && !panel.isDisposed) panel.close();
      return client.whenWorktreeDiscarded(chat.corePanelId);
    }));
  }

  // AD12 Projects: a removed project's worktree chats unload and keep their worktrees, which re-adding lists again.
  private unloadWorktreeChats(projectKey: string): void {
    for (const event of [...this.worktreeStates.values()]) {
      if (event.worktreeId === undefined || folderKey(event.projectPath) !== projectKey) continue;
      const panel = this.panelOfCore(event.panelId);
      if (panel && !panel.isDisposed) panel.close();
    }
  }

  private toggleSidebar(): void {
    const current = this.windowLayout.sidebar();
    this.windowLayout.setSidebar({ ...current, sidebarVisible: !current.sidebarVisible });
    if (current.sidebarVisible && this.shellFocusedPart === 'sidebar') this.views?.focusChat();
    this.shellStateChanged();
  }

  private showSidebar(): void {
    const current = this.windowLayout.sidebar();
    if (current.sidebarVisible) return;
    this.windowLayout.setSidebar({ ...current, sidebarVisible: true });
    this.shellStateChanged();
  }

  private async toggleTheme(): Promise<void> {
    await this.requirePlatform().settings.update(THEME_SETTING, currentThemeKind() === 'dark' ? 'light' : 'dark', 'user');
  }

  private shellActions(views: PanelViews, browserTabs: BrowserTabs, overlay: OverlayHost, window: BrowserWindow): ShellActions {
    return {
      state: () => this.shellState(views),
      addProject: reportFailure(() => this.addProject(), this.shellFailure('Add Project', 'Damocles could not add the project: {0}')),
      removeProject: (key) => this.removeProject(key),
      selectProject: reportFailure((key: string) => this.selectProject(key), this.shellFailure('Select Project', 'Damocles could not open the project: {0}')),
      grantTrust: reportFailure(async (key: string) => {
        await this.trust.requestTrust(this.projectByKey(key).fsPath);
      }, this.shellFailure('Trust Project', 'Damocles could not trust the project: {0}')),
      listChats: (key) => this.listChats(key),
      searchChats: (key, query) => this.searchChats(key, query),
      selectChat: (id) => this.selectChat(id),
      newChat: reportFailure((key: string | undefined, worktree?: NewChatWorktree) => this.newChat(key, worktree), this.shellFailure('New Chat', 'Damocles could not open a new conversation: {0}')),
      newChatInWorktree: reportFailure((request: NewChatInWorktreeRequest) => this.newChatInWorktree(request), this.newChatInWorktreeFailure()),
      worktreeOptions: (key) => this.worktreeOptions(key),
      showFolder: reportFailure(async (request: ShowFolderRequest) => this.showFolder(request), this.shellFailure('Show Folder', 'Damocles could not switch the folder: {0}')),
      worktreeFinish: reportFailure((request: WorktreeFinishRequest) => this.worktreeFinish(request), this.shellFailure('Worktree Action', 'The worktree action failed: {0}')),
      renameChat: reportFailure((id: string, name: string) => this.renameChat(id, name), this.shellFailure('Rename Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      tagChat: reportFailure((id: string, tag: string | null) => this.tagChat(id, tag), this.shellFailure('Tag Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      deleteChat: reportFailure((id: string) => this.deleteChat(id), this.shellFailure('Delete Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      // A popup the overlay could not show (no page loaded or loading, no acknowledgement, a crash or reload) answers as dismissed.
      requestOverlay: reportFailure(
        (request: OverlayRequest, returnFocus: WebContents) => this.requestFromShell(overlay, request, returnFocus),
        this.shellFailure('Show Popup', 'Damocles could not open the menu or dialog: {0}'),
        OVERLAY_DISMISSED,
      ),
      openAppMenu: (anchor) => popupApplicationMenu(window, anchor),
      toggleTheme: () => { this.toggleTheme().catch(this.shellFailure('Toggle Theme', 'Damocles could not change the theme: {0}')); },
      restartEngine: () => this.restartEngine(),
      toggleSidebar: () => this.toggleSidebar(),
      showSidebar: () => this.showSidebar(),
      windowControl: (control) => {
        if (control === 'minimize') window.minimize();
        else if (control === 'close') window.close();
        else if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      },
      openSettings: (section) => this.openSettings(section !== undefined ? { section } : {}),
      update: () => this.requireUpdates().snapshot(),
      runUpdateAction: (action) => runUpdateAction(action, this.aboutDeps()),
      setContentBounds: (bounds) => views.setContentBounds(bounds),
      // Main owns the sidebar's visibility and the grid's slots, visibility and maximized pane. The shell owns the sizes and
      // Search states while it runs, each part reporting only its own fields, so main stores them without publishing.
      setSidebarLayout: (reported) => this.windowLayout.setSidebar({ ...this.windowLayout.sidebar(), ...reported }),
      setGridSizes: (sizes) => {
        const current = this.windowLayout.sidebar();
        this.windowLayout.setSidebar({ ...current, grid: { ...current.grid, ...sizes } });
      },
      layoutMove: (pane, slot) => this.layoutMove(pane, slot),
      toggleEditor: () => this.toggleGridPane('editor'),
      toggleTerminal: () => this.toggleTerminal(false),
      toggleMaximize: (pane) => this.setGrid(toggleGridMaximize(this.windowLayout.sidebar().grid, pane)),
      dropZonesPointer: (pointer) => {
        if (overlay.isOpen('dropZones')) overlay.send(OVERLAY_CHANNELS.dropZonesPointer, pointer);
      },
      openQuickOpen: () => this.openQuickOpen('files'),
      showCommands: () => this.openQuickOpen('commands'),
      search: {
        start: (request) => this.requireSearch().start(request),
        cancel: () => this.requireSearch().cancel(),
        clear: () => this.requireSearch().clear(),
        dismiss: (request) => this.requireSearch().dismiss(request),
        copy: (request) => this.requireSearch().copy(request),
        confirmReplace: (request) => this.requireSearch().confirmReplace(request),
        replace: (request) => this.requireSearch().replace(request),
        preview: (request) => this.requireSearch().preview(request),
        findInFolder: (folder) => this.requireSearch().findInFolder(folder),
      },
      scm: {
        state: () => this.requireScm().state(),
        select: (raw) => this.requireScm().select(raw),
        run: (raw) => this.requireScm().run(raw),
        commit: (raw) => this.requireScm().commit(raw),
        generateMessage: (raw) => this.requireScm().generateMessage(raw),
        fileDiff: (raw) => this.requireScm().fileDiff(raw),
        copy: (raw) => this.requireScm().copy(raw),
        commitInput: (raw) => this.requireScm().commitInput(raw),
        amend: (raw) => this.requireScm().amend(raw),
        artifacts: (raw) => this.requireScm().artifacts(raw),
        quickDiffBase: (raw) => this.requireScm().quickDiffBase(raw),
        blame: (raw) => this.requireScm().blame(raw),
        timeline: (raw) => this.requireScm().timeline(raw),
        history: (raw) => this.beforeHistory().then(() => this.requireScm().history(raw)),
        commitDetails: (raw) => this.requireScm().commitDetails(raw),
        mergeInputs: (raw) => this.requireScm().mergeInputs(raw),
        mergeFile: (raw) => this.requireScm().mergeFile(raw),
        resource: (raw) => this.requireScm().resource(raw),
      },
      review: {
        fileDiff: (raw) => this.chatReviews.fileDiff(raw),
        setScope: (raw) => this.chatReviews.setScope(raw),
        send: (raw) => this.chatReviews.send(raw),
        discard: (raw) => this.chatReviews.discard(raw),
        setDrafts: (raw) => this.chatReviews.setDrafts(raw),
      },
      searchEditor: {
        openNew: (request) => this.requireSearch().openNew(request),
        setConfig: (documentId, config) => this.requireSearch().setConfig(documentId, config),
        run: (documentId) => this.requireSearch().run(documentId),
        openResult: (request) => this.requireSearch().openResult(request),
      },
      editor: {
        state: () => this.requireEditorPane().state(),
        content: (documentId) => this.requireEditorPane().content(documentId),
        open: (request) => this.requireEditorPane().openFromUser(request.projectKey, request.relativePath, {
          ...(request.line !== undefined ? { line: request.line } : {}),
          ...(request.as !== undefined ? { as: request.as } : {}),
          ...(request.preserveFocus !== undefined ? { preserveFocus: request.preserveFocus } : {}),
          ...(request.toSide !== undefined ? { toSide: request.toSide } : {}),
        }),
        tab: (request) => this.requireEditorPane().tabAction(request.action, request.tabId),
        edit: (request) => this.requireEditorPane().edit(request.documentId, request),
        save: (request, as) => this.requireEditorPane().save(request.documentId, request.version, request.text, as),
        conflict: (request) => this.requireEditorPane().conflict(request.documentId, request.action),
        format: (request) => this.requireFormatter().format(request.documentId, request.text, request.reason),
        formatFailed: (failure) => this.requireFormatter().builtinFailed(failure.documentId, failure.reason, failure.timedOut, failure.message),
        selection: (documentId, range) => this.requireEditorPane().select(documentId, range),
        mention: (tabId) => this.requireEditorPane().mention(tabId),
        setFocusOverlay: (open) => views.setFocusOverlay(open),
        flushed: (requestId) => this.requireEditorPane().flushed(requestId),
      },
      browser: {
        action: (request) => browserTabs.action(request.tabId, request.action),
        navigate: (request) => browserTabs.navigate(request.tabId, request.url),
        setBounds: (bounds, radius) => browserTabs.setBounds(bounds, radius),
      },
      files: {
        list: (projectKey, relativeDir, report) => (report
          ? this.runFilesAction('list', { projectKey, relativePath: relativeDir }, () => this.requireFileTree().list(projectKey, relativeDir))
          : this.requireFileTree().list(projectKey, relativeDir)),
        create: (request) => this.runFilesAction(
          'create',
          { projectKey: request.projectKey, relativePath: request.relativeDir === '' ? request.name : `${request.relativeDir}/${request.name}` },
          () => this.requireFileTree().create(request.projectKey, request.relativeDir, request.name, request.kind),
        ),
        rename: (file, newName) => this.runFilesAction('rename', file, () => this.requireEditorPane().fileRenamed(
          file.projectKey,
          file.relativePath,
          () => this.requireFileTree().rename(file.projectKey, file.relativePath, newName),
        ), newName),
        delete: (file) => this.runFilesAction('delete', file, () => this.requireFileTree().delete(file.projectKey, file.relativePath)),
        copyPath: async (file, relative) => {
          await this.runFilesAction('copyPath', file, () => this.requireFileTree().copyPath(file.projectKey, file.relativePath, relative));
        },
        reveal: async (file) => {
          await this.runFilesAction('reveal', file, () => this.requireFileTree().reveal(file.projectKey, file.relativePath));
        },
        mention: (file) => this.mentionInSelectedChat(file),
      },
      setFocusedPart: (part) => {
        this.shellFocusedPart = part;
        this.refreshMenuState();
      },
      terminal: {
        state: () => this.requireTerminals().state(),
        has: (id) => this.requireTerminals().has(id),
        create: (request) => this.requireTerminals().create(request, false),
        openNew: () => { this.newTerminal().catch(this.report('New Terminal')); },
        input: (id, data) => this.requireTerminals().input(id, data),
        resize: (id, cols, rows) => this.requireTerminals().resize(id, cols, rows),
        ack: (id, chars) => this.requireTerminals().ack(id, chars),
        kill: (id) => { this.requireTerminals().requestKill([id]).catch(this.report('Kill Terminal')); },
        restart: (id) => { this.requireTerminals().restart(id).catch(this.report('Restart Terminal')); },
        select: (id) => this.requireTerminals().select(id),
        split: (id) => { this.requireTerminals().split(id).catch(this.report('Split Terminal')); },
        unsplit: (id) => this.requireTerminals().unsplit(id),
        resizePanes: (groupId, sizes) => this.requireTerminals().resizePanes(groupId, sizes),
        setListWidth: (rem) => this.requireTerminals().setListWidth(rem),
        shellLoaded: () => this.requireTerminals().shellLoaded(),
        paste: (request) => { this.terminalPaste.paste(request).catch(this.report('Paste')); },
        setInputFocused: (focused) => {
          this.terminalInputFocused = focused;
          this.refreshMenuState();
        },
        resolveLinks: (request) => {
          const terminals = this.requireTerminals();
          if (!terminals.has(request.id)) throw new Error('Unknown terminal');
          const base = terminals.linkBase(request.id);
          return base ? this.terminalLinks.resolveAll(request.paths, base) : Promise.resolve(request.paths.map(() => null));
        },
        openLink: (request) => { this.openTerminalLink(request).catch(this.report('Open Link')); },
        rename: (id, name) => this.requireTerminals().rename(id, name),
        pickIcon: (id) => { this.pickTerminalIcon(id).catch(this.report('Change Icon')); },
        pickColor: (id) => { this.pickTerminalColor(id).catch(this.report('Change Color')); },
        selectDefaultProfile: () => { this.selectDefaultTerminalProfile().catch(this.report('Select Default Profile')); },
        addToChat: (request) => { this.addTerminalOutputToChat(request).catch(this.shellFailure('Add to Chat', 'Damocles could not add the terminal output to the chat: {0}')); },
      },
      gestures: {
        pasteKey: () => {
          if (this.terminalInputHasFocus()) this.terminalPaste.allow('clipboard');
        },
        middleClick: () => this.terminalPaste.allow('selection'),
        contextMenu: () => this.shellMenuGrant.grant(true),
        blurred: () => {
          this.shellMenuGrant.clear();
          this.terminalPaste.clear();
        },
      },
    };
  }

  private terminalInputHasFocus(): boolean {
    return this.terminalInputFocused && this.focusedPart() === 'terminal';
  }

  // The bell's center marks every entry seen once the overlay shows it; choosing a row closes it, and main then runs the row's action.
  private async requestFromShell(overlay: OverlayHost, request: OverlayRequest, returnFocus: WebContents): Promise<OverlayAnswer> {
    const shown = request.kind === 'notifications' ? () => this.notificationCenter.markSeen() : undefined;
    const platform = this.requirePlatform();
    const answer = await askShellMenu(request, {
      ask: (shownRequest) => overlay.request(shownRequest, returnFocus, shown),
      takeMenuGrant: () => this.shellMenuGrant.take() === true,
      label: (action) => platform.localization.t(action === 'cut' ? 'Cut' : action === 'copy' ? 'Copy' : 'Paste'),
      page: returnFocus,
      allowTerminalPaste: () => this.terminalPaste.allow('clipboard'),
      log: (line) => log(line),
    });
    if (answer.kind === 'notifications') {
      if (answer.action === 'open') this.notificationCenter.open(answer.entryId);
      else this.notificationCenter.answer(answer.entryId, answer.label);
    }
    if (answer.kind === 'dropZones' && request.kind === 'dropZones' && answer.slot !== null) this.layoutMove(request.pane, answer.slot);
    return answer;
  }

  private startEditor(platform: DesktopPlatform, localization: DesktopLocalizationService): void {
    const t = (message: string, ...args: Array<string | number>): string => localization.t(message, ...args);
    // every root a renderer may name files in (AD5, rule 19): the project folders and their live chat worktrees
    const projects = (): readonly Project[] => this.roots.all();
    const report = (line: string): void => log(line);
    const documents = new DocumentService({
      projects,
      watchers: platform.fileWatchers,
      ask: this.ask,
      t,
      log: report,
      pickSavePath: (defaultPath) => this.pickSavePath(defaultPath),
      backups: this.backups,
      settings: {
        locate: (scope) => {
          const located = locateSettingsFile(platform, scope);
          return typeof located === 'string' ? located : undefined;
        },
        save: (scope, filePath, content, baseVersion) => saveSettingsFileText(platform, scope, filePath, content, baseVersion),
      },
    });
    const fileTree = new FileTree({
      projects,
      exclude: () => {
        const value = platform.settings.get<unknown>(FILES_EXCLUDE_SETTING);
        return isDesktopSettingValue(FILES_EXCLUDE_SETTING, value) ? (value as Record<string, unknown>) : DEFAULT_FILES_EXCLUDE;
      },
      watchers: platform.fileWatchers,
      ask: this.ask,
      t,
      log: report,
      trash: (absolutePath) => this.trashEntry(absolutePath),
      remove: (absolutePath) => this.removeEntry(absolutePath),
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      copy: (text) => platform.clipboard.writeText(text),
      changed: (change) => this.shell?.filesChanged(change),
      ignored: (projectKey, relativeDir, entries) => this.scm?.ignored(projectKey, relativeDir, entries) ?? Promise.resolve(new Set()),
    });
    const quickOpenIndex = new QuickOpenIndex({
      projects: () => this.quickOpenRoots(),
      rgPath: () => resolveRgPath(platform.paths),
      ignoreArgs: () => getRipgrepSearchOptions(platform.settings),
      excludes: () => [...fileTree.excludePatterns(), ...this.searchExcludePatterns()],
      watch: (project) => fileTree.watch(project),
      startWorker: () => new Worker(quickOpenWorkerPath(platform.paths)),
      log: report,
    });
    const editorPane = new EditorPane({
      documents,
      settings: platform.settings,
      ask: this.ask,
      t,
      log: report,
      restoreLayout: () => platform.settings.get<boolean>(RESTORE_LAYOUT_SETTING, true) !== false,
      persist: (editor) => this.windowLayout.setEditor(editor),
      flushBackups: () => this.backups.flush(),
      logsDir: this.logsDir,
      sendState: (state) => {
        this.shell?.editorState(state);
        this.editorRootKeys = new Set(state.tabs.flatMap((tab) => (tab.projectKey !== undefined ? [tab.projectKey] : [])));
        this.refreshScmRoots();
        this.refreshMenuState();
      },
      sendDocument: (documentId, content) => this.shell?.documentChanged(documentId, content),
      sendCommand: (command) => this.shell?.editorCommand(command),
      sendFlush: (requestId, format) => this.shell?.editorFlush(requestId, format) ?? false,
      focusTab: (tabId) => this.shell?.focusEditorTab(tabId),
      revealLine: (tabId, line, range) => this.shell?.revealEditorLine(tabId, line, range),
      showPane: () => {
        if (!this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      hidePane: () => {
        if (this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      showPaneBeside: () => {
        const grid = this.windowLayout.sidebar().grid;
        if (grid.maximized !== null && grid.maximized !== 'editor') this.setGrid({ ...grid, maximized: null });
        if (!this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      projects,
      worktreeBranch: (key) => this.roots.branchOf(key),
      copy: (text) => platform.clipboard.writeText(text),
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      mention: (target) => this.mentionInSelectedChat(target),
      browser: () => this.browserTabs,
      warn: (message) => void this.notifications.warn(message),
      searchEditorClosed: (documentId) => this.search?.searchEditorClosed(documentId),
      reviewClosed: (reviewId) => this.chatReviews.reviewClosed(reviewId),
      gitOf: (absolutePath) => this.scm?.gitOf(absolutePath),
      openChanges: (absolutePath) => this.requireScm().openChangesOf(absolutePath),
    });
    const formatterHosts = new FormatterHosts({
      spawn: (root) => spawnFormatterHost(path.join(platform.paths.unpackedRoot, 'dist', 'formatter-host.js'), root),
      watch: (root, onChange) => {
        const watcher = platform.fileWatchers.watch(root, PRETTIER_INSTALL_GLOB);
        watcher.onDidCreate(onChange);
        watcher.onDidChange(onChange);
        watcher.onDidDelete(onChange);
        return watcher;
      },
      log: report,
    });
    // D29's errors and timeouts; Show Output opens it as a log tab (D36).
    const formatLog = this.logSinks.create('Format');
    const formatter = new FormatService({
      target: (documentId) => editorPane.formatTarget(documentId),
      projects,
      isTrusted: (fsPath) => this.trust.isTrusted(fsPath),
      requestTrust: (fsPath) => {
        this.trust.requestTrust(fsPath).catch(this.report('Trust Project'));
      },
      formatOnSave: () => editorSettings(platform.settings).formatOnSave,
      hosts: formatterHosts,
      notify: (severity, message, action) => {
        const actions = action ? [action.label] : [];
        const answer = severity === 'info' ? this.notifications.info(message, ...actions) : this.notifications.warn(message, ...actions);
        answer.then((chosen) => {
          if (action && chosen === action.label) action.run();
        }, this.report('A format notice'));
      },
      formatLog: { appendLine: (line) => formatLog.appendLine(line), show: () => formatLog.show(false) },
      log: report,
      t,
    });
    const search = new SearchHost({
      settings: platform.settings,
      documents,
      editorPane,
      projects,
      selectedFolder: () => this.searchFolder(),
      rgPath: () => resolveRgPath(platform.paths),
      ignoreArgs: () => getRipgrepSearchOptions(platform.settings),
      excludeSettings: () => [...fileTree.excludePatterns(), ...this.searchExcludePatterns()],
      ask: this.ask,
      t,
      warn: (message) => void platform.notifications.warn(message),
      copy: (text) => platform.clipboard.writeText(text),
      selectedText: () => editorPane.activeContext()?.selection?.text,
      showSidebar: () => this.showSidebar(),
      clearSearchHistory: () => {
        this.windowLayout.clearSearchHistory();
        this.shellStateChanged();
      },
      sendResults: (batch) => this.shell?.searchResults(batch),
      sendFileUpdate: (update) => this.shell?.searchFileUpdate(update),
      sendDone: (done) => this.shell?.searchDone(done),
      sendHighlights: (highlights) => this.shell?.searchEditorHighlights(highlights),
      sendCommand: (message) => this.shell?.searchCommand(message),
      focusSearch: (focus) => this.shell?.focusSearch(focus),
      stateChanged: () => this.refreshMenuState(),
      log: report,
      lineDelimiter: process.platform === 'win32' ? '\r\n' : '\n',
    });
    documents.onDidChangeText((change) => search.documentChanged(change.documentId));
    // Source control (AD4) runs in Damocles Core, which writes the Git log (argv, duration and exit code, redacted as it is
    // written); Show Git Output opens it as a log tab (D36).
    const git = this.gitProbe;
    const askInput = createInputAsker({
      overlay: () => this.overlay,
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      unavailable: () => void platform.notifications.error(t('The text box could not be shown, so nothing was changed. Try again.')),
      log: report,
    });
    this.askCredential = createAskpassBridge({ ask: this.ask, askInput, t });
    const scmClient = createScmClient({
      core: (label, work) => this.core.run(label, (core) => work(core.client)),
      gitVersion: git.available ? git.version : undefined,
      log: report,
    });
    this.scmClient = scmClient;
    const scm = new ScmHost({
      service: scmClient,
      settings: platform.settings,
      documents,
      projects: () => this.scmRoots(),
      selectedProjectKey: () => this.searchFolder()?.projectKey,
      editorPane,
      selection: { get: (projectKey) => this.windowLayout.scmSelected(projectKey), set: (projectKey, root) => this.windowLayout.setScmSelected(projectKey, root) },
      notify: platform.notifications,
      t,
      showGitLog: () => this.openLogTab(path.join(this.logsDir, logFileName('Git')), false),
      copy: (text) => platform.clipboard.writeText(text),
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      openExternal: async (url) => {
        if (!(await platform.shell.openExternal(url))) throw new Error('The link could not be opened');
      },
      pickFolder: (defaultPath, title, buttonLabel) => platform.dialogs.pickFolder({ title: title ?? t('Open Repository'), defaultPath, ...(buttonLabel !== undefined ? { buttonLabel } : {}) }),
      addProject: (folder) => this.addProjectAt(folder),
      selectProject: (projectKey) => this.selectProject(projectKey),
      worktrees: this.scmWorktreeDeps(),
      gitFound: git.available,
      quickPick: createQuickPickAsker({
        overlay: () => this.overlay,
        focused: () => webContents.getFocusedWebContents() ?? undefined,
        unavailable: () => void platform.notifications.error(t('The list could not be shown, so nothing was changed. Try again.')),
        tooLarge: () => void platform.notifications.error(t('The list has too many entries to show, so nothing was changed.')),
        log: report,
      }),
      ask: this.ask,
      askInput,
      mention: (target) => this.mentionInSelectedChat(target),
      addToChat: (projectKey, attachment, prompt) => this.addAttachmentToChat(projectKey, attachment, t('The chat could not be loaded, so the commit was not added to it.'), prompt),
      send: {
        view: (view) => this.shell?.scmView(view),
        state: (snapshot) => this.shell?.scmState(snapshot),
        decorations: (decorations) => this.shell?.scmDecorations(decorations),
        settings: (settings) => this.shell?.scmSettings(settings),
        command: (command) => this.shell?.scmCommand(command),
        setInput: (input) => this.shell?.scmSetInput(input),
        clone: (state) => this.shell?.scmClone(state),
        artifactsChanged: (changed) => this.shell?.scmArtifactsChanged(changed),
        filesChanged: (projectKey) => this.shell?.filesChanged({ projectKey, relativeDirs: [] }),
      },
      menuChanged: () => this.refreshMenuState(),
      log: report,
      platform: process.platform,
    });
    this.scm = scm;
    // the list each core receives as it attaches (ScmClient)
    scm.setProjects(this.scmRoots());
    this.disposables.push(scm, scmClient);

    this.palette = new CommandPalette({
      commands: () => desktopCommands(this.projects.folders(), this.menuActions(), process.platform),
      l10n: localization,
      english: createDesktopLocalizationService(resourceRoot, 'en', report),
      platform: process.platform,
      log: report,
    });
    this.disposables.push(fileTree.onDidChangeStructure((projectKey) => quickOpenIndex.invalidate(projectKey)), quickOpenIndex, fileTree, editorPane, documents, search, formatterHosts, formatLog);
    this.formatter = formatter;
    this.formatterHosts = formatterHosts;
    this.search = search;
    this.fileTree = fileTree;
    this.quickOpenIndex = quickOpenIndex;
    this.editorPane = editorPane;
    // Playwright drives the agent's side of EditorService (openFile, showDiff without approvalId), raises host prompts and modal
    // questions, stores their answers as secrets, routes the browser's requests and makes Files' trash or permanent delete fail
    // through this, in the unpackaged app only. What reaches the engine goes through core's e2e.* requests.
    if (E2E_HOOKS) {
      const hooks = {
        editor: platform.editor,
        dialogs: { inputBox: (options: InputBoxOptions) => this.requireCore().client.e2eInputBox(options) },
        // core's capabilities read this platform until the next core starts; null restores the real one, which is returned
        setCorePlatform: (next: NodeJS.Platform | null) => this.core.run('e2e', (core) => core.client.e2eSetPlatform(next)),
        // core's renames to a file of this name wait delayMs from now on, and how many waited (core's writeJsonConfig)
        slowCoreRenames: (basename: string, delayMs: number) => this.core.run('e2e', (core) => core.client.e2eSlowRenames(basename, delayMs)),
        slowedCoreRenames: (basename: string) => this.core.run('e2e', (core) => core.client.e2eSlowedRenames(basename)),
        // core's next core.shutdown never answers, so the quit's bound kills core
        holdCoreShutdown: () => this.core.run('e2e', (core) => core.client.e2eHoldShutdown()),
        notifications: platform.notifications,
        secrets: platform.secrets,
        // requests of the active page's browser context whose URL matches pattern load from toHost instead; routed lists them
        browser: {
          route: (pattern: string, toHost: string) => this.requireCore().client.e2eRouteBrowser(pattern, toHost),
          routed: () => this.requireCore().client.e2eRoutedRequests(),
        },
        // counts the browser page restores main asks core for, from now on
        countPageRestores: () => {
          this.e2ePageRestores = { count: 0 };
          return this.e2ePageRestores;
        },
        launchTabsOpened: () => this.launchTabs,
        failFiles: (failure: { readonly trash?: string; readonly remove?: string }) => {
          if (failure.trash !== undefined) this.trashEntry = () => Promise.reject(new Error(failure.trash));
          if (failure.remove !== undefined) this.removeEntry = () => Promise.reject(new Error(failure.remove));
        },
        // reached turns true once a quit waits on the hold
        holdStoreFlush: () => {
          const hold = { reached: false, release: (): void => undefined };
          const released = new Promise<void>((resolve) => (hold.release = resolve));
          this.beforeStoreFlush = () => {
            hold.reached = true;
            return released;
          };
          return hold;
        },
        // reached turns true once a core dispose waits on the hold
        holdCoreDispose: () => {
          const hold = { reached: false, release: (): void => undefined };
          const released = new Promise<void>((resolve) => (hold.release = resolve));
          this.beforeCoreDispose = () => {
            hold.reached = true;
            return released;
          };
          return hold;
        },
        // Source control: the sub-call ledger path and the Git log as written.
        scm: {
          // one autofetch round of the selected project now, as if the period had elapsed
          autofetchNow: () => this.requireScm().autofetchNow(),
          ledgerPath: () => SUBCALL_USAGE_LEDGER_PATH,
          gitLog: () => fs.promises.readFile(path.join(this.logsDir, logFileName('Git')), 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? '' : Promise.reject(err))),
          // reached turns true once a Graph history request waits on the hold; release answers it and every later one, fail
          // rejects them, until the next hold
          holdHistory: () => {
            const hold = { reached: false, release: (): void => undefined, fail: (): void => undefined };
            const released = new Promise<void>((resolve, reject) => {
              hold.release = resolve;
              hold.fail = () => reject(new Error('the e2e hooks failed the history read'));
            });
            // a hold failed before any request waits on it is not an unhandled rejection
            released.catch(() => undefined);
            this.beforeHistory = () => {
              hold.reached = true;
              return released;
            };
            return hold;
          },
        },
        reloadCore: () => this.core.reload(),
        // the worktree dialogs (slice 12a) asked as main asks them, for the captures
        worktrees: {
          ask: (dialog: WorktreeDialog) => {
            if (!this.askWorktreeDialog) throw new Error('Worktrees are not started');
            return this.askWorktreeDialog(dialog);
          },
        },
        // reached turns true once a chat restore waits on the hold; fail makes every held restore reject
        holdChatRestore: () => {
          const hold = { reached: false, release: (): void => undefined, fail: (): void => undefined };
          const released = new Promise<void>((resolve, reject) => {
            hold.release = resolve;
            hold.fail = () => reject(new Error('the e2e hooks failed the chat restore'));
          });
          this.beforeChatRestore = () => {
            hold.reached = true;
            return released;
          };
          return hold;
        },
      };
      // DAMOCLES_E2E_HOLD_CHAT_RESTORE=1 holds the chat restores from launch on, before a test can call holdChatRestore.
      const launchRestore = process.env['DAMOCLES_E2E_HOLD_CHAT_RESTORE'] === '1' ? hooks.holdChatRestore() : undefined;
      (globalThis as { __damoclesE2e?: unknown }).__damoclesE2e = { ...hooks, launchRestore };
    }
  }

  private requireEditorPane(): EditorPane {
    if (!this.editorPane) throw new Error('The editor pane used before startup finished');
    return this.editorPane;
  }

  private requireFormatter(): FormatService {
    if (!this.formatter) throw new Error('Formatting used before startup finished');
    return this.formatter;
  }

  private requireFileTree(): FileTree {
    if (!this.fileTree) throw new Error('Files used before startup finished');
    return this.fileTree;
  }

  private requireQuickOpenIndex(): QuickOpenIndex {
    if (!this.quickOpenIndex) throw new Error('Quick Open used before startup finished');
    return this.quickOpenIndex;
  }

  private requireScm(): ScmHost {
    if (!this.scm) throw new Error('Source control used before startup finished');
    return this.scm;
  }

  private requireSearch(): SearchHost {
    if (!this.search) throw new Error('Search used before startup finished');
    return this.search;
  }

  private requirePalette(): CommandPalette {
    if (!this.palette) throw new Error('The command palette used before startup finished');
    return this.palette;
  }

  // The true entries of damocles.desktop.search.exclude.
  private searchExcludePatterns(): string[] {
    const value = this.requirePlatform().settings.get<unknown>(SEARCH_EXCLUDE_SETTING);
    return excludeSettingGlobs(isDesktopSettingValue(SEARCH_EXCLUDE_SETTING, value) ? (value as Record<string, unknown>) : DEFAULT_SEARCH_EXCLUDE);
  }

  // Search's folder: the selected project's shown folder (D31), resolved against main's own roots.
  private searchFolder(): SearchFolder | undefined {
    const key = this.selectedProjectKey ?? this.client()?.defaultTarget()?.key;
    const root = key === undefined ? undefined : this.roots.resolve(this.shownFolders.rootKeyOf(key));
    return root ? { projectKey: root.key, fsPath: root.fsPath } : undefined;
  }

  // A chat feature in the selected chat (AD11), once that chat's view is ready.
  private runChatCommand(command: ChatCommand): void {
    const panel = this.views?.selected();
    if (!panel) return;
    const deps = this.entryActionDeps;
    void deps.whenReady(panel).then((ready) => {
      if (ready && this.views?.selected() === panel) deps.post(panel, { type: 'runChatCommand', command });
    }, this.report('Run Chat Command'));
  }

  // The project list as Files, Quick Open and the editor confine to it: each key is folderKey(fsPath), as the shell names it.
  private desktopProjects(): readonly Project[] {
    const client = this.client();
    return this.projects.folders().map((folder) => {
      const key = folderKey(folder.fsPath);
      return { key, fsPath: folder.fsPath, name: client?.resolve(key)?.label ?? folder.name };
    });
  }

  // Trust's view of core's worktree records, and the controller whose UI core's worktree services reach; once per app run.
  private startWorktrees(): WorktreeController {
    const records = this.worktreeRecords;
    this.trust.setWorktrees({
      projectOf: (folder) => records.liveChatRecordAt(folder)?.projectPath,
      workingFolders: (projectPath) => records.liveChatRecords(projectPath).map((record) => record.workingFolder),
    });
    const t = (message: string, ...args: Array<string | number>): string => this.requireLocalization().t(message, ...args);
    const report = (line: string): void => log(line);
    const askDialog = createWorktreeDialogAsker({
      overlay: () => this.overlay,
      focused: () => webContents.getFocusedWebContents() ?? undefined,
      ask: this.ask,
      warn: (message) => void this.notifications.warn(message),
      t,
      log: report,
    });
    this.askWorktreeDialog = askDialog;
    const controller = new WorktreeController({
      records,
      engine: this.worktreeEngine,
      roots: this.roots,
      gitFound: this.gitProbe.available,
      branchPrefix: () => this.requirePlatform().settings.get<string>(SCM_SETTING_KEYS.branchPrefix, '') ?? '',
      isTrusted: (folder) => this.trust.isTrusted(folder),
      askDialog,
      ask: this.ask,
      notify: this.notifications,
      t,
      log: report,
      setupShell: () => setupShell(process.platform, process.env, this.terminalProfiles?.profiles().find((profile) => profile.id === 'pwsh')?.file),
      runTask: (request) => {
        this.showTerminalPane();
        this.requireTerminals().runTask(request);
      },
      retrySetup: (worktreeId) => this.core.run('Retry Setup', (core) => core.client.retrySetup(worktreeId)),
      worktreeEnv: (record) => worktreeEnvironment(record),
      chatsUsing: (worktreeId) => [...this.worktreeStates.values()].filter((event) => event.worktreeId === worktreeId).map((event) => ({ panelId: event.panelId, busy: event.busy })),
      sessionsUsing: (worktreeId) => this.sessionsUsing(worktreeId),
      leasedElsewhere: (sessionId) => this.core.run('Lease Check', (core) => core.client.leaseRefused(sessionId, false)),
      closeWorktree: (worktreeId, key, stop) => this.closeWorktreeRoot(worktreeId, key, stop),
      afterClose: (worktreeId, removed) => this.worktreeClosed(worktreeId, removed),
      showProjectFolder: (projectKey) => {
        this.shownFolders.show(projectKey, 'project');
      },
      beginFinish: (worktreeId, action) => this.core.run(`Worktree ${action}`, (core) => core.client.beginWorktreeFinish(worktreeId, action, () => !core.isReady())),
      showTask: (key) => {
        const terminals = this.requireTerminals();
        const id = terminals.taskTerminal(key);
        if (id === undefined) return false;
        this.showTerminalPane();
        terminals.select(id);
        return true;
      },
      stopTask: (key) => {
        const terminals = this.terminals;
        const id = terminals?.taskTerminal(key);
        if (terminals && id !== undefined) terminals.kill(id);
      },
      projectRepositoryWhenReady: async (projectPath) => this.scm?.projectRepositoryWhenReady(folderKey(projectPath)),
      worktreeChats: (projectPath) => this.worktreeChats(folderKey(projectPath)),
      openConflicts: (folder, files, applyBranch) => this.openWorktreeConflicts(folder, files, applyBranch),
      publish: (key) => this.withScmRoot(key, async (repoId) => {
        await this.requireScm().runRequest({ op: 'publish', repoId });
      }),
      targetFacts: (record) => this.scm?.rootRepository(folderKey(record.projectPath)) ?? { hasRemote: false, detached: false },
      generateMessage: (record) => this.withScmRoot(this.worktreeRootKey(record), async (repoId) => {
        const generated = await this.requireScm().generateMessage({ repoId });
        return generated.ok ? generated.message : undefined;
      }),
      changed: () => this.worktreesChanged(),
      reveal: (absolutePath) => this.requirePlatform().shell.revealPath(absolutePath),
    });
    this.worktrees = controller;
    this.disposables.push(records, records.onDidChange(() => this.worktreesChanged()));
    return controller;
  }

  // What source control's worktree flows need of worktree chats (D58, B40, B45, rules 14 and 16).
  private scmWorktreeDeps(): ScmWorktreeDeps {
    const liveChatAt = (worktreePath: string): ChatWorktreeRecord | undefined => this.worktreeRecords.records().find(
      (record): record is ChatWorktreeRecord => record.kind === 'chat' && record.deletedAt === undefined && folderKey(record.worktreeRoot) === folderKey(worktreePath),
    );
    return {
      deleteChatWorktreeAt: async (worktreePath) => {
        const record = liveChatAt(worktreePath);
        if (!record) return false;
        await this.requireWorktrees().finish(record.id, 'delete');
        return true;
      },
      adopt: async (project, worktree, repositoryRoot, mainProject) => {
        await this.worktreeEngine.upsertAdopted({
          worktreeRoot: worktree.path,
          workingFolder: project.fsPath,
          repositoryRoot,
          ...(mainProject ? { projectPath: mainProject.fsPath } : {}),
          ...(worktree.branch !== null ? { branch: worktree.branch } : {}),
        });
      },
      adoptCreated: async (projectKey, repositoryRoot, worktreePath, branch) => {
        const project = this.desktopProjects().find((candidate) => candidate.key === projectKey);
        await this.worktreeEngine.upsertAdopted({ worktreeRoot: worktreePath, workingFolder: worktreePath, repositoryRoot, ...(project ? { projectPath: project.fsPath } : {}), ...(branch !== undefined ? { branch } : {}) });
      },
      markRemoved: (worktreePath) => this.worktreeEngine.markAdoptedRemoved(worktreePath),
      closeProject: (projectKey) => this.closeProjectForDelete(projectKey),
      chatOf: (worktreePath) => {
        const record = liveChatAt(worktreePath);
        return record ? this.worktreeChatOf(record) : undefined;
      },
      newChatTargetAt: (worktreePath) => this.newChatInTarget(liveChatAt(worktreePath)),
      selectChat: async (chatId) => {
        await this.selectChat(chatId);
      },
      showProjectFolder: (projectKey) => {
        this.shownFolders.show(projectKey, 'project');
      },
      projectCopyOf: (key, absolutePath) => {
        const root = this.roots.resolve(key);
        if (!root?.worktree) return undefined;
        const relative = path.relative(root.fsPath, absolutePath);
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
        const project = this.roots.resolve(root.root.projectKey);
        return project ? { project, relativePath: relative.split(path.sep).join('/') } : undefined;
      },
    };
  }

  // B45: the worktree's most recently viewed chat, loaded or listed; a worktree no chat uses yet names none.
  private worktreeChatOf(record: ChatWorktreeRecord): ScmWorktreeChat | undefined {
    const loaded = [...this.worktreeStates.values()]
      .filter((event) => event.worktreeId === record.id)
      .flatMap((event) => {
        const panel = this.panelOfCore(event.panelId);
        return panel ? [{ panel, event }] : [];
      })
      .sort((a, b) => (this.lastViewed.get(b.panel) ?? 0) - (this.lastViewed.get(a.panel) ?? 0))[0];
    if (loaded) return { chatId: this.chatIdOf(loaded.panel), title: this.titleOf(loaded.panel), place: loaded.event.state.place };
    const row = [...(this.catalogRows.get(folderKey(record.projectPath)) ?? [])]
      .filter((candidate) => candidate.worktree?.worktreeId === record.id)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    return row?.worktree ? { chatId: row.id, title: storedTitle(row), place: row.worktree.place } : undefined;
  }

  // New Chat in This Worktree's target: a live chat record of an open, trusted project with no finish action running.
  private newChatInTarget(record: WorktreeRecord | undefined): NewChatInWorktreeRequest | undefined {
    if (record?.kind !== 'chat' || record.deletedAt !== undefined || this.worktrees?.isFinishing(record.id) !== false) return undefined;
    const projectKey = folderKey(record.projectPath);
    const project = this.projects.folders().find((folder) => folderKey(folder.fsPath) === projectKey);
    return project && this.trust.isTrusted(project.fsPath) ? { projectKey, worktreeId: record.id } : undefined;
  }

  // Rule 14 for a worktree open as its own project: its chats unload and its terminals stop (asked first when one runs a
  // process) before `git worktree remove`; a running conversation refuses.
  private async closeProjectForDelete(projectKey: string): Promise<'closed' | 'cancelled' | { readonly reason: string }> {
    const project = this.projectByKey(projectKey);
    const running = { reason: this.requireLocalization().t('A conversation is running in {0}. Stop it or wait for it to finish, then remove the project.', project.name) };
    if (await this.projectBusy(projectKey)) return running;
    const terminals = this.requireTerminals();
    if (!(await terminals.confirmKill(terminals.idsIn(projectKey)))) return 'cancelled';
    // a turn may have started while the question was open
    if (await this.projectBusy(projectKey)) return running;
    const loaded = (this.client()?.chats() ?? []).filter((chat) => (chat.folder.ownerKey ?? chat.folder.key) === projectKey);
    for (const chat of loaded) {
      const panel = this.panelOfCore(chat.panelId);
      if (panel && !panel.isDisposed) panel.close();
    }
    await this.projects.remove(project.fsPath);
    await this.client()?.whenFolderReleased(project.fsPath);
    return 'closed';
  }

  // Rule 16's pass, in core: an open project that is a linked worktree gets an adopted record under the open project holding
  // its main worktree.
  private adoptOpenWorktrees(): Promise<void> {
    return this.worktreeEngine.adoptOpenWorktrees(this.desktopProjects().map((project) => ({ key: project.key, fsPath: project.fsPath })));
  }

  // ShellProject.worktreeOf: the project whose main worktree this adopted project's folder belongs to.
  private adoptedProjectName(projectKey: string): string | undefined {
    const record = this.worktreeRecords.records().find((candidate) => candidate.kind === 'adopted' && candidate.deletedAt === undefined && folderKey(candidate.workingFolder) === projectKey);
    if (!record) return undefined;
    if (record.projectPath === undefined) return path.basename(record.repositoryRoot);
    const main = folderKey(record.projectPath);
    return this.desktopProjects().find((project) => project.key === main)?.name ?? path.basename(record.projectPath);
  }

  private requireWorktrees(): WorktreeController {
    if (!this.worktrees) throw new Error('Worktrees used before startup finished');
    return this.worktrees;
  }

  private worktreeRootKey(record: ChatWorktreeRecord): string {
    return rootKey({ projectKey: folderKey(record.projectPath), worktreeId: record.id });
  }

  // The finish actions' enablement of a live chat worktree; before the controller exists nothing is enabled.
  private finishStateOf(record: ChatWorktreeRecord): { busy: boolean; hasRemote: boolean; detachedTarget: boolean } {
    return this.worktrees?.finishState(record) ?? { busy: true, hasRemote: false, detachedTarget: true };
  }

  // A project's selected chat for its shown folder (D31): its id, and core's worktree state while it is loaded.
  private selectedChatPlace(projectKey: string): { readonly chatId: string; readonly worktreeId?: string; readonly state?: WorktreeStateData } | undefined {
    const chatId = this.lastChatByProject.get(projectKey);
    if (chatId === undefined) return undefined;
    const panel = this.loadedChat(chatId);
    const corePanelId = panel ? this.corePanelIdOf(panel) : undefined;
    const event = corePanelId !== undefined ? this.worktreeStates.get(corePanelId) : undefined;
    if (!event) return { chatId };
    return { chatId, ...(event.worktreeId !== undefined ? { worktreeId: event.worktreeId } : {}), state: event.state };
  }

  private worktreeEventOf(panel: DesktopPanel): WorktreeEvent | undefined {
    const corePanelId = this.corePanelIdOf(panel);
    return corePanelId === undefined ? undefined : this.worktreeStates.get(corePanelId);
  }

  // Core's state of one chat changed (a turn starting or ending flips its busy): the shown folder, that chat's row, the
  // menu and the chat pool follow; the roots change only with the registry, which worktreesChanged follows.
  private onWorktreeState(event: WorktreeEvent): void {
    const sharedBefore = this.worktreeStates.get(event.panelId)?.state.sharedWith;
    this.worktreeStates.set(event.panelId, event);
    if (sharedBefore !== event.state.sharedWith) this.chatReviews.sharingChanged(event.panelId);
    const panel = this.panelOfCore(event.panelId);
    this.shownFolders.refresh();
    this.refreshScmRoots();
    if (panel) this.chatsChanged(this.projectOf(panel));
    this.refreshMenuState();
    this.scheduleRetention();
  }

  // The registry, the projects or a finish action changed: views keyed by a root follow only a root joining or leaving.
  private worktreesChanged(): void {
    const roots = this.roots.all().map((root) => root.key);
    const changed = this.rootSet.update(roots);
    if (changed) {
      this.formatterHosts?.retain(roots);
      this.terminals?.projectsChanged(roots);
      this.fileTree?.projectsChanged();
      for (const key of changed.removed) this.quickOpenIndex?.invalidate(key);
    }
    this.shownFolders.refresh();
    this.refreshScmRoots();
    this.chatsChanged();
    this.refreshMenuState();
    this.shellStateChanged();
  }

  // Source control's projects: every project folder, plus the chat worktrees a project shows, an editor tab names, or a flow
  // pinned (rule 19); a worktree root leaving the list closes its repository.
  private scmRoots(): RootProject[] {
    const kept = new Set(this.pinnedScmRoots);
    for (const shown of Object.values(this.shownFolders.all())) {
      if (shown.worktree) kept.add(rootKey({ projectKey: shown.projectKey, worktreeId: shown.worktree.worktreeId }));
    }
    for (const key of this.editorRootKeys) kept.add(key);
    return this.roots.all().filter((root) => root.worktree === undefined || kept.has(root.key));
  }

  private refreshScmRoots(): void {
    this.scm?.setProjects(this.scmRoots());
  }

  // Runs work on the repository of a root source control opens for the flow's length.
  private async withScmRoot<T>(key: string, work: (repoId: string) => Promise<T | undefined>): Promise<T | undefined> {
    this.pinnedScmRoots.add(key);
    this.refreshScmRoots();
    try {
      const repoId = await this.requireScm().rootRepositoryWhenReady(key);
      if (repoId === undefined) {
        void this.notifications.warn(this.requireLocalization().t('The worktree\'s repository could not be opened.'));
        return undefined;
      }
      return await work(repoId);
    } finally {
      this.pinnedScmRoots.delete(key);
      this.refreshScmRoots();
    }
  }

  // Slice 12's merge editor on the first conflicted file of the repository holding folder; Apply's conflicts take the
  // worktree branch's Incoming label.
  private async openWorktreeConflicts(folder: string, files: readonly string[], applyBranch?: string): Promise<void> {
    const live = this.worktreeRecords.liveChatRecordAt(folder);
    const key = live ? this.worktreeRootKey(live) : folderKey(folder);
    await this.withScmRoot(key, async (repoId) => {
      const scm = this.requireScm();
      if (applyBranch !== undefined) scm.deps.service.noteWorktreeConflicts(repoId, files, applyBranch);
      await scm.deps.service.currentStatus(repoId);
      const first = files[0];
      if (first !== undefined) await scm.runRequest({ op: 'openMergeEditor', repoId, path: first });
      return undefined;
    });
  }

  // Per worktree, the project's chats working in it and their latest activity, listed or loaded (the New menu's rows).
  private async worktreeChats(projectKey: string): Promise<Map<string, { count: number; lastActivity: number }>> {
    const rows = await this.core.read('Read Chat List', (core) => this.catalogList(core, projectKey));
    // only chats working there, as sharedWith counts them; a loaded chat's live state is newer than its file
    const chats = new Map<string, { worktreeId: string; lastActivity: number } | undefined>();
    for (const row of rows) if (row.worktree?.place === 'worktree') chats.set(row.id, { worktreeId: row.worktree.worktreeId, lastActivity: row.timestamp });
    for (const event of this.worktreeStates.values()) {
      const panel = this.panelOfCore(event.panelId);
      if (!panel || this.projectOf(panel) !== projectKey) continue;
      const id = this.chatIdOf(panel);
      const working = event.worktreeId !== undefined && event.state.place === 'worktree' && event.state.phase === 'ready';
      chats.set(id, working ? { worktreeId: event.worktreeId!, lastActivity: chats.get(id)?.lastActivity ?? 0 } : undefined);
    }
    const byWorktree = new Map<string, { count: number; lastActivity: number }>();
    for (const chat of chats.values()) {
      if (!chat) continue;
      const { worktreeId, lastActivity } = chat;
      const current = byWorktree.get(worktreeId);
      byWorktree.set(worktreeId, { count: (current?.count ?? 0) + 1, lastActivity: Math.max(current?.lastActivity ?? 0, lastActivity) });
    }
    return byWorktree;
  }

  // The sessions whose latest worktree entry names the worktree, stored or loaded.
  private async sessionsUsing(worktreeId: string): Promise<string[]> {
    const record = this.worktreeRecords.get(worktreeId);
    const ids = new Set<string>();
    if (record?.projectPath !== undefined) {
      const projectKey = folderKey(record.projectPath);
      const rows = await this.core.read('Read Chat List', (core) => this.catalogList(core, projectKey));
      for (const row of rows) if (row.worktree?.worktreeId === worktreeId) ids.add(row.id);
    }
    for (const event of this.worktreeStates.values()) if (event.worktreeId === worktreeId && event.sessionId !== undefined) ids.add(event.sessionId);
    return [...ids];
  }

  // Rule 14's first half for a chat worktree (close-worktree.ts): every question first, then what runs there stops.
  private closeWorktreeRoot(worktreeId: string, key: string, stop: () => Promise<boolean>): Promise<CloseOutcome> {
    const terminals = this.requireTerminals();
    return closeWorktreeRoot({
      editor: this.requireEditorPane(),
      terminals: { idsIn: (rootKey) => terminals.idsIn(rootKey), confirmKill: (ids) => terminals.confirmKill([...ids]), kill: (id) => terminals.kill(id) },
      closeChats: () => {
        const panels = [...this.worktreeStates.values()].filter((event) => event.worktreeId === worktreeId).flatMap((event) => this.panelOfCore(event.panelId) ?? []);
        for (const panel of panels) this.closeForWorktree(panel);
      },
      rootsChanged: () => this.worktreesChanged(),
      releaseFormatter: (rootKey) => this.formatterHosts?.release(rootKey) ?? Promise.resolve(),
      whenFolderReleased: async () => {
        const record = this.worktreeRecords.get(worktreeId);
        if (record) await this.client()?.whenFolderReleased(record.workingFolder);
      },
    }, key, stop);
  }

  // A chat closed for a worktree delete does not pull the selection elsewhere; the delete selects its project again after.
  private closeForWorktree(panel: DesktopPanel): void {
    this.closingForWorktree.add(panel);
    const corePanelId = this.corePanelIdOf(panel);
    if (corePanelId !== undefined) this.worktreeStates.delete(corePanelId);
    panel.close();
  }

  private worktreeClosed(worktreeId: string, removed: boolean): void {
    if (removed) {
      const record = this.worktreeRecords.get(worktreeId);
      if (record?.projectPath !== undefined) this.windowLayout.forgetRoot(rootKey({ projectKey: folderKey(record.projectPath), worktreeId }));
    }
    this.worktreesChanged();
    const projectPath = this.worktreeRecords.get(worktreeId)?.projectPath;
    if (this.views && !this.views.selected() && projectPath !== undefined) this.selectProject(folderKey(projectPath)).catch(this.report('Selecting a chat after a worktree delete'));
  }

  // Native, as every file picker is (D41); the editor confines the answer to an open project.
  private async pickSavePath(defaultPath: string): Promise<string | undefined> {
    const window = this.window;
    const options = { defaultPath, title: this.requireLocalization().t('Save As') };
    const result = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
    return result.canceled ? undefined : result.filePath;
  }

  private setGrid(grid: ShellGridLayout): void {
    const current = this.windowLayout.sidebar();
    this.windowLayout.setSidebar({ ...current, grid });
    this.shellStateChanged();
    if (current.grid.visible.terminal !== grid.visible.terminal) this.postTerminalShown();
  }

  private terminalToggle(): { shown: boolean; shortcut: string } {
    return { shown: this.windowLayout.sidebar().grid.visible.terminal, shortcut: shellShortcutLabels().toggleTerminal };
  }

  // Every loaded chat's header toggle follows the pane (core posts it as the terminal mirror changes); a chat view that loads
  // later gets it with its ready.
  private postTerminalShown(): void {
    this.core.started()?.terminalToggleChanged();
  }

  // A click shows or hides the pane; Ctrl+` also focuses a shown terminal that lacks focus, as VS Code's toggle does. Showing
  // starts a terminal when there is none and focuses it: both are user actions.
  private toggleTerminal(byKeyboard: boolean): void {
    const shown = this.windowLayout.sidebar().grid.visible.terminal;
    if (shown && (!byKeyboard || this.focusedPart() === 'terminal')) {
      this.toggleGridPane('terminal');
      return;
    }
    if (!shown) this.toggleGridPane('terminal');
    this.focusShownTerminal().catch(this.report('Toggle Terminal'));
  }

  // Once the shells are detected (VS Code's profilesReady) and the saved terminals restored, so a restored terminal is the
  // one focused rather than a new one started ahead of it; nothing when the pane was hidden meanwhile.
  private async focusShownTerminal(): Promise<void> {
    await Promise.all([this.profilesDetected, this.terminalsRestored]);
    if (!this.windowLayout.sidebar().grid.visible.terminal) return;
    const terminals = this.requireTerminals();
    const id = terminals.ensureTerminal();
    if (id !== undefined) terminals.focus(id);
  }

  // New Terminal: the overlay's quick pick of the detected shells, then the terminal in the shown pane, focused.
  private async newTerminal(): Promise<void> {
    await this.profilesDetected;
    const overlay = this.overlay;
    const terminals = this.requireTerminals();
    if (!overlay) return;
    const pick = await pickNewTerminal(overlay, terminals.profileOptions(), terminals.projectOptions(), webContents.getFocusedWebContents() ?? undefined);
    if (!pick) return;
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
    const created = terminals.create(pick, true);
    if (!created.ok) log(`[terminal] New Terminal refused: ${created.reason}`);
  }

  // A terminal link click: resolved again here, then a file opens in the editor (focused, a user's action) and a folder in Files.
  private async openTerminalLink(request: TerminalOpenLink): Promise<void> {
    const base = this.requireTerminals().linkBase(request.id);
    if (!base) return;
    const link = await this.terminalLinks.resolveFresh(request.path, base);
    if (!link) return;
    if (link.kind === 'folder') {
      const action = folderLinkAction(base.project, link.relativePath, this.currentProjectKey());
      if (action.kind === 'reveal') this.shell?.revealInFiles(action.file);
      else await this.openQuickOpen('files', action.scope);
      return;
    }
    const opened = await this.requireEditorPane().openFromUser(base.project.key, link.relativePath, {
      ...(request.line !== null ? { line: request.line } : {}),
      ...(request.column !== null ? { column: request.column } : {}),
    });
    if (!opened.ok) log(`[terminal] a link did not open: ${opened.reason}`);
  }

  private async pickTerminalIcon(id: string): Promise<void> {
    const overlay = this.overlay;
    const appearance = this.requireTerminals().appearance(id);
    if (!overlay || !appearance) return;
    const t = (message: string): string => this.requirePlatform().localization.t(message);
    const icons: Record<TerminalCustomIcon, string> = {
      'terminal': t('Terminal'),
      'square-terminal': t('Console'),
      'code': t('Code'),
      'bug': t('Bug'),
      'rocket': t('Rocket'),
      'server': t('Server'),
      'database': t('Database'),
      'cloud': t('Cloud'),
      'container': t('Container'),
      'package': t('Package'),
      'git-branch': t('Branch'),
      'globe': t('Globe'),
      'cpu': t('Processor'),
      'monitor': t('Monitor'),
      'flask-conical': t('Flask'),
      'activity': t('Activity'),
      'gauge': t('Gauge'),
      'zap': t('Lightning'),
      'flame': t('Flame'),
      'sparkles': t('Sparkles'),
      'star': t('Star'),
      'heart': t('Heart'),
      'wrench': t('Wrench'),
      'bot': t('Bot'),
    };
    const labels = { placeholder: t('Select an icon for the terminal'), profileIcon: t('Default'), icons };
    const picked = await pickTerminalIcon(overlay, appearance, labels, webContents.getFocusedWebContents() ?? undefined);
    if (picked) this.requireTerminals().setCustomIcon(id, picked.customIcon);
  }

  private async pickTerminalColor(id: string): Promise<void> {
    const overlay = this.overlay;
    const appearance = this.requireTerminals().appearance(id);
    if (!overlay || !appearance) return;
    const t = (message: string): string => this.requirePlatform().localization.t(message);
    const colors: Record<TerminalColor, string> = {
      black: t('Black'),
      red: t('Red'),
      green: t('Green'),
      yellow: t('Yellow'),
      blue: t('Blue'),
      magenta: t('Magenta'),
      cyan: t('Cyan'),
      white: t('White'),
    };
    const picked = await pickTerminalColor(overlay, appearance, { placeholder: t('Select a color for the terminal'), noColor: t('No color'), colors }, webContents.getFocusedWebContents() ?? undefined);
    if (picked) this.requireTerminals().setColor(id, picked.color);
  }

  // The choice comes from main's own list of detected profiles; core's settings store writes it at user scope.
  private async selectDefaultTerminalProfile(): Promise<void> {
    const overlay = this.overlay;
    if (!overlay) return;
    const platform = this.requirePlatform();
    const profileId = await pickDefaultProfile(overlay, this.requireTerminals().profileOptions(), platform.localization.t('Select your default terminal profile'), webContents.getFocusedWebContents() ?? undefined);
    if (profileId !== undefined) await writeDesktopSetting(platform.settings, TERMINAL_DEFAULT_PROFILE_SETTING, profileId);
  }

  private showTerminalPane(): void {
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
  }

  // Settings › Terminal: the listed profiles, the detected ones a null entry hides, and the entries main refused.
  private terminalProfileReport(): TerminalProfileReport {
    const catalog = this.terminalProfiles;
    return { profiles: this.requireTerminals().profileOptions(), hidden: [...(catalog?.hidden() ?? [])], problems: [...(catalog?.problems() ?? [])] };
  }

  // Focus Next or Previous Terminal: the terminal pane shows, and the terminal takes keyboard focus.
  private focusRelativeTerminal(delta: 1 | -1): void {
    const terminals = this.requireTerminals();
    const id = terminals.relative(delta);
    if (id === undefined) return;
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
    terminals.select(id);
    terminals.focus(id);
  }

  // The palette's Rename...: the shell renames the active terminal in place.
  private renameActiveTerminal(): void {
    const id = this.requireTerminals().activeTerminal();
    if (id === null) return;
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
    this.shell?.startTerminalRename(id);
  }

  // The palette's Copy Last Command, Copy Last Command Output, Add to Chat and Scroll to Previous or Next Command: the shell
  // carries them out on the active terminal's buffer, which takes keyboard focus (a user action).
  private runTerminalAction(action: TerminalAction): void {
    const id = this.requireTerminals().activeTerminal();
    if (id === null) return;
    if (!this.windowLayout.sidebar().grid.visible.terminal) this.toggleGridPane('terminal');
    this.shell?.runTerminalAction(id, action);
  }

  // G25: the shell's selection or a command's output becomes a pending attachment of the current chat, labelled from main's own
  // facts and bounded again here.
  private async addTerminalOutputToChat(request: TerminalAddToChat): Promise<void> {
    const terminals = this.requireTerminals();
    const title = terminals.titleOf(request.id);
    const projectKey = terminals.state().terminals.find((terminal) => terminal.id === request.id)?.projectKey;
    if (title === undefined || projectKey === undefined) return;
    const facts = request.commandId === null ? undefined : terminals.commandFacts(request.id, request.commandId);
    const capped = capTerminalText(request.text);
    const attachment = {
      kind: 'terminal' as const,
      source: request.source,
      commandLine: facts && facts.commandLine !== '' ? facts.commandLine : null,
      exitCode: facts?.exitCode ?? null,
      terminalTitle: title,
      text: capped.text,
      omittedLines: Math.min(request.omittedLines + capped.omittedLines, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES),
    };
    await this.addAttachmentToChat(projectKey, attachment, this.requireLocalization().t('The chat could not be loaded, so the terminal output was not added to it.'));
  }

  // Add to Chat from a terminal or the Graph: a pending attachment of the current chat (the selected one, else a new chat in
  // the project of root, a project key or a chat worktree's root key, or the default target for none); prompt, when given, joins
  // the composer's draft. The composer takes focus, as the user asked. notLoaded: the warning when the chat could not be loaded.
  private async addAttachmentToChat(root: string | null, attachment: ChatAttachmentInput, notLoaded: string, prompt?: string): Promise<void> {
    const projectKey = root === null ? undefined : parseRootKey(root)?.projectKey;
    await this.core.run('Add to Chat', async (core) => {
      if (!this.views?.selected()) await this.newChatIn(core, projectKey !== undefined && this.isKnownProject(projectKey, core) ? projectKey : undefined);
      const panel = this.views?.selected();
      // A chat still restoring is the chat the attachment goes to, once core registered it.
      const restored = panel ? await this.restoredCorePanel(panel) : undefined;
      const corePanelId = restored?.corePanelId;
      if (restored?.failed) {
        void this.requirePlatform().notifications.warn(notLoaded);
        return;
      }
      if (!panel || corePanelId === undefined || !(await this.entryActionDeps.whenReady(panel)) || this.views?.selected() !== panel) {
        log(`[${attachment.kind}] Add to Chat: the chat closed before it was ready`);
        return;
      }
      if (!(await core.client.addAttachment(corePanelId, attachment, prompt))) return;
      this.views?.focusChat();
    });
  }

  // Edit › Paste and Cmd+V: a terminal whose xterm has keyboard focus pastes through main; anything else (a terminal's Find box
  // or rename field included) gets what the paste roles do, which on macOS also reaches native dialogs' text fields.
  private paste(matchStyle: boolean): void {
    const id = this.terminals?.activeTerminal() ?? null;
    if (id !== null && this.terminalInputHasFocus()) {
      this.terminalPaste.allow('clipboard');
      this.shell?.requestTerminalPaste(id);
      return;
    }
    if (process.platform === 'darwin') {
      Menu.sendActionToFirstResponder(matchStyle ? 'pasteAndMatchStyle:' : 'paste:');
      return;
    }
    webContents.getFocusedWebContents()?.paste();
  }

  private layoutMove(pane: GridPane, slot: GridSlot): void {
    this.setGrid(moveGridPane(this.windowLayout.sidebar().grid, pane, slot));
  }

  // Hiding the editor while it, or its page tab's view, holds focus gives focus to the chat.
  private toggleGridPane(pane: 'editor' | 'terminal'): void {
    const grid = this.windowLayout.sidebar().grid;
    const next = toggleGridPane(grid, pane);
    const focused = this.focusedPart() === pane;
    this.setGrid(next);
    if (!next.visible[pane] && focused) this.views?.focusChat();
  }

  private async openQuickOpen(mode: QuickOpenMode, scope?: QuickOpenScope): Promise<void> {
    const picker = this.quickOpenPicker;
    if (!picker) return;
    const outcome = await picker.show(webContents.getFocusedWebContents() ?? undefined, mode, scope);
    if (!outcome) return;
    // The overlay has hidden and given focus back, so the command acts where the user was.
    if (outcome.kind === 'command') {
      this.requirePalette().run(outcome.id, outcome.context);
      return;
    }
    const pick = outcome.pick;
    if (pick.mention) {
      await this.mentionInSelectedChat({ projectKey: pick.projectKey, relativePath: pick.relativePath });
      return;
    }
    const opened = await this.requireEditorPane().openFromUser(pick.projectKey, pick.relativePath, pick.line !== undefined ? { line: pick.line } : {});
    if (!opened.ok) void this.requirePlatform().notifications.warn(this.requireLocalization().t('{0} could not be opened.', pick.relativePath));
  }

  // Files' and Source Control's Mention in chat, the editor's mention button and Quick Open's @ mention in the selected chat.
  // A chat still restoring is the chat the file goes to, once core registered it.
  private async mentionInSelectedChat(target: MentionTarget): Promise<void> {
    await this.core.run('Mention', async (core) => {
      const selected = this.views?.selected();
      const restored = selected ? await this.restoredCorePanel(selected) : undefined;
      const corePanelId = restored?.corePanelId;
      // A chat page drops a message core posts before it is ready.
      if (!selected || corePanelId === undefined || !(await this.entryActionDeps.whenReady(selected))) {
        const { t } = this.requireLocalization();
        void this.requirePlatform().notifications.warn(restored?.failed ? t('The chat could not be loaded, so the file was not mentioned in it.') : t('Open a chat to mention a file in it.'));
        return;
      }
      await core.client.mention(corePanelId, target);
    });
  }

  private openLogTab(filePath: string, preserveFocus: boolean): void {
    this.editorPane?.openLog(filePath, !preserveFocus).catch(this.report('Show Log'));
  }

  private notificationsChanged(): void {
    this.taskbar.update(this.notificationCenter.bell().unseen);
    this.shellStateChanged();
    if (this.overlay?.isOpen('notifications')) this.overlay.send(OVERLAY_CHANNELS.notificationsState, this.notificationCenter.state());
  }

  // The chat the user is looking at: the selected one, while the window has focus (D52's read rule).
  private viewedChat(): ChatKey | undefined {
    const selected = this.views?.selected();
    if (!selected || !this.window || this.window.isDestroyed() || !this.window.isFocused()) return undefined;
    const sessionId = this.sessionIdOf(selected);
    return { panelId: selected.panelId, ...(sessionId !== undefined ? { sessionId } : {}) };
  }

  private notificationProject(key: string): NotificationProject {
    const folder = this.projects.folders().find((candidate) => folderKey(candidate.fsPath) === key);
    const name = this.client()?.resolve(key)?.label ?? folder?.name;
    return { key, name: name ?? path.basename(key) };
  }

  // The chat a notification is about, with a title from the catalog when main has not read one yet.
  private async describeChat(corePanelId: string): Promise<ChatRef | undefined> {
    const panel = this.panelOfCore(corePanelId);
    const projectKey = panel ? this.projectOf(panel) : undefined;
    if (!panel || projectKey === undefined) return undefined;
    const sessionId = this.sessionIdOf(panel);
    if (sessionId !== undefined && this.titleOf(panel) === '') {
      await this.core.read('Read Chat List', (core) => this.catalogList(core, projectKey)).catch(this.report('Reading the chat list'));
    }
    return {
      panelId: panel.panelId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      project: this.notificationProject(projectKey),
      title: this.titleOf(panel),
    };
  }

  // Selecting shows the chat, and core posts panelFocused (which focuses the composer) inside that show, so a message an
  // entry's action posts reaches the chat after it.
  private readonly entryActionDeps: EntryActionDeps<DesktopPanel> = {
    selected: () => this.views?.selected(),
    // A refusal (another process's lease, a deleted chat) shows its toast.
    select: async (chat: ChatRef) => {
      const views = this.views;
      if (!views) return undefined;
      const loaded = views.panel(chat.panelId);
      const chatId = loaded && views.chats().includes(loaded) ? this.chatIdOf(loaded) : chat.sessionId ?? `${NEW_CHAT_ID_PREFIX}${chat.panelId}`;
      const result = await this.selectChat(chatId);
      return result.ok ? this.loadedChat(chatId) : undefined;
    },
    // AD11: a message for a chat's UI goes out once that chat's view is ready, so a chat that just loaded never drops it.
    whenReady: async (panel) => {
      const corePanelId = this.corePanelIdOf(panel);
      const client = this.client();
      if (!client || corePanelId === undefined) {
        log('[notifications] the chat is not ready for its action');
        return false;
      }
      return client.whenReady(corePanelId);
    },
    post: (panel, message) => {
      const corePanelId = this.corePanelIdOf(panel);
      if (corePanelId !== undefined) this.client()?.post(corePanelId, message).catch(this.report('Posting to a chat'));
    },
  };

  private shellState(views: PanelViews): Omit<ShellState, 'revision'> {
    const client = this.client();
    const defaultKey = client?.defaultTarget()?.key;
    const counts = new Map<string, { running: number; waiting: number }>();
    for (const chat of views.chats()) {
      const key = this.projectOf(chat);
      if (key === undefined) continue;
      const status = statusOf(this.activityOf(chat));
      const count = counts.get(key) ?? { running: 0, waiting: 0 };
      if (status === 'running') count.running++;
      if (status === 'waiting') count.waiting++;
      counts.set(key, count);
    }
    const projects = this.projects.folders().map((folder): ShellProject => {
      const key = folderKey(folder.fsPath);
      const branch = client?.branchOf(key);
      const worktreeOf = this.adoptedProjectName(key);
      return {
        key,
        name: client?.resolve(key)?.label ?? folder.name,
        fsPath: folder.fsPath,
        trusted: this.trust.isTrusted(folder.fsPath),
        ...(branch !== undefined ? { branch } : {}),
        ...(worktreeOf !== undefined ? { worktreeOf } : {}),
        running: counts.get(key)?.running ?? 0,
        waiting: counts.get(key)?.waiting ?? 0,
      };
    });
    const selected = views.selected();
    const selectedId = selected ? this.chatIdOf(selected) : undefined;
    const projectKey = this.selectedProjectKey ?? defaultKey;
    return {
      locale: this.requireLocalization().language,
      platform: shellPlatform(process.platform),
      windowState: windowStateOf(this.window),
      projects,
      selected: { ...(projectKey !== undefined ? { projectKey } : {}), ...(selectedId !== undefined ? { chatId: selectedId } : {}) },
      ...(selected && selectedId !== undefined ? { selectedChat: { id: selectedId, title: this.titleOf(selected), status: statusOf(this.activityOf(selected)) } } : {}),
      effectiveTheme: currentThemeKind(),
      layout: this.windowLayout.sidebar(),
      layoutRevision: this.layoutRevision,
      shortcuts: shellShortcutLabels(),
      notifications: this.notificationCenter.bell(),
      engineHalted: this.core.halted(),
      search: shellSearchSettings(this.requirePlatform().settings),
      shownFolders: this.shownFolders.all(),
      sidebar: { alwaysShowHeaderActions: this.requirePlatform().settings.get<unknown>(SIDEBAR_ALWAYS_SHOW_HEADER_ACTIONS_SETTING) === true },
    };
  }

  private titleOf(panel: DesktopPanel): string {
    const sessionId = this.sessionIdOf(panel);
    const projectKey = this.projectOf(panel);
    if (sessionId === undefined || projectKey === undefined) return '';
    const row = this.catalogRows.get(projectKey)?.find((session) => session.id === sessionId);
    return row ? storedTitle(row) : '';
  }

  private shellStateChanged(): void {
    this.shell?.stateChanged();
    this.updateWindowTitle();
  }

  // undefined: every project's list. With no core (a reload or quit tore it down), or while a closing window or core closes
  // the chats with their states kept, there is no list to fetch; the chats announce themselves again as they reopen.
  private chatsChanged(projectKey?: string): void {
    const shell = this.shell;
    if (!shell || !this.core.current() || this.views?.retainingStates) return;
    if (projectKey !== undefined) {
      shell.chatsChanged(projectKey);
      return;
    }
    for (const folder of this.projects.folders()) shell.chatsChanged(folderKey(folder.fsPath));
    const defaultKey = this.client()?.defaultTarget()?.key;
    if (defaultKey !== undefined) shell.chatsChanged(defaultKey);
  }

  // A folder switch moves the selected chat, and so does its folder leaving the project list; the selection follows it.
  private followSelectedChat(): void {
    const selected = this.views?.selected();
    if (selected && this.projectOf(selected) !== this.selectedProjectKey) this.selectionChanged(selected);
  }

  private viewsChanged(): void {
    this.chatFoldersChanged.fire();
    this.overlaySettings?.selectionChanged();
    this.followSelectedChat();
    this.shellStateChanged();
    this.refreshMenuState();
    this.scheduleRetention();
  }

  private updateWindowTitle(): void {
    const selected = this.views?.selected();
    if (!selected || !this.window || this.window.isDestroyed()) return;
    const title = this.titleOf(selected);
    this.window.setTitle(title ? `${title} - Damocles` : 'Damocles');
  }

  // The main window's child view that shows `contents`; the window's own page is not a child view.
  private windowView(contents: WebContents): WebContentsView | undefined {
    const window = this.window;
    if (!window || window.isDestroyed()) return undefined;
    return window.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView && child.webContents === contents);
  }

  private focusedPart(): FocusPart | undefined {
    const views = this.views;
    if (!views) return undefined;
    if (this.notifier.focused) return 'toasts';
    if (this.browserTabs?.focused()) return 'editor';
    if (views.chatFocused()) return 'chat';
    return this.shell?.focused ? (this.shellFocusedPart ?? undefined) : undefined;
  }

  private menuState(): MenuState {
    return {
      chat: this.views?.selected() !== undefined,
      editor: this.editorPane?.hasTabs() === true,
      browser: this.browserEnabled(),
      page: this.browserTabs?.activePage() !== undefined,
      focus: this.focusedPart(),
      updateCheck: this.updates !== undefined && canCheck(this.updates.snapshot().state),
      terminalCreate: this.terminals?.canCreate() === true,
      terminal: this.terminals?.activeStatus(),
      terminalSplit: this.terminals?.splitActive() === true,
      terminalInput: this.terminalInputHasFocus(),
      search: this.searchMenuState(),
      scm: this.scm?.menuState() ?? NO_SCM_MENU_STATE,
      editorKind: this.editorPane?.activeKind(),
      editorGit: this.editorPane?.activeGit() ?? null,
      selectedChatHasChanges: this.chatReviews.hasChanges(this.selectedCorePanelId()),
      ...this.selectedWorktreeMenuState(),
    };
  }

  // D33's and D61's enablement from the selected chat's last worktree state.
  private selectedWorktreeMenuState(): Pick<MenuState, 'worktree' | 'handOff' | 'newChatInWorktree'> {
    const selected = this.views?.selected();
    const event = selected ? this.worktreeEventOf(selected) : undefined;
    const record = event?.worktreeId !== undefined ? this.worktreeRecords.get(event.worktreeId) : undefined;
    const live = record?.kind === 'chat' && record.deletedAt === undefined ? record : undefined;
    const working = event?.state.phase === 'ready' && event.state.place === 'worktree';
    return {
      worktree: live ? { finish: this.finishStateOf(live), ...(event?.state.baseBranch !== undefined ? { baseBranch: event.state.baseBranch } : {}) } : undefined,
      handOff: event && event.state.phase !== 'deleted' ? { canHandOff: event.state.canHandOff, place: event.state.place } : undefined,
      newChatInWorktree: working ? this.newChatInTarget(live) : undefined,
    };
  }

  // The selected chat's core panel id; undefined while no chat is selected or loaded.
  private selectedCorePanelId(): string | undefined {
    const selected = this.views?.selected();
    return selected ? this.corePanelIdOf(selected) : undefined;
  }

  // EditorService.showChatReview and Chat: Review Changes: the chat's review tab in the editor pane, which shows.
  private async showChatReview(panelId: string, scope: ChatReviewScope): Promise<void> {
    await this.chatReviews.show(panelId, scope);
  }

  // Search's enablement context, from main's search service, editor pane and layout.
  private searchMenuState(): MenuState['search'] {
    const layout = this.windowLayout.sidebar();
    const viewVisible = layout.sidebarVisible && !layout.sections.search.collapsed;
    return this.search?.menuState(viewVisible) ?? { editorActive: false, viewHasSearch: false, viewHasResults: false, viewRunning: false, viewVisible };
  }

  private refreshMenuState(): void {
    if (this.platform) updateMenuState(this.menuState());
  }

  // F6 and Shift+F6 move keyboard focus through the sidebar, the editor, the chat and the desktop popups while each is shown,
  // as VS Code's Focus Next Part does; Tab cannot leave a WebContents. A page tab's view is reached through the editor part.
  private focusPart(delta: 1 | -1): void {
    const views = this.views;
    if (!views || !this.shell) return;
    const parts: FocusPart[] = [];
    if (this.windowLayout.sidebar().sidebarVisible) parts.push('sidebar');
    if (this.windowLayout.sidebar().grid.visible.editor && this.editorPane?.hasTabs()) parts.push('editor');
    if (views.selected()) parts.push('chat');
    if (this.windowLayout.sidebar().grid.visible.terminal && this.terminals?.hasTerminals()) parts.push('terminal');
    if (this.notifier.showing) parts.push('toasts');
    if (parts.length === 0) return;
    const current = this.focusedPart();
    const index = current === undefined ? (delta === 1 ? -1 : 0) : parts.indexOf(current);
    const next = parts[(index + delta + parts.length) % parts.length]!;
    if (next === 'toasts' && current !== 'toasts') this.toastFocusOrigin = current ?? 'chat';
    if (current === 'toasts' && next !== 'toasts') this.leavePopupsFor(next);
    else this.focusOn(next);
  }

  // Escape in the popups, or their last card going while they hold focus, gives focus back to the part F6 took it from;
  // popups focused by a click, or left for another window, leave focus where the OS puts it.
  private leavePopups(): void {
    const origin = this.toastFocusOrigin;
    this.toastFocusOrigin = undefined;
    if (origin !== undefined) this.leavePopupsFor(origin);
  }

  // Except on macOS, Electron focuses the window's own page as the window gains focus, and X11 activates the window only
  // after focus() returns; a part focused before that activation lands would lose focus to the shell.
  private leavePopupsFor(part: FocusPart): void {
    this.showWindow();
    if (this.window?.isFocused()) this.focusOn(part);
    else this.focusOnActivation = part;
  }

  // A part that is no longer shown, or an overlay with no popup open, falls back to the selected chat, and with none
  // selected to the window's own page.
  private focusOn(part: FocusPart | 'overlay'): void {
    this.focusOnActivation = undefined;
    const views = this.views;
    if (!views) return;
    if (part === 'overlay' && this.overlay?.mode === 'full') this.overlay.focus();
    else if (part === 'toasts') this.notifier.focusToasts();
    else if (part === 'sidebar' && this.windowLayout.sidebar().sidebarVisible) this.shell?.focusPart('sidebar');
    else if ((part === 'editor' || part === 'terminal') && this.windowLayout.sidebar().grid.visible[part]) this.shell?.focusPart(part);
    else if (views.selected()) views.focusChat();
    else this.window?.webContents.focus();
  }

  // Each call that turns a reason on flashes again; the flash stops once no reason is left.
  private flash(reason: 'notifications' | 'overlay', on: boolean): void {
    if (on) this.flashReasons.add(reason);
    else if (!this.flashReasons.delete(reason) || this.flashReasons.size > 0) return;
    if (this.window && !this.window.isDestroyed()) this.window.flashFrame(on);
  }

  private readonly chatTabs: ChatTabMessenger = {
    deliver: (panelId, message) => {
      const views = this.requireViews();
      return this.requireCore().client.deliver(panelId, views.selected()?.panelId, views.chats().map((chat) => chat.panelId), message);
    },
    post: (panelId, message) => {
      this.client()?.post(panelId, message).catch(this.report('Posting to a chat'));
    },
  };

  private installMenu(): void {
    installApplicationMenu(this.projects.folders(), this.menuActions(), this.requirePlatform().localization, this.menuState());
  }

  private menuActions(): MenuActions {
    const platform = this.requirePlatform();
    const report = (action: string) => this.report(action);
    return {
      scmRun: (request) => this.scm?.paletteRun(request),
      scmActiveFile: (op) => this.scm?.activeFile(op),
      scmCommit: (variant) => this.scm?.paletteCommit(variant),
      editorCommand: (command) => this.editorPane?.command(command),
      toggleInlineBlame: () => {
        const settings = this.requirePlatform().settings;
        const shown = settings.get<unknown>(GIT_BLAME_EDITOR_DECORATION_SETTING) !== false;
        settings.update(GIT_BLAME_EDITOR_DECORATION_SETTING, !shown, 'user').catch(report('Toggle Inline Blame'));
      },
      reviewChatChanges: () => {
        const panelId = this.selectedCorePanelId();
        if (panelId !== undefined) this.showChatReview(panelId, 'chat').catch(report('Review Changes'));
      },
      // core checks again that the chat is idle before it moves anything (D61)
      handOff: (to) => {
        const panelId = this.selectedCorePanelId();
        if (panelId !== undefined) this.core.run('Hand Off', (core) => core.client.handOff(panelId, to)).catch(report('Hand Off'));
      },
      worktreeFinish: (action: WorktreeFinishAction) => {
        const selected = this.views?.selected();
        const worktreeId = selected ? this.worktreeEventOf(selected)?.worktreeId : undefined;
        if (worktreeId !== undefined) this.requireWorktrees().finish(worktreeId, action).catch(report('Worktree'));
      },
      addProject: () => { this.addProject().catch(report('Add Project')); },
      newChat: () => { this.newChat(undefined).catch(report('New Chat')); },
      newChatInWorktree: (target) => { this.newChatInWorktree(target).catch(this.newChatInWorktreeFailure()); },
      openChat: () => { this.core.run('Open Chat', (core) => core.client.openChat()).catch(report('Open Chat')); },
      openChatForProject: (fsPath) => { this.newChat(folderKey(fsPath)).catch(report('Open Chat in Project')); },
      newSession: () => { this.core.run('New Session', (core) => core.client.newSession()).catch(report('New Session')); },
      cancelSession: () => { this.core.run('Cancel Session', (core) => core.client.cancelSession()).catch(report('Cancel Session')); },
      quickOpen: () => { this.openQuickOpen('files').catch(report('Quick Open')); },
      showCommands: () => { this.openQuickOpen('commands').catch(report('Command Palette')); },
      searchInFiles: (replace) => this.requireSearch().searchInFiles(replace),
      searchViewCommand: (command) => this.requireSearch().viewCommand(command),
      searchEditorCommand: (command) => this.requireSearch().editorCommand(command),
      cancelSearch: () => this.requireSearch().cancel(),
      clearSearchHistory: () => this.requireSearch().clearSearchHistory(),
      toggleSearchOnType: () => { this.requireSearch().toggleSearchOnType().catch(report('Toggle Search on Type')); },
      newSearchEditor: () => this.requireSearch().newSearchEditor(),
      openSearchEditor: () => this.requireSearch().openSearchEditor(),
      openResultsInEditor: () => this.requireSearch().openResultsInEditor(),
      runChatCommand: (command) => this.runChatCommand(command),
      saveEditor: () => this.editorPane?.command('save'),
      saveEditorAs: () => this.editorPane?.command('saveAs'),
      formatDocument: () => this.editorPane?.command('formatDocument'),
      closeEditor: () => this.editorPane?.command('close'),
      cycleEditor: (delta) => this.editorPane?.cycle(delta),
      relativeByKeyboard: (delta) => {
        if (this.focusedPart() === 'editor' && this.editorPane?.hasTabs()) this.editorPane.cycle(delta);
        else this.selectRelativeChat(delta).catch(report('Select Chat'));
      },
      toggleEditor: () => this.toggleGridPane('editor'),
      toggleTerminal: (byKeyboard) => this.toggleTerminal(byKeyboard),
      newTerminal: () => { this.newTerminal().catch(report('New Terminal')); },
      killTerminal: () => {
        const id = this.terminals?.activeTerminal();
        if (id) this.terminals?.requestKill([id]).catch(report('Kill Terminal'));
      },
      restartTerminal: () => {
        const id = this.terminals?.activeTerminal();
        if (id) this.terminals?.restart(id).catch(report('Restart Terminal'));
      },
      killAllTerminals: () => {
        const terminals = this.terminals;
        terminals?.requestKill(terminals.ids()).catch(report('Kill All Terminals'));
      },
      runTerminalAction: (action) => this.runTerminalAction(action),
      focusRelativeTerminal: (delta) => this.focusRelativeTerminal(delta),
      splitTerminal: () => {
        const id = this.terminals?.activeTerminal();
        if (!id) return;
        this.showTerminalPane();
        this.terminals?.split(id).catch(report('Split Terminal'));
      },
      unsplitTerminal: () => {
        const id = this.terminals?.activeTerminal();
        if (id) this.terminals?.unsplit(id);
      },
      focusTerminalPane: (delta) => {
        if (!this.terminals?.activeTerminal()) return;
        this.showTerminalPane();
        this.terminals.focusPane(delta);
      },
      resizeTerminalPane: (direction) => {
        const id = this.terminals?.activeTerminal();
        // VS Code's resizePane does nothing for a group of one pane
        if (id && this.terminals?.splitActive()) this.shell?.runTerminalAction(id, direction === 'left' ? 'resizePaneLeft' : 'resizePaneRight');
      },
      renameTerminal: () => this.renameActiveTerminal(),
      changeTerminalIcon: () => {
        const id = this.terminals?.activeTerminal();
        if (id) this.pickTerminalIcon(id).catch(report('Change Icon'));
      },
      changeTerminalColor: () => {
        const id = this.terminals?.activeTerminal();
        if (id) this.pickTerminalColor(id).catch(report('Change Color'));
      },
      selectDefaultTerminalProfile: () => { this.selectDefaultTerminalProfile().catch(report('Select Default Profile')); },
      paste: (matchStyle) => this.paste(matchStyle),
      toggleSidebar: () => this.toggleSidebar(),
      openSettings: () => this.openSettings({}),
      selectRelativeChat: (delta) => { this.selectRelativeChat(delta).catch(report('Select Chat')); },
      focusPart: (delta) => this.focusPart(delta),
      togglePromptNavigator: () => {
        if (this.views?.selected()) this.core.run('Toggle Prompt Navigator', (core) => core.client.postToActive({ type: 'togglePromptNavigator' })).catch(report('Toggle Prompt Navigator'));
      },
      newBrowserPage: () => { this.browserTabs?.newPage().catch(report('New Browser Page')); },
      toggleBrowserDevTools: () => this.browserTabs?.activePage()?.deliver({ type: 'openDevTools' }),
      showLog: () => showLog(),
      restartEngine: () => this.restartEngine(),
      about: () => this.openSettings({ section: 'about' }),
      releaseNotes: () => this.openSettings({ section: 'about', release: platform.appInfo.version }),
      checkForUpdates: () => this.requireUpdates().check('help'),
    };
  }

  // A close or quit asks about running terminals (G22), then releases the editors (AD5); true when it may go on. The
  // terminals' answer holds until the editors cancel, so the window's own close event does not ask twice. Callers go
  // through lifecycle.release, which shares one question among every close and quit.
  private async releaseForClose(): Promise<boolean> {
    const terminals = this.terminals;
    if (!this.terminalsReleased) this.terminalsReleased = !terminals || (await terminals.confirmKill(terminals.ids()));
    if (!this.terminalsReleased) return false;
    let released = false;
    try {
      released = await (this.editorPane?.release() ?? Promise.resolve(true));
    } finally {
      if (!released) this.terminalsReleased = false;
    }
    return released;
  }

  // The extension's deactivate chain (session metadata index close, lease release, sentinels, stores), after the window closed.
  private async disposeAll(): Promise<void> {
    // Before the window closes, so its requests waiting on a reload settle and the window's close is not held up.
    this.core.stop();
    this.views?.retainStatesOnClose(true);
    await shutDown({
      // The window's own close handler saves its placement, seals the stores and closes the chats with their states kept.
      closeWindows: () => {
        this.window?.close();
        return this.windowClosed;
      },
      // core's own shutdown waits for its worktree temp folders (git apply must finish), within CLOSE_TIMEOUT_MS
      disposeCore: () => this.core.dispose(),
      // The stores last: closing the chats can still change their saved state, and core writes the others.
      flushStores: () => this.flushStores(),
      disposeTerminals: async () => this.terminals?.dispose(),
      closeWatchers: async () => this.platform?.fileWatchers.close(),
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      timeoutMs: DISPOSE_TIMEOUT_MS,
      log: (line) => log(line),
    });
    for (const disposable of this.disposables.reverse()) disposable.dispose();
    this.notificationCenter.dispose();
    this.taskbar.dispose();
    this.notifier.dispose();
    this.tray?.dispose();
    this.tray = undefined;
    this.platform?.settings.dispose();
    await this.launcher?.dispose();
  }

  // Every store under userData, the settings files and every other config file main writes (a settings file editor save);
  // each flush also waits for a write queued while it runs. Core settles its own writes in core.shutdown.
  private async flushStores(): Promise<void> {
    await this.beforeStoreFlush();
    await Promise.all([
      this.states.flush(),
      this.windowLayout.flush(),
      this.projects.flush(),
      this.trust.flush(),
      this.usageWarnings.flush(),
      this.state.flush(),
      this.platform?.flush(),
      allJsonConfigWritesSettled(),
      // the quit's last lines, will-quit included, then land in order
      this.logSinks.endAsyncWrites(),
    ]);
  }
}

// Before anything reads a path: the name decides the default userData folder.
app.setName(APP_NAME);
const userDataDir = parseUserDataDir(process.argv);
if (userDataDir !== undefined) app.setPath('userData', path.resolve(userDataDir));
app.setAppUserModelId(APP_ID);
app.enableSandbox();
registerAppScheme();
// Every view sets spellcheck: false, yet on Linux a session still fetches a Hunspell dictionary from Google for each of its
// languages as soon as it exists, so each session is given none as it is created.
app.on('session-created', (created) => {
  created.setSpellCheckerEnabled(false);
  created.setSpellCheckerLanguages([]);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Reading the stores can fail (EACCES on userData), which must end in the same dialog as a failed start.
  const failed = (err: unknown): void => {
    const message = errorText(err);
    log(`[startup] failed: ${message}`);
    dialog.showErrorBox('Damocles failed to start', message);
    app.exit(1);
  };
  try {
    new DesktopApp().start().catch(failed);
  } catch (err) {
    failed(err);
  }
}
