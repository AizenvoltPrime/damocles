import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { ChatPanelProvider, flushCoreWrites } from '../../core/chat-panel';
import { announceLeaseRefusal, leaseRefusalFor } from '../../core/chat-panel/session-ownership';
import { listMirroredSessions, mirroredProjectFolder, mirroredSessionFile } from '../../core/chat-panel/transcript-view';
import type { AttachedView, CompassViewsHandle, HostInstance } from '../../core/chat-panel/types';
import { log } from '../../core/logger';
import { runCheckpointMaintenance, setCheckpointGitAvailability } from '../../core/pi-session/checkpoints';
import { setMcpSecretStorage } from '../../core/pi-session/mcp/mcp-auth';
import { PiRuntime } from '../../core/pi-session/pi-runtime';
import { signInStubOAuth } from '../../core/pi-session/e2e-stub-oauth';
import type { ChatActivity } from '../../core/pi-session/session-state';
import { setupAutoDisable } from '../../core/voice/auto-disable';
import { e2eVoiceRecorder, fakeVoiceForE2e } from '../../core/voice/recorder';
import { settingsFolderOf, type FolderTarget } from '../../core/workspace-folders/folder-registry';
import type { Disposable } from '../../platform/disposable';
import type { PanelHost } from '../../platform/window-service';
import { holdsWorktreeSetup, isActiveActivity } from '../../shared/chat-retention';
import { VOICE_VIEW_MESSAGES } from '../../shared/remote-user';
import type { WebviewToExtensionMessage, WorktreePhase } from '../../shared/types/messages';
import type { ChatEntry, FolderTargetEntry } from '../core-protocol';
import { currentActor } from '../core-protocol/actor';
import { resolveChatTab } from './chat-tab-target';
import type { ChatFolderSource } from './local';
import type { CorePlatform } from './platform';
import type { FinishHolds } from './worktrees';

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_FIRST_DELAY_MS = 20_000;

// Compass tree views are VS Code UI; desktop has none.
const NO_COMPASS_VIEWS: CompassViewsHandle = {
  register: () => undefined,
  setActive: () => undefined,
  dispose: () => undefined,
};

/**
 * Damocles Core's side of the core protocol (docs/invariants.md "Desktop host"): builds the services src/vscode/extension.ts
 * activate builds, minus VS Code-only UI, serves main's requests, publishes the chats and folder targets main reads
 * synchronously, and reports what changed as events. A mirror delta goes out before the event or reply that depends on it.
 */
export interface CoreServiceOptions {
  // the settings folders of the loaded chats, which core's settings store reads
  readonly chatFolders: ChatFolderSource;
  // the holds worktree.beginFinish gives out, which core's finish actions require (core-host/worktrees.ts)
  readonly finishHolds: FinishHolds;
  // what core.shutdown disposes after ChatPanelProvider: source control, worktrees, the network, the stall monitor
  readonly teardown: () => Promise<void>;
  // settles once every log line written so far has landed
  readonly flushLogs: () => Promise<void>;
  // e2e.setPlatform: the platform core's capabilities read; undefined reads process.platform
  readonly setPlatform: (platform: NodeJS.Platform | undefined) => void;
}

export interface CoreService {
  // core.shutdown's steps, run once however often asked
  readonly shutdown: () => Promise<void>;
}

