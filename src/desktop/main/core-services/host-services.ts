import { randomUUID } from 'node:crypto';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { Disposable } from '../../../platform/disposable';
import type { Memento } from '../../../platform/key-value-state';
import type { NotificationOptions } from '../../../platform/notification-service';
import type { Platform } from '../../../platform/platform';
import type { PanelHost } from '../../../platform/window-service';
import type { DesktopEditorService, HostDiffView } from '../platform/editor-service';
import { DIFF_TITLE_NAME, type AskQuestion, type CoreInit, type CredentialKind, type MainEndpoint, type MirrorTopics, type PanelCreate, type StateScope } from '../../core-protocol';

export interface HostTrust {
  trustedFolders(): readonly string[];
  onDidGrant(listener: (folderPaths: readonly string[]) => void): Disposable;
  requestTrust(folderPath: string): Promise<boolean>;
}

export interface HostState {
  readonly global: Memento;
  readonly workspace: Memento;
  snapshot(scope: StateScope): Readonly<Record<string, unknown>>;
  // after a key's update landed, whichever process asked for it
  onDidUpdate(listener: (scope: StateScope, key: string) => void): Disposable;
}

export type HostPlatform = Pick<Platform, 'appInfo' | 'secrets' | 'notifications' | 'clipboard' | 'shell' | 'window' | 'lifecycle' | 'workspaceFolders'> & {
  readonly dialogs: Pick<Platform['dialogs'], 'pickFolder' | 'pickFile'>;
  readonly editor: DesktopEditorService;
};

/** A view main relays a panel's traffic to: a core message arrives as JSON text, which the view forwards unparsed. */
export interface RelayView extends PanelHost {
  readonly panelId: string;
  postJson(type: string, json: string): void;
}

/**
 * The worktree UI main keeps (core/worktrees/host.ts), which core's worktree services reach over worktrees.* requests. A
 * question's signal aborts when its request does (core ended), which withdraws it with its cancel answer.
 */
export interface HostWorktreeUi {
  reviewSetup(request: { readonly projectPath: string; readonly projectName: string; readonly commands: readonly string[] }, signal: AbortSignal): Promise<'run' | 'skip'>;
  runSetup(
    request: { readonly worktreeId: string; readonly cwd: string; readonly commands: readonly string[]; readonly env: Readonly<Record<string, string>> },
    onStep: (step: { readonly index: number; readonly total: number; readonly command: string }) => void,
  ): Promise<{ readonly exitCode: number }>;
  showSetupTerminal(worktreeId: string): void;
  stopSetup(worktreeId: string): void;
  confirmHandOff(
    request: { readonly direction: 'toWorktree' | 'toProject'; readonly branch?: string; readonly files: readonly { readonly path: string; readonly letter: string; readonly alsoUserEdits: boolean }[] },
    signal: AbortSignal,
  ): Promise<boolean>;
  showRefusal(request: { readonly kind: 'handOff' | 'apply'; readonly files: readonly { readonly path: string; readonly letter: string }[] }, signal: AbortSignal): Promise<void>;
  showApplyConflicts(worktreeId: string, files: readonly string[]): Promise<void>;
}

/** Main's own UI core's engine reaches: log tabs, the trash, questions, credential prompts and the worktree dialogs. */
export interface HostUi {
  // logs/<name>.log as a read-only editor tab (D36)
  showLog(name: string, preserveFocus: boolean): void;
  trash(absolutePath: string): Promise<void>;
  // signal withdraws the question, which then answers undefined
  ask(question: AskQuestion, signal: AbortSignal): Promise<number | undefined>;
  // undefined answer with cancelled false: nothing was asked (a notice) or the prompt was withdrawn
  askpass(prompt: { readonly kind: CredentialKind; readonly text: string }, signal: AbortSignal): Promise<{ readonly answer?: string; readonly cancelled: boolean }>;
  readonly worktrees: HostWorktreeUi;
}

