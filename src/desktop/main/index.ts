import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, screen, session, webContents, type WebContents } from 'electron';
import { installLogSink, log, showLog } from '../../core/logger';
import { installPlatform } from '../../core/platform-host';
import type { ChatActivity } from '../../core/pi-session/session-state';
import { restoredWorkspaceFolderKey } from '../../core/chat-panel/panel-manager';
import { LANGUAGE_PREFERENCE_KEY } from '../../core/chat-panel/message-router/index';
import type { CatalogResult } from '../../core/chat-panel/session-catalog';
import { announceLeaseRefusal, leaseRefusalFor } from '../../core/chat-panel/session-ownership';
import type { HostInstance } from '../../core/chat-panel/types';
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
import {
  MAX_TAG_LENGTH,
  NEW_CHAT_ID_PREFIX,
  type ChatMutationResult,
  type ChatStatus,
  type RemoveProjectResult,
  type SelectChatResult,
  type ShellChat,
  type ShellChatList,
  type ShellFocusPart,
  type ShellProject,
  type ShellState,
} from '../preload/shell-channels';
import { trayIcon, windowIcon } from './app-icon';
import { startCore, type DesktopCore } from './bootstrap';
import { chatsToUnload, ChatWorkQueue, isActiveActivity } from './chat-pool';
import { resolveChatTab } from './chat-tab-target';
import { storedTitle } from './chat-title';
import { parseUserDataDir } from './cli';
import { CoreHost } from './core-host';
import { NOTIFICATION_SOUND_SETTING, NOTIFICATIONS_SETTING, RESTORE_LAYOUT_SETTING, THEME_SETTING, type DesktopLanguageSetting } from './desktop-configuration';
import {
  installApplicationMenu,
  popupApplicationMenu,
  shellShortcutLabels,
  togglePaneShortcutLabel,
  updateMenuState,
  type FocusPart,
  type MenuState,
} from './menu';
import { createMessageAsker } from './message-dialog';
import { installCaCertificates } from './network/ca-certificates';
import { installProxyDispatcher } from './network/proxy-dispatcher';
import { DO_NOT_DISTURB_KEY, handleCenterChannels, NotificationCenter, runEntryAction, type ChatKey, type ChatRef, type EntryActionDeps } from './notification-center';
import { NotifierHost } from './notifier';
import { OverlayHost, overlayHtml } from './overlay';
import { OverlaySettings } from './overlay-settings';
import type { SettingsAccountId, SettingsSectionId } from '../../shared/settings-sections';
import { PanelStateStore } from './panel-state-store';
import { createDesktopPlatform, type DesktopPlatform } from './platform';
import { unpackagedResourceRoot, type DesktopLayout } from './platform/app-paths';
import type { ChatTabMessenger } from './platform/editor-service';
import { createDesktopKeyValueState, type DesktopKeyValueState } from './platform/key-value-state';
import { createDesktopLocalizationService, launchLanguage, readLanguageSetting, type DesktopLocalizationService } from './platform/localization-service';
import { createDesktopLogSinkFactory } from './platform/log-sink';
import { Emitter } from './platform/emitter';
import { createDesktopNotificationService } from './platform/notification-service';
import { logUncaughtErrors } from './process-errors';
import { ProjectList } from './projects';
import { appResourceUri, handleAppProtocol, registerAppScheme } from './protocol';
import { restrictPermissions, hardenWebContents } from './security';
import { paneHtml } from './pane';
import { reportFailure, ShellHost, shellHtml, type ShellActions } from './shell';
import { mergeLoginShellEnv, probeGit } from './shell-env';
import { TaskbarBadges } from './taskbar-badges';
import { TaskbarCounter } from './taskbar-counter';
import { currentTheme, currentThemeKind, followThemeSettings, LIGHT_THEME, onThemeChange, THEME_BACKGROUND, titleBarOverlay } from './theme';
import { AppTray } from './tray';
import { TrustStore } from './trust-store';
import { loadAutoUpdater, startUpdater } from './updater';
import { UsageWarningStore } from './usage-warning-store';
import { PanelViews, type DesktopPanel, type PaneContext } from './views';
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