export function startCoreService(platform: CorePlatform, options: CoreServiceOptions): CoreService {
  const { endpoint, panels } = platform;
  const subscriptions: Disposable[] = [];
  setCheckpointGitAvailability(platform.init.git.available ? { available: true } : { available: false, reason: platform.init.git.reason ?? '' });
  setMcpSecretStorage(platform.secrets);

  const provider = new ChatPanelProvider(platform, { subscriptions, createCompassViews: () => NO_COMPASS_VIEWS });
  const panelManager = provider.getPanelManager();
  const registry = provider.getFolderRegistry();
  const catalog = provider.getSessionCatalog();
  platform.setChatPrompts(provider.getWebviewPrompts());

  subscriptions.push(
    platform.settings.onDidChange('damocles.pi.webSearch.enabled', () => {
      if (PiRuntime.exists) void PiRuntime.get().refreshWebSearch();
    }),
  );
  setupAutoDisable(provider.getVoiceService(), subscriptions, {
    onPanelsAllClosed: (callback: () => void) => panelManager.onAllPanelsClosed(callback),
  });
  const runSweep = (): void => {
    const retentionDays = platform.settings.get<number>('damocles.checkpoints.retentionDays', 30);
    runCheckpointMaintenance({ retentionDays }).catch((err: unknown) => {
      log(`[Checkpoints] maintenance sweep threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const initial = setTimeout(runSweep, MAINTENANCE_FIRST_DELAY_MS);
  initial.unref();
  const timer = setInterval(runSweep, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  subscriptions.push({ dispose: () => { clearTimeout(initial); clearInterval(timer); } });

  const targetEntry = (target: FolderTarget): FolderTargetEntry => {
    const branch = registry.branchOf(target.key);
    return {
      key: target.key,
      fsPath: target.fsPath,
      name: target.name,
      label: target.label,
      projectScope: target.projectScope,
      ...(target.ownerKey !== undefined ? { ownerKey: target.ownerKey } : {}),
      ...(branch !== undefined ? { branch } : {}),
    };
  };
  const publishFolders = (): void => {
    endpoint.publish('folderTargets', { defaultKey: registry.defaultTarget().key, targets: [...registry.targets(), ...registry.ownedFolders()].map(targetEntry) });
  };

  // the last entry published per core panel id, and the panels whose close is watched
  const published = new Map<string, string>();
  const watched = new Set<string>();
  // the last activity and worktree phase per core panel id, which an unload re-checks
  const activities = new Map<string, ChatActivity>();
  const phases = new Map<string, WorktreePhase>();
  const entryOf = (panelId: string, instance: HostInstance): ChatEntry | undefined => {
    const viewId = panels.idOf(instance.host);
    if (viewId === undefined) return undefined;
    const sessionId = instance.session.storedSessionId ?? undefined;
    const heldPrompt = panelManager.heldPrompt(panelId);
    const settingsFolder = settingsFolderOf(instance.folder);
    return {
      panelId,
      viewId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(instance.restoreRetry !== undefined ? { restoring: instance.restoreRetry } : {}),
      hasConversation: instance.session.hasConversation(),
      folder: targetEntry(instance.folder),
      ...(settingsFolder ? { settingsFolder: { path: settingsFolder.path, ...(settingsFolder.personalPath !== undefined ? { personalPath: settingsFolder.personalPath } : {}) } } : {}),
      ...(heldPrompt !== undefined ? { heldPrompt } : {}),
      permissions: instance.permissionHandler.getPermissions(),
    };
  };
  const forget = (panelId: string): void => {
    activities.delete(panelId);
    phases.delete(panelId);
    watched.delete(panelId);
    if (published.delete(panelId)) endpoint.publish('chats', { panelId });
  };
  const publishChat = (panelId: string): void => {
    // every session bind, a folder switch's included, may change what settings folders the loaded chats read
    options.chatFolders.changed();
    const instance = panelManager.getPanels().get(panelId);
    const entry = instance ? entryOf(panelId, instance) : undefined;
    if (!instance || !entry) {
      forget(panelId);
      return;
    }
    if (!watched.has(panelId)) {
      watched.add(panelId);
      instance.host.onDispose(() => forget(panelId));
    }
    const json = JSON.stringify(entry);
    if (published.get(panelId) === json) return;
    published.set(panelId, json);
    endpoint.publish('chats', { panelId, entry });
  };
  const publishHost = (host: PanelHost | undefined): void => {
    for (const [panelId, instance] of panelManager.getPanels()) if (instance.host === host) publishChat(panelId);
  };
  const panelOfView = (viewId: string): [string, HostInstance] | undefined => {
    const host = panels.get(viewId);
    return host === undefined ? undefined : [...panelManager.getPanels()].find(([, instance]) => instance.host === host);
  };
  const requireInstance = (panelId: string): HostInstance => {
    const instance = panelManager.getPanels().get(panelId);
    if (!instance) throw new Error('The chat is not loaded');
    return instance;
  };
  const requireHost = (viewId: string): PanelHost => {
    const host = panels.get(viewId);
    if (!host) throw new Error('The chat is not loaded');
    return host;
  };

  subscriptions.push(
    registry.onDidChange(publishFolders),
    registry.onDidChangeOwned(publishFolders),
    // recorded before publishChat, which forgets a closed chat's entry
    panelManager.onActivity((panelId, activity) => {
      activities.set(panelId, activity);
      publishChat(panelId);
      const sessionId = panelManager.getPanels().get(panelId)?.session.storedSessionId ?? undefined;
      endpoint.emit('chat.activity', { panelId, activity, ...(sessionId !== undefined ? { sessionId } : {}) });
    }),
    panelManager.onTurnSettled((panelId, outcome) => {
      publishChat(panelId);
      endpoint.emit('chat.turnSettled', { panelId, outcome });
    }),
    panelManager.onChatChanges((panelId, totals, generation) => endpoint.emit('chat.changes', { panelId, totals, generation })),
    panelManager.onUsageThreshold((crossing) => endpoint.emit('chat.usageThreshold', { crossing })),
    panelManager.onDidChangeWorktreeState((event) => {
      phases.set(event.panelId, event.state.phase);
      publishChat(event.panelId);
      endpoint.emit('chat.worktreeState', { event });
    }),
    panelManager.onAllPanelsClosed(() => endpoint.emit('chat.allClosed', {})),
    // main keeps a chat whose restore waits for a stale lease as restoring, so retention leaves it loaded
    panelManager.onRestoreRetry(publishChat),
    // published as each change lands, so a crash right after it still reopens the chat with it
    panelManager.onPermissionsChanged(publishChat),
    catalog.onDidChange((change) => endpoint.emit('catalog.changed', change.projectKey !== undefined ? { projectKey: change.projectKey } : {})),
    // every loaded chat's header toggle follows the terminal pane; a chat that loads later gets it with its ready
    endpoint.onMirror('terminal', ({ shown, shortcut }) => panelManager.broadcast({ type: 'terminalShown', shown, shortcut })),
  );
  publishFolders();
  options.chatFolders.set(() => [...panelManager.getPanels().values()].flatMap((instance) => settingsFolderOf(instance.folder) ?? []));

  const { finishHolds } = options;
  const settingsViews = new Map<number, { readonly panelId: string; readonly view: AttachedView; readonly handle: Disposable }>();
  const routed: string[] = [];
  let shutdown: Promise<void> | undefined;
  // e2e.holdShutdown: the next core.shutdown never settles
  let holdShutdown = false;

  const shutdownCore = (): Promise<void> => {
    if (holdShutdown) return new Promise<void>(() => undefined);
    shutdown ??= (async () => {
      // Every step runs after a failed one, so core's config writes and log lines still land; the first failure is the reply.
      const failures: unknown[] = [];
      const settle = async (...steps: Promise<unknown>[]): Promise<void> => {
        for (const outcome of await Promise.allSettled(steps)) if (outcome.status === 'rejected') failures.push(outcome.reason);
      };
      const runtimeDisposed = PiRuntime.exists ? PiRuntime.disposeInstance() : Promise.resolve();
      await settle(provider.dispose(), runtimeDisposed);
      for (const subscription of subscriptions.reverse()) subscription.dispose();
      finishHolds.dispose();
      platform.setChatPrompts(undefined);
      await settle(options.teardown());
      await settle(flushCoreWrites());
      for (const err of failures) log(`[core] shutdown step failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      log('Damocles core disposed');
      await options.flushLogs();
      if (failures.length > 0) throw failures[0];
    })();
    return shutdown;
  };
  endpoint.serve('core.shutdown', shutdownCore);
  endpoint.serve('chats.restore', async ({ viewId, folderKey, permissions }) => {
    const host = panels.attach(viewId);
    await provider.restorePanel(host, folderKey, permissions);
    publishHost(host);
  });
  // only this computer's core, and only a file of the session mirror, which is checked here again
  endpoint.serve('chats.openTranscript', async ({ viewId, hostId, file }) => {
    if (platform.init.remote) throw new Error('A remote core shows no mirrored transcript');
    const mirrored = await mirroredSessionFile(path.dirname(platform.init.logs.dir), hostId, file);
    if (!mirrored) throw new Error('The transcript is not a file of the session mirror');
    provider.openTranscript(panels.attach(viewId), mirrored.path, mirrored.sessionId);
  });
  // only this computer's core, and only a project folder of the session mirror, which is checked here again
  endpoint.serve('chats.listMirrored', async ({ hostId, folder, query }) => {
    if (platform.init.remote) throw new Error('A remote core lists no session mirror');
    const mirrored = await mirroredProjectFolder(path.dirname(platform.init.logs.dir), hostId, folder);
    if (mirrored === undefined) throw new Error('The folder is not a project folder of the session mirror');
    return mirrored === null ? [] : listMirroredSessions(mirrored, query ?? '');
  });
  endpoint.serve('chats.startInWorktree', async ({ viewId, projectKey, worktreeId }) => {
    const host = panels.attach(viewId);
    publishChat(await provider.startInWorktree(host, projectKey, worktreeId));
  });
  endpoint.serve('chats.whenSetUp', async ({ viewId }) => {
    const host = panels.get(viewId);
    if (!host) return;
    await panelManager.whenSetUp(host);
    publishHost(host);
  });
  endpoint.serve('chats.setWorktreeOptIn', async ({ panelId, startRef, bringChanges }) => {
    await panelManager.setWorktreeOptIn(panelId, { startRef, bringChanges });
    publishChat(panelId);
  });
  endpoint.serve('chats.restoreDraft', ({ panelId, content }) => panelManager.restoreDraft(panelId, [...content] as Parameters<typeof panelManager.restoreDraft>[1]));
  endpoint.serve('chats.restorePages', async ({ viewId, urls, activePage }) => {
    // a chat closed while its restore ran has no tabs left to restore into
    const host = panels.get(viewId);
    if (host) await provider.getBrowserService().restoreChatPages(host, urls, activePage);
  });
  endpoint.serve('chats.mention', async ({ panelId, target }) => {
    await panelManager.mentionFile(panelId, target);
  });
  endpoint.serve('chats.addAttachment', async ({ panelId, attachment, prompt }) => {
    if (!panelManager.addTerminalAttachment(panelId, attachment as Parameters<typeof panelManager.addTerminalAttachment>[1])) return false;
    if (prompt !== undefined) await panelManager.appendToComposer(panelId, prompt);
    return true;
  });
  endpoint.serve('chats.handOff', ({ panelId, to }) => panelManager.chatMove(panelId, to));
  endpoint.serve('chats.open', () => provider.show());
  endpoint.serve('chats.newSession', () => provider.newSession());
  endpoint.serve('chats.cancelSession', () => provider.cancelSession());
  endpoint.serve('chats.stop', async ({ panelId }) => {
    log(`[core] stopping chat ${panelId}'s turn for a client`);
    await requireInstance(panelId).session.interrupt();
  });
  endpoint.serve('chats.postToActive', ({ message }) => {
    panelManager.postToActivePanel(message as Parameters<typeof panelManager.postToActivePanel>[0]);
  });
  endpoint.serve('chats.post', ({ panelId, message }) => {
    const instance = panelManager.getPanels().get(panelId);
    if (instance) panelManager.postMessage(instance.host, message as Parameters<typeof panelManager.postMessage>[1]);
  });
  endpoint.serve('chats.deliver', async ({ panelId, selected, chats, message }) => {
    const target = await resolveChatTab({
      panels: () => panelManager.getPanels(),
      selected: () => (selected === undefined ? undefined : panels.get(selected)),
      chats: () => chats.map((viewId) => panels.get(viewId)),
      openChat: () => panelManager.show(),
    }, panelId);
    panelManager.postMessage(target.host, message as Parameters<typeof panelManager.postMessage>[1]);
    return target.panelId;
  });
  endpoint.serve('chats.whenReady', async ({ panelId }) => {
    const instance = panelManager.getPanels().get(panelId);
    if (!instance) return false;
    await instance.webviewReady;
    return panelManager.getPanels().get(panelId) === instance;
  });
  // main's retention rule (chat-pool.ts), re-checked against core's state: active, holding pages, restoring or setting up
  endpoint.serve('chats.unload', ({ viewId, empty }) => {
    const found = panelOfView(viewId);
    if (!found) return false;
    const [panelId, instance] = found;
    if (isActiveActivity(activities.get(panelId)) || holdsWorktreeSetup(phases.get(panelId))) return false;
    if (instance.restoreRetry !== undefined || provider.getBrowserService().holdsPages(instance.host)) return false;
    if (empty && (instance.session.hasConversation() || instance.session.storedSessionId !== null)) return false;
    instance.host.close();
    return true;
  });
  endpoint.serve('chats.promptTarget', async () => (await panelManager.promptTarget(undefined))?.panelId);
  endpoint.serve('chats.whenFolderReleased', ({ fsPath }) => panelManager.whenFolderReleased(fsPath));
  endpoint.serve('chats.whenWorktreeDiscarded', ({ panelId }) => panelManager.whenWorktreeDiscarded(panelId));
  endpoint.serve('chats.projectBusy', ({ projectKey }) => [...panelManager.getPanels()].some(([panelId, instance]) =>
    (instance.folder.ownerKey ?? instance.folder.key) === projectKey && (instance.session.processing || isActiveActivity(activities.get(panelId)))));
  endpoint.serve('chats.leaseRefusal', ({ sessionId, announce }) => {
    const refusal = leaseRefusalFor(sessionId);
    if (!refusal) return false;
    if (announce) {
      announceLeaseRefusal(platform.notifications, refusal, {
        takeover: {
          sessionId,
          canOpen: () => shutdown === undefined,
          open: async () => endpoint.emit('chat.takeover', { sessionId }),
        },
      });
    }
    return true;
  });
  endpoint.serve('catalog.list', ({ projectKey, complete }) => (complete ? catalog.listComplete(projectKey) : catalog.list(projectKey)));
  endpoint.serve('catalog.search', ({ projectKey, query }) => catalog.search(projectKey, query));
  endpoint.serve('catalog.rename', ({ sessionId, name }) => catalog.rename(sessionId, name));
  endpoint.serve('catalog.tag', ({ sessionId, tag }) => catalog.tag(sessionId, tag));
  endpoint.serve('catalog.delete', ({ sessionId }) => catalog.delete(sessionId));
  endpoint.serve('folders.setDefault', async ({ key }) => {
    await registry.setDefault(key);
  });
  endpoint.serve('browser.newPage', ({ chatViewId }) => provider.getBrowserService().openNewPageForChat(requireHost(chatViewId)));
  // this computer's user scope for remote chats: main asks only this core, and checks every answer before it leaves
  endpoint.serve('user.resolveCredential', ({ provider, force }) => PiRuntime.get().resolveCredentialForBroker(provider, force === true));
  // the daemon stamps the pushing client as the actor, so the token lands only in that client's broker entries
  endpoint.serve('user.credentials.push', ({ provider, credential }) => PiRuntime.get().acceptPushedCredential(currentActor(), provider, credential));
  endpoint.serve('user.clientAuth', () => PiRuntime.get().clientAuthSnapshot());
  // a daemon's core has no user scope of its own to relay
  if (!platform.remote) {
    const stopClientAuth = PiRuntime.onClientAuthChange(() => endpoint.emit('user.clientAuthChanged', {}));
    subscriptions.push({ dispose: stopClientAuth });
  }
  endpoint.serve('user.voice.speak', ({ viewId, text }) => provider.speakForeign(viewId, text));
  endpoint.serve('panels.attachForeign', ({ authority, viewId }) => {
    panels.attachForeign(authority, viewId);
  });
  endpoint.serve('panels.detachForeign', ({ viewId }) => panels.detachForeign(viewId));
  // main sends only VOICE_VIEW_MESSAGES of a view it attached; checked again here
  endpoint.serve('panels.foreignMessage', async ({ viewId, message }) => {
    const host = panels.foreign(viewId);
    if (!host) throw new Error('The remote chat view is not attached');
    const type = (message as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !VOICE_VIEW_MESSAGES.has(type)) throw new Error('Only voice messages reach this computer from a remote chat');
    await provider.dispatchForeign(host, message as WebviewToExtensionMessage);
  });
  endpoint.serve('worktree.retrySetup', ({ worktreeId }) => panelManager.retrySetup(worktreeId));
  endpoint.serve('worktree.beginFinish', ({ worktreeId, action }) => {
    const hold = panelManager.beginWorktreeFinish(worktreeId, action);
    return hold === undefined ? undefined : finishHolds.add(worktreeId, hold);
  });
  endpoint.serve('worktree.endFinish', ({ hold }) => finishHolds.release(hold));
  endpoint.serve('review.snapshot', ({ panelId, scope, fresh }) => requireInstance(panelId).session.chatReviewSnapshot(scope, { fresh }));
  endpoint.serve('review.fileDiff', ({ panelId, scope, path }) => requireInstance(panelId).session.chatReviewFileDiff(scope, path));
  type Session = HostInstance['session'];
  endpoint.serve('review.anchor', ({ panelId, comment }) => requireInstance(panelId).session.chatReviewAnchor(comment as Parameters<Session['chatReviewAnchor']>[0]));
  endpoint.serve('review.stale', ({ panelId, checks }) => requireInstance(panelId).session.chatReviewStale(checks as Parameters<Session['chatReviewStale']>[0]));
  endpoint.serve('review.submit', ({ panelId, drafts }) => requireInstance(panelId).session.submitReview(drafts as Parameters<Session['submitReview']>[0]));
  endpoint.serve('settingsView.attach', ({ panelId, attachment, scope }) => {
    const clientId = currentActor();
    const view: AttachedView = {
      post: (message) => endpoint.emit('settingsView.post', { attachment, message }),
      detached: () => {
        settingsViews.delete(attachment);
        endpoint.emit('settingsView.detached', { attachment });
      },
      ...(scope !== undefined ? { scope } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    };
    const handle = panelManager.attachView(panelId, view);
    settingsViews.set(attachment, { panelId, view, handle });
  });
  // a view main made for a panel this core holds; the panel's token never changes
  endpoint.serve('views.join', async ({ viewId, viewKey, joining }) => {
    const host = panels.get(viewId);
    if (!host) return null;
    const panelId = await panelManager.joinView(host, viewKey, joining);
    return panelId === undefined ? null : { panelId };
  });
  endpoint.serve('settingsView.dispatch', async ({ attachment, message }) => {
    const attached = settingsViews.get(attachment);
    if (attached) await panelManager.dispatchFromView(attached.panelId, attached.view, message as Parameters<typeof panelManager.dispatchFromView>[2]);
  });
  endpoint.serve('settingsView.detach', ({ attachment }) => {
    settingsViews.get(attachment)?.handle.dispose();
  });
  if (platform.init.e2eHooks) {
    const realPlatform = process.platform;
    endpoint.serve('e2e.setPlatform', ({ platform: next }) => {
      options.setPlatform(next === null ? undefined : (next as NodeJS.Platform));
      return realPlatform;
    });
    // core's own writes (writeJsonConfig's renames), which a test slows to catch a quit that does not wait for them
    const slowed = new Map<string, { readonly delayMs: number; count: number }>();
    const rename = fsPromises.rename.bind(fsPromises);
    endpoint.serve('e2e.slowRenames', ({ basename, delayMs }) => {
      slowed.set(basename, { delayMs, count: 0 });
      fsPromises.rename = async (from, to) => {
        const slow = slowed.get(path.basename(String(to)));
        if (slow) {
          slow.count++;
          await new Promise((resolve) => setTimeout(resolve, slow.delayMs));
        }
        return rename(from, to);
      };
    });
    endpoint.serve('e2e.slowedRenames', ({ basename }) => slowed.get(basename)?.count ?? 0);
    endpoint.serve('e2e.holdShutdown', () => {
      holdShutdown = true;
    });
    endpoint.serve('e2e.inputBox', (options) => platform.dialogs.inputBox(options));
    // this computer's ChatGPT sign-in, signed in and refreshed by a stub with short-lived tokens
    endpoint.serve('e2e.stubOAuth', ({ account, expiresInMs, offline }) => signInStubOAuth(PiRuntime.get(), account, expiresInMs, offline));
    // this core's recorder starts a stand-in under its own launcher, so a test can tell which process records
    endpoint.serve('e2e.fakeVoice', ({ transcript }) => {
      fakeVoiceForE2e(transcript);
      return { pid: process.pid };
    });
    endpoint.serve('e2e.voiceRecorder', () => e2eVoiceRecorder());
    // the requests a route sends to toHost instead, by their original URL
    endpoint.serve('e2e.routeBrowser', async ({ pattern, toHost }) => {
      const page = provider.getBrowserService().getActivePage();
      if (!page) throw new Error('No browser page is open');
      await page.context().route(new RegExp(pattern), (route) => {
        const url = new URL(route.request().url());
        routed.push(url.href);
        return route.continue({ url: `${url.protocol}//${toHost}${url.pathname}` });
      });
    });
    endpoint.serve('e2e.routedRequests', () => [...routed]);
    // through core's own factory, so it shares the per-root watch core's watchers of that folder use
    const watchProbes = new Map<string, { readonly watcher: Disposable; readonly created: string[] }>();
    endpoint.serve('e2e.watchProbe', ({ folder }) => {
      let probe = watchProbes.get(folder);
      if (!probe) {
        const created: string[] = [];
        const watcher = platform.fileWatchers.watch(folder, '**/*');
        watcher.onDidCreate((fsPath) => created.push(fsPath));
        probe = { watcher, created };
        watchProbes.set(folder, probe);
      }
      return [...probe.created];
    });
    endpoint.serve('e2e.stopWatchProbe', ({ folder }) => {
      watchProbes.get(folder)?.watcher.dispose();
      watchProbes.delete(folder);
    });
  }
  return { shutdown: shutdownCore };
}