export interface HostServicesDeps {
  readonly endpoint: MainEndpoint;
  // main's own services, which core's proxies reach
  readonly platform: HostPlatform;
  readonly trust: HostTrust;
  readonly state: HostState;
  readonly theme: { css(): string; onDidChange(listener: (css: string) => void): Disposable };
  readonly terminalToggle: () => { readonly shown: boolean; readonly shortcut: string };
  readonly resolveProxy: (url: string) => Promise<string>;
  // the view for a panel core creates, with the id core issued; a browser page's owner is its chat's view
  readonly createView: (panelId: string, create: Omit<PanelCreate, 'owner'> & { readonly owner?: RelayView }) => RelayView;
  readonly git: CoreInit['git'];
  readonly e2eHooks: boolean;
  readonly paths: CoreInit['paths'];
  readonly logs: CoreInit['logs'];
  // the cores that crashed earlier in this app run
  readonly endedCores: CoreInit['endedCores'];
  readonly worktreeRecords: CoreInit['worktreeRecords'];
  readonly language: { current(): MirrorTopics['language']['language']; onDidChange(listener: () => void): Disposable };
  readonly power: { onSuspend(listener: () => void): Disposable; onResume(listener: () => void): Disposable };
  readonly ui: HostUi;
  readonly log: (line: string) => void;
}

export interface HostServices extends Disposable {
  // every mirror at version 0, read when the services were created; core's platform starts from it
  readonly init: CoreInit;
  // the window's terminal pane was shown or hidden
  terminalToggleChanged(): void;
  // Relays a chat view main created from before attach asks core to attach to it, which may set its HTML at once; its view
  // state follows the request, which creates the proxy it updates.
  adopt<T>(view: RelayView, attach: () => Promise<T>): Promise<T>;
}

const trustedKeys = (trust: HostTrust): string[] => trust.trustedFolders().map((folder) => folderKey(folder));

/**
 * Main's side of the core protocol: serves core's proxied calls with main's services, publishes the mirrors core reads
 * synchronously, and makes the views core asks for. A mirror delta goes out on the listener that saw the change, so it
 * precedes the reply of any call whose work caused it.
 */
