import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BrowserWindow } from 'electron';
import type { LogSinkFactory } from '../../../platform/log-sink';
import type { NotificationService } from '../../../platform/notification-service';
import type { WindowService } from '../../../platform/window-service';
import { readContributedConfiguration } from '../../../core/config/read-contributed-configuration';
import { DAMOCLES_HOME_DIR } from '../../../core/paths';
import { withVolatileSecretsNotice } from '../../../core/volatile-secrets-notice';
import { defaultProjectPath, DEFAULT_WORKSPACE_FOLDER_STATE_KEY } from '../../../core/workspace-folders/folder-registry';
import type { ProjectList } from '../projects';
import type { TrustStore } from '../trust-store';
import { createDesktopAppInfo } from './app-info';
import { createDesktopAppPaths, watchWorkerPath, type DesktopLayout } from './app-paths';
import { desktopHostCapabilities } from '../../local-services/capabilities';
import { createDesktopClipboardService } from './clipboard-service';
import { createDesktopDialogService } from './dialog-service';
import { createDesktopEditorService, type ChatTabMessenger, type DesktopEditorService } from './editor-service';
import type { EditorService } from '../../../platform/editor-service';
import type { Platform } from '../../../platform/platform';
import type { EditorPane } from '../editor-pane';
import { createDesktopFileConfinement } from '../../local-services/file-confinement';
import { DesktopFileWatcherFactory } from '../../local-services/file-watcher-factory';
import { createDesktopHostLifecycle } from './host-lifecycle';
import type { DesktopKeyValueState } from '../../local-services/key-value-state';
import type { DesktopLocalizationService } from '../../local-services/localization-service';
import { createDesktopSecretsStore } from './secrets-store';
import { DesktopSettingsStore, type ChatFolders } from '../../local-services/settings-store';
import { createDesktopShellService } from './shell-service';
import { createDesktopTrustService } from './trust-service';
import { createWorkerTreeHost } from '../../local-services/watch-worker-host';
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
  // shows the settings modal in the overlay, attached to the selected chat
  readonly openAppSettings: WindowService['openAppSettings'];
  // the Toggle Terminal command, for the chat header's Terminal toggle
  readonly toggleTerminal: WindowService['toggleTerminal'];
  readonly terminalToggle: WindowService['terminalToggle'];
  // posts to a chat, opening one in the selected project when none is loaded
  readonly chatTabs: ChatTabMessenger;
  // the window-wide editor pane; it exists from the platform's creation on
  readonly editorPane: () => EditorPane;
  // opens or focuses the chat's review tab (D60) in the editor pane
  readonly showChatReview: EditorService['showChatReview'];
  readonly chatFolders: ChatFolders;
  readonly reload: () => Promise<void>;
  // lines logged before the core log sink is installed
  readonly log: (line: string) => void;
}

export interface DesktopPlatform extends Platform {
  readonly editor: DesktopEditorService;
  readonly settings: DesktopSettingsStore;
  readonly state: DesktopKeyValueState;
  readonly fileWatchers: DesktopFileWatcherFactory;
  readonly localization: DesktopLocalizationService;
  // Settles once the settings and secrets stores' writes, one queued meanwhile included, have landed or failed; a quit awaits it.
  flush(): Promise<void>;
}

// Built once per app run and kept across core restarts; each core builds its own platform (core-host/platform).
export function createDesktopPlatform(deps: DesktopPlatformDeps): DesktopPlatform {
  const workspaceFolders = createDesktopWorkspaceFolders(deps.projects);
  const paths = createDesktopAppPaths(deps.layout);
  const windowsTree = createWorkerTreeHost(() => new Worker(watchWorkerPath(paths)), deps.log);
  const fileWatchers = new DesktopFileWatcherFactory(workspaceFolders, deps.log, windowsTree);
  const shell = createDesktopShellService(deps.log);
  const trust = createDesktopTrustService(deps.trust);
  const { state, notifications } = deps;
  const secrets = createDesktopSecretsStore(deps.userDataDir, notifications, deps.localization.t, deps.log);
  const settings = new DesktopSettingsStore({
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
    // Core's store reports a file that stops parsing: it reads every folder a loaded chat uses, main's only those main reads.
    notifications: undefined,
    localization: deps.localization,
    log: deps.log,
  });
  return {
    // Main answers no handshake; core reads its own capabilities (core-host/local.ts), which e2e.setPlatform replaces.
    capabilities: desktopHostCapabilities(process.platform),
    settings,
    secrets: withVolatileSecretsNotice(secrets, notifications, shell),
    state,
    trust,
    workspaceFolders,
    fileWatchers,
    confinement: createDesktopFileConfinement(),
    notifications,
    paths,
    appInfo: createDesktopAppInfo(deps.layout),
    localization: deps.localization,
    clipboard: createDesktopClipboardService(),
    shell,
    dialogs: createDesktopDialogService(deps.window),
    editor: createDesktopEditorService(deps.chatTabs, deps.editorPane, deps.openAppSettings, deps.showChatReview),
    window: createDesktopWindowService(deps.openAppSettings, deps.toggleTerminal, deps.terminalToggle),
    lifecycle: createDesktopHostLifecycle(deps.reload),
    logSinks: deps.logSinks,
    flush: async () => {
      await Promise.all([settings.flush(), secrets.flush()]);
    },
  };
}
