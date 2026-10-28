// The routes between the daemon's Damocles Core and its clients (docs/invariants.md "Remote daemon and wire"). Every message of
// core-protocol/messages.ts has a route below, so a message added there without one fails `npm run typecheck`. Towards core
// the daemon is main; towards each client attach it is core, and every client message is parsed there and sent again, never
// forwarded raw, because core ends on any violation. A violation on a client's channel closes that client only.
import { keyProviderOfSecret } from '../../core/pi-session/custom-providers';
import { OPENAI_API_KEY_SECRET } from '../../core/pi-session/openai-auth';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { Disposable } from '../../platform/disposable';
import type { OpenFolder } from '../../platform/workspace-folders';
import { createCoreEndpoint, processActor, type CoreEndpoint, type CoreTransport, type MainEndpoint } from '../core-protocol';
import { CLIENT_STATE_KEYS, MAX_ITEMS } from '../core-protocol/messages';
import { confineExisting, projectOfPath } from '../local-services/confine';
import { readFileBytes } from '../local-services/file-bytes';
import { CREDENTIAL_CLIENT_ABSENT } from '../../shared/remote-user';
import { CodecError } from '../../remote/codec';
import type { Call, ChatEntry, ClientAuth, ClientPolicy, ClientUser, CoreEvents, CoreMirrorTopics, CorePanelOps, CoreRequests, MainEvents, MainPanelOps, MainRequests, MirrorTopics, StateScope } from '../core-protocol/messages';
import { isClientStateKey, type DaemonState } from './daemon-state';
import { createPanelRetention, type PanelRetention } from './panel-retention';
import type { RunRegistry } from './run-registry';
import { createViewKeys, joinView } from './views-join';

type Params<T, M extends keyof T> = T[M] extends Call<infer P, unknown> ? P : never;
type Result<T, M extends keyof T> = T[M] extends Call<unknown, infer R> ? R : never;

/** What a route answers from when no client is attached: the folders core works in. */
export interface NoClientContext {
  readonly folders: readonly OpenFolder[];
}

/**
 * client: the client the request's actor names, else the acting client, else another attached one, else noClient (a client
 * inside its reconnection grace is skipped); issuingClient: the client that sent the scm.commit the token names; viewClient:
 * a client showing params.viewId, the actor's first; pinnedClient: exactly the client params.clientId names, refused with
 * CREDENTIAL_CLIENT_ABSENT while it is gone or inside its grace, never another.
 */
export type CoreRequestRoute<M extends keyof CoreRequests> =
  | { readonly to: 'client' | 'issuingClient' | 'viewClient'; readonly noClient: (params: Params<CoreRequests, M>, context: NoClientContext) => Result<CoreRequests, M> | Promise<Result<CoreRequests, M>> }
  | { readonly to: 'daemon' }
  | { readonly to: 'pinnedClient' }
  | { readonly to: 'refused' };

const nothing = (): undefined => undefined;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// editor.readText with no client: a regular text file inside an open project, within the document size limit.
async function readConfinedText(target: string, folders: readonly OpenFolder[]): Promise<string> {
  const projects = folders.map((folder) => ({ key: folderKey(folder.fsPath), fsPath: folder.fsPath, name: folder.name }));
  const found = await projectOfPath(projects, target);
  if (!found) throw new Error(`${target} is outside the open projects`);
  const confined = await confineExisting(found.project, found.relativePath);
  if (!confined.ok) throw new Error(`${target} cannot be read: ${confined.reason}`);
  const read = await readFileBytes(confined.path);
  if (read.kind === 'missing') throw Object.assign(new Error(`ENOENT: no such file, open '${target}'`), { code: 'ENOENT' });
  if (read.kind === 'tooLarge') throw new Error(`${target} is ${read.bytes} bytes, over the document limit`);
  if (read.kind === 'unreadable') throw new Error(read.error);
  if (read.bytes.includes(0)) throw new Error(`${target} is a binary file`);
  try {
    return utf8.decode(read.bytes);
  } catch {
    throw new Error(`${target} is not UTF-8 text`);
  }
}
const answer = <R>(value: R) => (): R => value;
const noClientFor = (what: string) => (): never => {
  throw new Error(`No client is attached to ${what}`);
};

export const CORE_REQUEST_ROUTES: { readonly [M in keyof CoreRequests]: CoreRequestRoute<M> } = {
  'secrets.get': { to: 'daemon' },
  'secrets.store': { to: 'daemon' },
  'secrets.delete': { to: 'daemon' },
  'secrets.keys': { to: 'daemon' },
  'notifications.show': { to: 'client', noClient: nothing },
  'dialogs.pickFolder': { to: 'client', noClient: nothing },
  'dialogs.pickFile': { to: 'client', noClient: nothing },
  // only the browser service, which runs on the client's own core, writes the clipboard
  'clipboard.writeText': { to: 'refused' },
  'shell.openExternal': { to: 'client', noClient: answer(false) },
  'shell.openFolder': { to: 'client', noClient: answer(false) },
  'shell.revealPath': { to: 'client', noClient: nothing },
  'editor.openFile': { to: 'client', noClient: nothing },
  'editor.openUntitled': { to: 'client', noClient: nothing },
  'editor.readText': { to: 'client', noClient: ({ path }, { folders }) => readConfinedText(path, folders) },
  'editor.showDiff': { to: 'client', noClient: noClientFor('show a diff') },
  'editor.closeDiff': { to: 'client', noClient: nothing },
  'editor.showMarkdownPreview': { to: 'client', noClient: nothing },
  'editor.openHostSettings': { to: 'client', noClient: nothing },
  'editor.openSettingsFile': { to: 'client', noClient: nothing },
  'editor.showChatReview': { to: 'client', noClient: nothing },
  'editor.searchHostExtensions': { to: 'client', noClient: nothing },
  'trust.request': { to: 'client', noClient: answer(false) },
  'state.update': { to: 'daemon' },
  'lifecycle.reload': { to: 'daemon' },
  'network.resolveProxy': { to: 'daemon' },
  'logs.show': { to: 'client', noClient: nothing },
  // a daemon's core deletes permanently instead (CoreInit.remote)
  'shell.trash': { to: 'refused' },
  'dialogs.ask': { to: 'client', noClient: nothing },
  'askpass.prompt': { to: 'client', noClient: answer({ cancelled: true }) },
  // the relay helper tells git on stderr that no client is attached
  'askpass.credential': { to: 'client', noClient: answer({ kind: 'notConnected' as const }) },
  'scm.branchName': { to: 'issuingClient', noClient: nothing },
  'worktrees.reviewSetup': { to: 'client', noClient: answer('skip' as const) },
  'worktrees.runSetup': { to: 'client', noClient: noClientFor('run the worktree setup') },
  'worktrees.showSetupTerminal': { to: 'client', noClient: nothing },
  'worktrees.stopSetup': { to: 'client', noClient: nothing },
  'worktrees.confirmHandOff': { to: 'client', noClient: answer(false) },
  'worktrees.showRefusal': { to: 'client', noClient: nothing },
  'worktrees.showApplyConflicts': { to: 'client', noClient: nothing },
  'user.credentials': { to: 'pinnedClient' },
  'user.voice.speak': { to: 'viewClient', noClient: nothing },
  'views.drained': { to: 'daemon' },
};

