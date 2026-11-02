// On a daemon's core the user-scope services live on the client: the browser (user.browser.*), global memory (user.memory.*)
// and personal MCP servers (user.mcp.*) are relayed to an attached client; with none attached each answers its reason here.
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

/** What this core reaches of its client's user scope now: the browser through any attached client, a relayed MCP tool only through the pinned device that relays it. */
export function userScopeReach(): UserScopeReach {
  const remote = installedPlatform()?.remote;
  if (remote === undefined) return { browser: true, relayedTool: () => true };
  const servers = pinnedRelayedServers(remote);
  return {
    browser: remote.clients.anyAttached(),
    relayedTool: ({ server, tool }) => servers?.some((candidate) => candidate.name === server && candidate.tools.some((own) => own.name === tool)) === true,
  };
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

/** A global memory operation a chat on a remote host has no relay for (the notes list, a global row's history). */
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

/** A call to a personal MCP server of a chat on a remote host while its client is not attached. */
export function relayedMcpClosedReason(server: string): LocalizedText {
  return l('The MCP server {0} runs on your computer and Damocles is closed.', server);
}

/** A call to a relayed MCP server from a turn whose device does not relay that server. */
export function relayedMcpElsewhereReason(server: string): LocalizedText {
  return l('The MCP server {0} runs on another computer, not the one that sent this message.', server);
}
