// The routes between the daemon's Damocles Core and its clients (docs/invariants.md "Remote daemon and wire"). Every message of
// core-protocol/messages.ts has a route below, so a message added there without one fails `npm run typecheck`. Towards core
// the daemon is main; towards each client attach it is core, and every client message is parsed there and sent again, never
// forwarded raw, because core ends on any violation. A violation on a client's channel closes that client only.
import { keyProviderOfSecret } from '../../core/pi-session/custom-providers';
import { OPENAI_API_KEY_SECRET } from '../../core/pi-session/openai-auth';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { Disposable } from '../../platform/disposable';
import type { TerminalToggle } from '../../platform/window-service';
import type { OpenFolder } from '../../platform/workspace-folders';
import { createCoreEndpoint, processActor, type CoreEndpoint, type CoreTransport, type MainEndpoint } from '../core-protocol';
import { MAX_ITEMS } from '../core-protocol/messages';
import { confineExisting, projectOfPath } from '../local-services/confine';
import { readFileBytes } from '../local-services/file-bytes';
import { CLIENT_FEATURE_MISSING, CREDENTIAL_CLIENT_ABSENT } from '../../shared/remote-user';
import { USER_FORGE_FEATURE } from '../../shared/forge/tools';
import { DESIGN_JOURNEY_UPDATE_NEEDED, DESIGN_PREVIEW_CLIENT_ABSENT, DESIGN_RENDER_CLIENT_ABSENT, DESIGN_RENDER_PREDATES } from '../../shared/design-render';
import { journeyNeedsScrollFeature } from '../../shared/design-journey';
import type { JourneyStep } from '../../shared/types/design';
import { CodecError } from '../../remote/codec';
import type { ChatEntry, ClientAuth, ClientPolicy, ClientUser, CoreEvents, CoreMirrorTopics, CorePanelOps, CoreRequests, EditorMirror, MainEvents, MainPanelOps, MainRequests, MirrorTopics, Params, Result } from '../core-protocol/messages';
import { ACTOR_INTENT_EXPIRY_MS, createActorOutbox } from './actor-outbox';
import type { DaemonState } from './daemon-state';
import { createPanelRetention, type PanelRetention } from './panel-retention';
import type { RunRegistry } from './run-registry';
import { createViewKeys, joinView } from './views-join';

/**
 * What a route answers from when no client is attached: the folders core works in, the features attached clients list, and
 * whether a present client shows the view or chat but its attach did not list the route's needs (viewClient, chatClient).
 */
export interface NoClientContext {
  readonly folders: readonly OpenFolder[];
  readonly attached: (feature: string) => boolean;
  readonly viewerLacksNeeds: boolean;
}

/**
 * client: what surfaces on a device (a dialog, notice, prompt, open, terminal): inside a client's work only that client, held
 * in the actor outbox while it is away and noClient once the intent expired, never another device; outside any, the acting
 * client, else another attached one, else noClient (a client inside its reconnection grace is skipped). workClient: a request
 * that surfaces nothing and only returns data (a read, a render): the actor while present, else the acting client, else another
 * attached one, never held, else noClient at once. issuingClient: the client that sent the scm.commit the token names;
 * viewClient: a client showing params.viewId, the actor's first; chatClient: a client showing the chat params.panelId names,
 * inside a client's work only the actor (a UI action never lands on another device), else any; pinnedClient: exactly the
 * client params.clientId names, refused with CREDENTIAL_CLIENT_ABSENT while it is gone or inside its grace, never another;
 * a params.viewId reaches it as that client's own view id, and not at all when it does not show the view.
 * needs: a name of FEATURES; on every route kind that has it, only a client whose attach listed it is asked (one that
 * predates the request would close its connection on the name): for client inside a client's work the actor alone, else the
 * first client of the route's order that lists it; a pinnedClient route refuses a client without it with
 * CLIENT_FEATURE_MISSING. A client-side route's needs may be read from the request, for params an older client's parser refuses.
 */
export type CoreRequestRoute<M extends keyof CoreRequests> =
  | { readonly to: 'client' | 'workClient' | 'issuingClient' | 'viewClient' | 'chatClient'; readonly noClient: (params: Params<CoreRequests, M>, context: NoClientContext) => Result<CoreRequests, M> | Promise<Result<CoreRequests, M>>; readonly needs?: string | ((params: Params<CoreRequests, M>) => string | undefined) }
  | { readonly to: 'daemon' }
  | { readonly to: 'pinnedClient'; readonly needs?: string }
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
  if (read.kind === 'notAFile') throw new Error(`${target} is not a file`);
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
const noRenderingClient = (): never => {
  throw new Error(DESIGN_RENDER_CLIENT_ABSENT);
};
// core tells an app that predates design.render, which it asks design.capture, from no app at all by the refusal's text
const noRenderClient = (_params: unknown, context: NoClientContext): never => {
  throw new Error(context.attached('design.capture') ? DESIGN_RENDER_PREDATES : DESIGN_RENDER_CLIENT_ABSENT);
};
// steps with a scroll or an explicit exact target, which an app's parser before design.journeyScroll refuses
const journeyNeeds = (base: string) => (params: { readonly steps: readonly JourneyStep[] }): string => (journeyNeedsScrollFeature(params.steps) ? 'design.journeyScroll' : base);
const noJourneyClient = (base: string) => (params: { readonly steps: readonly JourneyStep[] }, context: NoClientContext): never => {
  throw new Error(journeyNeedsScrollFeature(params.steps) && context.attached(base) ? DESIGN_JOURNEY_UPDATE_NEEDED : DESIGN_RENDER_CLIENT_ABSENT);
};

