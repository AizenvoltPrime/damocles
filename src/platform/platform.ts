import type { HostCapabilities } from '../shared/types/messages';
import type { AppInfo } from './app-info';
import type { AppPaths } from './app-paths';
import type { ClipboardService } from './clipboard-service';
import type { DialogService } from './dialog-service';
import type { EditorService } from './editor-service';
import type { FileWatcherFactory } from './file-watcher';
import type { HostLifecycle } from './host-lifecycle';
import type { KeyValueState } from './key-value-state';
import type { LocalizationService } from './localization-service';
import type { LogSinkFactory } from './log-sink';
import type { NotificationService } from './notification-service';
import type { SecretsStore } from './secrets-store';
import type { SettingsStore } from './settings-store';
import type { ShellService } from './shell-service';
import type { TrustService } from './trust-service';
import type { WindowService } from './window-service';
import type { WorkspaceFolders } from './workspace-folders';

export interface Platform {
  // the affordances this host offers the webview (hostCapabilities handshake); a new host affordance is a flag here
  readonly capabilities: HostCapabilities;
  readonly settings: SettingsStore;
  readonly secrets: SecretsStore;
  readonly state: KeyValueState;
  readonly trust: TrustService;
  readonly workspaceFolders: WorkspaceFolders;
  readonly fileWatchers: FileWatcherFactory;
  readonly notifications: NotificationService;
  readonly paths: AppPaths;
  readonly appInfo: AppInfo;
  readonly localization: LocalizationService;
  readonly clipboard: ClipboardService;
  readonly shell: ShellService;
  readonly dialogs: DialogService;
  readonly editor: EditorService;
  readonly window: WindowService;
  readonly lifecycle: HostLifecycle;
  readonly logSinks: LogSinkFactory;
}