export function createHostServices(deps: HostServicesDeps): HostServices {
  const { endpoint, platform, trust, state, log } = deps;
  const views = new Map<string, RelayView>();
  const viewSubscriptions = new Map<string, Disposable[]>();
  // the diffs core opened, until their tab closes; a checkpoint diff's handle core never asks to close
  const diffs = new Map<string, HostDiffView>();
  let terminal = deps.terminalToggle();

  const init: CoreInit = {
    appInfo: { version: platform.appInfo.version, host: 'desktop' },
    secretsPersistent: platform.secrets.isPersistent,
    chatBrowserPane: platform.window.chatBrowserPane,
    e2eHooks: deps.e2eHooks,
    git: deps.git,
    paths: deps.paths,
    logs: deps.logs,
    endedCores: deps.endedCores,
    worktreeRecords: deps.worktreeRecords,
    mirrors: {
      state: { global: state.snapshot('global'), workspace: state.snapshot('workspace') },
      trust: { keys: trustedKeys(trust) },
      folders: { folders: platform.workspaceFolders.folders() },
      editor: editorPatch(platform.editor.getActiveContext()),
      terminal,
      theme: { css: deps.theme.css() },
      language: { language: deps.language.current() },
    },
  };

  const publishViewState = (panelId: string, view: PanelHost): void => {
    endpoint.publish('panel', { panelId, visible: view.visible, active: view.active, ...(view.column !== undefined ? { column: view.column } : {}) });
  };

  // An id relayed once more would overwrite its view and leak the first one's subscriptions.
  const refuseRelayed = (panelId: string): void => {
    if (views.has(panelId)) throw new Error(`Panel ${panelId} is already relayed`);
  };

  const relay = (view: RelayView): void => {
    const { panelId } = view;
    refuseRelayed(panelId);
    views.set(panelId, view);
    viewSubscriptions.set(panelId, [
      view.onMessage((message) => endpoint.postPanel(panelId, 'message', { message })),
      view.onDidChangeViewState(() => publishViewState(panelId, view)),
      view.onDispose(() => {
        forget(panelId);
        endpoint.postPanel(panelId, 'disposed', {});
      }),
    ]);
  };

  const forget = (panelId: string): void => {
    views.delete(panelId);
    for (const subscription of viewSubscriptions.get(panelId) ?? []) subscription.dispose();
    viewSubscriptions.delete(panelId);
  };

  const createView = (panelId: string, create: PanelCreate): RelayView => {
    refuseRelayed(panelId);
    const { owner, ...options } = create;
    if (owner === undefined) return deps.createView(panelId, options);
    const chat = views.get(owner);
    if (!chat) throw new Error('A browser page opens only in a loaded chat');
    return deps.createView(panelId, { ...options, owner: chat });
  };

  const serve = (): void => {
    const { secrets, dialogs, editor, shell } = platform;
    endpoint.serve('secrets.get', ({ key }) => secrets.get(key));
    endpoint.serve('secrets.store', ({ key, value }) => secrets.store(key, value));
    endpoint.serve('secrets.delete', ({ key }) => secrets.delete(key));
    endpoint.serve('secrets.keys', () => secrets.keys());
    // a modal notice is a question, which goes with its request when core ends
    endpoint.serve('notifications.show', ({ severity, message, modal, actions }, signal) => {
      const notifications = platform.notifications;
      const show = notifications[severity].bind(notifications) as (message: string, ...rest: Array<NotificationOptions | string>) => Promise<string | undefined>;
      return modal === undefined ? show(message, ...actions) : show(message, { modal, signal }, ...actions);
    });
    endpoint.serve('dialogs.pickFolder', (options) => dialogs.pickFolder(options));
    endpoint.serve('dialogs.pickFile', (options) => dialogs.pickFile(options));
    endpoint.serve('clipboard.writeText', ({ text }) => platform.clipboard.writeText(text));
    endpoint.serve('shell.openExternal', ({ url }) => shell.openExternal(url));
    endpoint.serve('shell.openFolder', ({ path }) => shell.openFolder(path));
    endpoint.serve('shell.revealPath', ({ path }) => shell.revealPath(path));
    endpoint.serve('editor.openFile', ({ path, options }) => editor.openFile(path, options));
    endpoint.serve('editor.openUntitled', ({ content, language, panelId }) => editor.openUntitled(content, language, panelId !== undefined ? { panelId } : undefined));
    endpoint.serve('editor.readText', ({ path }) => editor.readText(path));
    endpoint.serve('editor.showDiff', async ({ titleTemplate, ...request }) => {
      const view = await editor.showDiff({ ...request, title: (fileName) => titleTemplate.split(DIFF_TITLE_NAME).join(fileName) });
      const viewId = randomUUID();
      diffs.set(viewId, view);
      void view.closed.then(() => diffs.delete(viewId));
      return { viewId };
    });
    endpoint.serve('editor.closeDiff', async ({ viewId }) => {
      const view = diffs.get(viewId);
      diffs.delete(viewId);
      await view?.close();
    });
    endpoint.serve('editor.showMarkdownPreview', ({ path, panelId }) => editor.showMarkdownPreview(path, panelId !== undefined ? { panelId } : undefined));
    endpoint.serve('editor.openHostSettings', ({ query, section }) => editor.openHostSettings(query, section));
    endpoint.serve('editor.openSettingsFile', ({ scope, key }) => editor.openSettingsFile(scope, key !== undefined ? { key } : undefined));
    endpoint.serve('editor.showChatReview', ({ panelId, scope }) => editor.showChatReview(panelId, scope));
    endpoint.serve('editor.searchHostExtensions', ({ query }) => editor.searchHostExtensions(query));
    endpoint.serve('trust.request', ({ folderPath }) => trust.requestTrust(folderPath));
    endpoint.serve('state.update', ({ scope, key, value }) => state[scope].update(key, value));
    endpoint.serve('lifecycle.reload', () => platform.lifecycle.reload());
    endpoint.serve('network.resolveProxy', ({ url }) => deps.resolveProxy(url));
    const { ui } = deps;
    endpoint.serve('logs.show', ({ name, preserveFocus }) => ui.showLog(name, preserveFocus));
    endpoint.serve('shell.trash', ({ path }) => ui.trash(path));
    endpoint.serve('dialogs.ask', (question, signal) => ui.ask(question, signal));
    endpoint.serve('askpass.prompt', (prompt, signal) => ui.askpass(prompt, signal));
    endpoint.serve('worktrees.reviewSetup', (request, signal) => ui.worktrees.reviewSetup(request, signal));
    endpoint.serve('worktrees.runSetup', (request) => ui.worktrees.runSetup(request, (step) => endpoint.emit('worktrees.setupStep', { worktreeId: request.worktreeId, ...step })));
    endpoint.serve('worktrees.showSetupTerminal', ({ worktreeId }) => ui.worktrees.showSetupTerminal(worktreeId));
    endpoint.serve('worktrees.stopSetup', ({ worktreeId }) => ui.worktrees.stopSetup(worktreeId));
    endpoint.serve('worktrees.confirmHandOff', (request, signal) => ui.worktrees.confirmHandOff(request, signal));
    endpoint.serve('worktrees.showRefusal', (request, signal) => ui.worktrees.showRefusal(request, signal));
    endpoint.serve('worktrees.showApplyConflicts', ({ worktreeId, files }) => ui.worktrees.showApplyConflicts(worktreeId, files));
  };

  serve();
  const subscriptions: Disposable[] = [
    endpoint.onEvent('window.openAppSettings', ({ section, account }) => platform.window.openAppSettings(section, account)),
    endpoint.onEvent('window.toggleTerminal', () => platform.window.toggleTerminal()),
    endpoint.onPanel((panelId, envelope) => {
      if (envelope.op === 'create') {
        try {
          const view = createView(panelId, envelope.payload);
          relay(view);
          // a view main shows while it creates it changed its state before anything listened
          publishViewState(panelId, view);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          log(`[core-services] could not create a ${envelope.payload.kind} panel: ${error}`);
          endpoint.postPanel(panelId, 'disposed', { error });
        }
        return;
      }
      // an envelope for a view main already closed crossed its disposed
      const view = views.get(panelId);
      if (!view) return;
      switch (envelope.op) {
        case 'setHtml':
          view.setHtml(envelope.payload.html);
          return;
        case 'post':
          view.postJson(envelope.payload.type, envelope.payload.json);
          return;
        case 'postBinary':
          void view.postMessage(envelope.payload.message);
          return;
        case 'setIcon':
          view.setIcon(envelope.payload.path);
          return;
        case 'setTitle':
          view.setTitle(envelope.payload.title);
          return;
        case 'setFolderLabel':
          view.setFolderLabel(envelope.payload.label);
          return;
        case 'reveal':
          view.reveal(envelope.payload.column);
          return;
        case 'close':
          view.close();
          return;
      }
    }),
    platform.secrets.onDidChange((key) => endpoint.emit('secrets.changed', { key })),
    state.onDidUpdate((scope, key) => endpoint.publish('state', { scope, key, value: state[scope].get(key) })),
    trust.onDidGrant((granted) => endpoint.publish('trust', { keys: trustedKeys(trust), granted })),
    platform.workspaceFolders.onDidChange(() => endpoint.publish('folders', { folders: platform.workspaceFolders.folders() })),
    platform.editor.onDidChangeActiveContext((context) => endpoint.publish('editor', editorPatch(context))),
    deps.theme.onDidChange((css) => endpoint.publish('theme', { css })),
    deps.language.onDidChange(() => endpoint.publish('language', { language: deps.language.current() })),
    deps.power.onSuspend(() => endpoint.emit('power.suspend', {})),
    deps.power.onResume(() => endpoint.emit('power.resume', {})),
  ];

  return {
    init,
    terminalToggleChanged: () => {
      const next = deps.terminalToggle();
      if (next.shown === terminal.shown && next.shortcut === terminal.shortcut) return;
      terminal = next;
      endpoint.publish('terminal', { shown: next.shown, shortcut: next.shortcut });
    },
    adopt: (view, attach) => {
      relay(view);
      const attached = attach();
      publishViewState(view.panelId, view);
      return attached;
    },
    // A view core left open (its process ended without closing it) closes with it; a reload's retained states survive.
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      diffs.clear();
      const left = [...views.values()];
      for (const panelId of [...views.keys()]) forget(panelId);
      for (const view of left) view.close();
    },
  };
}

function editorPatch(context: ReturnType<HostPlatform['editor']['getActiveContext']>): CoreInit['mirrors']['editor'] {
  return context ? { context } : {};
}