/** The FEATURES name a client-side route needs for this request. */
function needsOf(route: { readonly needs?: string | ((params: never) => string | undefined) }, params: unknown): string | undefined {
  return typeof route.needs === 'function' ? route.needs(params as never) : route.needs;
}
const noPreviewClient = (): never => {
  throw new Error(DESIGN_PREVIEW_CLIENT_ABSENT);
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
  // the base text of an Edit or Write diff, which every approval waits for
  'editor.readText': { to: 'workClient', noClient: ({ path }, { folders }) => readConfinedText(path, folders) },
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
  // only this computer's core keeps Git hosting accounts
  'forge.chooseAccount': { to: 'refused' },
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
  // core refuses a browser tool itself while no client is attached; one that detached meanwhile fails here
  // a call with served goes only to a client that serves root files; core reads CLIENT_FEATURE_MISSING as an app to update,
  // so only a viewer that lacks the feature gets it
  'user.browser.tool': {
    to: 'viewClient',
    noClient: (params, { viewerLacksNeeds }) => {
      if (params.served !== undefined && viewerLacksNeeds) throw new Error(CLIENT_FEATURE_MISSING);
      return noClientFor('run a browser tool')();
    },
    needs: (params) => (params.served === undefined ? undefined : 'user.browser.servedFiles'),
  },
  // a daemon's core relays its browser calls (user.browser.tool), so main serves root files to this computer's core only
  'browser.servedFileUrl': { to: 'refused' },
  // with no client showing the view, the scope's tabs close with the view's proxy there
  'user.browser.release': { to: 'viewClient', noClient: nothing },
  // a client's global memory and personal MCP servers are its own, so only that client answers
  'user.memory.search': { to: 'pinnedClient' },
  'user.memory.profile': { to: 'pinnedClient' },
  'user.memory.resolve': { to: 'pinnedClient' },
  'user.memory.apply': { to: 'pinnedClient' },
  'user.memory.list': { to: 'pinnedClient', needs: 'user.memory.list' },
  'user.mcp.call': { to: 'pinnedClient' },
  'user.mcp.resources': { to: 'pinnedClient' },
  'user.mcp.readResource': { to: 'pinnedClient' },
  // the turn's device runs a chat's GitHub and GitLab tools with its own accounts
  'user.forge.tool': { to: 'pinnedClient', needs: USER_FORGE_FEATURE },
  'user.forge.describe': { to: 'pinnedClient', needs: USER_FORGE_FEATURE },
  'views.drained': { to: 'daemon' },
  'chats.reveal': { to: 'daemon' },
  // the daemon asks it of a client itself, for chats.reveal
  'chats.showSession': { to: 'refused' },
  // a client opens the tab in its own window, of a chat it shows; core matches the refusal's text (DESIGN_PREVIEW_CLIENT_ABSENT)
  'design.openPreview': { to: 'chatClient', noClient: noPreviewClient, needs: 'design.openPreview' },
  // core matches the refusal's text (DESIGN_RENDER_CLIENT_ABSENT)
  'design.capture': { to: 'workClient', noClient: noRenderingClient, needs: 'design.capture' },
  // core falls back to design.capture on DESIGN_RENDER_PREDATES when the call asked for nothing only design.render does
  'design.render': { to: 'workClient', noClient: noRenderClient, needs: 'design.render' },
  'design.probe': { to: 'workClient', noClient: noRenderingClient, needs: 'design.probe' },
  'design.journey': { to: 'workClient', noClient: noJourneyClient('design.journey'), needs: journeyNeeds('design.journey') },
  // a replay drives the chat's own preview tab, so only a client showing the chat runs it
  'design.replayJourney': { to: 'chatClient', noClient: noJourneyClient('design.replayJourney'), needs: journeyNeeds('design.replayJourney') },
};

// actingClient: as a client request route, an event held past its expiry dropped and logged; registry: the daemon's own (the
// run registry, the port detector); needs: every attached client whose attach listed that name of FEATURES, as a request
// route's needs
export type CoreEventRoute = 'allClients' | 'actingClient' | 'attachmentClient' | 'registry' | 'dropped' | { readonly to: 'allClients'; readonly needs: string };

