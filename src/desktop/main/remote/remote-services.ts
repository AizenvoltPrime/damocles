// What a remote authority's core reaches of main: main's own services for the requests the daemon relays, with main's
// refusals in front of them. No request from a target opens, reads or changes a file of this computer, or reads what this
// computer's editor shows of another host (docs/invariants.md "Remote daemon and wire").
import type { Disposable } from '../../../platform/disposable';
import type { Memento } from '../../../platform/key-value-state';
import type { NotificationService } from '../../../platform/notification-service';
import type { OpenFolder } from '../../../platform/workspace-folders';
import type { SecretsStore } from '../../../platform/secrets-store';
import type { Project } from '../../local-services/confine';
import { CLIENT_STATE_KEYS, type StateScope } from '../../core-protocol';
import { VOICE_VIEW_POSTS } from '../../../shared/remote-user';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import type { HostPlatform, HostServicesDeps, HostState, HostTrust, HostUi, HostUser } from '../core-services/host-services';
import type { DesktopEditorService, HostDiffView } from '../platform/editor-service';
import type { ActiveEditorContext, DiffRequest } from '../../../platform/editor-service';
import type { ChatReviewScope, SettingsFileScope } from '../../../shared/types/messages';
import { authorityKeyOfProject } from '../../../shared/project-location';

export interface RemoteServicesDeps {
  readonly authority: string;
  readonly hostId: string;
  // the host's name as this computer's host store names it; a target never names itself
  readonly hostName: () => string;
  // main's own platform, whose services the allowed requests use
  readonly platform: HostPlatform;
  readonly state: HostState;
  // the authority's projects, their paths native to the target
  readonly projects: () => readonly Project[];
  // the roots a target path may name a file in: the projects and their live chat worktrees, keyed as main's roots
  readonly fileRoots: () => readonly Project[];
  // the authority's project list changed (remote-hosts.json)
  readonly onProjectsChanged: (listener: () => void) => Disposable;
  readonly workspace: () => ProjectWorkspace;
  readonly trust: HostTrust;
  // opens a project file in the editor pane by its project key and relative path
  readonly openInEditor: (projectKey: string, relativePath: string, line: number | undefined, focus: boolean) => Promise<void>;
  // an Edit/Write approval or checkpoint diff, its target paths resolved only inside this host's projects (remote-files.ts)
  readonly showDiff: (request: DiffRequest) => Promise<HostDiffView>;
  // a rendered Markdown preview of text the core sent, titled after its file on the target, which main never reads
  readonly showMarkdown: (targetPath: string, content: string) => Promise<void>;
  // the chat review of a chat of this core, by its core panel id
  readonly showChatReview: (corePanelId: string, scope: ChatReviewScope) => Promise<void>;
  // a settings file of the host, read and saved through its workspace; user scope names the host's own ~/.damocles/settings.json
  readonly openSettingsFile: (scope: SettingsFileScope, key: string | undefined) => Promise<void>;
  // the target's log by name (control logs.read), as a read-only editor tab named with the host
  readonly showLog: (name: string, preserveFocus: boolean) => void;
  // worktrees: the host's worktree controller, whose Setup terminal runs on the host's pty host
  readonly ui: Pick<HostUi, 'ask' | 'askpass' | 'worktrees'>;
  // main's notices, each shown with the host's name from this computer's host store, never one the core sent
  readonly notices: NotificationService;
  // this computer's credentials and speech, which only a remote core is relayed
  readonly user: HostUser;
  readonly base: Pick<HostServicesDeps, 'terminalToggle' | 'createView' | 'git' | 'e2eHooks' | 'paths' | 'logs' | 'language' | 'divert' | 'log'>;
  readonly t: (message: string, ...args: string[]) => string;
}

const refused = (what: string): Promise<never> => Promise.reject(new Error(`${what} is not available to a remote core`));

/** A key outside remote/<hostId>/ is refused and logged by name, and only that namespace is listed or heard. */
export function namespacedSecrets(secrets: SecretsStore, hostId: string, log: (line: string) => void): SecretsStore {
  const prefix = `remote/${hostId}/`;
  const inside = (key: string): boolean => key.startsWith(prefix) && key.length > prefix.length;
  const check = (key: string): void => {
    if (inside(key)) return;
    log(`[remote] refused the secret ${JSON.stringify(key.slice(0, 64))} to the core of host ${hostId}`);
    throw new Error(`A remote core may only use secrets under ${prefix}`);
  };
  return {
    get isPersistent() {
      return secrets.isPersistent;
    },
    get: async (key) => {
      check(key);
      return secrets.get(key);
    },
    store: async (key, value) => {
      check(key);
      await secrets.store(key, value);
    },
    delete: async (key) => {
      check(key);
      await secrets.delete(key);
    },
    keys: async () => (await secrets.keys()).filter(inside),
    onDidChange: (listener) => secrets.onDidChange((key) => {
      if (inside(key)) listener(key);
    }),
  };
}

const CLIENT_KEYS: ReadonlySet<string> = new Set(CLIENT_STATE_KEYS);

const NO_CONTEXT: ActiveEditorContext = { filePath: undefined, selection: undefined };

const readOnly = (memento: Memento): Memento => ({
  get: ((key: string, defaultValue?: unknown) => (CLIENT_KEYS.has(key) ? memento.get(key, defaultValue) : defaultValue)) as Memento['get'],
  update: () => refused('A state write'),
});