export type CoreEventRoute = 'allClients' | 'actingClient' | 'attachmentClient' | 'registry' | 'dropped';

export const CORE_EVENT_ROUTES: Readonly<Record<keyof CoreEvents, CoreEventRoute>> = {
  'window.openAppSettings': 'actingClient',
  'window.toggleTerminal': 'actingClient',
  // the run registry reads these two as well
  'chat.activity': 'allClients',
  'chat.turnSettled': 'allClients',
  'chat.changes': 'allClients',
  'chat.usageThreshold': 'allClients',
  'chat.worktreeState': 'allClients',
  'chat.allClosed': 'allClients',
  'chat.takeover': 'actingClient',
  'catalog.changed': 'allClients',
  'settingsView.post': 'attachmentClient',
  'settingsView.detached': 'attachmentClient',
  'scm.changed': 'allClients',
  'worktrees.newChatInWorktree': 'actingClient',
  'worktrees.newChatInProject': 'actingClient',
  // the run registry's only
  'chat.providers': 'registry',
  // this computer's core only
  'panel.foreignPost': 'dropped',
  'user.clientAuthChanged': 'dropped',
};

// each attach gets a snapshot as deltas from version 1, then live deltas; chats only of the panels that client views
export const CORE_MIRROR_ROUTES: Readonly<Record<keyof CoreMirrorTopics, 'materialized'>> = {
  chats: 'materialized',
  folderTargets: 'materialized',
  worktrees: 'materialized',
  scm: 'materialized',
};

export const CORE_PANEL_OP_ROUTES: Readonly<Record<keyof CorePanelOps, 'actingClient' | 'views'>> = {
  create: 'actingClient',
  showPage: 'views',
  post: 'views',
  postBinary: 'views',
  setIcon: 'views',
  setTitle: 'views',
  setFolderLabel: 'views',
  reveal: 'views',
  close: 'views',
};

/**
 * core: sent to core as is; view: params.viewId is the client's view, sent as core's; restore: that view becomes the
 * client's; deliver: chats.deliver's view ids; unload: the panel rule first; join: views-join.ts; settingsView: attachment
 * ids mapped per client; commit: the token's client recorded; e2e: only with the daemon's e2e hooks.
 */
export type MainRequestRoute = 'core' | 'view' | 'restore' | 'deliver' | 'unload' | 'join' | 'settingsView' | 'commit' | 'e2e' | 'refused';

export const MAIN_REQUEST_ROUTES: Readonly<Record<keyof MainRequests, MainRequestRoute>> = {
  // the daemon sends it itself before it exits
  'core.shutdown': 'refused',
  'chats.restore': 'restore',
  // only this computer's core shows a mirrored transcript
  'chats.openTranscript': 'refused',
  'chats.listMirrored': 'refused',
  'chats.startInWorktree': 'restore',
  'chats.whenSetUp': 'view',
  'chats.setWorktreeOptIn': 'core',
  'chats.restoreDraft': 'core',
  // the browser runs on the client's own core
  'chats.restorePages': 'refused',
  'chats.mention': 'core',
  'chats.addAttachment': 'core',
  'chats.handOff': 'core',
  'chats.open': 'core',
  'chats.newSession': 'core',
  'chats.cancelSession': 'core',
  'chats.stop': 'core',
  'chats.postToActive': 'core',
  'chats.post': 'core',
  'chats.deliver': 'deliver',
  'chats.whenReady': 'core',
  'chats.unload': 'unload',
  'chats.promptTarget': 'core',
  'chats.whenFolderReleased': 'core',
  'chats.whenWorktreeDiscarded': 'core',
  'chats.projectBusy': 'core',
  'chats.leaseRefusal': 'core',
  'catalog.list': 'core',
  'catalog.search': 'core',
  'catalog.rename': 'core',
  'catalog.tag': 'core',
  'catalog.delete': 'core',
  'folders.setDefault': 'core',
  'browser.newPage': 'refused',
  'worktree.retrySetup': 'core',
  'worktree.beginFinish': 'core',
  'worktree.endFinish': 'core',
  'review.snapshot': 'core',
  'review.fileDiff': 'core',
  'review.anchor': 'core',
  'review.stale': 'core',
  'review.submit': 'core',
  'settingsView.attach': 'settingsView',
  'settingsView.dispatch': 'settingsView',
  'settingsView.detach': 'settingsView',
  'views.join': 'join',
  'scm.call': 'core',
  'scm.commit': 'commit',
  'scm.ignoredIn': 'core',
  'scm.commitBlob': 'core',
  'scm.generateMessage': 'core',
  'scm.repo': 'core',
  'worktrees.call': 'core',
  'e2e.inputBox': 'e2e',
  'e2e.routeBrowser': 'e2e',
  'e2e.routedRequests': 'e2e',
  'e2e.setPlatform': 'e2e',
  'e2e.slowRenames': 'e2e',
  'e2e.slowedRenames': 'e2e',
  'e2e.holdShutdown': 'e2e',
  'e2e.watchProbe': 'e2e',
  'e2e.stopWatchProbe': 'e2e',
  'e2e.fakeVoice': 'e2e',
  'e2e.voiceRecorder': 'e2e',
  'e2e.stubOAuth': 'e2e',
  // served by the client's own core
  'user.resolveCredential': 'refused',
  'user.clientAuth': 'refused',
  // lands only in the pushing client's cache (the request's actor)
  'user.credentials.push': 'core',
  'user.voice.speak': 'refused',
  'panels.attachForeign': 'refused',
  'panels.detachForeign': 'refused',
  'panels.foreignMessage': 'refused',
};

export const MAIN_EVENT_ROUTES: Readonly<Record<keyof MainEvents, 'core' | 'hostSecrets' | 'dropped'>> = {
  // only a key of the client's namespace for this host, without its prefix
  'secrets.changed': 'hostSecrets',
  // the client's sleep is not the target's
  'power.suspend': 'dropped',
  'power.resume': 'dropped',
  'worktrees.setupStep': 'core',
};

/**
 * clientState: only CLIENT_STATE_KEYS; union: every client's grants for the daemon's life; folders: the attached clients'
 * projects, a busy one kept; panel: per panel, by the client's view; lastSender: the client that sent one last;
 * lastAttached: the most recently attached client's; perClient: keyed by the sending client's id, dropped when it detaches;
 * daemonOwned: the daemon publishes it, a client's delta is dropped.
 */
export const MIRROR_TOPIC_ROUTES: Readonly<Record<keyof MirrorTopics, 'clientState' | 'union' | 'folders' | 'panel' | 'lastSender' | 'lastAttached' | 'perClient' | 'daemonOwned'>> = {
  state: 'clientState',
  trust: 'union',
  folders: 'folders',
  panel: 'panel',
  editor: 'lastSender',
  terminal: 'lastSender',
  language: 'lastAttached',
  clientAuth: 'perClient',
  clientUser: 'perClient',
  clientPolicy: 'perClient',
  actingClient: 'daemonOwned',
  hostSockets: 'daemonOwned',
};