export const CORE_EVENT_ROUTES: Readonly<Record<keyof CoreEvents, CoreEventRoute>> = {
  'window.openAppSettings': 'actingClient',
  'window.toggleTerminal': 'actingClient',
  // the run registry reads these two as well; the router also replays chat.activity (the attach snapshot, publishChat)
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
  'user.mcpChanged': 'dropped',
  'ports.urlSeen': 'registry',
  'design.changed': { to: 'allClients', needs: 'design.changed' },
  // only this computer's core keeps Git hosting accounts
  'forge.chooseAccountRows': 'dropped',
  'forge.bindingsChanged': 'dropped',
  'forge.ci.changed': 'dropped',
};

// each attach gets a snapshot as deltas from version 1, then live deltas; chats only of the panels that client views;
// dropped: a topic only this computer's core publishes, which no client gets from a daemon
export const CORE_MIRROR_ROUTES: Readonly<Record<keyof CoreMirrorTopics, 'materialized' | 'dropped'>> = {
  chats: 'materialized',
  folderTargets: 'materialized',
  worktrees: 'materialized',
  scm: 'materialized',
  heldMemory: 'materialized',
  // a daemon's core keeps no Git hosting accounts
  forge: 'dropped',
  forgeAuthorAvatars: 'dropped',
};

