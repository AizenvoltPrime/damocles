import * as path from 'node:path';
import { app, BrowserWindow, dialog, session } from 'electron';
import { installLogSink, log, showLog } from '../../core/logger';
import { installPlatform } from '../../core/platform-host';
import { restoredWorkspaceFolderKey } from '../../core/chat-panel/panel-manager';
import { LANGUAGE_PREFERENCE_KEY } from '../../core/chat-panel/message-router/index';
import type { HostInstance } from '../../core/chat-panel/types';
import { runLegacySettingsMigrations } from '../../core/config/legacy-settings-migrations';
import { setCheckpointGitAvailability } from '../../core/pi-session/checkpoints';
import { setExploreApiKey } from '../../core/pi-session/explore-api-key';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { Disposable } from '../../platform/disposable';
import type { PanelOptions } from '../../platform/window-service';
import type { RemoveProjectResult, ShellState, ShellTab } from '../preload/shell-channels';
import { startCore, type DesktopCore } from './bootstrap';
import { resolveChatTab } from './chat-tab-target';
import { parseUserDataDir } from './cli';
import { CoreHost } from './core-host';
import { installApplicationMenu, togglePaneShortcutLabel, updateMenuState, type MenuState } from './menu';
import { installCaCertificates } from './network/ca-certificates';
import { installProxyDispatcher } from './network/proxy-dispatcher';
import { PanelStateStore } from './panel-state-store';
import { createDesktopPlatform, type DesktopPlatform } from './platform';
import { unpackagedResourceRoot, type DesktopLayout } from './platform/app-paths';
import type { ChatTabMessenger } from './platform/editor-service';
import { createDesktopKeyValueState, type DesktopKeyValueState } from './platform/key-value-state';
import { createDesktopLocalizationService, normalizeLanguage, type DesktopLocalizationService } from './platform/localization-service';
import { createDesktopLogSinkFactory } from './platform/log-sink';
import { createDesktopNotificationService } from './platform/notification-service';
import { logUncaughtErrors } from './process-errors';
import { ProjectList } from './projects';
import { appResourceUri, handleAppProtocol, registerAppScheme } from './protocol';
import { restrictPermissions, hardenWebContents } from './security';
import { paneHtml } from './pane';
import { reportFailure, ShellHost, shellHtml, type ShellActions } from './shell';
import { mergeLoginShellEnv, probeGit } from './shell-env';
import { currentTheme, currentThemeKind, onThemeChange } from './theme';
import { AppTray } from './tray';
import { TrustStore } from './trust-store';
import { loadAutoUpdater, startUpdater } from './updater';
import { PanelViews, THEME_BACKGROUND, type DesktopPanel, type PaneContext } from './views';

// electron-builder.yml appId: the Windows AppUserModelID, the macOS bundle id and the update identity. The unpackaged app's own
// ID keeps its Start Menu shortcut, which Windows reads for the taskbar icon and notifications, apart from an installed copy's.
const APP_ID = app.isPackaged ? 'io.github.aizenvoltprime.damocles' : 'io.github.aizenvoltprime.damocles.dev';
// The packaged package.json name. The unpackaged app sets it too, or Electron names it "Electron" and it shares its
// userData folder and safeStorage key with every other unpackaged Electron app.
// The unpackaged app never shares userData, the safeStorage key or the single-instance lock with an installed copy.
const APP_NAME = app.isPackaged ? 'damocles' : 'damocles-dev';
const DISPOSE_TIMEOUT_MS = 10_000;
const CHAT_PANEL: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [] };
const BROWSER_ENABLED_KEY = 'damocles.browser.enabled';

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

const layout: DesktopLayout = app.isPackaged
  ? { packaged: true, asarPath: app.getAppPath() }
  : { packaged: false, repoRoot: unpackagedResourceRoot(__dirname) };
const resourceRoot = layout.packaged ? layout.asarPath : layout.repoRoot;