// daemon: the daemon sends it itself, and a client's is dropped
export const MAIN_PANEL_OP_ROUTES: Readonly<Record<keyof MainPanelOps, 'core' | 'panelRule' | 'daemon'>> = {
  message: 'core',
  disposed: 'panelRule',
  viewDetached: 'daemon',
};

/** What the daemon takes from its clients for core, kept across core restarts for the daemon's life. */
export interface ClientMirrors {
  readonly trust: Set<string>;
  // each attached client's folders; the set core sees is in `folders`
  readonly clientFolders: Map<string, readonly OpenFolder[]>;
  folders: readonly OpenFolder[];
  editor: MirrorTopics['editor'];
  terminal: MirrorTopics['terminal'];
  language: MirrorTopics['language'];
  // by client id, the attached clients' only
  readonly clientAuth: Map<string, ClientAuth>;
  readonly clientUser: Map<string, ClientUser>;
  readonly clientPolicy: Map<string, ClientPolicy>;
  actingClient: MirrorTopics['actingClient'];
}

export function createClientMirrors(): ClientMirrors {
  return {
    trust: new Set(),
    clientFolders: new Map(),
    folders: [],
    editor: {},
    terminal: { shown: false, shortcut: '' },
    language: { language: 'en' },
    clientAuth: new Map(),
    clientUser: new Map(),
    clientPolicy: new Map(),
    actingClient: {},
  };
}

type PerClientTopic = 'clientAuth' | 'clientUser' | 'clientPolicy';
const PER_CLIENT_TOPICS: readonly PerClientTopic[] = ['clientAuth', 'clientUser', 'clientPolicy'];

/** What the router learns of a client's connection besides its channel. */
export interface ClientLink {
  // settles once the core channel's queue toward the client is within its window, or the connection closed
  readonly drained: () => Promise<void>;
  // inside its reconnection grace: what it is sent waits for its resume, so it answers nothing until then
  readonly lost: () => boolean;
  // fires when the connection is lost and when it resumes
  readonly onLostChange: (listener: () => void) => Disposable;
}

export interface RouterClient extends ClientLink {
  // the connection's id, for logs
  readonly id: string;
  // the hello's stable client id: core names the client by it (mirrors, actingClient, user.credentials, actor), so a device
  // that attaches again on a new connection is the same client
  readonly clientId: string;
  // the client's own id for this host: its secrets namespace is remote/<hostId>/
  readonly hostId: string;
  // the attach generation's transport (attached-transport framing already removed)
  readonly transport: CoreTransport;
  readonly mirrors: { readonly state: { readonly global: Readonly<Record<string, unknown>>; readonly workspace: Readonly<Record<string, unknown>> } } & Pick<ClientMirrors, 'editor' | 'terminal' | 'language'> & {
    readonly trust: { readonly keys: readonly string[] };
    readonly folders: MirrorTopics['folders'];
    readonly clientAuth: ClientAuth;
    readonly clientUser: ClientUser;
    readonly clientPolicy: ClientPolicy;
  };
  // closes the client's connection
  readonly close: (reason: string) => void;
}

export interface CoreRouterDeps {
  readonly core: MainEndpoint;
  readonly state: DaemonState;
  readonly registry: RunRegistry;
  readonly mirrors: ClientMirrors;
  // the daemon's memory cache of the core's secrets, kept across restarts; undefined marks a key known absent
  readonly secrets: Map<string, string | undefined>;
  readonly e2eHooks: boolean;
  // lifecycle.reload: the daemon restarts core within its budget
  readonly reload: () => void;
  readonly log: (line: string) => void;
}

export interface CoreRouter extends Disposable {
  // serves the client on its fresh endpoint: the snapshot first, then everything routed to it
  attach(client: RouterClient): Disposable;
}

interface Session {
  readonly client: RouterClient;
  readonly endpoint: CoreEndpoint;
  // the client's view id -> core's view id
  readonly views: Map<string, string>;
  // the client's view id -> the daemon's key of that view, which core addresses it by (panel op post, message)
  readonly viewKeys: Map<string, string>;
  // the core panel ids whose chats entry this client was sent
  readonly chats: Set<string>;
  // the client's settings attachment -> the daemon's
  readonly attachments: Map<number, number>;
  // its CLIENT_STATE_KEYS values; core sees the acting client's
  readonly clientState: Record<StateScope, Map<string, unknown>>;
  // core sees the last attached client's
  language: MirrorTopics['language'];
  // its listeners on its own endpoint, disposed when it detaches
  readonly disposables: Disposable[];
  closed: boolean;
}

type ScmPatch = CoreMirrorTopics['scm'];

// one client's view of a core view: its session and its own view id
interface Viewer {
  readonly session: Session;
  readonly viewId: string;
}

const NAMESPACE = (hostId: string): string => `remote/${hostId}/`;
const STATE_SCOPES: readonly StateScope[] = ['global', 'workspace'];

// A provider's key reaches a daemon's core only through the token broker, never as a secret.
function isProviderKey(key: string): boolean {
  return key === OPENAI_API_KEY_SECRET || keyProviderOfSecret(key) !== undefined;
}