export const CORE_PANEL_OP_ROUTES: Readonly<Record<keyof CorePanelOps, 'actingClient' | 'views'>> = {
  // inside a client's work held for that client alone, and disposed toward core once the intent expired
  create: 'actingClient',
  showPage: 'views',
  post: 'views',
  postBinary: 'views',
  setIcon: 'views',
  setTitle: 'views',
  setFolderLabel: 'views',
  // core's own work only: a reveal inside a client's work is chats.reveal
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
  'sessionFiles.write': 'core',
  'folders.setDefault': 'core',
  'browser.newPage': 'refused',
  'browser.useClientCertificate': 'refused',
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
  // core reads only a design a chat of its own holds, and only below that design's folder
  'design.read': 'core',
  'design.info': 'core',
  // the remote core writes the markup into its own design folder, on its own machine
  'design.markup': 'core',
  'design.tweak': 'core',
  // the remote core opens the preview in its own design chat, which the client shows
  'design.previewScreen': 'core',
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
  'e2e.clientNetworkAnswers': 'e2e',
  // served by the client's own core
  'user.resolveCredential': 'refused',
  'user.clientAuth': 'refused',
  // lands only in the pushing client's cache (the request's actor)
  'user.credentials.push': 'core',
  'user.voice.speak': 'refused',
  'user.browser.tool': 'refused',
  'user.browser.release': 'refused',
  'user.memory.search': 'refused',
  'user.memory.profile': 'refused',
  'user.memory.resolve': 'refused',
  'user.memory.apply': 'refused',
  'user.memory.list': 'refused',
  // the request's actor is the device that takes a held queue
  'memory.deliverHeld': 'core',
  'memory.discardHeld': 'core',
  'user.mcp.servers': 'refused',
  // a daemon's core keeps no Git hosting accounts
  'forge.avatar': 'refused',
  'forge.repoAccounts': 'refused',
  'forge.bindAccount': 'refused',
  'forge.hostDefaults': 'refused',
  'forge.setHostDefault': 'refused',
  'forge.prepareGitOperation': 'refused',
  'forge.forgetProject': 'refused',
  'forge.forgetHost': 'refused',
  'forge.keepHosts': 'refused',
  'forge.gitCredential': 'refused',
  'forge.ci.watch': 'refused',
  'forge.ci.unwatch': 'refused',
  'forge.ci.jobs': 'refused',
  'forge.ci.jobLog': 'refused',
  'forge.ci.jobAction': 'refused',
  'forge.ci.commitStatus': 'refused',
  'forge.ci.webUrl': 'refused',
  'forge.link': 'refused',
  'forge.history.context': 'refused',
  'forge.history.avatars': 'refused',
  'forge.history.containing': 'refused',
  'forge.branchProtection': 'refused',
  'forge.pushProtection': 'refused',
  'forge.servers': 'refused',
  'forge.clone.accounts': 'refused',
  'forge.clone.search': 'refused',
  'forge.clone.paste': 'refused',
  'forge.clone.target': 'refused',
  'forge.publishAccounts': 'refused',
  'forge.publishOwners': 'refused',
  'forge.createRepository': 'refused',
  'forge.pushAccess': 'refused',
  'forge.fork': 'refused',
  'forge.openMergeRequest': 'refused',
  'forge.openOrgAccess': 'refused',
  'user.mcp.call': 'refused',
  'user.mcp.resources': 'refused',
  'user.mcp.readResource': 'refused',
  'user.forge.tool': 'refused',
  'user.forge.describe': 'refused',
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
 * union: every client's grants for the daemon's life; folders: the attached clients' projects, a busy one kept; panel: per
 * panel, by the client's view; perClient: keyed by the sending client's id (editor, terminal and language as clientEditor,
 * clientTerminal and clientLanguage), dropped when it detaches; daemonOwned: the daemon publishes it, a client's delta is
 * dropped (state: core's key-value state is the daemon's own).
 */
export const MIRROR_TOPIC_ROUTES: Readonly<Record<keyof MirrorTopics, 'union' | 'folders' | 'panel' | 'perClient' | 'daemonOwned'>> = {
  state: 'daemonOwned',
  trust: 'union',
  folders: 'folders',
  panel: 'panel',
  editor: 'perClient',
  terminal: 'perClient',
  language: 'perClient',
  clientAuth: 'perClient',
  clientUser: 'perClient',
  clientPolicy: 'perClient',
  actingClient: 'daemonOwned',
  hostSockets: 'daemonOwned',
  clientNetwork: 'daemonOwned',
  clientEditor: 'daemonOwned',
  clientTerminal: 'daemonOwned',
  clientLanguage: 'daemonOwned',
  clientMcp: 'perClient',
  clientForges: 'perClient',
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
  // by client id, the attached clients' only
  readonly clientAuth: Map<string, ClientAuth>;
  readonly clientUser: Map<string, ClientUser>;
  readonly clientPolicy: Map<string, ClientPolicy>;
  readonly clientEditor: Map<string, EditorMirror>;
  readonly clientTerminal: Map<string, TerminalToggle>;
  readonly clientLanguage: Map<string, MirrorTopics['language']>;
  readonly clientMcp: Map<string, MirrorTopics['clientMcp']['value'] & object>;
  readonly clientForges: Map<string, MirrorTopics['clientForges']['value'] & object>;
  actingClient: MirrorTopics['actingClient'];
}

export function createClientMirrors(): ClientMirrors {
  return {
    trust: new Set(),
    clientFolders: new Map(),
    folders: [],
    clientAuth: new Map(),
    clientUser: new Map(),
    clientPolicy: new Map(),
    clientEditor: new Map(),
    clientTerminal: new Map(),
    clientLanguage: new Map(),
    clientMcp: new Map(),
    clientForges: new Map(),
    actingClient: {},
  };
}

type PerClientTopic = 'clientAuth' | 'clientUser' | 'clientPolicy' | 'clientEditor' | 'clientTerminal' | 'clientLanguage' | 'clientMcp' | 'clientForges';
type PerClientValue = ClientAuth | ClientUser | ClientPolicy | EditorMirror | TerminalToggle | MirrorTopics['language'] | (MirrorTopics['clientMcp']['value'] & object) | (MirrorTopics['clientForges']['value'] & object);
const PER_CLIENT_TOPICS: readonly PerClientTopic[] = ['clientAuth', 'clientUser', 'clientPolicy', 'clientEditor', 'clientTerminal', 'clientLanguage', 'clientMcp', 'clientForges'];

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
  // the names of FEATURES its attach listed (CoreAttach.features), which a route's needs reads; absent, none
  readonly features?: ReadonlySet<string>;
  // the attach generation's transport (attached-transport framing already removed)
  readonly transport: CoreTransport;
  readonly mirrors: Pick<MirrorTopics, 'editor' | 'terminal' | 'language'> & {
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
  // a URL an agent shell printed (ports.urlSeen)
  readonly agentShellUrl: (hit: CoreEvents['ports.urlSeen']) => void;
  // a client's clientPolicy changed in mirrors
  readonly clientPolicyChanged: () => void;
  // how long the work of a device that is away waits for it; ACTOR_INTENT_EXPIRY_MS unless the e2e hooks shorten it
  readonly actorIntentExpiryMs?: number;
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

// actor: the client the work's actor names, with its session only while it is present; acting: work with no actor
type RouteTarget =
  | { readonly kind: 'actor'; readonly clientId: string; readonly session?: Session }
  | { readonly kind: 'acting'; readonly session?: Session };

type CorePanelEnvelope = Parameters<Parameters<MainEndpoint['onPanel']>[0]>[1];

// views.drained holds core's pacing while a create is held, so core folds its partials; this bounds what still arrives unpaced
export const MAX_HELD_PANEL_OPS = 10_000;

// a create held for a client that is away, what core sent that panel since, in order, and the end of the hold
interface HeldCreate {
  readonly cancel: AbortController;
  readonly ops: CorePanelEnvelope[];
  released?: Promise<void>;
}

const NAMESPACE = (hostId: string): string => `remote/${hostId}/`;

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
  // each panel's latest chat.activity while its chats entry stands: core sends one only at a change or a session bind
  const activities = new Map<string, CoreEvents['chat.activity']>();
  // core's view id -> the panel's title, which listRuns reports
  const titles = new Map<string, string>();
  let folderTargets: CoreMirrorTopics['folderTargets'] | undefined;
  let worktrees: CoreMirrorTopics['worktrees'] | undefined;
  let heldMemory: CoreMirrorTopics['heldMemory'] | undefined;
  const scmViews = new Map<string, ScmPatch>();
  const scmRepositories = new Map<string, ScmPatch>();
  const scmStates = new Map<string, ScmPatch>();
  const scmDecorations = new Map<string, ScmPatch>();
  let scmClone: ScmPatch | undefined;
  const attachments = new Map<number, { readonly session: Session; readonly attachment: number }>();
  let nextAttachment = 0;
  const commitTokens = new Map<string, Session>();
  let acting: Session | undefined;
  const disposables: Disposable[] = [];
  // core ended: nothing more is asked of it
  let ended = false;

  const live = (session: Session | undefined): session is Session => session !== undefined && !session.closed;
  // a client inside its reconnection grace still gets every post and delta, sent on its resume, but answers nothing meanwhile
  const present = (session: Session | undefined): session is Session => live(session) && !session.client.lost();
  const actingSession = (): Session | undefined => (live(acting) ? acting : [...sessions.values()].at(-1));
  // the acting client core is told of: a lost one reads as detached, so another attached one, else none
  const actingPresent = (): Session | undefined => (present(acting) ? acting : [...sessions.values()].reverse().find(present));
  const actingChain = (): Session | undefined => {
    const fallback = actingSession();
    return present(fallback) ? fallback : [...sessions.values()].reverse().find(present);
  };
  // core stamps the work's origin as its actor: the effects of a client's work reach that client alone, so it names the
  // session only while that client is present; work with no actor goes to the acting client, else another present one
  const routeTarget = (): RouteTarget => {
    const actor = processActor.current();
    if (actor !== undefined) {
      const named = sessions.get(actor);
      return present(named) ? { kind: 'actor', clientId: actor, session: named } : { kind: 'actor', clientId: actor };
    }
    const session = actingChain();
    return session ? { kind: 'acting', session } : { kind: 'acting' };
  };
  // a turn's view and the secrets namespace serve the work rather than a device's click: the actor when present, else acting
  const workSession = (): Session | undefined => routeTarget().session ?? actingChain();
  const outbox = createActorOutbox<Session>({ expiryMs: deps.actorIntentExpiryMs ?? ACTOR_INTENT_EXPIRY_MS, timers: { setTimeout, clearTimeout }, log });
  // core's view id -> its create, held for a client that is away
  const heldCreates = new Map<string, HeldCreate>();
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
  const capable = (session: Session, needs: string | undefined): boolean => needs === undefined || session.client.features?.has(needs) === true;
  const noClientContext = (viewerLacksNeeds = false): NoClientContext => ({ folders: deps.mirrors.folders, attached: (feature) => [...sessions.values()].some((session) => present(session) && capable(session, feature)), viewerLacksNeeds });
  // the first present client that lists needs: the preferred one, then the acting client, then the latest attached
  const capableSession = (preferred: Session | undefined, needs: string | undefined): Session | undefined =>
    [preferred, actingSession(), ...[...sessions.values()].reverse()].find((candidate) => present(candidate) && capable(candidate, needs));
  // core reads the acting client from this mirror, so it is published before the message that made the client act
  const publishActing = (): void => {
    const clientId = actingPresent()?.client.clientId;
    if (ended || deps.mirrors.actingClient.clientId === clientId) return;
    deps.mirrors.actingClient = clientId === undefined ? {} : { clientId };
    core.publish('actingClient', deps.mirrors.actingClient);
  };
  const publishClientValue = (topic: PerClientTopic, clientId: string, value: PerClientValue | undefined): void => {
    const map = deps.mirrors[topic] as Map<string, unknown>;
    if (value === undefined) map.delete(clientId);
    else map.set(clientId, value);
    if (!ended) (core.publish as (name: string, patch: unknown) => void)(topic, value === undefined ? { clientId } : { clientId, value });
    if (topic === 'clientPolicy') deps.clientPolicyChanged();
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
      const added = !session.chats.has(panelId);
      session.chats.add(panelId);
      deliver(session, (endpoint) => endpoint.publish('chats', { panelId, entry: { ...entry, viewId: viewer.viewId } }));
      // after the entry: main drops the activity of a panel whose entry it does not hold
      const activity = activities.get(panelId);
      if (added && activity !== undefined) deliver(session, (endpoint) => endpoint.emit('chat.activity', activity));
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
      const session = workSession();
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
      const session = workSession();
      if (session) await session.endpoint.request('secrets.store', { key: NAMESPACE(session.client.hostId) + key, value }, signal);
    },
    'secrets.delete': async ({ key }, signal) => {
      if (isProviderKey(key)) {
        log(`[core-host] refused core's delete of the provider key ${key}`);
        throw new Error('A provider key changes only on the client');
      }
      deps.secrets.set(key, undefined);
      const session = workSession();
      if (session) await session.endpoint.request('secrets.delete', { key: NAMESPACE(session.client.hostId) + key }, signal);
    },
    'secrets.keys': async (_params, signal) => {
      const cached = [...deps.secrets].flatMap(([key, value]) => (value === undefined ? [] : [key]));
      const session = workSession();
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
      // a panel held for an away device drains once it is delivered or its hold ends
      await heldCreates.get(viewId)?.released;
      // a keyed ask waits for that view's client alone, an unkeyed one for every viewing client; neither for one inside its grace
      if (viewKey !== undefined) {
        const keyed = viewers.get(viewId)?.get(viewKey);
        if (keyed !== undefined && live(keyed.session)) await drainedUnlessLost(keyed.session);
        return;
      }
      await Promise.all([...new Set(liveViewers(viewId).map((viewer) => viewer.session))].map(drainedUnlessLost));
    },
    // A reveal inside a device's work shows the chat on that device alone and never moves another device's view, held in the
    // actor outbox while that device is away; it answers false when that device cannot be shown it (back too late, an app
    // without chats.showSession, no stored session to join by, or its app did not open it).
    'chats.reveal': async ({ viewId, column }, signal) => {
      const payload = column !== undefined ? { column } : {};
      const reveal = (targets: readonly Viewer[]): true => {
        for (const viewer of targets) deliver(viewer.session, (endpoint) => endpoint.postPanel(viewer.viewId, 'reveal', payload));
        return true;
      };
      const revealOn = async (actor: Session): Promise<boolean> => {
        const own = viewerOf(actor, viewId);
        if (own) return reveal([own]);
        const sessionId = [...chats.values()].find((entry) => entry.viewId === viewId)?.sessionId;
        if (sessionId === undefined || !capable(actor, 'chats.showSession')) {
          log(`[core-host] revealing view ${viewId} for ${actor.client.id}, which cannot open it (${sessionId === undefined ? 'no stored session' : 'no chats.showSession'})`);
          return false;
        }
        try {
          await actor.endpoint.request('chats.showSession', { sessionId }, signal);
        } catch (err) {
          log(`[core-host] ${actor.client.id} did not open chat ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
        // the client joined the panel before answering, so a request core sends next for the chat finds it among the viewers
        return viewerOf(actor, viewId) !== undefined;
      };
      const actorId = processActor.current();
      if (actorId === undefined) return reveal(liveViewers(viewId));
      const actor = sessions.get(actorId);
      if (present(actor)) return revealOn(actor);
      let revealed: Promise<boolean> | undefined;
      await outbox.hold(actorId, {
        what: `the reveal of view ${viewId}`,
        signal,
        deliver: (session) => {
          revealed = revealOn(session);
        },
      });
      return (await revealed) ?? false;
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
      serveCore(method, (async (params: { provider?: string; clientId: string; viewId?: string }, signal: AbortSignal) => {
        const session = sessions.get(params.clientId);
        const what = params.provider === undefined ? method : `${method} for ${params.provider}`;
        if (!present(session)) {
          log(`[core-host] ${what}: client ${params.clientId} is not attached`);
          throw new Error(CREDENTIAL_CLIENT_ABSENT);
        }
        if (!capable(session, route.needs)) {
          log(`[core-host] ${what}: client ${params.clientId} attached without ${route.needs}`);
          throw new Error(CLIENT_FEATURE_MISSING);
        }
        log(`[core-host] ${what} from client ${params.clientId} (${session.client.id})`);
        // a client lost while it answers is absent at once: its answer would arrive only on its resume
        const asking = new AbortController();
        const cancel = (): void => asking.abort();
        signal.addEventListener('abort', cancel, { once: true });
        const lostWhileAsking = session.client.onLostChange(() => {
          if (session.client.lost()) asking.abort();
        });
        const gone = new Promise<never>((_resolve, reject) => asking.signal.addEventListener('abort', () => reject(new Error(CREDENTIAL_CLIENT_ABSENT)), { once: true }));
        const { viewId, ...rest } = params;
        const clientView = viewId === undefined ? undefined : viewerOf(session, viewId)?.viewId;
        const sent = clientView === undefined ? rest : { ...rest, viewId: clientView };
        try {
          return await Promise.race([(session.endpoint.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, sent, asking.signal), gone]);
        } catch (err) {
          // the connection closed, was replaced or was lost while the client answered: the turn waits for that device as for an absent one
          if (session.closed || session.client.lost()) throw new Error(CREDENTIAL_CLIENT_ABSENT);
          throw err;
        } finally {
          signal.removeEventListener('abort', cancel);
          lostWhileAsking.dispose();
        }
      }) as never);
    } else if (route.to === 'viewClient' || route.to === 'chatClient') {
      const noClient = route.noClient as (params: unknown, context: NoClientContext) => unknown;
      serveCore(method, ((params: { viewId?: string; panelId?: string }, signal: AbortSignal) => {
        const needs = needsOf(route, params);
        const viewId = route.to === 'viewClient' ? params.viewId : chats.get(params.panelId ?? '')?.viewId;
        const actorId = processActor.current();
        const actorOnly = route.to === 'chatClient' && actorId !== undefined;
        const eligible = viewId === undefined ? [] : liveViewers(viewId).filter((viewer) => present(viewer.session) && (!actorOnly || viewer.session.client.clientId === actorId));
        const shown = eligible.filter((viewer) => capable(viewer.session, needs));
        const actor = workSession();
        const viewer = actorOnly ? shown[0] : shown.find((candidate) => candidate.session === actor) ?? shown[0];
        if (!viewer) {
          const asked = actorOnly ? `client ${actorId}` : 'no client';
          log(`[core-host] ${method} for ${route.to === 'viewClient' ? `view ${params.viewId}` : `chat ${params.panelId}`}, which ${asked}${needs === undefined ? '' : ` listing ${needs}`} shows`);
          return noClient(params, noClientContext(eligible.length > 0));
        }
        const sent = route.to === 'viewClient' ? { ...params, viewId: viewer.viewId } : params;
        return (viewer.session.endpoint.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, sent, signal);
      }) as never);
    } else {
      const noClient = route.noClient as (params: unknown, context: NoClientContext) => unknown;
      const ask = (session: Session, params: unknown, signal: AbortSignal): Promise<unknown> =>
        (session.endpoint.request as (name: string, value: unknown, abort: AbortSignal) => Promise<unknown>)(method, params, signal);
      serveCore(method, (async (params: unknown, signal: AbortSignal) => {
        const needs = needsOf(route, params);
        const target = route.to === 'issuingClient' ? undefined : routeTarget();
        const actorAlone = route.to === 'client' && target?.kind === 'actor';
        if (actorAlone && target.session === undefined) {
          let asked: Promise<unknown> | undefined;
          await outbox.hold(target.clientId, {
            what: `core's ${method}`,
            signal,
            deliver: (session) => {
              if (capable(session, needs)) asked = ask(session, params, signal);
              else log(`[core-host] ${method}: client ${session.client.id} attached again without ${needs}`);
            },
          });
          return asked ?? noClient(params, noClientContext());
        }
        const session = target === undefined
          ? commitTokens.get((params as { token: string }).token)
          : actorAlone ? target.session : capableSession(target.session, needs);
        if (!present(session)) {
          log(`[core-host] ${method} with no client${needs === undefined ? '' : ` listing ${needs}`} attached`);
          return noClient(params, noClientContext());
        }
        if (!capable(session, needs)) {
          log(`[core-host] ${method}: client ${session.client.id} attached without ${needs}`);
          return noClient(params, noClientContext());
        }
        return ask(session, params, signal);
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
      if (typeof route === 'object') {
        for (const session of sessions.values()) if (capable(session, route.needs)) emitTo(session, name, payload);
        return;
      }
      if (route === 'registry') return;
      if (route === 'dropped') log(`[core-host] dropped core's ${name}, which a daemon's core never sends`);
      else if (route === 'allClients') for (const session of sessions.values()) emitTo(session, name, payload);
      else if (route === 'actingClient') {
        const target = routeTarget();
        if (target.kind === 'actor' && target.session === undefined) void outbox.hold(target.clientId, { what: `core's ${name}`, deliver: (session) => emitTo(session, name, payload) });
        else emitTo(target.session, name, payload);
      }
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
    core.onEvent('chat.activity', (payload) => {
      if (chats.has(payload.panelId)) activities.set(payload.panelId, payload);
      deps.registry.panelActivity(runOf(payload.panelId), payload.activity, processActor.current() ?? actingPresent()?.client.clientId);
    }),
    core.onEvent('chat.turnSettled', ({ panelId }) => deps.registry.panelSettled(panelId)),
    core.onEvent('chat.providers', ({ panelId, providers }) => deps.registry.panelProviders(panelId, providers)),
    core.onEvent('ports.urlSeen', (hit) => deps.agentShellUrl(hit)),
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
        activities.delete(patch.panelId);
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
    core.onMirror('heldMemory', (patch) => {
      heldMemory = patch;
      for (const session of sessions.values()) deliver(session, (endpoint) => endpoint.publish('heldMemory', patch));
    }),
    core.onMirror('scm', (patch) => {
      scmMaps(patch);
      for (const session of sessions.values()) deliver(session, (endpoint) => endpoint.publish('scm', patch));
    }),
  );

  // ---- core's panel envelopes
  const toViews = (viewId: string, envelope: CorePanelEnvelope): void => {
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
  };
  disposables.push(core.onPanel((viewId, envelope) => {
    const held = heldCreates.get(viewId);
    if (held !== undefined && envelope.op !== 'create') {
      // what core sends a held panel (its page, icon, title) follows its create; a close cancels both
      if (envelope.op === 'close') held.cancel.abort();
      else if (held.ops.length < MAX_HELD_PANEL_OPS) held.ops.push(envelope);
      else {
        heldCreates.delete(viewId);
        held.cancel.abort();
        log(`[core-host] dropped the new panel ${viewId}: core sent it over ${MAX_HELD_PANEL_OPS} updates while its device was away`);
        core.postPanel(viewId, 'disposed', { error: 'the device that asked is away', reason: 'user' });
      }
      return;
    }
    if (CORE_PANEL_OP_ROUTES[envelope.op] === 'actingClient') {
      // the browser runs on the client's own core
      if (envelope.op === 'create' && (envelope.payload as CorePanelOps['create']).kind === 'browser') {
        log(`[core-host] refused core's browser page ${viewId}`);
        core.postPanel(viewId, 'disposed', { error: 'a host opens no browser page', reason: 'user' });
        return;
      }
      const { parent, ...create } = envelope.payload as CorePanelOps['create'];
      titles.set(viewId, create.title);
      const createOn = (session: Session): void => {
        bindView(session, viewId, viewId);
        // core names the parent by its own view id, which this client may show under another (a chat it rejoined)
        const parentView = parent === undefined ? undefined : viewerOf(session, parent)?.viewId;
        deliver(session, (endpoint) => endpoint.postPanel(viewId, 'create', parentView === undefined ? create : { ...create, parent: parentView }));
      };
      const target = routeTarget();
      if (target.kind === 'actor' && target.session === undefined) {
        // core's own wait for the page (webviewReady) ends when the expiry disposes it
        const entry: HeldCreate = { cancel: new AbortController(), ops: [] };
        heldCreates.set(viewId, entry);
        const deliverCreate = (session: Session): void => {
          heldCreates.delete(viewId);
          // a detach disposes only the views it unbinds, so core would wait on this page's webviewReady
          if (session.closed) {
            core.postPanel(viewId, 'disposed', { error: 'the device that asked is away', reason: 'user' });
            return;
          }
          createOn(session);
          for (const op of entry.ops) toViews(viewId, op);
        };
        entry.released = outbox.hold(target.clientId, { what: `the new panel ${viewId}`, signal: entry.cancel.signal, deliver: deliverCreate }).then((outcome) => {
          if (heldCreates.get(viewId) === entry) heldCreates.delete(viewId);
          if (outcome === 'expired' && !ended) core.postPanel(viewId, 'disposed', { error: 'the device that asked is away', reason: 'user' });
        });
        return;
      }
      // with no other client there, one inside its grace still gets the page, on its resume
      const session = target.session ?? actingSession();
      if (!session) {
        core.postPanel(viewId, 'disposed', { error: 'no client is attached', reason: 'user' });
        return;
      }
      createOn(session);
      return;
    }
    toViews(viewId, envelope);
  }));

  // ---- a client
  const snapshot = (session: Session): void => deliver(session, (endpoint) => {
    if (folderTargets) endpoint.publish('folderTargets', folderTargets);
    if (worktrees) endpoint.publish('worktrees', worktrees);
    if (heldMemory) endpoint.publish('heldMemory', heldMemory);
    for (const panelId of chats.keys()) publishChat(session, panelId);
    for (const payload of activities.values()) endpoint.emit('chat.activity', payload);
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
            publishClientValue('clientEditor', client.clientId, patch as EditorMirror);
            return;
          case 'terminal':
            publishClientValue('clientTerminal', client.clientId, patch as TerminalToggle);
            return;
          case 'language':
            publishClientValue('clientLanguage', client.clientId, patch as MirrorTopics['language']);
            return;
          case 'clientAuth':
          case 'clientUser':
          case 'clientPolicy':
          case 'clientMcp':
          case 'clientForges': {
            const { value } = patch as { value?: ClientAuth | ClientUser | ClientPolicy | MirrorTopics['clientMcp']['value'] | MirrorTopics['clientForges']['value'] };
            if (value === undefined) {
              log(`[core-host] dropped ${client.id}'s ${topic} without a value`);
              return;
            }
            publishClientValue(topic, client.clientId, value);
            return;
          }
          case 'state':
          case 'actingClient':
          case 'hostSockets':
          case 'clientNetwork':
          case 'clientEditor':
          case 'clientTerminal':
          case 'clientLanguage':
            log(`[core-host] dropped ${client.id}'s ${topic}, which the daemon publishes`);
            return;
          default: {
            const unrouted: never = topic;
            log(`[core-host] dropped ${client.id}'s ${String(unrouted)}, which has no route`);
          }
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
    // a core that ended keeps its clients' values for the next core's init; the connection drops them when it closes
    if (!ended) for (const topic of PER_CLIENT_TOPICS) publishClientValue(topic, session.client.clientId, undefined);
    publishActing();
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
        disposables: [],
        closed: false,
      };
      sessions.set(client.clientId, session);
      acting = session;
      for (const topic of ['clientAuth', 'clientUser', 'clientPolicy'] as const) publishClientValue(topic, client.clientId, client.mirrors[topic]);
      publishClientValue('clientEditor', client.clientId, client.mirrors.editor);
      publishClientValue('clientTerminal', client.clientId, client.mirrors.terminal);
      publishClientValue('clientLanguage', client.clientId, client.mirrors.language);
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
        if (!client.lost()) outbox.present(client.clientId, session, () => present(session));
      }));
      publishActing();
      serveClient(session);
      grantTrust(client.mirrors.trust.keys, []);
      deps.mirrors.clientFolders.set(client.clientId, client.mirrors.folders.folders);
      publishFolders();
      // a snapshot the wire refuses detaches a session already whole; what its work held follows the snapshot
      snapshot(session);
      if (present(session)) outbox.present(client.clientId, session, () => present(session));
      return { dispose: () => detach(session, 'the client detached') };
    },
    dispose: () => {
      ended = true;
      outbox.dispose();
      for (const session of [...sessions.values()]) detach(session, 'Damocles Core stopped');
      for (const disposable of disposables.splice(0)) disposable.dispose();
      retention.dispose();
      for (const panelId of chats.keys()) deps.registry.removePanel(panelId);
    },
  };
}