class DesktopApp {
  private readonly userDataDir = app.getPath('userData');
  private readonly logSinks = createDesktopLogSinkFactory(path.join(this.userDataDir, 'logs'), !app.isPackaged);
  private readonly logSink = this.logSinks.create('Damocles');
  private readonly states: PanelStateStore;
  private readonly projects: ProjectList;
  private readonly state: DesktopKeyValueState;
  private readonly trust: TrustStore;
  private readonly notifications = createDesktopNotificationService({
    window: () => this.window,
    toasts: () => this.shell?.toastSink,
    showWindow: () => this.showWindow(),
    t: (message) => this.requireLocalization().t(message),
    log: (line) => log(line),
  });
  private readonly core = new CoreHost<DesktopCore>({
    start: () => this.startCoreServices(),
    openTabs: () => this.openInitialTabs(),
    retainTabStates: (retain) => this.views?.retainStatesOnClose(retain),
    log: (line) => log(line),
  });
  private localization: DesktopLocalizationService | undefined;
  private window: BrowserWindow | undefined;
  private views: PanelViews | undefined;
  private shell: ShellHost | undefined;
  private tray: AppTray | undefined;
  private platform: DesktopPlatform | undefined;
  private readonly disposables: Disposable[] = [];
  private shutdown: 'running' | 'disposing' | 'done' = 'running';

  // The stores log what they skip while reading their files, so they are read only once the log sink is installed.
  constructor() {
    installLogSink(this.logSink);
    logUncaughtErrors(process, (line) => log(line));
    this.states = new PanelStateStore(this.userDataDir, (line) => log(line));
    this.projects = new ProjectList(this.userDataDir, (line) => log(line));
    this.state = createDesktopKeyValueState(this.userDataDir, (line) => log(line));
    this.trust = new TrustStore(this.userDataDir, () => this.window, (message, ...args) => this.requireLocalization().t(message, ...args), (line) => log(line));
  }