/** The client's state as a remote core sees it: only CLIENT_STATE_KEYS, never written from the target. */
export function clientState(state: HostState): HostState {
  const pick = (scope: StateScope): Readonly<Record<string, unknown>> => Object.fromEntries(Object.entries(state.snapshot(scope)).filter(([key]) => CLIENT_KEYS.has(key)));
  return {
    global: readOnly(state.global),
    workspace: readOnly(state.workspace),
    snapshot: pick,
    onDidUpdate: (listener) => state.onDidUpdate((scope, key) => {
      if (CLIENT_KEYS.has(key)) listener(scope, key);
    }),
  };
}

export function remoteServices(deps: RemoteServicesDeps): Omit<HostServicesDeps, 'endpoint'> {
  const { platform, t } = deps;
  // what the editor shows reaches a core only while its document is of that core's host
  const ownProjectKey = (): string | undefined => {
    const projectKey = platform.editor.activeProjectKey();
    return projectKey !== undefined && authorityKeyOfProject(projectKey) === deps.authority ? projectKey : undefined;
  };
  const ownContext = (context: ActiveEditorContext | undefined): ActiveEditorContext | undefined => (context === undefined || ownProjectKey() !== undefined ? context : NO_CONTEXT);
  const projectOf = async (target: string): Promise<{ project: Project; relativePath: string } | undefined> =>
    deps.workspace().files.projectOfPath(deps.fileRoots(), target);
  const editor: DesktopEditorService = {
    openFile: async (filePath, opts) => {
      const found = await projectOf(filePath);
      if (!found) throw new Error(`${filePath} is not in an open project`);
      const line = opts?.line !== undefined && Number.isInteger(opts.line) && opts.line > 0 ? opts.line : undefined;
      await deps.openInEditor(found.project.key, found.relativePath, line, opts?.preserveFocus !== true);
    },
    openUntitled: (content, language, opts) => platform.editor.openUntitled(content, language, opts),
    readText: async (filePath) => {
      if (!(await projectOf(filePath))) throw new Error(`${filePath} is not in an open project`);
      const text = await deps.workspace().files.readText(filePath);
      if (text === undefined) throw new Error(`${filePath} cannot be opened as text`);
      return text;
    },
    showDiff: (request) => deps.showDiff(request),
    showMarkdownPreview: (filePath, opts) => (opts?.content === undefined ? refused('A Markdown preview of a file on the host') : deps.showMarkdown(filePath, opts.content)),
    getActiveContext: () => ownContext(platform.editor.getActiveContext()),
    activeProjectKey: ownProjectKey,
    onDidChangeActiveContext: (listener) => platform.editor.onDidChangeActiveContext((context) => listener(ownContext(context))),
    openHostSettings: (query, section) => platform.editor.openHostSettings(query, section),
    openSettingsFile: (scope, opts) => deps.openSettingsFile(scope, opts?.key),
    showChatReview: (panelId, scope) => deps.showChatReview(panelId, scope),
    isHostExtensionActive: () => false,
    searchHostExtensions: (query) => platform.editor.searchHostExtensions(query),
  };
  const folders: { folders(): readonly OpenFolder[]; onDidChange(cb: () => void): Disposable } = {
    folders: () => deps.projects().map((project) => ({ fsPath: project.fsPath, name: project.name })),
    onDidChange: (cb) => deps.onProjectsChanged(cb),
  };
  // the host's folder browser is not built yet, so a picker says so instead of doing nothing
  const noPicker = (): Promise<undefined> => {
    void deps.notices.info(t('Choosing a file or folder on {0} is not available yet.', deps.hostName()));
    return Promise.resolve(undefined);
  };
  const remotePlatform: HostPlatform = {
    appInfo: platform.appInfo,
    secrets: namespacedSecrets(platform.secrets, deps.hostId, deps.base.log),
    notifications: deps.notices,
    clipboard: { writeText: () => refused('A clipboard write') },
    shell: {
      // The user sees the address and the host before anything opens.
      openExternal: async (url) => {
        // only a web address, shown as it would open
        const href = URL.canParse(url) ? new URL(url) : undefined;
        if (href?.protocol !== 'http:' && href?.protocol !== 'https:') return false;
        const open = t('Open');
        if ((await deps.notices.info(t('{0} wants to open {1}', deps.hostName(), href.href), open)) !== open) return false;
        return platform.shell.openExternal(href.href);
      },
      openFolder: () => Promise.resolve(false),
      revealPath: () => Promise.resolve(),
    },
    window: platform.window,
    lifecycle: { reload: () => refused('A reload') },
    workspaceFolders: folders,
    dialogs: { pickFolder: noPicker, pickFile: noPicker },
    editor,
  };
  const ui: HostUi = {
    showLog: (name, preserveFocus) => deps.showLog(name, preserveFocus),
    trash: () => refused('The trash'),
    ask: (question, signal) => deps.ui.ask({ ...question, message: t('{0}: {1}', deps.hostName(), question.message) }, signal),
    askpass: (prompt, signal) => deps.ui.askpass({ ...prompt, text: t('{0}: {1}', deps.hostName(), prompt.text) }, signal),
    worktrees: deps.ui.worktrees,
  };
  return {
    ...deps.base,
    platform: remotePlatform,
    trust: deps.trust,
    state: clientState(deps.state),
    resolveProxy: () => refused('A proxy lookup'),
    endedCores: [],
    worktreeRecords: [],
    power: { onSuspend: () => ({ dispose: () => undefined }), onResume: () => ({ dispose: () => undefined }) },
    ui,
    user: deps.user,
    // voice view state reaches a remote chat's view only from this computer's core (voice-relay.ts)
    refusedPosts: VOICE_VIEW_POSTS,
  };
}
