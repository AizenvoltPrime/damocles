// On a daemon's core the user-scope services live on the client: the browser (user.browser.*), global memory (user.memory.*),
// personal MCP servers (user.mcp.*) and the GitHub and GitLab tools (user.forge.*) are relayed to an attached client; with none
// attached each answers its reason here.
import { USER_SCOPE_UNAVAILABLE, type RelayedMcpServer } from '../shared/remote-user';
import type { LocalizedText } from '../shared/localized-text';
import type { RemoteHost } from '../platform/remote-host';
import { currentPin } from './client-snapshots';
import { l } from './l10n';
import { installedPlatform } from './platform-host';
import type { UserScopeReach } from './pi-session/tools/deferred-tools';

/** Whether this core is a daemon's, whose user-scope services are its client's. */
export function userScopeRemote(): boolean {
  return installedPlatform()?.remote !== undefined;
}

/** Whether this core reaches a browser: its own on this computer, an attached client's on a daemon. */
export function browserReachable(): boolean {
  const remote = installedPlatform()?.remote;
  return remote === undefined || remote.clients.anyAttached();
}

/** The relayed MCP servers of the device the running turn is pinned to, else the acting one; undefined while it is away. */
function pinnedRelayedServers(remote: RemoteHost): readonly RelayedMcpServer[] | undefined {
  const clientId = currentPin(remote).clientId;
  return clientId !== undefined && remote.clients.attached(clientId) ? remote.clients.mcp(clientId) ?? [] : undefined;
}

let localForgeAccounts: () => boolean = () => false;

/** This computer's core: whether a GitHub or GitLab account exists (ForgeService.hasAccount); a core without one keeps the default. */
export function setLocalForgeAccounts(hasAccount: () => boolean): void {
  localForgeAccounts = hasAccount;
}

/** A daemon's core: the GitHub and GitLab accounts of the device the running turn is pinned to (else the acting one). */
function pinnedForges(remote: RemoteHost): 'away' | 'unread' | 'none' | 'account' {
  const clientId = currentPin(remote).clientId;
  if (clientId === undefined || !remote.clients.attached(clientId)) return 'away';
  const forges = remote.clients.forges(clientId);
  if (forges?.pending === true) return 'unread';
  return forges?.servers.some((server) => server.hasAccount) === true ? 'account' : 'none';
}

/**
 * What this core reaches of its client's user scope now: the browser through any attached client, the GitHub and GitLab
 * tools while the pinned device has an account (this computer's core: its own accounts), a relayed MCP tool only through the
 * pinned device that relays it.
 */
export function userScopeReach(): UserScopeReach {
  const remote = installedPlatform()?.remote;
  if (remote === undefined) return { browser: true, forge: localForgeAccounts(), relayedTool: () => true };
  const servers = pinnedRelayedServers(remote);
  return {
    browser: remote.clients.anyAttached(),
    forge: pinnedForges(remote) === 'account',
    relayedTool: ({ server, tool }) => servers?.some((candidate) => candidate.name === server && candidate.tools.some((own) => own.name === tool)) === true,
  };
}

/** Why the Tools panel's GitHub and GitLab group is unavailable: the pinned device's servers are not read yet, or no account is known; undefined with one. */
export function forgeGroupUnavailable(): 'noForgeAccount' | 'forgeServersUnread' | undefined {
  const remote = installedPlatform()?.remote;
  if (remote === undefined) return localForgeAccounts() ? undefined : 'noForgeAccount';
  switch (pinnedForges(remote)) {
    case 'account':
      return undefined;
    case 'unread':
      return 'forgeServersUnread';
    default:
      return 'noForgeAccount';
  }
}

/**
 * Why the GitHub and GitLab tools are out of reach: the pinned device is away, its servers are not read yet, or no account
 * exists where they would run.
 */
export function forgeUnreachableReason(): LocalizedText {
  const remote = installedPlatform()?.remote;
  if (remote === undefined) return forgeNoAccountReason();
  switch (pinnedForges(remote)) {
    case 'away':
      return forgeClosedReason();
    case 'unread':
      return l('Damocles has not read the GitHub and GitLab servers of your computer yet. Try again in a moment.');
    default:
      return forgeNoAccountReason();
  }
}

/** A GitHub or GitLab tool of a chat on a remote host while the device it runs on is not attached. */
export function forgeClosedReason(): LocalizedText {
  return l('Your GitHub and GitLab accounts are on your computer, and Damocles is closed.');
}

/** A GitHub or GitLab tool where no account exists. */
export function forgeNoAccountReason(): LocalizedText {
  return l('No GitHub or GitLab account is signed in. Sign in to one in Settings › Models & accounts › Git hosting.');
}

/** Why a relayed MCP server's tool is out of reach: its device is away, or the pinned device does not relay it. */
export function relayedMcpUnreachableReason(server: string): LocalizedText {
  const remote = installedPlatform()?.remote;
  return remote !== undefined && pinnedRelayedServers(remote) !== undefined ? relayedMcpElsewhereReason(server) : relayedMcpClosedReason(server);
}

/** A browser tool of a chat on a remote host while no client is attached. */
export function browserClosedReason(): LocalizedText {
  return l('The browser runs on your computer and Damocles is closed.');
}

/** A browser control of the page view itself (the element picker), which no relay carries; a view's form. */
export function browserUnavailableReason(): LocalizedText {
  return l('{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', l('The browser'), USER_SCOPE_UNAVAILABLE);
}

/** A global memory operation a chat on a remote host has no relay for (a global row by id, the global profile's edit). */
export function globalMemoryUnavailableReason(): LocalizedText {
  return l('{0} is not available in a chat on a remote host yet: it runs on your computer ({1}).', l('Global memory'), USER_SCOPE_UNAVAILABLE);
}

/** A change, by id, of a global memory a chat on a remote host read from the user's computer. */
export function globalMemoryChangeReason(): LocalizedText {
  return l('Change this global memory on your computer.');
}

/** A read, by id, of a global memory's history or neighbours, which only the user's computer holds. */
export function globalMemoryReadReason(): LocalizedText {
  return l('Look at this global memory on your computer.');
}

/** A global memory search of a chat on a remote host while no client is attached. */
export function globalMemoryClosedReason(): LocalizedText {
  return l('Your global memories live on your computer and Damocles is closed.');
}

/** An agent's read of the acting client's notes or global memories while memory is off on that client (CLIENT_MEMORY_OFF). */
export function globalMemoryOffReason(): LocalizedText {
  return l('Memory is off on your computer.');
}

/** The notes list of a chat on a remote host while the acting client's Damocles predates user.memory.list. */
export function globalMemoryListOutdatedReason(): LocalizedText {
  return l('Your notes are on your computer, whose Damocles is too old to list them for a chat on a remote host. Update Damocles there.');
}

/** A call to a personal MCP server of a chat on a remote host while its client is not attached. */
export function relayedMcpClosedReason(server: string): LocalizedText {
  return l('The MCP server {0} runs on your computer and Damocles is closed.', server);
}

/** A call to a relayed MCP server from a turn whose device does not relay that server. */
export function relayedMcpElsewhereReason(server: string): LocalizedText {
  return l('The MCP server {0} runs on another computer, not the one that sent this message.', server);
}