function shellPlatform(): ShellState['platform'] {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

function isShellTag(tag: string | undefined): tag is string {
  return tag !== undefined && tag.trim().length > 0 && tag.length <= MAX_TAG_LENGTH;
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
  private readonly logSinks = createDesktopLogSinkFactory(path.join(this.userDataDir, 'logs'), !app.isPackaged);
  private readonly logSink = this.logSinks.create('Damocles');
  private readonly states: PanelStateStore;
  private readonly windowLayout: WindowLayoutStore;
  private readonly projects: ProjectList;
  private readonly state: DesktopKeyValueState;
  private readonly trust: TrustStore;
  private readonly usageWarnings: UsageWarningStore;
  // Every desktop question: the overlay's dialog, else the OS message box (D41).
  private readonly ask = createMessageAsker({
    overlay: () => this.overlay,
    window: () => this.window,
    focused: () => webContents.getFocusedWebContents() ?? undefined,
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
    state: () => ({ locale: this.requireLocalization().language, platform: shellPlatform() }),
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
  });
  private localization: DesktopLocalizationService | undefined;
  private window: BrowserWindow | undefined;
  private views: PanelViews | undefined;
  private shell: ShellHost | undefined;
  private overlay: OverlayHost | undefined;
  private overlaySettings: OverlaySettings | undefined;
  // damocles.desktop.language as read at launch; a change applies after a restart (D23)
  private languageSetting: DesktopLanguageSetting = 'system';
  // damocles.desktop.restoreLayout as read at launch
  private restoreAtLaunch = true;
  private tray: AppTray | undefined;
  private platform: DesktopPlatform | undefined;
  private readonly disposables: Disposable[] = [];
  private shutdown: 'running' | 'disposing' | 'done' = 'running';
  // The selected project; the selected chat belongs to it once one is selected.
  private selectedProjectKey: string | undefined;
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
  // The part F6 moved keyboard focus from into the desktop popups, until focus is anywhere else or the popup window loses it.
  private toastFocusOrigin: FocusPart | undefined;
  // What the main window focuses once it gains focus (a part left from the popups, or an overlay popup opened while it was
  // unfocused), until a later focusOn places focus.
  private focusOnActivation: FocusPart | 'overlay' | undefined;
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
        this.refreshMenuState();
      });
      contents.on('blur', () => this.refreshMenuState());
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
      pane: () => paneHtml(currentTheme()),
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
      openAppSettings: (section, account) => this.openSettings(section, account),
      prompts: () => this.core.current()?.provider.getWebviewPrompts(),
      chatTabs: this.chatTabs,
      chatFolders: {
        folders: () => [...this.chatInstances().values()].flatMap((instance) => settingsFolderOf(instance.folder) ?? []),
        onDidChange: (cb) => this.chatFoldersChanged.add(cb),
      },
      reload: () => this.core.reload(),
      log: bootLog,
    });
    installPlatform(this.platform);
    log(`Damocles desktop starting (version ${this.platform.appInfo.version}, Electron ${process.versions.electron}, userData ${this.userDataDir})`);

    // Before the window exists, which takes its background from the effective theme.
    this.disposables.push(
      followThemeSettings(this.platform.settings),
      onThemeChange((theme) => {
        this.views?.broadcastTheme(theme);
        this.shell?.sendTheme(theme);
        this.overlay?.sendTheme(theme);
        this.notifier.sendTheme(theme);
        this.applyTitleBarOverlay();
        this.shellStateChanged();
      }),
      this.projects.onDidChange(() => {
        this.installMenu();
        this.shellStateChanged();
      }),
      this.trust.onDidGrant(() => this.shellStateChanged()),
      this.platform.settings.onDidChange('damocles', (change) => {
        if (change.affects(BROWSER_ENABLED_KEY)) this.views?.browserEnabledChanged();
        if (change.affects(NOTIFICATIONS_SETTING)) this.notificationCenter.popupPolicyChanged();
      }),
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
        this.views?.pane.stateChanged();
      }),
      this.onScaleChange(() => this.taskbar.reapply()),
    );
    this.installMenu();

    app.on('before-quit', (event) => this.onBeforeQuit(event));
    app.on('window-all-closed', () => {
      log('[window] all windows closed');
      if (process.platform !== 'darwin') app.quit();
    });
    // The last main-process event of a quit, so the log covers the whole shutdown.
    app.on('will-quit', () => {
      log('[shutdown] will-quit');
      this.logSink.dispose();
    });
    app.on('activate', () => this.showWindow());

    await runLegacySettingsMigrations(this.platform.settings);
    this.restoreAtLaunch = this.platform.settings.get<boolean>(RESTORE_LAYOUT_SETTING, true);
    if (!this.restoreAtLaunch) {
      this.windowLayout.reset();
      for (const chat of this.states.list()) this.states.delete(chat.panelId);
    }
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
    await this.openInitialChats();

    if (!git.available) void this.platform.notifications.warn(git.reason);
    this.disposables.push(startUpdater({
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      notifications: this.platform.notifications,
      shell: this.platform.shell,
      t: (message, ...args) => localization.t(message, ...args),
      log: bootLog,
      showLog: () => showLog(),
      load: loadAutoUpdater,
    }));
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

  private paneContext(): PaneContext {
    return {
      locale: this.requireLocalization().language,
      platform: shellPlatform(),
      toggleShortcutLabel: togglePaneShortcutLabel(),
      browserEnabled: () => this.browserEnabled(),
      newPage: (chat) => this.requireCore().provider.getBrowserService().openNewPageForChat(chat),
      openExternal: (url) => this.requirePlatform().shell.openExternal(url),
    };
  }

  private requireCore(): DesktopCore {
    const core = this.core.current();
    if (!core) throw new Error('Core services used before startup finished or while they reload');
    return core;
  }

  private startCoreServices(): DesktopCore {
    const core = startCore(this.requirePlatform());
    const panelManager = core.provider.getPanelManager();
    // The previous core's chats closed with it.
    for (const corePanelId of this.activity.keys()) this.notificationCenter.panelClosed(corePanelId);
    this.activity.clear();
    this.catalogRows.clear();
    const subscriptions = [
      core.provider.getFolderRegistry().onDidChange(() => this.shellStateChanged()),
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
        for (const subscription of subscriptions) subscription.dispose();
        await core.dispose();
      },
    };
  }

  private createWindow(): void {
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
      // AD7: frameless; the shell draws the title bar and the OS draws the window controls over it.
      titleBarStyle: 'hidden',
      ...(mac ? { trafficLightPosition: { x: 12, y: 13 } } : { titleBarOverlay: titleBarOverlay(currentThemeKind()) }),
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
      state: () => ({ locale: this.requireLocalization().language, platform: shellPlatform() }),
      focusOutside: () => this.focusOn('chat'),
      // Activation is asynchronous on X11 and Electron focuses the window's own page as it activates, so the overlay takes
      // focus from the window's focus event.
      awaitActivation: () => {
        this.focusOnActivation = 'overlay';
        this.flash('overlay', true);
      },
      // A badge drawn while the page could not draw is a dot.
      canRasterize: () => this.taskbar.reapply(),
      log: (line) => log(line),
    });
    handleCenterChannels(overlay, this.notificationCenter);
    const views = new PanelViews(
      {
        window,
        preloadPath: path.join(__dirname, 'preload-panel.js'),
        panePreloadPath: path.join(__dirname, 'preload-pane.js'),
        states: this.states,
        log: (line) => log(line),
        onChange: () => this.viewsChanged(),
        onRestack: () => overlay.restack(),
        onReveal: (chat) => this.showChat(chat, { focus: true }),
        onRendererGaveUp: (panel) => this.chatGaveUp(panel),
        onSavedSessionChange: (chat) => this.chatChanged(chat),
        onPaneGaveUp: () => this.paneGaveUp(views),
        paneContext: () => this.paneContext(),
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
        app.relaunch();
        app.quit();
      },
      resetLayout: () => this.resetLayout(),
      log: (line) => log(line),
      languageAtLaunch: this.languageSetting,
    });
    const shell: ShellHost = new ShellHost(window, this.shellActions(views, overlay, window), (line) => log(line), () => this.shellGaveUp(shell));
    const savePlacement = (): void => this.saveWindowPlacement(window);
    for (const event of ['resized', 'moved', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      window.on(event as 'resized', savePlacement);
    }
    // Closing the window closes its chats but keeps their state, so the next window or launch restores them.
    window.on('close', () => {
      savePlacement();
      views.retainStatesOnClose(true);
      for (const panelId of views.panelIds()) views.panel(panelId)?.close();
    });
    window.on('closed', () => {
      log('[window] closed');
      // A window left open would keep the app from quitting on Windows and Linux.
      this.notifier.dispose();
      shell.dispose();
      overlaySettings.dispose();
      overlay.dispose();
      views.dispose();
      if (this.window === window) {
        this.window = undefined;
        this.views = undefined;
        this.shell = undefined;
        this.overlay = undefined;
        this.overlaySettings = undefined;
      }
      this.tray?.relocalize();
    });
    window.on('show', () => this.tray?.relocalize());
    window.on('hide', () => this.tray?.relocalize());
    window.on('focus', () => {
      this.notificationCenter.windowFocused();
      this.flash('overlay', false);
      const viewed = this.viewedChat();
      if (viewed) this.notificationCenter.chatViewed(viewed);
      if (this.focusOnActivation !== undefined) this.focusOn(this.focusOnActivation);
    });
    this.window = window;
    this.notificationCenter.windowOpened();
    this.taskbar.reapply();
    this.views = views;
    this.shell = shell;
    this.overlay = overlay;
    this.overlaySettings = overlaySettings;
    overlay.load();
    shell.load();
  }

  /** Shows the settings modal in the overlay, attached to the selected chat (plan AD2); a closed window opens first. */
  private openSettings(section: SettingsSectionId | undefined, account?: SettingsAccountId): void {
    this.showWindow();
    const overlay = this.overlay;
    const settings = this.overlaySettings;
    if (!overlay || !settings) return;
    overlay.whenLoaded().then(() => settings.show(section, account)).catch(this.report('Settings'));
  }

  // The selected chat's core panel, else the chat a host prompt would use: one being opened, or a new one on the default project.
  private async settingsTarget(): Promise<string | undefined> {
    const selected = this.views?.selected();
    const selectedId = selected ? this.corePanelIdOf(selected) : undefined;
    if (selectedId !== undefined) return selectedId;
    return (await this.core.current()?.provider.getPanelManager().promptTarget(undefined))?.panelId;
  }

  // Restore default layout: window-layout.json back to its defaults, applied to this window now.
  private resetLayout(): void {
    this.windowLayout.reset();
    const window = this.window;
    if (window && !window.isDestroyed()) {
      if (window.isFullScreen()) window.setFullScreen(false);
      if (window.isMaximized()) window.unmaximize();
      window.setSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT);
      window.center();
    }
    this.shellStateChanged();
  }

  // Normal bounds, so a maximized window restores to the size it had before it was maximized.
  private saveWindowPlacement(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    this.windowLayout.setWindow({ bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullScreen: window.isFullScreen() });
  }

  private applyTitleBarOverlay(): void {
    if (process.platform === 'darwin' || !this.window || this.window.isDestroyed()) return;
    this.window.setTitleBarOverlay(titleBarOverlay(currentThemeKind()));
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

  private paneGaveUp(views: PanelViews): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Browser Pane');
    this.notifications.error(t('The browser pane stopped working because its page kept crashing.'), reload).then((answer) => {
      if (answer === reload) views.pane.restart();
    }, this.report('Reporting a crashed browser pane'));
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
    if (!this.core.current()) return;
    if (!this.window) {
      this.createWindow();
      this.openInitialChats().catch(this.report('Reopening chats'));
      return;
    }
    const window = this.window;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  // Every saved chat loads again; the saved selection, else a saved chat of the saved project, else the first, is shown
  // before any of them loads. With none saved, the saved (else default) project gets a new chat.
  private async openInitialChats(): Promise<void> {
    const core = this.requireCore();
    const views = this.requireViews();
    const persisted = this.states.list();
    const selection = this.states.selected();
    const registry = core.provider.getFolderRegistry();
    const savedProject = selection && this.isKnownProject(selection.projectKey) ? selection.projectKey : undefined;
    if (persisted.length === 0) {
      await this.newChat(this.restoreAtLaunch ? savedProject : undefined);
      return;
    }
    const restored = persisted.map((saved) => {
      const host = views.create({ options: CHAT_PANEL, restore: { panelId: saved.panelId, state: saved.state } });
      this.trackChat(host, restoredWorkspaceFolderKey(saved.state) ?? registry.defaultTarget().key);
      // A chat whose saved pages are on their way back is active, so retention keeps it until they arrive.
      if (saved.pane.pages.length > 0) views.setRestoring(host, true);
      this.lastViewed.set(host, ++this.viewCount);
      return { host, saved };
    });
    const selected = restored.find(({ saved }) => saved.panelId === selection?.panelId)
      ?? restored.find(({ host }) => selection?.sessionId !== undefined && host.savedSessionId === selection.sessionId)
      ?? restored.find(({ host }) => this.projectOf(host) === savedProject)
      ?? restored[0];
    if (selected) this.showChat(selected.host, { focus: true });
    const ordered = selected ? [selected, ...restored.filter((entry) => entry !== selected)] : restored;
    for (const { host, saved } of ordered) {
      // A chat dropped while an earlier one loaded is gone; setting up a session for it would leak one.
      if (views.panel(host.panelId) !== host) continue;
      await core.provider.restorePanel(host, restoredWorkspaceFolderKey(saved.state));
      this.restorePages(host, saved.pane.pages, saved.pane.activePage);
    }
    this.scheduleRetention();
  }

  // Reopens a chat's saved pages in its pane once the browser relaunches, which the remaining chats and the updater
  // do not wait for; the pane keeps its saved open state meanwhile and no page takes focus.
  private restorePages(chat: DesktopPanel, urls: readonly string[], activePage: number | undefined): void {
    if (urls.length === 0) return;
    const views = this.requireViews();
    this.requireCore().provider.getBrowserService().restoreChatPages(chat, urls, activePage)
      .catch(this.report('Restoring browser pages'))
      .finally(() => views.setRestoring(chat, false));
  }

  // Every chat main or core creates passes through here once, before it is shown.
  private trackChat(panel: DesktopPanel, projectKey: string): void {
    this.openedInProject.set(panel, projectKey);
    panel.onDispose(() => this.chatClosed(panel));
  }

  // A chat core opens itself (Open Chat, a fork, a dialog with no chat loaded) lands in the selected project,
  // which core uses as its default folder.
  private openCoreChat(options: PanelOptions): DesktopPanel {
    const views = this.requireViews();
    const host = views.create({ options });
    this.trackChat(host, this.selectedProjectKey ?? this.requireCore().provider.getFolderRegistry().defaultTarget().key);
    this.showChat(host, { focus: true });
    return host;
  }

  private async newChat(projectKey: string | undefined): Promise<void> {
    const core = this.requireCore();
    const views = this.requireViews();
    const key = projectKey ?? this.selectedProjectKey ?? core.provider.getFolderRegistry().defaultTarget().key;
    if (!this.isKnownProject(key)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    const host = views.create({ options: CHAT_PANEL });
    this.trackChat(host, key);
    this.showChat(host, { focus: true });
    await core.provider.restorePanel(host, key);
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
  private isKnownProject(key: string): boolean {
    if (this.projects.folders().some((folder) => folderKey(folder.fsPath) === key)) return true;
    return this.core.current()?.provider.getFolderRegistry().defaultTarget().key === key;
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

  private projectOf(panel: DesktopPanel): string | undefined {
    return this.chatInstances().get(panel)?.folder.key ?? this.openedInProject.get(panel);
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
  private async storedChat(sessionId: string): Promise<{ readonly session: StoredSession; readonly projectKey: string } | undefined> {
    const keys = [...new Set([this.selectedProjectKey, ...this.projects.folders().map((folder) => folderKey(folder.fsPath))])];
    for (const key of keys) {
      if (key === undefined) continue;
      const session = (await this.catalogList(key)).find((row) => row.id === sessionId);
      if (session) return { session, projectKey: key };
    }
    return undefined;
  }

  private async catalogList(projectKey: string): Promise<readonly StoredSession[]> {
    const rows = await this.requireCore().provider.getSessionCatalog().list(projectKey);
    this.catalogRows.set(projectKey, rows);
    return rows;
  }

  private refreshSelectedCatalog(): void {
    const key = this.selectedProjectKey;
    if (key === undefined || this.catalogRows.has(key) || !this.core.current()) return;
    this.catalogList(key).then(() => this.shellStateChanged(), this.report('Reading the chat list'));
  }

  private showChat(panel: DesktopPanel, options: { readonly focus: boolean }): void {
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

  private async selectChat(chatId: string): Promise<SelectChatResult> {
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
      const stored = await this.storedChat(chatId);
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
      await this.requireCore().provider.restorePanel(host, stored.projectKey);
      return { ok: true };
    });
  }

  private missingChat(): { ok: false; reason: 'missing' } {
    void this.notifications.info(this.requireLocalization().t('This chat no longer exists.'));
    return { ok: false, reason: 'missing' };
  }

  // The project's last viewed chat when it still exists, else a new chat in it.
  private async selectProject(key: string): Promise<void> {
    if (!this.isKnownProject(key)) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    const remembered = this.lastChatByProject.get(key);
    if (remembered !== undefined) {
      const loaded = this.loadedChat(remembered);
      if (loaded) {
        this.showChat(loaded, { focus: false });
        return;
      }
      if (!remembered.startsWith(NEW_CHAT_ID_PREFIX) && (await this.storedChat(remembered))?.projectKey === key) {
        const result = await this.selectChat(remembered);
        if (result.ok) return;
      }
    }
    await this.newChat(key);
  }

  private async selectRelativeChat(delta: 1 | -1): Promise<void> {
    const key = this.selectedProjectKey;
    const selected = this.views?.selected();
    if (key === undefined || !selected) return;
    const ids = (await this.listChats(key)).chats.map((chat) => chat.id);
    if (ids.length < 2) return;
    const current = ids.indexOf(this.chatIdOf(selected));
    if (current < 0) return;
    const target = ids[(current + delta + ids.length) % ids.length];
    if (target !== undefined) await this.selectChat(target);
  }

  private async listChats(projectKey: string): Promise<ShellChatList> {
    if (!this.isKnownProject(projectKey)) throw new Error('Unknown project');
    return this.chatList(projectKey, await this.catalogList(projectKey), true);
  }

  private async searchChats(projectKey: string, query: string): Promise<ShellChatList> {
    if (!this.isKnownProject(projectKey)) throw new Error('Unknown project');
    if (query.trim() === '') return this.listChats(projectKey);
    return this.chatList(projectKey, await this.requireCore().provider.getSessionCatalog().search(projectKey, query), false);
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
    return this.chatWork.run(chatId, async () => this.mutationResult(await this.requireCore().provider.getSessionCatalog().rename(chatId, name), 'rename'));
  }

  private async tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) return this.loadedChat(chatId) ? this.unwrittenChat() : this.missingChat();
    return this.chatWork.run(chatId, async () => this.mutationResult(await this.requireCore().provider.getSessionCatalog().tag(chatId, tag), 'tag'));
  }

  // Core deletes lease first and detaches every holder; the detached chat then unloads like any other.
  private async deleteChat(chatId: string): Promise<ChatMutationResult> {
    if (chatId.startsWith(NEW_CHAT_ID_PREFIX)) {
      const chat = this.loadedChat(chatId);
      if (!chat) return this.missingChat();
      chat.close();
      return { ok: true };
    }
    return this.chatWork.run(chatId, async () => {
      const holder = this.loadedChat(chatId);
      const result = this.mutationResult(await this.requireCore().provider.getSessionCatalog().delete(chatId), 'delete');
      if (result.ok && holder && !holder.isDisposed) holder.close();
      return result;
    });
  }

  // A chat left memory: by retention, Delete, or the window or core closing (which keep the saved selection).
  private chatClosed(panel: DesktopPanel): void {
    const projectKey = this.projectOf(panel);
    this.chatsChanged(projectKey);
    const views = this.views;
    if (!views || views.retainingStates || this.shutdown !== 'running' || views.selected() !== undefined) return;
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
    if (!views || !this.core.current() || views.retainingStates || this.shutdown !== 'running') return;
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
    if (!views || !this.core.current() || views.retainingStates || this.shutdown !== 'running') return [];
    const selected = views.selected();
    return chatsToUnload(views.chats().flatMap((chat) => {
      // A chat whose session core is still setting up is neither idle nor empty yet.
      if (this.corePanelIdOf(chat) === undefined) return [];
      return [{
        id: chat.panelId,
        selected: chat === selected,
        active: isActiveActivity(this.activityOf(chat)) || (chat.pane?.pages.length ?? 0) > 0 || chat.pane?.restoring === true,
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

  // A refusal or failure comes back as the reason the project list shows under the project.
  private async removeProject(key: string): Promise<RemoveProjectResult> {
    try {
      const project = this.projectByKey(key);
      const running = [...this.chatInstances().values()].some((instance) => instance.folder.key === key && instance.session.processing);
      if (running) {
        return { ok: false, reason: this.requireLocalization().t('A conversation is running in {0}. Stop it or wait for it to finish, then remove the project.', project.name) };
      }
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

  private async toggleTheme(): Promise<void> {
    await this.requirePlatform().settings.update(THEME_SETTING, currentThemeKind() === 'dark' ? 'light' : 'dark', 'user');
  }

  private shellActions(views: PanelViews, overlay: OverlayHost, window: BrowserWindow): ShellActions {
    return {
      state: () => this.shellState(views),
      addProject: reportFailure(() => this.addProject(), this.shellFailure('Add Project', 'Damocles could not add the project: {0}')),
      removeProject: (key) => this.removeProject(key),
      selectProject: reportFailure((key: string) => this.selectProject(key), this.shellFailure('Select Project', 'Damocles could not open the project: {0}')),
      grantTrust: reportFailure(async (key: string) => {
        await this.trust.requestTrust(this.projectByKey(key).fsPath);
      }, this.shellFailure('Trust Project', 'Damocles could not trust the project: {0}')),
      togglePane: () => {
        const selected = views.selected();
        if (selected) views.togglePane(selected.panelId);
      },
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
      openSettings: (section) => this.openSettings(section),
      setContentBounds: (bounds) => views.setContentBounds(bounds),
      setLayout: (reported) => {
        this.windowLayout.setSidebar({ ...reported, sidebarVisible: this.windowLayout.sidebar().sidebarVisible });
      },
      setFocusedPart: (part) => {
        this.shellFocusedPart = part;
        this.refreshMenuState();
      },
    };
  }

  // The bell's center marks every entry seen once the overlay shows it; choosing a row closes it, and main then runs the row's action.
  private async requestFromShell(overlay: OverlayHost, request: OverlayRequest, returnFocus: WebContents): Promise<OverlayAnswer> {
    const shown = request.kind === 'notifications' ? () => this.notificationCenter.markSeen() : undefined;
    const answer = await overlay.request(request, returnFocus, shown);
    if (answer.kind === 'notifications') this.notificationCenter.open(answer.entryId);
    return answer;
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
      await this.catalogList(projectKey).catch(this.report('Reading the chat list'));
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

  private shellState(views: PanelViews): ShellState {
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
      platform: shellPlatform(),
      projects,
      selected: { ...(projectKey !== undefined ? { projectKey } : {}), ...(selectedId !== undefined ? { chatId: selectedId } : {}) },
      ...(selected && selectedId !== undefined ? { selectedChat: { id: selectedId, title: this.titleOf(selected) } } : {}),
      effectiveTheme: currentThemeKind(),
      layout: this.windowLayout.sidebar(),
      ...(selected?.pane && this.browserEnabled() ? { pane: { open: selected.pane.open } } : {}),
      paneShortcutLabel: togglePaneShortcutLabel(),
      shortcuts: shellShortcutLabels(),
      notifications: this.notificationCenter.bell(),
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

  // undefined: every project's list. With no core (a reload or quit tore it down) there is no list to fetch; the next
  // core's chats announce themselves as they open and bind.
  private chatsChanged(projectKey?: string): void {
    const shell = this.shell;
    if (!shell || !this.core.current()) return;
    if (projectKey !== undefined) {
      shell.chatsChanged(projectKey);
      return;
    }
    for (const folder of this.projects.folders()) shell.chatsChanged(folderKey(folder.fsPath));
    const defaultKey = this.core.current()?.provider.getFolderRegistry().defaultTarget().key;
    if (defaultKey !== undefined) shell.chatsChanged(defaultKey);
  }

  private viewsChanged(): void {
    this.chatFoldersChanged.fire();
    this.overlaySettings?.selectionChanged();
    const selected = this.views?.selected();
    // A folder switch moves the selected chat, and the selection follows it to its new project.
    if (selected && this.projectOf(selected) !== this.selectedProjectKey) this.selectionChanged(selected);
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

  private focusedPart(): FocusPart | undefined {
    const views = this.views;
    if (!views) return undefined;
    if (this.notifier.focused) return 'toasts';
    if (views.paneFocused()) return 'pane';
    if (views.chatFocused()) return 'chat';
    return this.shell?.focused && this.shellFocusedPart === 'sidebar' ? 'sidebar' : undefined;
  }

  private menuState(): MenuState {
    return {
      chat: this.views?.selected() !== undefined,
      browser: this.browserEnabled(),
      page: this.views?.activePage() !== undefined,
      focus: this.focusedPart(),
    };
  }

  private refreshMenuState(): void {
    if (this.platform) updateMenuState(this.menuState());
  }

  // F6 and Shift+F6 move keyboard focus through the sidebar, the chat, the pane and the desktop popups while each is shown,
  // as VS Code's Focus Next Part does; Tab cannot leave a WebContents.
  private focusPart(delta: 1 | -1): void {
    const views = this.views;
    if (!views || !this.shell) return;
    const parts: FocusPart[] = [];
    if (this.windowLayout.sidebar().sidebarVisible) parts.push('sidebar');
    if (views.selected()) parts.push('chat');
    if (views.paneVisible()) parts.push('pane');
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
    else if (part === 'sidebar' && this.windowLayout.sidebar().sidebarVisible) this.shell?.focusSidebar();
    else if (part === 'pane' && views.paneVisible()) views.focusPane();
    else if (views.selected()) views.focusChat();
    else this.window?.webContents.focus();
  }

  // Each call that turns a reason on flashes again; the flash stops once no reason is left.
  private flash(reason: 'notifications' | 'overlay', on: boolean): void {
    if (on) this.flashReasons.add(reason);
    else if (!this.flashReasons.delete(reason) || this.flashReasons.size > 0) return;
    if (this.window && !this.window.isDestroyed()) this.window.flashFrame(on);
  }

  // Close Page closes the browser pane's active page while the pane holds focus; chats leave memory only by retention or Delete.
  private closePage(): void {
    const views = this.views;
    if (views?.paneFocused()) views.activePage()?.close();
  }

  private readonly chatTabs: ChatTabMessenger = {
    show: async (panelId, message) => {
      const views = this.requireViews();
      const panelManager = this.requireCore().provider.getPanelManager();
      const target = await resolveChatTab({
        panels: () => panelManager.getPanels(),
        selected: () => views.selected(),
        chats: () => views.chats(),
        openChat: () => panelManager.show(),
      }, panelId);
      target.host.reveal();
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
    const platform = this.requirePlatform();
    const report = (action: string) => this.report(action);
    installApplicationMenu(this.projects.folders(), {
      addProject: () => { this.addProject().catch(report('Add Project')); },
      newChat: () => { this.newChat(undefined).catch(report('New Chat')); },
      openChat: () => { this.requireCore().provider.show().catch(report('Open Chat')); },
      openChatForProject: (fsPath) => { this.newChat(folderKey(fsPath)).catch(report('Open Chat in Project')); },
      newSession: () => this.requireCore().provider.newSession(),
      cancelSession: () => this.requireCore().provider.cancelSession(),
      closePage: () => this.closePage(),
      toggleSidebar: () => this.toggleSidebar(),
      openSettings: () => this.openSettings(undefined),
      selectRelativeChat: (delta) => { this.selectRelativeChat(delta).catch(report('Select Chat')); },
      focusPart: (delta) => this.focusPart(delta),
      togglePromptNavigator: () => {
        if (this.views?.selected()) this.requireCore().provider.getPanelManager().postToActivePanel({ type: 'togglePromptNavigator' });
      },
      togglePane: () => {
        const selected = this.views?.selected();
        if (selected) this.views?.togglePane(selected.panelId);
      },
      toggleBrowserDevTools: () => this.views?.activePage()?.deliver({ type: 'openDevTools' }),
      setExploreApiKey: () => { setExploreApiKey(platform).catch(report('Set Explore API Key')); },
      showLog: () => showLog(),
    }, platform.localization, this.menuState());
  }

  private onBeforeQuit(event: Electron.Event): void {
    if (this.shutdown === 'done') return;
    event.preventDefault();
    if (this.shutdown === 'disposing') return;
    this.shutdown = 'disposing';
    log('[shutdown] quitting');
    if (this.window) this.saveWindowPlacement(this.window);
    void this.disposeAll().finally(() => {
      this.shutdown = 'done';
      log('[shutdown] disposed; closing the window');
      // A quit started in native code (Cmd+Q, the Dock, logout, CDP Browser.close) stores this handler's prevented result
      // only after the handler's microtasks have run, which overwrites a quit made from them; macOS then keeps running.
      setImmediate(() => app.quit());
    });
  }

  // The extension's deactivate chain (session list cache flush, lease release, sentinels, stores), bounded so a hung teardown cannot block quitting.
  private async disposeAll(): Promise<void> {
    this.views?.retainStatesOnClose(true);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log(`[shutdown] core dispose did not finish within ${DISPOSE_TIMEOUT_MS} ms; quitting anyway`);
        resolve();
      }, DISPOSE_TIMEOUT_MS);
    });
    await Promise.race([Promise.all([this.core.dispose(), this.windowLayout.flush()]), timedOut]);
    clearTimeout(timer);
    for (const disposable of this.disposables.reverse()) disposable.dispose();
    this.notificationCenter.dispose();
    this.taskbar.dispose();
    this.notifier.dispose();
    this.tray?.dispose();
    this.tray = undefined;
    this.platform?.fileWatchers.dispose();
    this.platform?.settings.dispose();
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
