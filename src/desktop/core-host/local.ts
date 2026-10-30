import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { readContributedConfiguration } from '../../core/config/read-contributed-configuration';
import { settingsViewScope } from '../../core/chat-panel/settings-view-scope';
import { DAMOCLES_HOME_DIR } from '../../core/paths';
import { defaultProjectPath, DEFAULT_WORKSPACE_FOLDER_STATE_KEY } from '../../core/workspace-folders/folder-registry';
import type { AppPaths } from '../../platform/app-paths';
import type { Disposable } from '../../platform/disposable';
import type { SettingsFolder } from '../../platform/settings-store';
import type { ClientUser, CoreInit } from '../core-protocol';
import { currentPin } from '../../core/client-snapshots';
import { desktopHostCapabilities, remoteHostCapabilities } from '../local-services/capabilities';
import { Emitter } from '../local-services/emitter';
import { createDesktopFileConfinement } from '../local-services/file-confinement';
import { DesktopFileWatcherFactory } from '../local-services/file-watcher-factory';
import type { DesktopLogSinkFactory } from '../local-services/log-sink';
import { DesktopSettingsStore, type DesktopSettingsStoreDeps } from '../local-services/settings-store';
import type { SettingsObject } from '../../core/config/settings-file';
import type { RemoteHost } from '../../platform/remote-host';
import { createWorkerTreeHost } from '../local-services/watch-worker-host';
import type { CoreLocalServices, CoreShared } from './platform';

/** Core's app paths, rebuilt from the ones main sent: main alone maps worker names to bundles. */
export function coreAppPaths(init: CoreInit): AppPaths {
  const { resourceRoot, unpackedRoot, workers } = init.paths;
  return { resourceRoot, unpackedRoot, workerEntry: (name) => workers[name] };
}

/** The folders loaded chats read their settings from, which the running core service reports (settingsFolderOf). */
export interface ChatFolderSource {
  set(read: () => readonly SettingsFolder[]): void;
  changed(): void;
}

export interface CoreLocal extends CoreLocalServices, Disposable {
  readonly settings: DesktopSettingsStore;
  readonly fileWatchers: DesktopFileWatcherFactory;
  readonly chatFolders: ChatFolderSource;
  // e2e.setPlatform: the platform capabilities read; undefined reads process.platform
  setPlatform(platform: NodeJS.Platform | undefined): void;
}

/** A daemon's core's user layer: the pinned (else acting) client's clientUser settings, which change with that client. */
export function remoteSettings(remote: RemoteHost): NonNullable<DesktopSettingsStoreDeps['remote']> {
  return {
    fromHostTab: () => settingsViewScope() === 'machine',
    clientSettings: () => currentPin(remote).user?.settings as SettingsObject | undefined,
    onDidChangeClientSettings: (cb) => remote.clients.onDidChange((change) => {
      if (change.topic === 'clientUser' && change.clientId !== undefined) {
        const before = change.before as ClientUser | undefined;
        cb({ clientId: change.clientId, before: before?.settings as SettingsObject | undefined, after: remote.clients.user(change.clientId)?.settings as SettingsObject | undefined });
      } else if (change.topic === 'actingClient') cb({});
    }),
  };
}

/** The services core's process holds its own instance of (docs/invariants.md "Platform boundary"), over the mirrors of main's. */
export function createCoreLocal(shared: CoreShared, logSinks: DesktopLogSinkFactory, log: (line: string) => void): CoreLocal {
  const { init } = shared;
  const paths = coreAppPaths(init);
  const windowsTree = createWorkerTreeHost(() => new Worker(init.paths.watchWorker), log);
  const fileWatchers = new DesktopFileWatcherFactory(shared.workspaceFolders, log, windowsTree);
  let chatFolders: () => readonly SettingsFolder[] = () => [];
  const chatFoldersChanged = new Emitter<[]>('chat-folders', log);
  const settings = new DesktopSettingsStore({
    userFile: path.join(DAMOCLES_HOME_DIR, 'settings.json'),
    contributed: readContributedConfiguration(paths.resourceRoot),
    fileWatchers,
    projects: shared.workspaceFolders,
    trust: shared.trust,
    chatFolders: { folders: () => chatFolders(), onDidChange: (cb) => chatFoldersChanged.add(cb) },
    notifications: shared.notifications,
    log,
    ...(shared.remote
      ? { remote: remoteSettings(shared.remote) }
      : {
          defaultProject: {
            folder: () => defaultProjectPath(shared.workspaceFolders, shared.state.workspace),
            onDidChange: (cb) => shared.state.onDidChange('workspace', DEFAULT_WORKSPACE_FOLDER_STATE_KEY, cb),
          },
        }),
  });
  let platform: NodeJS.Platform | undefined;
  return {
    capabilities: () => {
      const capabilities = desktopHostCapabilities(platform ?? process.platform);
      return shared.remote ? remoteHostCapabilities(capabilities, currentPin(shared.remote).policy) : capabilities;
    },
    settings,
    fileWatchers,
    confinement: createDesktopFileConfinement(),
    logSinks,
    paths,
    chatFolders: {
      set: (read) => {
        chatFolders = read;
        chatFoldersChanged.fire();
      },
      changed: () => chatFoldersChanged.fire(),
    },
    setPlatform: (next) => {
      platform = next;
    },
    dispose: () => {
      chatFoldersChanged.clear();
      settings.dispose();
    },
  };
}
