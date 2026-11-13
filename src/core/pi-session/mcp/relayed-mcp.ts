import type { JsonRpcMessage, McpTransport } from '@earendil-works/pi-mcp';
import type { Platform } from '../../../platform/platform';
import type { RemoteHost } from '../../../platform/remote-host';
import type { SettingsStore } from '../../../platform/settings-store';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import { CREDENTIAL_CLIENT_ABSENT, MAX_RELAYED_MCP_TIMEOUT_MS, type RelayedMcpServer } from '../../../shared/remote-user';
import { MCP_REMOTE_AVAILABLE_SETTING, type McpHttpServerConfig } from '../../../shared/types/mcp';
import { currentPin } from '../../client-snapshots';
import { relayedMcpClosedReason, relayedMcpElsewhereReason } from '../../user-scope';
import { resolveResourceExposure, resolveToolExposure, type ToolExposureLayer } from './exposure';
import type { McpClientManager } from './mcp-client-manager';

// The scheme of a relayed server's placeholder url; no transport ever opens it (McpServerManager uses the relay instead).
const RELAYED_URL_SCHEME = 'relayed:';

/** Whether this core relays its personal MCP servers to remote hosts: this computer's desktop core alone. */
export function relaysPersonalMcp(platform: Pick<Platform, 'appInfo' | 'remote'>): boolean {
  return platform.appInfo.host === 'desktop' && platform.remote === undefined;
}

/** The personal servers the user marked available on remote hosts (damocles.desktop.mcp.remoteAvailable). */
export function remoteAvailableNames(settings: Pick<SettingsStore, 'get'>): string[] {
  const raw = settings.get<unknown>(MCP_REMOTE_AVAILABLE_SETTING, []);
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string' && name !== '') : [];
}

/** The user scope's `damocles.mcp.toolExposure` and `damocles.mcp.resourceExposure` layers, over the servers' config. */
export interface RelayedMcpExposure {
  readonly tools: readonly ToolExposureLayer[];
  readonly resources: readonly ToolExposureLayer[];
}

/**
 * This computer's core: what a remote host learns of the marked personal servers its user MCP manager serves: each one's
 * name, description, request timeout and its tools' names, descriptions, schemas, read-only mark and config exposure, and
 * whether it offers resources. A tool or the resources the user turned Off, in the server's config or the user settings,
 * are not relayed. Built field by field, so a server's env, headers, command, url or tokens never cross.
 */
export function relayedServerDescriptors(userMcp: McpClientManager, relayable: (name: string) => boolean, marked: readonly string[], exposure: RelayedMcpExposure): RelayedMcpServer[] {
  const descriptors = userMcp.getAllToolDescriptors().filter((descriptor) =>
    resolveToolExposure(exposure.tools, descriptor.serverName, descriptor.rawToolName, descriptor.configExposure).exposure !== 'off');
  return [...new Set(marked)].sort().filter((name) => relayable(name) && userMcp.hasServer(name)).map((name) => {
    const own = descriptors.filter((descriptor) => descriptor.serverName === name);
    const description = own.find((descriptor) => descriptor.serverDescription !== undefined)?.serverDescription;
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      tools: own.map((descriptor) => ({
        name: descriptor.rawToolName,
        ...(descriptor.description !== '' ? { description: descriptor.description } : {}),
        ...(descriptor.inputSchema !== undefined ? { inputSchema: descriptor.inputSchema } : {}),
        ...(descriptor.readOnly ? { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } } : {}),
        ...(descriptor.configExposure === 'direct' ? { exposure: 'direct' as const } : {}),
      })),
      resources: userMcp.serverHasResources(name) === true && relayedResourceExposure(userMcp, name, exposure) !== 'off',
      timeoutMs: Math.min(Math.max(1, Math.ceil(userMcp.callTimeoutMsOf(name))), MAX_RELAYED_MCP_TIMEOUT_MS),
    };
  });
}

function relayedResourceExposure(userMcp: McpClientManager, name: string, exposure: RelayedMcpExposure) {
  return resolveResourceExposure(exposure.resources, name, userMcp.configResourceExposureOf(name)).exposure;
}

