import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Platform } from '../../../platform/platform';
import type { LogSinkFactory } from '../../../platform/log-sink';
import type { NotificationService } from '../../../platform/notification-service';
import type { PanelHost, PanelOptions, WindowService } from '../../../platform/window-service';
import type { WebviewPrompts } from '../../../core/chat-panel/webview-prompts';
import { readContributedConfiguration } from '../../../core/config/contributed-configuration';
import { DAMOCLES_HOME_DIR } from '../../../core/paths';
import { withVolatileSecretsNotice } from '../../../core/volatile-secrets-notice';
import { defaultProjectPath, DEFAULT_WORKSPACE_FOLDER_STATE_KEY } from '../../../core/workspace-folders/folder-registry';
import type { ProjectList } from '../projects';
import type { TrustStore } from '../trust-store';
import type { PanelViews } from '../views';
import { createDesktopAppInfo } from './app-info';
import { createDesktopAppPaths, type DesktopLayout } from './app-paths';
import { desktopHostCapabilities } from './capabilities';
import { createDesktopClipboardService } from './clipboard-service';
import { createDesktopDialogService } from './dialog-service';
import { createDesktopEditorService, type ChatTabMessenger } from './editor-service';
import { DesktopFileWatcherFactory } from './file-watcher-factory';
import { createDesktopHostLifecycle } from './host-lifecycle';
import type { DesktopKeyValueState } from './key-value-state';
import type { DesktopLocalizationService } from './localization-service';
import { createDesktopSecretsStore } from './secrets-store';
import { DesktopSettingsStore, type ChatFolders } from './settings-store';
import { createDesktopShellService } from './shell-service';
import { createDesktopTrustService } from './trust-service';
import { createDesktopWindowService } from './window-service';
import { createDesktopWorkspaceFolders } from './workspace-folders';

export interface DesktopPlatformDeps {
  readonly userDataDir: string;
  readonly layout: DesktopLayout;
  readonly logSinks: LogSinkFactory;
  readonly localization: DesktopLocalizationService;
  readonly state: DesktopKeyValueState;
  readonly notifications: NotificationService;
  readonly projects: ProjectList;
  readonly trust: TrustStore;
  readonly window: () => BrowserWindow | undefined;
  readonly views: () => PanelViews;
  // a chat core opens (Open Chat, a fork): created in the selected project and selected
  readonly openChat: (options: PanelOptions) => PanelHost;
  // shows the settings modal in the overlay, attached to the selected chat
  readonly openAppSettings: WindowService['openAppSettings'];
  // undefined while the core services are being (re)built
  readonly prompts: () => WebviewPrompts | undefined;
  // posts to a chat, opening one in the selected project when none is loaded
  readonly chatTabs: ChatTabMessenger;
  readonly chatFolders: ChatFolders;
  readonly reload: () => Promise<void>;
  // lines logged before the core log sink is installed
  readonly log: (line: string) => void;
}

export interface DesktopPlatform extends Platform {
  readonly settings: DesktopSettingsStore;
  readonly state: DesktopKeyValueState;
  readonly fileWatchers: DesktopFileWatcherFactory;
  readonly localization: DesktopLocalizationService;
}

// Built once per app run; a host reload rebuilds the core services on top of the same platform.
export function createDesktopPlatform(deps: DesktopPlatformDeps): DesktopPlatform {
  const workspaceFolders = createDesktopWorkspaceFolders(deps.projects);
  const fileWatchers = new DesktopFileWatcherFactory(workspaceFolders, deps.log);
  const shell = createDesktopShellService(deps.log);
  const trust = createDesktopTrustService(deps.trust);
  const paths = createDesktopAppPaths(deps.layout);
  const { state, notifications } = deps;
  return {
    // Read on every handshake, so a test can stand in for macOS by redefining process.platform in main.
    get capabilities() {
      return desktopHostCapabilities(process.platform);
    },
    settings: new DesktopSettingsStore({
      userFile: path.join(DAMOCLES_HOME_DIR, 'settings.json'),
      contributed: readContributedConfiguration(paths.resourceRoot),
      fileWatchers,
      projects: workspaceFolders,
      trust,
      defaultProject: {
        folder: () => defaultProjectPath(workspaceFolders, state.workspace),
        onDidChange: (cb) => state.onDidChange('workspace', DEFAULT_WORKSPACE_FOLDER_STATE_KEY, cb),
      },
      chatFolders: deps.chatFolders,
      notifications,
      localization: deps.localization,
      log: deps.log,
    }),
    secrets: withVolatileSecretsNotice(createDesktopSecretsStore(deps.userDataDir, notifications, deps.localization.t, deps.log), notifications, shell),
    state,
    trust,
    workspaceFolders,
    fileWatchers,
    notifications,
    paths,
    appInfo: createDesktopAppInfo(deps.layout),
    localization: deps.localization,
    clipboard: createDesktopClipboardService(),
    shell,
    dialogs: createDesktopDialogService(deps.window, deps.prompts),
    editor: createDesktopEditorService(deps.chatTabs, deps.openAppSettings),
    window: createDesktopWindowService(deps.views, deps.openChat, deps.openAppSettings),
    lifecycle: createDesktopHostLifecycle(deps.reload),
    logSinks: deps.logSinks,
  };
}