  async start(): Promise<void> {
    const bootLog = (line: string): void => log(line);
    app.on('second-instance', () => this.showWindow());
    app.on('web-contents-created', (_event, contents) => {
      hardenWebContents(contents, (url) => this.requirePlatform().shell.openExternal(url), bootLog);
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
    const localization = createDesktopLocalizationService(resourceRoot, this.preferredLanguage(), bootLog);
    this.localization = localization;
    const git = await probeGit(bootLog, (message, ...args) => localization.t(message, ...args));
    setCheckpointGitAvailability(git);
    restrictPermissions(session.defaultSession);
    handleAppProtocol(resourceRoot, {
      panel: (panelId) => this.views?.htmlFor(panelId),
      shell: () => shellHtml(currentTheme()),
      pane: () => paneHtml(currentTheme()),
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
      prompts: () => this.core.current()?.provider.getWebviewPrompts(),
      chatTabs: this.chatTabs,
      reload: () => this.core.reload(),
      log: bootLog,
    });
    installPlatform(this.platform);
    log(`Damocles desktop starting (version ${this.platform.appInfo.version}, Electron ${process.versions.electron}, userData ${this.userDataDir})`);

    this.disposables.push(
      onThemeChange((theme) => {
        this.views?.broadcastTheme(theme);
        this.shell?.sendTheme(theme);
      }),
      this.projects.onDidChange(() => {
        this.installMenu();
        this.shellStateChanged();
      }),
      this.trust.onDidGrant(() => this.shellStateChanged()),
      this.platform.settings.onDidChange('damocles', (change) => {
        if (change.affects(BROWSER_ENABLED_KEY)) this.views?.browserEnabledChanged();
      }),
      this.state.onDidChange('global', LANGUAGE_PREFERENCE_KEY, () => localization.setLanguage(this.preferredLanguage())),
      localization.onDidChangeLanguage(() => {
        this.installMenu();
        this.tray?.relocalize();
        this.tabsChanged();
        this.views?.pane.stateChanged();
      }),
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
    this.core.start();
    this.createWindow();
    this.tray = new AppTray(path.join(resourceRoot, 'resources', 'icon.png'), {
      windowVisible: () => this.window?.isVisible() ?? false,
      toggleWindow: () => {
        if (this.window?.isVisible()) this.window.hide();
        else this.showWindow();
      },
      newConversation: () => {
        this.showWindow();
        this.requireCore().provider.show().catch(this.report('New Conversation'));
      },
      quit: () => app.quit(),
    }, localization);
    await this.openInitialTabs();

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

  // The webview's language choice when the user made one, else the OS locale; the webview normalizes what it stores.
  private preferredLanguage(): 'en' | 'el' {
    return normalizeLanguage(this.state.global.get<string>(LANGUAGE_PREFERENCE_KEY) ?? app.getLocale());
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
    const subscriptions = [
      core.provider.getFolderRegistry().onDidChange(() => this.shellStateChanged()),
      core.provider.getPanelManager().onAllPanelsClosed(() => log('[tabs] the last chat tab closed')),
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
    const window = new BrowserWindow({
      width: 1200,
      height: 820,
      minWidth: 480,
      minHeight: 360,
      title: 'Damocles',
      icon: path.join(resourceRoot, 'resources', 'icon.png'),
      backgroundColor: THEME_BACKGROUND[currentThemeKind()],
      webPreferences: {
        preload: path.join(__dirname, 'preload-shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const views = new PanelViews(
      {
        window,
        preloadPath: path.join(__dirname, 'preload-panel.js'),
        panePreloadPath: path.join(__dirname, 'preload-pane.js'),
        states: this.states,
        log: (line) => log(line),
        onChange: () => this.tabsChanged(),
        onRendererGaveUp: (panel) => this.tabGaveUp(panel),
        onPaneGaveUp: () => this.paneGaveUp(views),
        paneContext: () => this.paneContext(),
      },
      (absolutePath) => appResourceUri(resourceRoot, absolutePath),
    );
    const shell: ShellHost = new ShellHost(window, this.shellActions(views), (line) => log(line), () => this.shellGaveUp(shell));
    // Closing the window closes its tabs but keeps their state, so the next window or launch restores them.
    window.on('close', () => {
      views.retainStatesOnClose(true);
      for (const panelId of views.panelIds()) views.panel(panelId)?.close();
    });
    window.on('closed', () => {
      log('[window] closed');
      shell.dispose();
      views.dispose();
      if (this.window === window) {
        this.window = undefined;
        this.views = undefined;
        this.shell = undefined;
      }
      this.tray?.relocalize();
    });
    window.on('show', () => this.tray?.relocalize());
    window.on('hide', () => this.tray?.relocalize());
    this.window = window;
    this.views = views;
    this.shell = shell;
    shell.load();
  }

  private tabGaveUp(panel: DesktopPanel): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Tab');
    this.notifications.error(t('A tab stopped working because its page kept crashing.'), reload).then((answer) => {
      if (answer === reload) panel.restart();
    }, this.report('Reporting a crashed tab'));
  }

  private paneGaveUp(views: PanelViews): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Browser Pane');
    this.notifications.error(t('The browser pane stopped working because its page kept crashing.'), reload).then((answer) => {
      if (answer === reload) views.pane.restart();
    }, this.report('Reporting a crashed browser pane'));
  }

  // The toasts render in the page that crashed, so a native dialog asks instead.
  private shellGaveUp(shell: ShellHost): void {
    const { t } = this.requireLocalization();
    const reload = t('Reload Window');
    this.notifications.error(t('The Damocles window stopped working because its page kept crashing.'), { modal: true }, reload).then((answer) => {
      if (answer === reload) shell.restart();
    }, this.report('Reporting a crashed window'));
  }

  // A second launch, a tray click or a macOS dock click: focus the window, or reopen it with its tabs when it was closed.
  private showWindow(): void {
    if (!this.core.current()) return;
    if (!this.window) {
      this.createWindow();
      this.openInitialTabs().catch(this.report('Reopening tabs'));
      return;
    }
    const window = this.window;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private async openInitialTabs(): Promise<void> {
    const core = this.requireCore();
    const views = this.requireViews();
    const persisted = this.states.list();
    const selected = this.states.selected();
    if (!persisted.some((panel) => panel.kind === 'chat')) {
      await core.provider.show();
    }
    for (const panel of persisted) {
      const host = views.create({ options: CHAT_PANEL, restore: { panelId: panel.panelId, state: panel.state } });
      await core.provider.restorePanel(host, restoredWorkspaceFolderKey(panel.state));
      this.restorePages(host, panel.pane.pages, panel.pane.activePage);
    }
    if (selected !== undefined && views.panel(selected)) views.show(selected, { focus: true });
  }

  // Reopens a chat tab's saved pages in its pane once the browser relaunches, which the remaining tabs and the updater
  // do not wait for; the pane keeps its saved open state meanwhile and no page takes focus.
  private restorePages(chat: DesktopPanel, urls: readonly string[], activePage: number | undefined): void {
    if (urls.length === 0) return;
    const views = this.requireViews();
    views.setRestoring(chat, true);
    this.requireCore().provider.getBrowserService().restoreChatPages(chat, urls, activePage)
      .catch(this.report('Restoring browser pages'))
      .finally(() => views.setRestoring(chat, false));
  }

  private async openChatForProject(fsPath: string): Promise<void> {
    const host = this.requireViews().create({ options: CHAT_PANEL });
    await this.requireCore().provider.restorePanel(host, folderKey(fsPath));
  }

  private async addProject(): Promise<void> {
    const platform = this.requirePlatform();
    const folder = await platform.dialogs.pickFolder({ title: platform.localization.t('Add Project') });
    if (folder === undefined) return;
    await this.projects.add(folder);
    if (!this.trust.isTrusted(folder)) await this.trust.requestTrust(folder);
    await this.openChatForProject(folder);
  }

  // Keys from the shell are matched against the project list; a renderer string is never used as a path.
  private projectByKey(key: string): { fsPath: string; name: string } {
    const project = this.projects.folders().find((folder) => folderKey(folder.fsPath) === key);
    if (!project) throw new Error(this.requireLocalization().t('The project is no longer in the project list.'));
    return project;
  }

  private chatInstances(): Map<unknown, HostInstance> {
    const panels = this.core.current()?.provider.getPanelManager().getPanels();
    return new Map([...(panels?.values() ?? [])].map((instance) => [instance.host, instance]));
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

  private shellFailure(action: string, message: string): (err: unknown) => void {
    return (err) => {
      log(`[shell] ${action} failed: ${errorText(err)}`);
      void this.notifications.error(this.requireLocalization().t(message, errorMessage(err)));
    };
  }

  private shellActions(views: PanelViews): ShellActions {
    const tab = (id: string): DesktopPanel => {
      const panel = views.panel(id);
      if (!panel) throw new Error('Unknown tab');
      return panel;
    };
    return {
      state: () => this.shellState(views),
      addProject: reportFailure(() => this.addProject(), this.shellFailure('Add Project', 'Damocles could not add the project: {0}')),
      removeProject: (key) => this.removeProject(key),
      selectProject: reportFailure(async (key: string) => {
        this.projectByKey(key);
        if (!(await this.requireCore().provider.getFolderRegistry().setDefault(key))) throw new Error(this.requireLocalization().t('The project is not open.'));
      }, this.shellFailure('Select Project', 'Damocles could not change the default project: {0}')),
      grantTrust: reportFailure(async (key: string) => {
        await this.trust.requestTrust(this.projectByKey(key).fsPath);
      }, this.shellFailure('Trust Project', 'Damocles could not trust the project: {0}')),
      newTab: reportFailure(async (projectKey: string | undefined) => {
        if (projectKey === undefined) await this.requireCore().provider.show();
        else await this.openChatForProject(this.projectByKey(projectKey).fsPath);
      }, this.shellFailure('New Tab', 'Damocles could not open a new conversation: {0}')),
      selectTab: (id) => views.show(tab(id).panelId, { focus: true }),
      closeTab: (id) => views.close(tab(id).panelId, { focusFallback: false }),
      togglePane: (id) => views.togglePane(tab(id).panelId),
      moveTab: (id, toIndex) => {
        if (toIndex < 0 || toIndex >= views.panelIds().length) throw new Error('Tab index out of range');
        views.move(tab(id).panelId, toIndex);
      },
      setContentBounds: (bounds) => views.setContentBounds(bounds),
      resolveToast: (id, action) => this.notifications.resolveToast(id, action),
      pendingToasts: () => this.notifications.pendingToasts(),
    };
  }

  private shellState(views: PanelViews): ShellState {
    const registry = this.core.current()?.provider.getFolderRegistry();
    const defaultKey = registry?.defaultTarget().key;
    const projects = this.projects.folders().map((folder) => {
      const key = folderKey(folder.fsPath);
      return {
        key,
        name: registry?.resolve(key)?.label ?? folder.name,
        fsPath: folder.fsPath,
        trusted: this.trust.isTrusted(folder.fsPath),
        isDefault: key === defaultKey,
      };
    });
    const instances = this.chatInstances();
    const tabs = views.tabs().map((panel): ShellTab => {
      const folder = instances.get(panel)?.folder;
      return {
        id: panel.panelId,
        title: panel.chatTitle?.title ?? '',
        ...(folder?.projectScope ? { projectKey: folder.key, projectName: folder.label } : {}),
        busy: panel.chatTitle?.busy ?? false,
      };
    });
    const selected = views.selected();
    return {
      locale: this.requireLocalization().language,
      platform: shellPlatform(),
      projects,
      tabs,
      ...(selected !== undefined ? { selectedTabId: selected.panelId } : {}),
      ...(selected?.pane && this.browserEnabled() ? { pane: { open: selected.pane.open } } : {}),
      paneShortcutLabel: togglePaneShortcutLabel(),
    };
  }

  private shellStateChanged(): void {
    this.shell?.stateChanged();
  }

  private tabsChanged(): void {
    this.shellStateChanged();
    updateMenuState(this.menuState());
    const selected = this.views?.selected();
    if (!selected || !this.window || this.window.isDestroyed()) return;
    const title = selected.chatTitle?.title;
    this.window.setTitle(title ? `${title} - Damocles` : 'Damocles');
  }

  private menuState(): MenuState {
    return {
      chat: this.views?.selected() !== undefined,
      browser: this.browserEnabled(),
      page: this.views?.activePage() !== undefined,
    };
  }

  // F6 and Shift+F6 move keyboard focus through the tab strip, the chat and the pane while it is shown, as VS Code's
  // Focus Next Part does; Tab cannot leave a WebContents.
  private focusPart(delta: 1 | -1): void {
    const views = this.views;
    const shell = this.shell;
    if (!views || !shell) return;
    const parts: Array<'strip' | 'chat' | 'pane'> = ['strip'];
    if (views.selected()) parts.push('chat');
    if (views.paneVisible()) parts.push('pane');
    const current = views.paneFocused() ? 'pane' : views.chatFocused() ? 'chat' : 'strip';
    const next = parts[(Math.max(parts.indexOf(current), 0) + delta + parts.length) % parts.length];
    if (next === 'pane') views.focusPane();
    else if (next === 'chat') views.focusChat();
    else shell.focusTabStrip();
  }

  // With focus in the pane, Close Tab closes the active page rather than the whole chat tab and its pages.
  private closeFocusedTab(): void {
    const views = this.views;
    if (!views) return;
    const page = views.paneFocused() ? views.activePage() : undefined;
    if (page) page.close();
    else views.selected()?.close();
  }

  private readonly chatTabs: ChatTabMessenger = {
    show: async (panelId, message) => {
      const views = this.requireViews();
      const panelManager = this.requireCore().provider.getPanelManager();
      const target = await resolveChatTab({
        panels: () => panelManager.getPanels(),
        selected: () => views.selected(),
        tabs: () => views.tabs(),
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
      newTab: () => { this.requireCore().provider.show().catch(report('New Tab')); },
      openChat: () => { this.requireCore().provider.show().catch(report('Open Chat')); },
      openChatForProject: (fsPath) => { this.openChatForProject(fsPath).catch(report('Open Chat in Project')); },
      newSession: () => this.requireCore().provider.newSession(),
      cancelSession: () => this.requireCore().provider.cancelSession(),
      closeTab: () => this.closeFocusedTab(),
      selectRelativeTab: (delta) => this.views?.selectRelative(delta),
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
    await Promise.race([this.core.dispose(), timedOut]);
    clearTimeout(timer);
    for (const disposable of this.disposables.reverse()) disposable.dispose();
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
