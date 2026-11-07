import type { HostCapabilities } from '../shared/types/messages';
import type { AppInfo } from './app-info';
import type { AppPaths } from './app-paths';
import type { ClipboardService } from './clipboard-service';
import type { DesignHost } from './design-host';
import type { DesignPreviewHost } from './design-preview';
import type { DialogService } from './dialog-service';
import type { EditorService } from './editor-service';
import type { FileConfinement } from './file-confinement';
import type { FileWatcherFactory } from './file-watcher';
import type { HostLifecycle } from './host-lifecycle';
import type { KeyValueState } from './key-value-state';
import type { LocalizationService } from './localization-service';
import type { LogSinkFactory } from './log-sink';
import type { NotificationService } from './notification-service';
import type { RemoteHost } from './remote-host';
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
  readonly confinement: FileConfinement;
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
  // set only for a daemon's core (desktop CoreInit.remote): user scope, AI sign-ins and the trash are the client's, not this host's
  readonly remote?: RemoteHost;
  // set only where a chat's own buttons open designs in the browser (VS Code); never on desktop (PD-35)
  readonly design?: DesignHost;
  // set only where a design opens in a preview tab (desktop, a daemon's core included)
  readonly designPreview?: DesignPreviewHost;
}
