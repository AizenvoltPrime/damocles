import { log } from '../../../core/logger';
import type { PlatformWithWorktrees, WorktreeHostServices } from '../../../core/worktrees/host';
import type { AppPaths } from '../../../platform/app-paths';
import type { DialogService } from '../../../platform/dialog-service';
import type { FileConfinement } from '../../../platform/file-confinement';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { LocalizationService } from '../../../platform/localization-service';
import type { LogSinkFactory } from '../../../platform/log-sink';
import type { NotificationService } from '../../../platform/notification-service';
import type { SettingsStore } from '../../../platform/settings-store';
import type { TrustService } from '../../../platform/trust-service';
import type { WorkspaceFolders } from '../../../platform/workspace-folders';
import type { HostCapabilities } from '../../../shared/types/messages';
import { createCoreEndpoint, type CoreEndpoint, type CoreInit, type CoreProtocolError, type CoreTransport } from '../../core-protocol';
import { createEditorProxy } from './editor';
import { createFoldersMirror, createStateMirror, createTrustMirror, type StateMirror } from './mirrored';
import { createCorePanels, type CorePanels } from './panels';
import { createClipboardProxy, createDialogsProxy, createLifecycleProxy, createNotificationsProxy, createSecretsProxy, createShellProxy, type ChatPrompts } from './proxied';
import { createWindowProxy } from './window';

/** The services core's process holds an instance of itself (docs/invariants.md "Platform boundary"). */
export interface CoreLocalServices {
  // a function of the OS core runs on, read on every handshake
  readonly capabilities: () => HostCapabilities;
  readonly settings: SettingsStore;
  readonly fileWatchers: FileWatcherFactory;
  readonly confinement: FileConfinement;
  readonly localization: LocalizationService;
  readonly logSinks: LogSinkFactory;
  readonly paths: AppPaths;
}

/** What core's local services are built over: the channel, the init, and the mirrors and proxies of main's services. */
export interface CoreShared {
  readonly endpoint: CoreEndpoint;
  readonly init: CoreInit;
  readonly workspaceFolders: WorkspaceFolders;
  readonly trust: TrustService;
  readonly state: StateMirror;
  readonly notifications: NotificationService;
}

export interface CorePlatform extends PlatformWithWorktrees {
  readonly dialogs: DialogService;
  readonly state: StateMirror;
  // the channel to main, which core's service (core-service.ts) serves main's requests on
  readonly endpoint: CoreEndpoint;
  readonly panels: CorePanels;
  readonly init: CoreInit;
  // Chromium's proxy for a URL, from main's session
  resolveProxy(url: string): Promise<string>;
  // Text input and quick picks render in a chat (WebviewPrompts), which the running ChatPanelProvider owns.
  setChatPrompts(prompts: ChatPrompts | undefined): void;
  // Worktree chats' services, built once core's source control exists; trust and Platform.worktrees read them from then on.
  setWorktrees(worktrees: WorktreeHostServices): void;
  // Rejects pending calls and stops reading the channel.
  dispose(): void;
}

/**
 * The engine's Platform: local services, mirrors of main's state and proxies of main's services, over one core channel.
 * init is main's first message as parseCoreInit parsed it; onViolation decides what a message outside the contract does.
 */
export function createCorePlatform(
  channel: CoreTransport,
  init: CoreInit,
  createLocal: (shared: CoreShared) => CoreLocalServices,
  onViolation?: (error: CoreProtocolError) => void,
): CorePlatform {
  const endpoint = createCoreEndpoint(channel, (line) => log(line), onViolation);
  let worktrees: WorktreeHostServices | undefined;
  const trust = createTrustMirror(endpoint, init, () => worktrees);
  const state = createStateMirror(endpoint, init);
  const workspaceFolders = createFoldersMirror(endpoint, init);
  const notifications = createNotificationsProxy(endpoint);
  const local = createLocal({ endpoint, init, workspaceFolders, trust, state, notifications });
  const panels = createCorePanels({ endpoint, init, resourceRoot: local.paths.resourceRoot });
  const secrets = createSecretsProxy(endpoint, init);
  const editor = createEditorProxy(endpoint, init);
  const window = createWindowProxy(endpoint, init, panels);
  let prompts: ChatPrompts | undefined;
  const owned = [panels, trust, state, workspaceFolders, secrets, editor, window];
  return {
    get capabilities() {
      return local.capabilities();
    },
    settings: local.settings,
    secrets,
    state,
    trust,
    workspaceFolders,
    fileWatchers: local.fileWatchers,
    confinement: local.confinement,
    notifications,
    paths: local.paths,
    appInfo: init.appInfo,
    localization: local.localization,
    clipboard: createClipboardProxy(endpoint),
    shell: createShellProxy(endpoint),
    dialogs: createDialogsProxy(endpoint, () => prompts),
    editor,
    window,
    lifecycle: createLifecycleProxy(endpoint),
    logSinks: local.logSinks,
    get worktrees() {
      if (!worktrees) throw new Error('Worktree services read before core built them');
      return worktrees;
    },
    endpoint,
    panels,
    init,
    resolveProxy: (url) => endpoint.request('network.resolveProxy', { url }),
    setChatPrompts: (next) => {
      prompts = next;
    },
    setWorktrees: (next) => {
      worktrees = next;
    },
    dispose: () => {
      endpoint.close('Damocles Core closed its channel');
      for (const service of owned) service.dispose();
    },
  };
}