/** One relayed request, as main forwards it to this computer's core. */
export type RelayedMcpRequest =
  | { readonly kind: 'call'; readonly server: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>> }
  | { readonly kind: 'resources' | 'templates'; readonly server: string; readonly cursor?: string }
  | { readonly kind: 'read'; readonly server: string; readonly uri: string };

/**
 * This computer's core runs a remote host's request on a personal server only when the server is one it relays now (marked,
 * relayable, enabled) and, for a call, the tool is one that server lists, or for a resource request, the server lists its
 * resources; `relayed` comes from relayedServerDescriptors with the same `exposure`, so a tool or resources turned Off is
 * refused before it reaches a server. `signal` is the remote caller's: its Stop or timeout ends the request here.
 */
export async function runRelayedMcpRequest(
  userMcp: McpClientManager,
  relayed: readonly RelayedMcpServer[],
  exposure: RelayedMcpExposure,
  request: RelayedMcpRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const opts = signal ? { signal } : {};
  const server = relayed.find((candidate) => candidate.name === request.server);
  if (!server) throw new Error(`MCP server "${request.server}" is not available on remote hosts`);
  switch (request.kind) {
    case 'call': {
      if (!server.tools.some((tool) => tool.name === request.tool)) throw new Error(`MCP server "${request.server}" has no tool "${request.tool}"`);
      const descriptor = userMcp.getAllToolDescriptors().find((candidate) => candidate.serverName === server.name && candidate.rawToolName === request.tool);
      if (!descriptor) throw new Error(`MCP server "${request.server}" has no tool "${request.tool}"`);
      return userMcp.callTool(descriptor.piName, { ...request.args }, opts);
    }
    case 'resources':
    case 'templates': {
      if (!server.resources) throw new Error(`MCP server "${request.server}" offers no resources`);
      const access = relayedResourceExposure(userMcp, server.name, exposure);
      return request.kind === 'resources'
        ? userMcp.listResourcesPage(server.name, request.cursor, opts, access)
        : userMcp.listResourceTemplatesPage(server.name, request.cursor, opts, access);
    }
    case 'read':
      if (!server.resources) throw new Error(`MCP server "${request.server}" offers no resources`);
      return userMcp.readResource(server.name, request.uri, opts, relayedResourceExposure(userMcp, server.name, exposure));
  }
}

/** The placeholder config of a relayed server's entry: it names the server, its client's timeout and tool exposures, and opens nothing. */
export function relayedServerConfig(server: RelayedMcpServer): McpHttpServerConfig {
  const direct = server.tools.filter((tool) => tool.exposure === 'direct').map((tool) => [tool.name, 'direct' as const]);
  return {
    type: 'http',
    url: `${RELAYED_URL_SCHEME}//${encodeURIComponent(server.name)}`,
    auth: false,
    ...(server.description !== undefined ? { description: server.description } : {}),
    // seconds, as a config holds it
    ...(server.timeoutMs !== undefined ? { timeout: server.timeoutMs / 1000 } : {}),
    ...(direct.length > 0 ? { toolExposure: Object.fromEntries(direct) } : {}),
  };
}

