import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, clipboard, dialog, Menu, powerMonitor, screen, session, shell as electronShell, webContents, WebContentsView, type WebContents } from 'electron';
import { installLogSink, log, showLog } from '../../core/logger';
import { getRipgrepSearchOptions, resolveRgPath } from '../../core/chat-panel/ripgrep';
import { locateSettingsFile, saveSettingsFileText } from '../../core/chat-panel/settings-file-editor';
import type { MentionTarget } from '../../core/chat-panel/mention-resolver';
import { installPlatform } from '../../core/platform-host';
import type { ChatActivity } from '../../core/pi-session/session-state';
import { restoredWorkspaceFolderKey } from '../../core/chat-panel/panel-manager';
import { LANGUAGE_PREFERENCE_KEY } from '../../core/chat-panel/message-router/index';
import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import { announceLeaseRefusal, leaseRefusalFor } from '../../core/chat-panel/session-ownership';
import type { HostInstance } from '../../core/chat-panel/types';
import { flushCoreWrites } from '../../core/chat-panel';
import { runLegacySettingsMigrations } from '../../core/config/legacy-settings-migrations';
import { setCheckpointGitAvailability } from '../../core/pi-session/checkpoints';
import { setExploreApiKey } from '../../core/pi-session/explore-api-key';
import { DAMOCLES_HOME_DIR } from '../../core/paths';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { settingsFolderOf } from '../../core/workspace-folders/folder-registry';
import type { Disposable } from '../../platform/disposable';
import type { PanelOptions } from '../../platform/window-service';
import type { StoredSession } from '../../shared/types/session';
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
import type { ChatCommand } from '../../shared/types/messages';
import { handleAboutChannels, runUpdateAction, type AboutDeps } from './about-channels';
import { ActivationFocus, onWindowActivated, onWindowDeactivated } from './activation-focus';
import { trayIcon, windowIcon } from './app-icon';
import { startCore, type DesktopCore } from './bootstrap';
import { BrowserTabs } from './browser-tabs';
import { chatsToUnload, ChatWorkQueue, isActiveActivity } from './chat-pool';
import { resolveChatTab } from './chat-tab-target';
import { storedTitle } from './chat-title';
import { parseUserDataDir } from './cli';
import { CoreHost } from './core-host';
import { QuitLifecycle, shutDown } from './shutdown';
import {
  DEFAULT_FILES_EXCLUDE,
  DEFAULT_SEARCH_EXCLUDE,
  FILES_EXCLUDE_SETTING,
  SEARCH_EXCLUDE_SETTING,
  isDesktopSettingValue,
  NOTIFICATION_SOUND_SETTING,
  NOTIFICATIONS_SETTING,
  RESTORE_LAYOUT_SETTING,
  TERMINAL_DEFAULT_PROFILE_SETTING,
  TERMINAL_PROFILES_SETTING,
  THEME_SETTING,
  type DesktopLanguageSetting,
} from './desktop-configuration';
import { BackupStore } from './documents/backups';
import type { Project } from './documents/confine';
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
import { createMessageAsker, type AskMessage } from './message-dialog';
import { installCaCertificates } from './network/ca-certificates';
import { installProxyDispatcher } from './network/proxy-dispatcher';
import { DO_NOT_DISTURB_KEY, handleCenterChannels, NotificationCenter, runEntryAction, type ChatKey, type ChatRef, type EntryActionDeps } from './notification-center';
import { NotifierHost } from './notifier';
import { OverlayHost, overlayHtml } from './overlay';
import { OverlaySettings, writeDesktopSetting } from './overlay-settings';
import type { SettingsTarget } from '../../shared/settings-sections';
import { PanelStateStore } from './panel-state-store';
import { createDesktopPlatform, type DesktopPlatform } from './platform';
import { ptyHostPaths, quickOpenWorkerPath, unpackagedResourceRoot, type DesktopLayout } from './platform/app-paths';
import type { ChatTabMessenger } from './platform/editor-service';
import { createDesktopKeyValueState, type DesktopKeyValueState } from './platform/key-value-state';
import { createDesktopLocalizationService, launchLanguage, readLanguageSetting, type DesktopLocalizationService } from './platform/localization-service';
import { createDesktopLogSinkFactory } from './platform/log-sink';
import { Emitter } from './platform/emitter';
import { createDesktopNotificationService } from './platform/notification-service';
import { logUncaughtErrors } from './process-errors';
import { ProjectList } from './projects';
import { announceInstalledVersion, ReleaseNotesSource } from './release-notes';
import { appResourceUri, handleAppProtocol, registerAppScheme } from './protocol';
import { restrictPermissions, hardenWebContents } from './security';
import { reportFailure, ShellHost, shellHtml, type ShellActions } from './shell';
import { mergeLoginShellEnv, probeGit } from './shell-env';
import { TaskbarBadges } from './taskbar-badges';
import { TaskbarCounter } from './taskbar-counter';
import { currentTheme, currentThemeKind, followThemeSettings, LIGHT_THEME, onThemeChange, THEME_BACKGROUND } from './theme';
import { AppTray } from './tray';
import { TrustStore } from './trust-store';
import { loadAutoUpdater, shellPlatform, UpdateService } from './updater';
import { UsageWarningStore } from './usage-warning-store';
import { PanelViews, type DesktopPanel, type ShowFocus } from './views';
import {
  clampToWorkAreas,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WindowLayoutStore,
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
  private readonly ask: AskMessage = (question) => {
    if (this.lifecycle.releasing) this.revealWindow();
    return this.askMessage(question);
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
    openTabs: () => this.openInitialChats(),
    retainTabStates: (retain) => this.views?.retainStatesOnClose(retain),
    log: (line) => log(line),
    drainTimeoutMs: CLOSE_TIMEOUT_MS,
  });
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
  // Settles once core finished restoring or setting up a chat, whether core registered the chat or not; every chat has one.
  private readonly chatRestores = new WeakMap<DesktopPanel, Promise<void>>();
  private fileTree: FileTree | undefined;
  private quickOpenIndex: QuickOpenIndex | undefined;
  private search: SearchHost | undefined;
  private palette: CommandPalette | undefined;
  private editorPane: EditorPane | undefined;
  private formatter: FormatService | undefined;
  private formatterHosts: FormatterHosts | undefined;
  private terminals: TerminalService | undefined;
  private readonly terminalLinks = new TerminalLinks((line) => log(line));
  private terminalProfiles: TerminalProfileCatalog | undefined;
  // settles once the shells were detected and the user's profiles validated, after which the window restores its terminals
  private profilesDetected: Promise<void> = Promise.resolve();
  // damocles.desktop.language as read at launch; a change applies after a restart (D23)
  private languageSetting: DesktopLanguageSetting = 'system';
  // damocles.desktop.restoreLayout as read at launch
  private restoreAtLaunch = true;
  private tray: AppTray | undefined;
  private platform: DesktopPlatform | undefined;
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
  // Each project's stored sessions from its last catalog read, for titles outside a list request.
  private readonly catalogRows = new Map<string, readonly StoredSession[]>();
  private readonly chatWork = new ChatWorkQueue();
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
    logUncaughtErrors(process, (line) => log(line));
    this.states = new PanelStateStore(this.userDataDir, (line) => log(line));
    this.windowLayout = new WindowLayoutStore(this.userDataDir, (line) => log(line));
    this.projects = new ProjectList(this.userDataDir, (line) => log(line));
    this.state = createDesktopKeyValueState(this.userDataDir, (line) => log(line));
    this.trust = new TrustStore(this.userDataDir, this.ask, (message, ...args) => this.requireLocalization().t(message, ...args), (line) => log(line));
    this.usageWarnings = new UsageWarningStore(this.userDataDir, (line) => log(line));
  }

  async start(): Promise<void> {
    const bootLog = (line: string): void => log(line);
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

    await mergeLoginShellEnv(bootLog);
    await app.whenReady();
    const problem = runtimeProblem();
    if (problem !== undefined) {
      dialog.showErrorBox('Damocles cannot start', problem);
      app.exit(1);
      return;
    }
    installCaCertificates(bootLog);
    this.disposables.push(installProxyDispatcher(session.defaultSession, bootLog));
    // The Language setting replaces the language the chat webview stored, so the webview follows it too.
    if (this.languageSetting !== 'system' && this.state.global.get<string>(LANGUAGE_PREFERENCE_KEY) !== undefined) {
      await this.state.global.update(LANGUAGE_PREFERENCE_KEY, undefined);
    }
    const localization = createDesktopLocalizationService(resourceRoot, this.preferredLanguage(), bootLog);
    this.localization = localization;
    const git = await probeGit(bootLog, (message, ...args) => localization.t(message, ...args));
    setCheckpointGitAvailability(git);
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
      views: () => this.requireViews(),
      openChat: (options) => this.openCoreChat(options),
      openAppSettings: (section, account) => this.openSettings({ ...(section !== undefined ? { section } : {}), ...(account !== undefined ? { account } : {}) }),
      toggleTerminal: () => this.toggleTerminal(false),
      terminalToggle: () => this.terminalToggle(),
      prompts: () => this.core.current()?.provider.getWebviewPrompts(),
      chatTabs: this.chatTabs,
      editorPane: () => this.requireEditorPane(),
      chatFolders: {
        folders: () => [...this.chatInstances().values()].flatMap((instance) => settingsFolderOf(instance.folder) ?? []),
        onDidChange: (cb) => this.chatFoldersChanged.add(cb),
      },
      reload: () => this.core.reload(),
      log: bootLog,
    });
    installPlatform(this.platform);
    this.startEditor(this.platform, localization);
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
        this.formatterHosts?.retain(this.desktopProjects().map((project) => project.key));
        this.terminals?.retain(this.desktopProjects().map((project) => project.key));
        this.terminalLinks.clear();
        this.installMenu();
        this.shellStateChanged();
        this.fileTree?.projectsChanged();
        this.quickOpenIndex?.invalidate();
      }),
      this.trust.onDidGrant(() => this.shellStateChanged()),
      this.platform.settings.onDidChange('damocles', (change) => {
        if (change.affects(BROWSER_ENABLED_KEY)) {
          this.browserTabs?.enabledChanged();
          this.refreshMenuState();
        }
        if (change.affects(NOTIFICATIONS_SETTING)) this.notificationCenter.popupPolicyChanged();
        if (change.affects(FILES_EXCLUDE_SETTING)) {
          this.fileTree?.excludeChanged();
          this.quickOpenIndex?.invalidate();
        }
        if (change.affects(SEARCH_EXCLUDE_SETTING)) this.quickOpenIndex?.invalidate();
        if (change.affects('damocles.desktop.search') || change.affects('damocles.desktop.searchEditor')) this.shellStateChanged();
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

    await runLegacySettingsMigrations(this.platform.settings);
    this.restoreAtLaunch = this.platform.settings.get<boolean>(RESTORE_LAYOUT_SETTING, true);
    if (!this.restoreAtLaunch) {
      this.windowLayout.clear();
      for (const chat of this.states.list()) this.states.delete(chat.panelId);
    }
    // Saved tabs come back with "Reopen where I left off"; a backup comes back either way, since it holds text the user never discarded.
    await this.requireEditorPane().restore(this.windowLayout.editor(), await this.backups.list());
    this.core.start();
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
    await this.core.openTabs();

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
        this.overlaySettings?.terminalProfilesChanged();
      },
    });
    this.terminalProfiles = catalog;
    this.profilesDetected = detectProfiles(systemProfileProbe(process.env, (line) => log(line))).then((profiles) => {
      log(`[terminal] detected shells: ${profiles.map((profile) => profile.id).join(', ') || 'none'}`);
      return catalog.setDetected(profiles);
    }).catch((err: unknown) => log(`[terminal] detecting the shells or validating the user's profiles failed: ${errorText(err)}`));
    return new TerminalService({
      spawnHost: () => spawnPtyHost(host.script, host.nodePty),
      profiles: () => catalog.profiles(),
      isDirectory: (folder) => fs.promises.stat(folder).then((stat) => stat.isDirectory(), (err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') log(`[terminal] cannot read the folder a shell reported: ${code ?? errorText(err)}`);
        return false;
      }),
      projects: () => this.desktopProjects(),
      currentProjectKey: () => this.currentProjectKey(),
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
      homedir: os.homedir(),
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
    const selected = this.selectedProjectKey ?? this.core.current()?.provider.getFolderRegistry().defaultTarget().key;
    return projects.find((project) => project.key === selected)?.key ?? projects[0]?.key;
  }

  private startCoreServices(): DesktopCore {
    const core = startCore(this.requirePlatform());
    const panelManager = core.provider.getPanelManager();
    // The previous core's chats closed with it.
    for (const corePanelId of this.activity.keys()) this.notificationCenter.panelClosed(corePanelId);
    this.activity.clear();
    this.catalogRows.clear();
    const subscriptions = [
      core.provider.getFolderRegistry().onDidChange(() => {
        this.followSelectedChat();
        this.shellStateChanged();
      }),
      panelManager.onAllPanelsClosed(() => log('[chats] the last loaded chat closed')),
      panelManager.onActivity((panelId, activity) => this.onChatActivity(panelId, activity)),
      panelManager.onTurnSettled((panelId, outcome) => {
        const panel = this.panelOfCore(panelId);
        if (panel) this.chatsChanged(this.projectOf(panel));
        this.notificationCenter.turnSettled(panelId, outcome);
        this.scheduleRetention();
      }),
      panelManager.onUsageThreshold((crossing) => this.notificationCenter.usageThreshold(crossing)),
      core.provider.getSessionCatalog().onDidChange((change) => {
        if (change.projectKey === undefined) this.catalogRows.clear();
        else this.catalogRows.delete(change.projectKey);
        this.chatsChanged(change.projectKey);
        this.refreshSelectedCatalog();
      }),
    ];
    return {
      provider: core.provider,
      dispose: async () => {
        await this.beforeCoreDispose();
        for (const subscription of subscriptions) subscription.dispose();
        await core.dispose();
      },
    };
  }

  private createWindow(): void {
    this.states.unseal();
    this.windowLayout.unseal();
    const placement = this.windowLayout.window();
    const bounds = placement
      ? clampToWorkAreas(placement.bounds, screen.getAllDisplays().map((display) => display.workArea))
      : { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
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
    const quickOpenPicker = new QuickOpenPicker(
      overlay,
      this.requireQuickOpenIndex(),
      () => ({ currentProjectKey: this.selectedProjectKey ?? this.core.current()?.provider.getFolderRegistry().defaultTarget().key, recent: this.requireEditorPane().recentFiles() }),
      { capture: () => this.menuState(), list: (context) => this.requirePalette().list(context) },
      (line) => log(line),
    );
    const browserTabs = new BrowserTabs({
      editor: this.requireEditorPane(),
      window,
      setPages: (chatPanelId, pages) => this.states.setPages(chatPanelId, pages),
      retainingStates: () => views.retainingStates,
      browserEnabled: () => this.browserEnabled(),
      newPage: (chat) => this.core.run('New Browser Page', (core) => core.provider.getBrowserService().openNewPageForChat(chat)),
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
      panelManager: () => this.core.current()?.provider.getPanelManager(),
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
    void Promise.all([this.profilesDetected, firstLoad]).then(() => {
      if (this.shell === shell) terminals.restore();
    });
    const savePlacement = (): void => this.saveWindowPlacement(window);
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
      this.sealPersistedState(window);
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
      return (await core.provider.getPanelManager().promptTarget(undefined))?.panelId;
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
      window.setSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT);
      window.center();
    }
    this.terminals?.setListWidth(TERMINAL_LIST_DEFAULT_REM);
    this.shellStateChanged();
    this.postTerminalShown();
  }

  // VS Code's onBeforeShutdown saves the window state, and a closing window does not rewrite it (windowsStateHandler.ts).
  private sealPersistedState(window: BrowserWindow): void {
    this.saveWindowPlacement(window);
    this.states.seal();
    this.windowLayout.seal();
  }

  // Normal bounds, so a maximized window restores to the size it had before it was maximized.
  private saveWindowPlacement(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    this.windowLayout.setWindow({ bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullScreen: window.isFullScreen() });
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

  // A second launch, a tray click or a macOS dock click: focus the window, or reopen it with its chats when it was closed.
  private showWindow(): void {
    // A quit past its last question has closed the window for good.
    const phase = this.lifecycle.phase;
    if (phase === 'disposing' || phase === 'done' || !this.core.current()) return;
    if (!this.window) {
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
  // Only CoreHost calls this, so a reload never disposes the core it reopens the chats into.
  private async openInitialChats(): Promise<void> {
    const core = this.requireCore();
    const views = this.requireViews();
    const persisted = this.states.list();
    const selection = this.states.selected();
    const registry = core.provider.getFolderRegistry();
    const savedProject = selection && this.isKnownProject(selection.projectKey, core) ? selection.projectKey : undefined;
    if (persisted.length === 0) {
      await this.newChatIn(core, this.restoreAtLaunch ? savedProject : undefined, { focus: 'whenReady' });
      return;
    }
    const restored = persisted.map((saved) => {
      const host = views.create({ options: CHAT_PANEL, restore: { panelId: saved.panelId, state: saved.state } });
      this.trackChat(host, restoredWorkspaceFolderKey(saved.state) ?? registry.defaultTarget().key);
      // A chat whose saved pages are on their way back is active, so retention keeps it until they arrive.
      if (saved.browser.pages.length > 0) this.browserTabs?.setRestoring(host, true);
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
        await this.restoreInCore(core, host, restoredWorkspaceFolderKey(saved.state));
        this.restorePages(core, host, saved.browser.pages, saved.browser.activePage);
      });
      this.chatRestores.set(host, restore);
      previous = restore.catch(this.report('Restoring a chat'));
    }
    await previous;
    this.scheduleRetention();
  }

  private async restoreInCore(core: DesktopCore, chat: DesktopPanel, folderKey: string | undefined): Promise<void> {
    await this.beforeChatRestore();
    // A chat closed meanwhile (dropped while an earlier one loaded, or by the quit) is gone; setting up a session for it would leak one.
    if (chat.isDisposed) return;
    await core.provider.restorePanel(chat, folderKey);
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

  // Reopens a chat's saved pages as its tabs once the browser relaunches, which the remaining chats and the updater do not
  // wait for; the active editor tab stays as restored meanwhile and no page takes focus.
  private restorePages(core: DesktopCore, chat: DesktopPanel, urls: readonly string[], activePage: number | undefined): void {
    // A chat the quit closed while core restored it has no tabs left to restore into.
    if (urls.length === 0 || chat.isDisposed) return;
    const browserTabs = this.browserTabs;
    core.provider.getBrowserService().restoreChatPages(chat, urls, activePage)
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
  private openCoreChat(options: PanelOptions): DesktopPanel {
    const core = this.requireCore();
    const views = this.requireViews();
    const host = views.create({ options });
    this.trackChat(host, this.selectedProjectKey ?? core.provider.getFolderRegistry().defaultTarget().key);
    // Core sets the chat up once this returns; a mention or Add to Chat waits for that as for a chat main restores.
    this.chatRestores.set(host, this.beforeChatRestore().then(() => core.provider.getPanelManager().whenSetUp(host)));
    this.showChat(host, { focus: true });
    return host;
  }

  private newChat(projectKey: string | undefined): Promise<void> {
    return this.core.run('New Chat', (core) => this.newChatIn(core, projectKey));
  }

  private async newChatIn(core: DesktopCore, projectKey: string | undefined, options: { readonly focus: ShowFocus } = { focus: true }): Promise<void> {
    const views = this.requireViews();
    const key = projectKey ?? this.selectedProjectKey ?? core.provider.getFolderRegistry().defaultTarget().key;
    if (!this.isKnownProject(key, core)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    const host = views.create({ options: CHAT_PANEL });
    this.trackChat(host, key);
    this.showChat(host, options);
    await this.restoreChat(core, host, key);
  }

  private async addProject(): Promise<void> {
    const platform = this.requirePlatform();
    const folder = await platform.dialogs.pickFolder({ title: platform.localization.t('Add Project') });
    if (folder === undefined) return;
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
    return core.provider.getFolderRegistry().defaultTarget().key === key;
  }

  private chatInstances(): Map<unknown, HostInstance> {
    const panels = this.core.current()?.provider.getPanelManager().getPanels();
    return new Map([...(panels?.values() ?? [])].map((instance) => [instance.host, instance]));
  }

  private corePanelIdOf(panel: DesktopPanel): string | undefined {
    for (const [panelId, instance] of this.core.current()?.provider.getPanelManager().getPanels() ?? []) {
      if (instance.host === panel) return panelId;
    }
    return undefined;
  }

  private panelOfCore(corePanelId: string): DesktopPanel | undefined {
    const host = this.core.current()?.provider.getPanelManager().getPanels().get(corePanelId)?.host;
    return this.views?.chats().find((chat) => chat === host);
  }

  private boundSessionIdOf(panel: DesktopPanel): string | undefined {
    const corePanelId = this.corePanelIdOf(panel);
    return corePanelId === undefined ? undefined : this.core.current()?.provider.getPanelManager().sessionIdOf(corePanelId);
  }

  // The chat's stored session: the one core bound, else, while it restores, the one its saved state names.
  private sessionIdOf(panel: DesktopPanel): string | undefined {
    return this.boundSessionIdOf(panel) ?? panel.savedSessionId;
  }

  // Core binds a restored chat's saved session only in its webview's `ready`, well after it registers the chat.
  private isRestoring(panel: DesktopPanel): boolean {
    return this.boundSessionIdOf(panel) === undefined && panel.savedSessionId !== undefined;
  }

  private activityOf(panel: DesktopPanel): ChatActivity | undefined {
    const corePanelId = this.corePanelIdOf(panel);
    return corePanelId === undefined ? undefined : this.activity.get(corePanelId);
  }

  // A chat core has registered that has no conversation and no session file, bound or being restored.
  private isEmpty(panel: DesktopPanel): boolean {
    const corePanelId = this.corePanelIdOf(panel);
    if (corePanelId === undefined) return false;
    return !this.requireCore().provider.getPanelManager().hasConversation(corePanelId) && this.sessionIdOf(panel) === undefined;
  }

  private chatIdOf(panel: DesktopPanel): string {
    return this.sessionIdOf(panel) ?? `${NEW_CHAT_ID_PREFIX}${panel.panelId}`;
  }

  // A chat whose folder left the project list is the default target's: core sets it up or moves it there (PanelManager.setUpHost, movePanelOffRemovedFolders).
  private projectOf(panel: DesktopPanel): string | undefined {
    const key = this.chatInstances().get(panel)?.folder.key ?? this.openedInProject.get(panel);
    const registry = this.core.current()?.provider.getFolderRegistry();
    if (key === undefined || !registry) return key;
    return registry.resolve(key)?.key ?? registry.defaultTarget().key;
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
    for (const key of keys) {
      if (key === undefined) continue;
      const session = (await this.catalogList(core, key)).find((row) => row.id === sessionId);
      if (session) return { session, projectKey: key };
    }
    return undefined;
  }

  private async catalogList(core: DesktopCore, projectKey: string): Promise<readonly StoredSession[]> {
    const rows = await core.provider.getSessionCatalog().list(projectKey);
    this.catalogRows.set(projectKey, rows);
    return rows;
  }

  private refreshSelectedCatalog(): void {
    const key = this.selectedProjectKey;
    if (key === undefined || this.catalogRows.has(key) || !this.core.current()) return;
    this.core.run('Read Chat List', (core) => this.catalogList(core, key)).then(() => this.shellStateChanged(), this.report('Reading the chat list'));
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
    if (projectChanged) this.search?.stopAll();
    this.lastChatByProject.set(projectKey, this.chatIdOf(panel));
    const sessionId = this.sessionIdOf(panel);
    this.states.select({ projectKey, panelId: panel.panelId, ...(sessionId !== undefined ? { sessionId } : {}) });
    const registry = this.core.current()?.provider.getFolderRegistry();
    if (projectChanged && registry && registry.defaultTarget().key !== projectKey) {
      registry.setDefault(projectKey).catch(this.report('Following the selected project'));
    }
    this.refreshSelectedCatalog();
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
      // Another Damocles process holds the conversation: the selection stays where it is.
      const refusal = leaseRefusalFor(chatId);
      if (refusal) {
        announceLeaseRefusal(this.notifications, refusal, {
          takeover: {
            sessionId: chatId,
            canOpen: () => this.views !== undefined,
            open: async () => {
              await this.selectChat(chatId);
            },
          },
        });
        return { ok: false, reason: 'leased' };
      }
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
    return this.core.run('List Chats', async (core) => (this.isKnownProject(projectKey, core) ? this.listChatsIn(core, projectKey) : undefined));
  }

  private async listChatsIn(core: DesktopCore, projectKey: string): Promise<ShellChatList> {
    if (!this.isKnownProject(projectKey, core)) throw new Error('Unknown project');
    return this.chatList(projectKey, await this.catalogList(core, projectKey), true);
  }

  private searchChats(projectKey: string, query: string): Promise<ShellChatList | undefined> {
    return this.core.run('Search Chats', async (core) => {
      if (!this.isKnownProject(projectKey, core)) return undefined;
      if (query.trim() === '') return this.listChatsIn(core, projectKey);
      return this.chatList(projectKey, await core.provider.getSessionCatalog().search(projectKey, query), false);
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
      });
    }
    return { projectKey, chats, tags: [...tags].sort((a, b) => a.localeCompare(b)).slice(0, MAX_OVERLAY_TAGS) };
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
    return this.core.run('Rename Chat', (core) => this.chatWork.run(chatId, async () => this.mutationResult(await core.provider.getSessionCatalog().rename(chatId, name), 'rename')));
  }

  private async tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.loadedChat(chatId) ? this.unwrittenChat() : this.missingChat();
    return this.core.run('Tag Chat', (core) => this.chatWork.run(chatId, async () => this.mutationResult(await core.provider.getSessionCatalog().tag(chatId, tag), 'tag')));
  }

  // Core deletes lease first and detaches every holder; the detached chat then unloads like any other.
  private async deleteChat(chatId: string): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) {
      const chat = this.loadedChat(chatId);
      if (!chat) return this.missingChat();
      chat.close();
      return { ok: true };
    }
    return this.core.run('Delete Chat', (core) => this.chatWork.run(chatId, async () => {
      const holder = this.loadedChat(chatId);
      const result = this.mutationResult(await core.provider.getSessionCatalog().delete(chatId), 'delete');
      if (result.ok && holder && !holder.isDisposed) holder.close();
      return result;
    }));
  }

  // A chat left memory: by retention, Delete, or the window or core closing (which keep the saved selection).
  private chatClosed(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    this.chatsChanged(projectKey);
    const views = this.views;
    if (!views || views.retainingStates || this.lifecycle.phase !== 'running' || views.selected() !== undefined) return;
    this.selectProject(projectKey ?? this.requireCore().provider.getFolderRegistry().defaultTarget().key).catch(this.report('Selecting a chat after a close'));
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
    const panels = this.requireCore().provider.getPanelManager().getPanels();
    for (const corePanelId of [...this.activity.keys()]) {
      if (panels.has(corePanelId)) continue;
      this.activity.delete(corePanelId);
      this.notificationCenter.panelClosed(corePanelId);
    }
    for (const panelId of this.chatsToUnload()) {
      const chat = views.panel(panelId);
      if (!chat) continue;
      this.chatWork.run(this.chatIdOf(chat), async () => {
        if (chat.isDisposed || !this.chatsToUnload().includes(chat.panelId)) return;
        log(`[chats] unloading chat ${chat.panelId}`);
        chat.close();
      }).catch(this.report('Unloading a chat'));
    }
  }

  private chatsToUnload(): string[] {
    const views = this.views;
    if (!views || !this.core.current() || views.retainingStates || this.lifecycle.phase !== 'running') return [];
    const selected = views.selected();
    return chatsToUnload(views.chats().flatMap((chat) => {
      // A chat whose session core is still setting up is neither idle nor empty yet.
      if (this.corePanelIdOf(chat) === undefined) return [];
      return [{
        id: chat.panelId,
        selected: chat === selected,
        active: isActiveActivity(this.activityOf(chat)) || this.browserTabs?.holdsPages(chat) === true,
        restoring: this.isRestoring(chat),
        hasSession: this.sessionIdOf(chat) !== undefined,
        empty: this.isEmpty(chat),
        lastViewed: this.lastViewed.get(chat) ?? 0,
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
    const name = file.relativePath === '' ? this.desktopProjects().find((project) => project.key === file.projectKey)?.name ?? '' : path.posix.basename(file.relativePath);
    const message = filesFailureMessage((text, ...args) => this.requireLocalization().t(text, ...args), action, name, result, newName);
    if (message !== undefined) void this.notifications.error(message);
    return result;
  }

  // A refusal or failure comes back as the reason the project list shows under the project.
  private async removeProject(key: string): Promise<RemoveProjectResult> {
    try {
      const project = this.projectByKey(key);
      const running = [...this.chatInstances().values()].some((instance) => instance.folder.key === key && instance.session.processing);
      if (running) {
        return { ok: false, reason: this.requireLocalization().t('A conversation is running in {0}. Stop it or wait for it to finish, then remove the project.', project.name) };
      }
      // Removing the project kills its terminals (AD6), so running ones are asked about first (G22); a cancel keeps it.
      const terminals = this.requireTerminals();
      if (!(await terminals.confirmKill(terminals.idsIn(key)))) return { ok: true };
      await this.projects.remove(project.fsPath);
      return { ok: true };
    } catch (err) {
      log(`[shell] removing a project failed: ${errorText(err)}`);
      return { ok: false, reason: errorMessage(err) };
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
      newChat: reportFailure((key: string | undefined) => this.newChat(key), this.shellFailure('New Chat', 'Damocles could not open a new conversation: {0}')),
      renameChat: reportFailure((id: string, name: string) => this.renameChat(id, name), this.shellFailure('Rename Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      tagChat: reportFailure((id: string, tag: string | null) => this.tagChat(id, tag), this.shellFailure('Tag Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      deleteChat: reportFailure((id: string) => this.deleteChat(id), this.shellFailure('Delete Chat', 'Damocles could not change the session: {0}'), CHAT_CHANGE_FAILED),
      // A popup the overlay could not show (not loaded, no acknowledgement, a crash) answers as dismissed.
      requestOverlay: reportFailure(
        (request: OverlayRequest, returnFocus: WebContents) => this.requestFromShell(overlay, request, returnFocus),
        this.shellFailure('Show Popup', 'Damocles could not open the menu or dialog: {0}'),
        OVERLAY_DISMISSED,
      ),
      openAppMenu: (anchor) => popupApplicationMenu(window, anchor),
      toggleTheme: () => { this.toggleTheme().catch(this.shellFailure('Toggle Theme', 'Damocles could not change the theme: {0}')); },
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
          const base = this.requireTerminals().linkBase(request.id);
          if (!base) throw new Error('Unknown terminal');
          return this.terminalLinks.resolveAll(request.paths, base);
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
    if (answer.kind === 'notifications') this.notificationCenter.open(answer.entryId);
    if (answer.kind === 'dropZones' && request.kind === 'dropZones' && answer.slot !== null) this.layoutMove(request.pane, answer.slot);
    return answer;
  }

  private startEditor(platform: DesktopPlatform, localization: DesktopLocalizationService): void {
    const t = (message: string, ...args: Array<string | number>): string => localization.t(message, ...args);
    const projects = (): readonly Project[] => this.desktopProjects();
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
    });
    const quickOpenIndex = new QuickOpenIndex({
      projects,
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
      showPaneBeside: () => {
        const grid = this.windowLayout.sidebar().grid;
        if (grid.maximized !== null && grid.maximized !== 'editor') this.setGrid({ ...grid, maximized: null });
        if (!this.windowLayout.sidebar().grid.visible.editor) this.toggleGridPane('editor');
      },
      projects,
      copy: (text) => platform.clipboard.writeText(text),
      reveal: (absolutePath) => platform.shell.revealPath(absolutePath),
      mention: (target) => this.mentionInSelectedChat(target),
      browser: () => this.browserTabs,
      warn: (message) => void this.notifications.warn(message),
      searchEditorClosed: (documentId) => this.search?.searchEditorClosed(documentId),
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
    // Playwright drives the agent's side of EditorService (openFile, showDiff without approvalId), routes the browser's
    // requests and makes Files' trash or permanent delete fail through this, in the unpackaged app only.
    if (!app.isPackaged && process.env['DAMOCLES_E2E_HOOKS'] === '1') {
      const hooks = {
        editor: platform.editor,
        browser: () => this.requireCore().provider.getBrowserService(),
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
        reloadCore: () => this.core.reload(),
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

  // Search's folder: the selected project's, resolved against main's own project list.
  private searchFolder(): SearchFolder | undefined {
    const key = this.selectedProjectKey ?? this.core.current()?.provider.getFolderRegistry().defaultTarget().key;
    const project = this.desktopProjects().find((candidate) => candidate.key === key);
    return project ? { projectKey: project.key, fsPath: project.fsPath } : undefined;
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
    const registry = this.core.current()?.provider.getFolderRegistry();
    return this.projects.folders().map((folder) => {
      const key = folderKey(folder.fsPath);
      return { key, fsPath: folder.fsPath, name: registry?.resolve(key)?.label ?? folder.name };
    });
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

  // Every loaded chat's header toggle follows the pane; a chat view that loads later gets it with its ready.
  private postTerminalShown(): void {
    const panelManager = this.core.current()?.provider.getPanelManager();
    if (!panelManager) return;
    const message = { type: 'terminalShown', ...this.terminalToggle() } as const;
    for (const instance of panelManager.getPanels().values()) panelManager.postMessage(instance.host, message);
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
    const terminals = this.requireTerminals();
    const id = terminals.ensureTerminal();
    if (id !== undefined) terminals.focus(id);
  }

  // New Terminal: the overlay's quick pick, then the terminal in the shown pane, focused.
  private async newTerminal(): Promise<void> {
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

  // G25: the shell's selection or a command's output becomes a pending attachment of the current chat (the selected one, else
  // a new chat in the terminal's project), labelled from main's own facts and bounded again here; its composer takes focus.
  private async addTerminalOutputToChat(request: TerminalAddToChat): Promise<void> {
    const terminals = this.requireTerminals();
    const title = terminals.titleOf(request.id);
    const projectKey = terminals.state().terminals.find((terminal) => terminal.id === request.id)?.projectKey;
    if (title === undefined || projectKey === undefined) return;
    const facts = request.commandId === null ? undefined : terminals.commandFacts(request.id, request.commandId);
    const capped = capTerminalText(request.text);
    const attachment = {
      source: request.source,
      commandLine: facts && facts.commandLine !== '' ? facts.commandLine : null,
      exitCode: facts?.exitCode ?? null,
      terminalTitle: title,
      text: capped.text,
      omittedLines: Math.min(request.omittedLines + capped.omittedLines, MAX_TERMINAL_ATTACHMENT_OMITTED_LINES),
    };
    await this.core.run('Add to Chat', async (core) => {
      if (!this.views?.selected()) await this.newChatIn(core, this.isKnownProject(projectKey, core) ? projectKey : undefined);
      const panel = this.views?.selected();
      // A chat still restoring is the chat the output goes to, once core registered it.
      const restored = panel ? await this.restoredCorePanel(panel) : undefined;
      const corePanelId = restored?.corePanelId;
      if (restored?.failed) {
        void this.requirePlatform().notifications.warn(this.requireLocalization().t('The chat could not be loaded, so the terminal output was not added to it.'));
        return;
      }
      if (!panel || corePanelId === undefined || !(await this.entryActionDeps.whenReady(panel)) || this.views?.selected() !== panel) {
        log('[terminal] Add to Chat: the chat closed before it was ready');
        return;
      }
      if (core.provider.getPanelManager().addTerminalAttachment(corePanelId, attachment)) this.views?.focusChat();
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

  // Files' Mention in chat, the editor's mention button and Quick Open's @ mention in the selected chat.
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
      await core.provider.getPanelManager().mentionFile(corePanelId, target);
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
    const name = this.core.current()?.provider.getFolderRegistry().resolve(key)?.label ?? folder?.name;
    return { key, name: name ?? path.basename(key) };
  }

  // The chat a notification is about, with a title from the catalog when main has not read one yet.
  private async describeChat(corePanelId: string): Promise<ChatRef | undefined> {
    const panel = this.panelOfCore(corePanelId);
    const projectKey = panel ? this.projectOf(panel) : undefined;
    if (!panel || projectKey === undefined) return undefined;
    const sessionId = this.sessionIdOf(panel);
    if (sessionId !== undefined && this.titleOf(panel) === '') {
      await this.core.run('Read Chat List', (core) => this.catalogList(core, projectKey)).catch(this.report('Reading the chat list'));
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
      const panelManager = this.core.current()?.provider.getPanelManager();
      const instance = corePanelId === undefined ? undefined : panelManager?.getPanels().get(corePanelId);
      if (!panelManager || !instance || corePanelId === undefined) {
        log('[notifications] the chat is not ready for its action');
        return false;
      }
      await instance.webviewReady;
      return panelManager.getPanels().get(corePanelId) === instance;
    },
    post: (panel, message) => this.core.current()?.provider.getPanelManager().postMessage(panel, message),
  };

  private shellState(views: PanelViews): Omit<ShellState, 'revision'> {
    const registry = this.core.current()?.provider.getFolderRegistry();
    const defaultKey = registry?.defaultTarget().key;
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
      const branch = registry?.branchOf(key);
      return {
        key,
        name: registry?.resolve(key)?.label ?? folder.name,
        fsPath: folder.fsPath,
        trusted: this.trust.isTrusted(folder.fsPath),
        ...(branch !== undefined ? { branch } : {}),
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
      search: shellSearchSettings(this.requirePlatform().settings),
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
    const defaultKey = this.core.current()?.provider.getFolderRegistry().defaultTarget().key;
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
      project: this.projects.folders().length > 0,
      terminal: this.terminals?.activeStatus(),
      terminalSplit: this.terminals?.splitActive() === true,
      terminalInput: this.terminalInputHasFocus(),
      search: this.searchMenuState(),
    };
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
    deliver: async (panelId, message) => {
      const views = this.requireViews();
      const panelManager = this.requireCore().provider.getPanelManager();
      const target = await resolveChatTab({
        panels: () => panelManager.getPanels(),
        selected: () => views.selected(),
        chats: () => views.chats(),
        openChat: () => panelManager.show(),
      }, panelId);
      panelManager.postMessage(target.host, message);
      return target.panelId;
    },
    post: (panelId, message) => {
      const panelManager = this.core.current()?.provider.getPanelManager();
      const instance = panelManager?.getPanels().get(panelId);
      if (panelManager && instance) panelManager.postMessage(instance.host, message);
    },
  };

  private installMenu(): void {
    installApplicationMenu(this.projects.folders(), this.menuActions(), this.requirePlatform().localization, this.menuState());
  }

  private menuActions(): MenuActions {
    const platform = this.requirePlatform();
    const report = (action: string) => this.report(action);
    return {
      addProject: () => { this.addProject().catch(report('Add Project')); },
      newChat: () => { this.newChat(undefined).catch(report('New Chat')); },
      openChat: () => { this.core.run('Open Chat', (core) => core.provider.show()).catch(report('Open Chat')); },
      openChatForProject: (fsPath) => { this.newChat(folderKey(fsPath)).catch(report('Open Chat in Project')); },
      newSession: () => { this.core.run('New Session', (core) => core.provider.newSession()).catch(report('New Session')); },
      cancelSession: () => { this.core.run('Cancel Session', (core) => core.provider.cancelSession()).catch(report('Cancel Session')); },
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
        if (this.views?.selected()) this.core.run('Toggle Prompt Navigator', (core) => core.provider.getPanelManager().postToActivePanel({ type: 'togglePromptNavigator' })).catch(report('Toggle Prompt Navigator'));
      },
      newBrowserPage: () => { this.browserTabs?.newPage().catch(report('New Browser Page')); },
      toggleBrowserDevTools: () => this.browserTabs?.activePage()?.deliver({ type: 'openDevTools' }),
      setExploreApiKey: () => { setExploreApiKey(platform).catch(report('Set Explore API Key')); },
      showLog: () => showLog(),
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

  // The extension's deactivate chain (session list cache flush, lease release, sentinels, stores), after the window closed.
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
  }

  // Every store under userData, the settings files and every config file core writes; each flush also waits for a write queued while it runs.
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
      flushCoreWrites(),
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