export function createCoreRouter(deps: CoreRouterDeps): CoreRouter {
  const { core, log } = deps;
  // by the hello's client id
  const sessions = new Map<string, Session>();
  // core's view id -> each view that shows it, by the daemon's view key
  const viewers = new Map<string, Map<string, Viewer>>();
  let nextViewKey = 0;
  const keys = createViewKeys();
  const chats = new Map<string, ChatEntry>();
  // core's view id -> the panel's title, which listRuns reports
  const titles = new Map<string, string>();
  let folderTargets: CoreMirrorTopics['folderTargets'] | undefined;
  let worktrees: CoreMirrorTopics['worktrees'] | undefined;
  const scmViews = new Map<string, ScmPatch>();
  const scmRepositories = new Map<string, ScmPatch>();
  const scmStates = new Map<string, ScmPatch>();
  const scmDecorations = new Map<string, ScmPatch>();
  let scmClone: ScmPatch | undefined;
  const attachments = new Map<number, { readonly session: Session; readonly attachment: number }>();
  let nextAttachment = 0;
  const commitTokens = new Map<string, Session>();
  let acting: Session | undefined;
  let lastAttached: Session | undefined;
  // the client whose CLIENT_STATE_KEYS values core has
  let stateOwner: Session | undefined;
  const disposables: Disposable[] = [];
  // core ended: nothing more is asked of it
  let ended = false;

  const live = (session: Session | undefined): session is Session => session !== undefined && !session.closed;
  // a client inside its reconnection grace still gets every post and delta, sent on its resume, but answers nothing meanwhile
  const present = (session: Session | undefined): session is Session => live(session) && !session.client.lost();
  const actingSession = (): Session | undefined => (live(acting) ? acting : [...sessions.values()].at(-1));
  // the acting client core is told of: a lost one reads as detached, so another attached one, else none
  const actingPresent = (): Session | undefined => (present(acting) ? acting : [...sessions.values()].reverse().find(present));
  // the client the current work's actor names (core stamps it from the work's origin), else the acting one, else another
  const actorSession = (): Session | undefined => {
    const actor = processActor.current();
    const named = actor === undefined ? undefined : sessions.get(actor);
    if (present(named)) return named;
    const fallback = actingSession();
    return present(fallback) ? fallback : [...sessions.values()].reverse().find(present);
  };
  // settles once the session's channel drained, or once it is lost, whose queue waits for its resume
  const drainedUnlessLost = (session: Session): Promise<void> => {
    if (session.client.lost()) return Promise.resolve();
    let subscription: Disposable | undefined;
    return new Promise<void>((resolve, reject) => {
      subscription = session.client.onLostChange(() => {
        if (session.client.lost()) resolve();
      });
      session.client.drained().then(resolve, reject);
    }).finally(() => subscription?.dispose());
  };
  const liveViewers = (viewId: string): Viewer[] => [...(viewers.get(viewId)?.values() ?? [])].filter((viewer) => live(viewer.session));
  const viewerOf = (session: Session, viewId: string): Viewer | undefined => liveViewers(viewId).find((viewer) => viewer.session === session);
  // core reads the acting client from this mirror, so it is published before the message that made the client act
  // core reads CLIENT_STATE_KEYS from the state mirror: the acting client's values, the last ones while none is attached
  const publishClientState = (): void => {
    const session = actingPresent();
    if (ended || !session || session === stateOwner) return;
    stateOwner = session;
    for (const scope of STATE_SCOPES) {
      for (const key of CLIENT_STATE_KEYS) {
        const value = session.clientState[scope].get(key);
        if (Object.is(deps.state.snapshot(scope)[key], value)) continue;
        deps.state.applyClient(scope, key, value);
        core.publish('state', { scope, key, value });
      }
    }
  };
  const publishActing = (): void => {
    publishClientState();
    const clientId = actingPresent()?.client.clientId;
    if (ended || deps.mirrors.actingClient.clientId === clientId) return;
    deps.mirrors.actingClient = clientId === undefined ? {} : { clientId };
    core.publish('actingClient', deps.mirrors.actingClient);
  };
  // the last attached client's language, which a client that attached earlier gets back once the later ones detach
  const publishLanguage = (): void => {
    if (ended || !live(lastAttached) || deps.mirrors.language.language === lastAttached.language.language) return;
    deps.mirrors.language = lastAttached.language;
    core.publish('language', deps.mirrors.language);
  };
  const publishClientValue = (topic: PerClientTopic, clientId: string, value: ClientAuth | ClientUser | ClientPolicy | undefined): void => {
    const map = deps.mirrors[topic] as Map<string, unknown>;
    if (value === undefined) map.delete(clientId);
    else map.set(clientId, value);
    if (!ended) (core.publish as (name: string, patch: unknown) => void)(topic, value === undefined ? { clientId } : { clientId, value });
  };
  const panelIdOfView = (viewId: string): string | undefined => [...chats.values()].find((entry) => entry.viewId === viewId)?.panelId;

  // A message the wire refuses (over its bounds) leaves that client's mirrors behind core's, so that client alone detaches and
  // its connection closes; its next attach starts from a fresh snapshot.
  const deliver = (session: Session, send: (endpoint: CoreEndpoint) => void): void => {
    if (session.closed) return;
    try {
      send(session.endpoint);
    } catch (err) {
      if (!(err instanceof CodecError)) throw err;
      log(`[core-host] closing ${session.client.id}: a message to it was refused (${err.message})`);
      detach(session, err.message);
      session.client.close(err.message);
    }
  };

  // ---- chats a client sees: only the panels it views, under its own view ids
  const publishChat = (session: Session, panelId: string): void => {
    const entry = chats.get(panelId);
    const viewer = entry === undefined ? undefined : viewerOf(session, entry.viewId);
    if (entry !== undefined && viewer !== undefined) {
      session.chats.add(panelId);
      deliver(session, (endpoint) => endpoint.publish('chats', { panelId, entry: { ...entry, viewId: viewer.viewId } }));
    } else if (session.chats.delete(panelId)) {
      deliver(session, (endpoint) => endpoint.publish('chats', { panelId }));
    }
  };
  const publishChatsOfView = (session: Session, viewId: string): void => {
    for (const entry of chats.values()) if (entry.viewId === viewId) publishChat(session, entry.panelId);
  };

  // A core view has a view of every client that shows it, each under its own key; a client shows a core view in one view.
  const bindView = (session: Session, clientViewId: string, viewId: string): { readonly viewKey: string; readonly created: boolean } => {
    const bound = session.views.get(clientViewId);
    if (bound !== undefined && bound !== viewId) throw new Error(`View ${clientViewId} is already in use`);
    if (bound !== undefined) return { viewKey: session.viewKeys.get(clientViewId)!, created: false };
    if (viewerOf(session, viewId) !== undefined) throw new Error(`View ${viewId} is already shown by this client`);
    const viewKey = `view-${++nextViewKey}`;
    session.views.set(clientViewId, viewId);
    session.viewKeys.set(clientViewId, viewKey);
    const shown = viewers.get(viewId) ?? new Map<string, Viewer>();
    shown.set(viewKey, { session, viewId: clientViewId });
    viewers.set(viewId, shown);
    publishChatsOfView(session, viewId);
    return { viewKey, created: true };
  };
  const unbindView = (session: Session, clientViewId: string): string | undefined => {
    const viewId = session.views.get(clientViewId);
    const viewKey = session.viewKeys.get(clientViewId);
    if (viewId === undefined || viewKey === undefined) return undefined;
    session.views.delete(clientViewId);
    session.viewKeys.delete(clientViewId);
    const shown = viewers.get(viewId);
    shown?.delete(viewKey);
    if (shown?.size === 0) viewers.delete(viewId);
    // core drops the key, so it builds no more posts for a view that is gone
    if (!ended) core.postPanel(viewId, 'viewDetached', { viewKey });
    publishChatsOfView(session, viewId);
    return viewId;
  };
  const coreViewOf = (session: Session, clientViewId: string): string => {
    const viewId = session.views.get(clientViewId);
    if (viewId === undefined) throw new Error(`View ${clientViewId} is not this client's`);
    return viewId;
  };

  const retention: PanelRetention = createPanelRetention({
    registry: deps.registry,
    panelIdOf: panelIdOfView,
    viewed: (viewId) => liveViewers(viewId).length > 0,
    dispose: (viewId, reason) => core.postPanel(viewId, 'disposed', { reason }),
    log,
  });

  // ---- core's requests
  const serveCore = <M extends keyof CoreRequests>(method: M, handler: (params: Params<CoreRequests, M>, signal: AbortSignal) => Result<CoreRequests, M> | Promise<Result<CoreRequests, M>>): void => {
    core.serve(method, handler as never);
  };
  const daemonHandlers: { readonly [M in keyof CoreRequests]?: (params: Params<CoreRequests, M>, signal: AbortSignal) => Result<CoreRequests, M> | Promise<Result<CoreRequests, M>> } = {
    // a provider key reads as absent, so a key-presence check on this host answers "not configured"
    'secrets.get': async ({ key }, signal) => {
      if (isProviderKey(key)) {
        log(`[core-host] refused core's read of the provider key ${key}`);
        return undefined;
      }
      if (deps.secrets.has(key)) return deps.secrets.get(key);
      const session = actorSession();
      if (!session) return undefined;
      const value = await session.endpoint.request('secrets.get', { key: NAMESPACE(session.client.hostId) + key }, signal);
      deps.secrets.set(key, value);
      return value;
    },
    'secrets.store': async ({ key, value }, signal) => {
      if (isProviderKey(key)) {
        log(`[core-host] refused core's write of the provider key ${key}`);
        throw new Error('A provider key changes only on the client');
      }
      deps.secrets.set(key, value);
      const session = actorSession();
      if (session) await session.endpoint.request('secrets.store', { key: NAMESPACE(session.client.hostId) + key, value }, signal);
    },
    'secrets.delete': async ({ key }, signal) => {
      if (isProviderKey(key)) {
        log(`[core-host] refused core's delete of the provider key ${key}`);
        throw new Error('A provider key changes only on the client');
      }
      deps.secrets.set(key, undefined);
      const session = actorSession();
      if (session) await session.endpoint.request('secrets.delete', { key: NAMESPACE(session.client.hostId) + key }, signal);
    },
    'secrets.keys': async (_params, signal) => {
      const cached = [...deps.secrets].flatMap(([key, value]) => (value === undefined ? [] : [key]));
      const session = actorSession();
      if (!session) return cached;
      const prefix = NAMESPACE(session.client.hostId);
      const relayed = (await session.endpoint.request('secrets.keys', {}, signal)).flatMap((key) => (key.startsWith(prefix) && !isProviderKey(key.slice(prefix.length)) ? [key.slice(prefix.length)] : []));
      return [...new Set([...relayed, ...cached])].filter((key) => deps.secrets.get(key) !== undefined || !deps.secrets.has(key));
    },
    'state.update': async ({ scope, key, value }) => {
      await deps.state.update(scope, key, value);
      // the delta goes out before the reply, as main's store does
      core.publish('state', { scope, key, value });
    },
    // the new core is no client's work: forked inside this request's context, every event it sends would carry its actor
    'lifecycle.reload': () => {
      setImmediate(() => processActor.run(undefined, deps.reload));
    },
    // core's dispatcher routes a login-environment proxy itself (EnvHttpProxyAgent)
    'network.resolveProxy': () => 'DIRECT',
    // a view no client shows queues nothing toward a page
    'views.drained': async ({ viewId, viewKey }) => {
      // a keyed ask waits for that view's client alone, an unkeyed one for every viewing client; neither for one inside its grace
      if (viewKey !== undefined) {
        const keyed = viewers.get(viewId)?.get(viewKey);
        if (keyed !== undefined && live(keyed.session)) await drainedUnlessLost(keyed.session);
        return;
      }
      await Promise.all([...new Set(liveViewers(viewId).map((viewer) => viewer.session))].map(drainedUnlessLost));
    },
  };
  for (const method of Object.keys(CORE_REQUEST_ROUTES) as Array<keyof CoreRequests>) {
    const route = CORE_REQUEST_ROUTES[method] as CoreRequestRoute<keyof CoreRequests>;
    if (route.to === 'refused') {
      serveCore(method, () => {
        log(`[core-host] refused core's ${method}, which a daemon's core never sends`);
        throw new Error(`${method} is not available on this host`);
      });
    } else if (route.to === 'daemon') {
      const handler = daemonHandlers[method];
      if (!handler) throw new Error(`No daemon handler for ${method}`);
      serveCore(method, handler as never);
    } else if (route.to === 'pinnedClient') {
      serveCore(method, (async (params: { provider: string; clientId: string }, signal: AbortSignal) => {
        const session = sessions.get(params.clientId);
        if (!present(session)) {
          log(`[core-host] ${method} for ${params.provider}: client ${params.clientId} is not attached`);
          throw new Error(CREDENTIAL_CLIENT_ABSENT);
        }
        log(`[core-host] ${method} for ${params.provider} from client ${params.clientId} (${session.client.id})`);
        // a client lost while it answers is absent at once: its answer would arrive only on its resume
        const asking = new AbortController();
        const cancel = (): void => asking.abort();
        signal.addEventListener('abort', cancel, { once: true });
        const lostWhileAsking = session.client.onLostChange(() => {
          if (session.client.lost()) asking.abort();
        });
        const gone = new Promise<never>((_resolve, reject) => asking.signal.addEventListener('abort', () => reject(new Error(CREDENTIAL_CLIENT_ABSENT)), { once: true }));
        try {
          return await Promise.race([(session.endpoint.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, params, asking.signal), gone]);
        } catch (err) {
          // the connection closed, was replaced or was lost while the client answered: the turn waits for that device as for an absent one
          if (session.closed || session.client.lost()) throw new Error(CREDENTIAL_CLIENT_ABSENT);
          throw err;
        } finally {
          signal.removeEventListener('abort', cancel);
          lostWhileAsking.dispose();
        }
      }) as never);
    } else if (route.to === 'viewClient') {
      const noClient = route.noClient as (params: unknown, context: NoClientContext) => unknown;
      serveCore(method, ((params: { viewId: string }, signal: AbortSignal) => {
        const shown = liveViewers(params.viewId).filter((viewer) => present(viewer.session));
        const actor = actorSession();
        const viewer = shown.find((candidate) => candidate.session === actor) ?? shown[0];
        if (!viewer) {
          log(`[core-host] ${method} for view ${params.viewId}, which no client shows`);
          return noClient(params, { folders: deps.mirrors.folders });
        }
        return (viewer.session.endpoint.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, { ...params, viewId: viewer.viewId }, signal);
      }) as never);
    } else {
      const noClient = route.noClient as (params: unknown, context: NoClientContext) => unknown;
      serveCore(method, ((params: unknown, signal: AbortSignal) => {
        const session = route.to === 'issuingClient' ? commitTokens.get((params as { token: string }).token) : actorSession();
        if (!present(session)) {
          log(`[core-host] ${method} with no client attached`);
          return noClient(params, { folders: deps.mirrors.folders });
        }
        return (session.endpoint.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, params, signal);
      }) as never);
    }
  }

  // ---- core's events
  const emitTo = (session: Session | undefined, name: keyof CoreEvents, payload: unknown): void => {
    if (live(session)) deliver(session, (endpoint) => (endpoint.emit as (event: string, value: unknown) => void)(name, payload));
  };
  for (const name of Object.keys(CORE_EVENT_ROUTES) as Array<keyof CoreEvents>) {
    const route = CORE_EVENT_ROUTES[name];
    disposables.push(core.onEvent(name, (payload: unknown) => {
      if (route === 'registry') return;
      if (route === 'dropped') log(`[core-host] dropped core's ${name}, which a daemon's core never sends`);
      else if (route === 'allClients') for (const session of sessions.values()) emitTo(session, name, payload);
      else if (route === 'actingClient') emitTo(actorSession(), name, payload);
      else {
        const { attachment } = payload as { attachment: number };
        const target = attachments.get(attachment);
        if (target) emitTo(target.session, name, { ...(payload as object), attachment: target.attachment });
        if (name === 'settingsView.detached' && target) {
          attachments.delete(attachment);
          target.session.attachments.delete(target.attachment);
        }
      }
    }));
  }
  const runOf = (panelId: string): { panelId: string; projectKey: string; title: string } => {
    const entry = chats.get(panelId);
    return { panelId, projectKey: entry ? (entry.folder.ownerKey ?? entry.folder.key) : '', title: (entry && titles.get(entry.viewId)) ?? panelId };
  };
  disposables.push(
    // a turn pins the client whose work started it, else the acting client (runPinnedTurn)
    core.onEvent('chat.activity', ({ panelId, activity }) => deps.registry.panelActivity(runOf(panelId), activity, processActor.current() ?? actingPresent()?.client.clientId)),
    core.onEvent('chat.turnSettled', ({ panelId }) => deps.registry.panelSettled(panelId)),
    core.onEvent('chat.providers', ({ panelId, providers }) => deps.registry.panelProviders(panelId, providers)),
  );

  // ---- core's mirrors, materialized
  const scmMaps = (patch: ScmPatch): void => {
    switch (patch.kind) {
      case 'view':
        if (patch.view === undefined) scmViews.delete(patch.projectKey);
        else scmViews.set(patch.projectKey, patch);
        return;
      case 'repository':
        scmStates.delete(patch.repoId);
        if (patch.repository === undefined) scmRepositories.delete(patch.repoId);
        else scmRepositories.set(patch.repoId, patch);
        return;
      case 'repositoryState':
        scmStates.set(patch.repoId, patch);
        return;
      case 'decorations':
        scmDecorations.set(patch.projectKey, patch);
        return;
      case 'clone':
        scmClone = patch;
        return;
    }
  };
  disposables.push(
    core.onMirror('chats', (patch) => {
      const before = chats.get(patch.panelId);
      if (patch.entry === undefined) {
        chats.delete(patch.panelId);
        deps.registry.removePanel(patch.panelId);
      } else {
        chats.set(patch.panelId, patch.entry);
      }
      for (const session of sessions.values()) if (!session.closed) publishChat(session, patch.panelId);
      if (before !== undefined && patch.entry === undefined) {
        keys.forget(before.viewId);
        titles.delete(before.viewId);
      }
    }),
    core.onMirror('folderTargets', (patch) => {
      folderTargets = patch;
      for (const session of sessions.values()) deliver(session, (endpoint) => endpoint.publish('folderTargets', patch));
    }),
    core.onMirror('worktrees', (patch) => {
      worktrees = patch;
      for (const session of sessions.values()) deliver(session, (endpoint) => endpoint.publish('worktrees', patch));
    }),
    core.onMirror('scm', (patch) => {
      scmMaps(patch);
      for (const session of sessions.values()) deliver(session, (endpoint) => endpoint.publish('scm', patch));
    }),
  );

  // ---- core's panel envelopes
  disposables.push(core.onPanel((viewId, envelope) => {
    if (CORE_PANEL_OP_ROUTES[envelope.op] === 'actingClient') {
      // with no other client there, one inside its grace still gets the page, on its resume
      const session = actorSession() ?? actingSession();
      if (!session) {
        core.postPanel(viewId, 'disposed', { error: 'no client is attached', reason: 'user' });
        return;
      }
      // the browser runs on the client's own core
      if (envelope.op === 'create' && (envelope.payload as CorePanelOps['create']).kind === 'browser') {
        log(`[core-host] refused core's browser page ${viewId}`);
        core.postPanel(viewId, 'disposed', { error: 'a host opens no browser page', reason: 'user' });
        return;
      }
      titles.set(viewId, (envelope.payload as CorePanelOps['create']).title);
      bindView(session, viewId, viewId);
      deliver(session, (endpoint) => endpoint.postPanel(viewId, envelope.op, envelope.payload as never));
      return;
    }
    if (envelope.op === 'setTitle') titles.set(viewId, (envelope.payload as CorePanelOps['setTitle']).title);
    // a panel the panel rule kept for its run has no view; a rejoin replays what it missed
    let targets = liveViewers(viewId);
    let payload = envelope.payload;
    if (envelope.op === 'post' || envelope.op === 'postBinary') {
      const { viewKey, except, ...post } = envelope.payload as CorePanelOps['post'] | CorePanelOps['postBinary'];
      payload = post;
      const shown = viewers.get(viewId);
      const keyed = viewKey === undefined ? undefined : shown?.get(viewKey);
      if (viewKey !== undefined) targets = keyed !== undefined && live(keyed.session) ? [keyed] : [];
      else if (except !== undefined) targets = targets.filter((viewer) => !except.some((key) => shown?.get(key) === viewer));
    }
    for (const viewer of targets) deliver(viewer.session, (endpoint) => (endpoint.postPanel as (id: string, op: string, value: unknown) => void)(viewer.viewId, envelope.op, payload));
    if (envelope.op === 'close') {
      for (const viewer of targets) unbindView(viewer.session, viewer.viewId);
      keys.forget(viewId);
    }
  }));

  // ---- a client
  const snapshot = (session: Session): void => deliver(session, (endpoint) => {
    if (folderTargets) endpoint.publish('folderTargets', folderTargets);
    if (worktrees) endpoint.publish('worktrees', worktrees);
    for (const panelId of chats.keys()) publishChat(session, panelId);
    for (const map of [scmViews, scmRepositories, scmStates, scmDecorations]) for (const patch of map.values()) endpoint.publish('scm', patch);
    if (scmClone) endpoint.publish('scm', scmClone);
  });

  // only the latest call publishes: an earlier one still checking a leaving folder holds an older folder set
  let folderGeneration = 0;
  const publishFolders = (): void => {
    const generation = ++folderGeneration;
    const union = new Map<string, OpenFolder>();
    for (const folders of deps.mirrors.clientFolders.values()) for (const folder of folders) union.set(folderKey(folder.fsPath), folder);
    const leaving = deps.mirrors.folders.filter((folder) => !union.has(folderKey(folder.fsPath)));
    void Promise.all(leaving.map(async (folder) => ({ folder, busy: await core.request('chats.projectBusy', { projectKey: folderKey(folder.fsPath) }) })))
      .then((checked) => {
        if (generation !== folderGeneration) return;
        for (const { folder, busy } of checked) if (busy) union.set(folderKey(folder.fsPath), folder);
        // core refuses a mirror past MAX_ITEMS, and its init carries the same set
        if (union.size > MAX_ITEMS) log(`[core-host] dropped ${union.size - MAX_ITEMS} folders past the ${MAX_ITEMS}-folder limit`);
        deps.mirrors.folders = [...union.values()].slice(0, MAX_ITEMS);
        core.publish('folders', { folders: deps.mirrors.folders });
      })
      .catch((err: unknown) => log(`[core-host] the folder set was not updated: ${err instanceof Error ? err.message : String(err)}`));
  };

  const grantTrust = (keysGranted: readonly string[], granted: readonly string[]): void => {
    const before = deps.mirrors.trust.size;
    for (const key of keysGranted) {
      // core refuses a mirror past MAX_ITEMS, and its init carries the same set
      if (deps.mirrors.trust.size >= MAX_ITEMS && !deps.mirrors.trust.has(key)) {
        log(`[core-host] refused a trust grant past the ${MAX_ITEMS}-folder limit`);
        break;
      }
      deps.mirrors.trust.add(key);
    }
    if (deps.mirrors.trust.size !== before || granted.length > 0) core.publish('trust', { keys: [...deps.mirrors.trust], granted });
  };

  const recordClientState = (session: Session, scope: StateScope, key: string, value: unknown): boolean => {
    if (!isClientStateKey(key)) {
      log(`[core-host] refused ${session.client.id}'s ${scope} state ${key}, which is this host's`);
      return false;
    }
    if (value === undefined) session.clientState[scope].delete(key);
    else session.clientState[scope].set(key, value);
    return true;
  };

  const serveClient = (session: Session): void => {
    const { endpoint, client } = session;
    // what the client sends runs as that client, so what the daemon forwards to core names it as the actor
    const touch = <A extends unknown[], R>(run: (...args: A) => R) => (...args: A): R => processActor.run(client.clientId, () => {
      acting = session;
      publishActing();
      return run(...args);
    });
    const forward = (method: string, params: unknown, signal: AbortSignal): Promise<unknown> =>
      (core.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, params, signal);
    const serve = (method: keyof MainRequests, handler: (params: never, signal: AbortSignal) => unknown): void => {
      (endpoint.serve as (name: string, run: (params: unknown, signal: AbortSignal) => unknown) => void)(method, touch(handler as (params: unknown, signal: AbortSignal) => unknown));
    };
    for (const method of Object.keys(MAIN_REQUEST_ROUTES) as Array<keyof MainRequests>) {
      const route = MAIN_REQUEST_ROUTES[method];
      switch (route) {
        case 'core':
          serve(method, (params, signal) => forward(method, params, signal));
          break;
        case 'view':
          serve(method, (params: { viewId: string }, signal) => forward(method, { ...params, viewId: coreViewOf(session, params.viewId) }, signal));
          break;
        case 'restore':
          serve(method, (params: { viewId: string }, signal) => {
            // a restore makes a new view; another client's view is shown only through views.join, which replays to it
            if ([...(viewers.get(params.viewId)?.values() ?? [])].some((viewer) => viewer.session !== session)) throw new Error(`View ${params.viewId} belongs to another client`);
            bindView(session, params.viewId, params.viewId);
            return forward(method, params, signal);
          });
          break;
        case 'deliver':
          serve(method, ({ selected, chats: views, ...params }: Params<MainRequests, 'chats.deliver'>, signal) => {
            const selectedView = selected === undefined ? undefined : session.views.get(selected);
            return forward(method, { ...params, ...(selectedView !== undefined ? { selected: selectedView } : {}), chats: views.flatMap((viewId) => session.views.get(viewId) ?? []) }, signal);
          });
          break;
        case 'unload':
          serve(method, async ({ viewId, empty }: Params<MainRequests, 'chats.unload'>, signal) => {
            const coreView = coreViewOf(session, viewId);
            if (!retention.mayUnload(coreView)) return false;
            // another client's view still shows the panel: only this client's view closes, as on its detach
            if (liveViewers(coreView).some((viewer) => viewer.session !== session)) {
              deliver(session, (endpoint) => endpoint.postPanel(viewId, 'close', {}));
              unbindView(session, viewId);
              retention.disposed(coreView, 'detach');
              return true;
            }
            return forward(method, { viewId: coreView, empty }, signal);
          });
          break;
        case 'join':
          serve(method, (params: Params<MainRequests, 'views.join'>, signal) => joinView({
            keys,
            core,
            viewOfSession: (sessionId) => [...chats.values()].find((entry) => entry.sessionId === sessionId)?.viewId,
            bind: (clientViewId, viewId) => bindView(session, clientViewId, viewId),
            unbind: (clientViewId) => void unbindView(session, clientViewId),
            log,
          }, params, signal));
          break;
        case 'settingsView':
          if (method === 'settingsView.attach') {
            serve(method, async (params: Params<MainRequests, 'settingsView.attach'>, signal) => {
              if (session.attachments.has(params.attachment)) throw new Error(`Settings view ${params.attachment} is already attached`);
              const attachment = ++nextAttachment;
              session.attachments.set(params.attachment, attachment);
              attachments.set(attachment, { session, attachment: params.attachment });
              try {
                return await forward(method, { ...params, attachment }, signal);
              } catch (err) {
                session.attachments.delete(params.attachment);
                attachments.delete(attachment);
                throw err;
              }
            });
          } else {
            serve(method, (params: { attachment: number }, signal) => {
              const attachment = session.attachments.get(params.attachment);
              if (attachment === undefined) throw new Error(`Settings view ${params.attachment} is not attached`);
              if (method === 'settingsView.detach') session.attachments.delete(params.attachment);
              return forward(method, { ...params, attachment }, signal);
            });
          }
          break;
        case 'commit':
          serve(method, (params: Params<MainRequests, 'scm.commit'>, signal) => {
            const token = params.branchName;
            if (token !== undefined) commitTokens.set(token, session);
            return forward(method, params, signal).finally(() => {
              if (token !== undefined && commitTokens.get(token) === session) commitTokens.delete(token);
            });
          });
          break;
        case 'e2e':
          serve(method, (params, signal) => {
            if (!deps.e2eHooks) throw new Error(`${method} is served only with e2e hooks`);
            return forward(method, params, signal);
          });
          break;
        case 'refused':
          serve(method, () => {
            log(`[core-host] refused ${client.id}'s ${method}`);
            throw new Error(`${method} is not available on this host`);
          });
          break;
      }
    }

    for (const name of Object.keys(MAIN_EVENT_ROUTES) as Array<keyof MainEvents>) {
      const route = MAIN_EVENT_ROUTES[name];
      session.disposables.push(endpoint.onEvent(name, touch((payload: unknown) => {
        if (route === 'dropped') return;
        if (route === 'core') {
          (core.emit as (event: string, value: unknown) => void)(name, payload);
          return;
        }
        const { key } = payload as MainEvents['secrets.changed'];
        const prefix = NAMESPACE(client.hostId);
        if (!key.startsWith(prefix)) {
          log(`[core-host] dropped ${client.id}'s secrets.changed for a key outside its namespace for this host`);
          return;
        }
        const own = key.slice(prefix.length);
        deps.secrets.delete(own);
        core.emit('secrets.changed', { key: own });
      })));
    }

    for (const topic of Object.keys(MIRROR_TOPIC_ROUTES) as Array<keyof MirrorTopics>) {
      session.disposables.push(endpoint.onMirror(topic, touch((patch: unknown) => {
        switch (topic) {
          case 'state': {
            const { scope, key, value } = patch as MirrorTopics['state'];
            // touch made this client the acting one, whose values core has
            if (!recordClientState(session, scope, key, value) || session !== stateOwner) return;
            deps.state.applyClient(scope, key, value);
            core.publish('state', { scope, key, value });
            return;
          }
          case 'trust': {
            const { keys: granted, granted: folders } = patch as MirrorTopics['trust'];
            grantTrust(granted, folders);
            return;
          }
          case 'folders':
            deps.mirrors.clientFolders.set(client.clientId, (patch as MirrorTopics['folders']).folders);
            publishFolders();
            return;
          case 'panel': {
            const view = patch as MirrorTopics['panel'];
            const viewId = session.views.get(view.panelId);
            if (viewId !== undefined) core.publish('panel', { ...view, panelId: viewId });
            return;
          }
          case 'editor':
            deps.mirrors.editor = patch as MirrorTopics['editor'];
            core.publish('editor', deps.mirrors.editor);
            return;
          case 'terminal':
            deps.mirrors.terminal = patch as MirrorTopics['terminal'];
            core.publish('terminal', deps.mirrors.terminal);
            return;
          case 'language':
            session.language = patch as MirrorTopics['language'];
            publishLanguage();
            return;
          case 'clientAuth':
          case 'clientUser':
          case 'clientPolicy': {
            const { value } = patch as { value?: ClientAuth | ClientUser | ClientPolicy };
            if (value === undefined) {
              log(`[core-host] dropped ${client.id}'s ${topic} without a value`);
              return;
            }
            publishClientValue(topic, client.clientId, value);
            return;
          }
          case 'actingClient':
          case 'hostSockets':
            log(`[core-host] dropped ${client.id}'s ${topic}, which the daemon publishes`);
            return;
        }
      })));
    }

    session.disposables.push(endpoint.onPanel(touch((clientViewId: string, envelope: { op: keyof MainPanelOps; payload: unknown }) => {
      const viewId = session.views.get(clientViewId);
      if (viewId === undefined) {
        log(`[core-host] dropped ${client.id}'s ${envelope.op} for view ${clientViewId}, which it does not show`);
        return;
      }
      const route = MAIN_PANEL_OP_ROUTES[envelope.op];
      if (route === 'daemon') {
        log(`[core-host] dropped ${client.id}'s ${envelope.op}, which the daemon sends`);
        return;
      }
      if (route === 'core') {
        const { message } = envelope.payload as MainPanelOps['message'];
        const token = typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ready' ? (message as { panelToken?: unknown }).panelToken : undefined;
        // the panel's own token names it for views.join; a joined view's page holds a token of its own
        if (typeof token === 'string' && keys.tokenOf(viewId) === undefined && keys.viewOf(token) === undefined) keys.record(viewId, token);
        // the daemon's key of the sending view, whatever the client put there
        core.postPanel(viewId, 'message', { message, viewKey: session.viewKeys.get(clientViewId)! });
        return;
      }
      const { reason } = envelope.payload as MainPanelOps['disposed'];
      unbindView(session, clientViewId);
      // the panel's token names it while any client's view shows it
      if (reason === 'user' && liveViewers(viewId).length === 0) keys.forget(viewId);
      retention.disposed(viewId, reason);
    }) as (panelId: string, envelope: unknown) => void));
  };

  const detach = (session: Session, reason: string): void => {
    if (session.closed) return;
    session.closed = true;
    // attach detaches a replaced session before it registers the newer one, so a live session is always the current one
    sessions.delete(session.client.clientId);
    session.endpoint.close(reason);
    for (const disposable of session.disposables.splice(0)) disposable.dispose();
    for (const [clientViewId, viewId] of [...session.views]) {
      unbindView(session, clientViewId);
      if (!ended) retention.disposed(viewId, 'detach');
    }
    for (const attachment of session.attachments.values()) {
      attachments.delete(attachment);
      if (ended) continue;
      core.request('settingsView.detach', { attachment }).catch((err: unknown) => log(`[core-host] detaching settings view ${attachment} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    deps.mirrors.clientFolders.delete(session.client.clientId);
    if (sessions.size > 0 && !ended) publishFolders();
    for (const [token, owner] of commitTokens) if (owner === session) commitTokens.delete(token);
    if (acting === session) acting = undefined;
    if (stateOwner === session) stateOwner = undefined;
    if (lastAttached === session) lastAttached = [...sessions.values()].at(-1);
    // a core that ended keeps its clients' values for the next core's init; the connection drops them when it closes
    if (!ended) for (const topic of PER_CLIENT_TOPICS) publishClientValue(topic, session.client.clientId, undefined);
    publishActing();
    publishLanguage();
  };

  return {
    attach: (client) => {
      const previous = sessions.get(client.clientId);
      if (previous) detach(previous, 'the client attached again');
      const endpoint = createCoreEndpoint(client.transport, log, (error) => client.close(error.message));
      const session: Session = {
        client,
        endpoint,
        views: new Map(),
        viewKeys: new Map(),
        chats: new Set(),
        attachments: new Map(),
        clientState: { global: new Map(), workspace: new Map() },
        language: client.mirrors.language,
        disposables: [],
        closed: false,
      };
      for (const scope of STATE_SCOPES) for (const [key, value] of Object.entries(client.mirrors.state[scope])) recordClientState(session, scope, key, value);
      sessions.set(client.clientId, session);
      lastAttached = session;
      acting = session;
      for (const topic of PER_CLIENT_TOPICS) publishClientValue(topic, client.clientId, client.mirrors[topic]);
      // core reads a lost client as detached, so a turn pinned to it waits visibly and asks it again once it resumed; the mirror
      // leaves it out meanwhile, so a core started then does not list it as attached
      let heldAuth: ClientAuth | undefined;
      session.disposables.push(client.onLostChange(() => {
        if (ended || session.closed) return;
        if (client.lost()) {
          heldAuth = deps.mirrors.clientAuth.get(client.clientId) ?? heldAuth;
          publishClientValue('clientAuth', client.clientId, undefined);
        } else if (heldAuth !== undefined) {
          publishClientValue('clientAuth', client.clientId, heldAuth);
          heldAuth = undefined;
        }
        publishActing();
      }));
      publishActing();
      serveClient(session);
      grantTrust(client.mirrors.trust.keys, []);
      deps.mirrors.clientFolders.set(client.clientId, client.mirrors.folders.folders);
      publishFolders();
      deps.mirrors.editor = client.mirrors.editor;
      deps.mirrors.terminal = client.mirrors.terminal;
      deps.mirrors.language = client.mirrors.language;
      core.publish('editor', deps.mirrors.editor);
      core.publish('terminal', deps.mirrors.terminal);
      core.publish('language', deps.mirrors.language);
      // last, so a snapshot the wire refuses detaches a session already whole
      snapshot(session);
      return { dispose: () => detach(session, 'the client detached') };
    },
    dispose: () => {
      ended = true;
      for (const session of [...sessions.values()]) detach(session, 'Damocles Core stopped');
      for (const disposable of disposables.splice(0)) disposable.dispose();
      retention.dispose();
      for (const panelId of chats.keys()) deps.registry.removePanel(panelId);
    },
  };
}