/** How a daemon's core reaches the client it relays a server's requests to. */
export interface RelayedMcpCalls {
  call(tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  resources(kind: 'resources' | 'templates', cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
  read(uri: string, signal: AbortSignal): Promise<unknown>;
}

/**
 * The relay of one server through the device the running turn is pinned to, else the acting one: refused with the server's
 * reason while that device is away or relays no server of that name.
 */
export function clientRelayCalls(remote: RemoteHost, server: string): RelayedMcpCalls {
  const client = (): string => {
    const clientId = currentPin(remote).clientId;
    if (clientId === undefined || !remote.clients.attached(clientId)) throw new LocalizedError(relayedMcpClosedReason(server));
    if (!remote.clients.mcp(clientId)?.some((candidate) => candidate.name === server)) throw new LocalizedError(relayedMcpElsewhereReason(server));
    return clientId;
  };
  const away = (err: unknown): never => {
    throw err instanceof Error && err.message === CREDENTIAL_CLIENT_ABSENT ? new LocalizedError(relayedMcpClosedReason(server)) : err;
  };
  return {
    call: async (tool, args, signal) => remote.mcpCall(client(), server, tool, args, signal).catch(away),
    resources: async (kind, cursor, signal) => remote.mcpResources(client(), server, kind, cursor, signal).catch(away),
    read: async (uri, signal) => remote.mcpReadResource(client(), server, uri, signal).catch(away),
  };
}

/** Where an attached client's read of its personal MCP servers stands; `known` also for a detached client. */
export type RelayedMcpRead = 'reading' | 'failed' | 'known';

export function relayedMcpState(remote: RemoteHost, clientId: string): RelayedMcpRead {
  const reason = remote.clients.mcpPending(clientId);
  if (reason === undefined || !remote.clients.attached(clientId)) return 'known';
  return reason === 'reading' ? 'reading' : 'failed';
}

/** Settles with the read's state once it is no longer `reading`, or with `reading` when `ended` aborts first. */
export function relayedMcpRead(remote: RemoteHost, clientId: string, ended: AbortSignal): Promise<RelayedMcpRead> {
  return new Promise((resolve) => {
    // a detach arrives as a clientAuth delta without a value
    const subscription = remote.clients.onDidChange((change) => {
      if (change.clientId === clientId && (change.topic === 'clientMcp' || change.topic === 'clientAuth')) settle();
    });
    const stop = (state: RelayedMcpRead): void => {
      subscription.dispose();
      ended.removeEventListener('abort', onEnded);
      resolve(state);
    };
    const onEnded = (): void => stop('reading');
    const settle = (): void => {
      const state = relayedMcpState(remote, clientId);
      if (state !== 'reading' || ended.aborted) stop(state);
    };
    ended.addEventListener('abort', onEnded, { once: true });
    settle();
  });
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function errorText(err: unknown): string {
  if (err instanceof LocalizedError) return englishText(err.text);
  return err instanceof Error ? err.message : String(err);
}

/**
 * A relayed server as the MCP client sees it: initialize and tools/list answer from the client's descriptor, and each tool
 * call and resource request goes to the client, so the result passes core's usual MCP handling (image rule, binary saves
 * on this host, untrusted-text sanitizing) as any server's would.
 */
export class RelayedMcpTransport implements McpTransport {
  private readonly server: RelayedMcpServer;
  private readonly calls: RelayedMcpCalls;
  private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly inFlight = new Map<string | number, AbortController>();
  private closed = false;

  constructor(server: RelayedMcpServer, calls: RelayedMcpCalls) {
    this.server = server;
    this.calls = calls;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`The relay of MCP server "${this.server.name}" is closed`));
    if (!('method' in message)) return Promise.resolve();
    if (!('id' in message)) {
      if (message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') this.inFlight.get(requestId)?.abort();
      }
      return Promise.resolve();
    }
    const { id, method } = message;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const abort = new AbortController();
    this.inFlight.set(id, abort);
    void this.answer(method, params, abort.signal).then(
      (result) => this.emit({ jsonrpc: '2.0', id, result }),
      (err: unknown) => this.emit({ jsonrpc: '2.0', id, error: { code: err instanceof MethodNotFound ? METHOD_NOT_FOUND : INTERNAL_ERROR, message: errorText(err) } }),
    ).finally(() => this.inFlight.delete(id));
    return Promise.resolve();
  }

  private async answer(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: params['protocolVersion'],
          capabilities: { tools: {}, ...(this.server.resources ? { resources: {} } : {}) },
          serverInfo: { name: this.server.name, version: 'relayed' },
          ...(this.server.description !== undefined ? { instructions: this.server.description } : {}),
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.server.tools };
      case 'tools/call': {
        const args = params['arguments'];
        return this.calls.call(String(params['name']), typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}, signal);
      }
      case 'resources/list':
      case 'resources/templates/list': {
        const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : undefined;
        return this.calls.resources(method === 'resources/list' ? 'resources' : 'templates', cursor, signal);
      }
      case 'resources/read':
        return this.calls.read(String(params['uri']), signal);
      default:
        throw new MethodNotFound(method);
    }
  }

  private emit(message: JsonRpcMessage): void {
    if (this.closed) return;
    for (const listener of [...this.messageListeners]) listener(message);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const abort of this.inFlight.values()) abort.abort();
    this.inFlight.clear();
    for (const listener of [...this.closeListeners]) listener();
    return Promise.resolve();
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

class MethodNotFound extends Error {
  constructor(method: string) {
    super(`Method not found: ${method}`);
  }
}
