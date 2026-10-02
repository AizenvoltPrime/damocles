/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Connection pool for MCP servers on `@earendil-works/pi-mcp`: transport selection (stdio /
 * streamable HTTP), connect dedup, tool/resource discovery, list_changed handling, and cancellable
 * tool calls. pi-mcp's value classes come from the dynamically imported bundle (it is esbuild-external).
 */
import type { AuthProvider, CallToolResult, McpClient, McpTransport, ReadResourceResult } from '@earendil-works/pi-mcp';
import type { McpServerErrorInfo } from '../../../shared/types/mcp';
import { MCP_STDERR_TAIL_CHARS } from '../../../shared/types/mcp';
import type { McpClientBundle } from './mcp-client-loader';
import {
  normalizeServerConfig,
  type McpTool,
  type McpResource,
  type McpServerDefinition,
  type McpServerSpec,
  type McpElicitationHandler,
} from './types';
import { resolveMcpServerValues } from './config-value';
import { hasScopeChallenge } from './mcp-auth-flow';
import { failureForLog, McpServerConnectError } from './connect-failure';
import { resolveNpxBinary } from './npx-resolver';
import { stdioEnvironment } from './stdio-env';
import { stripBidiControls, stripControlChars } from '../untrusted-text';
import { log } from '../../logger';

export type ConnectionStatus = 'connected' | 'closed' | 'needs-auth';

/** Per-request timeout when the config sets no `timeout`. */
export const DEFAULT_MCP_TIMEOUT_MS = 120_000;
/** Health checks ping servers one after another, so one hung server delays the rest by at most this. */
export const HEALTH_PING_TIMEOUT_MS = 10_000;

export interface ServerConnection {
  client: McpClient;
  transport: McpTransport;
  /** The definition with its values resolved for this connect. */
  definition: McpServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  serverInfo?: { name: string; version: string };
  /** The server's `initialize` instructions, trimmed. */
  instructions?: string;
  lastUsedAt: number;
  inFlight: number;
  status: ConnectionStatus;
  /** Whether the transport carries an auth provider, so an authorization failure means sign-in is needed. */
  authenticates: boolean;
  /** Set on a needs-auth connection that asks for more scope than was granted. */
  errorInfo?: McpServerErrorInfo;
  /** True when the client/transport were already torn down (a needs-auth result), so `close()` must not re-tear them. */
  transportClosed?: boolean;
}

/** Produces the auth provider for a remote server from its resolved definition, or undefined for none. */
export type AuthProviderFactory = (serverName: string, url: string, definition: McpServerDefinition) => AuthProvider | undefined;

export interface McpServerManagerOptions {
  client: McpClientBundle;
  /** Damocles' version, sent as `clientInfo.version`. */
  clientVersion: string;
  authProviderFactory?: AuthProviderFactory;
  /** The shell `!command` values run in on Windows, read on every connect. */
  shellPath?: () => string | undefined;
  /** Fired after a server's tool/resource list changes (list_changed notification → refetch done). */
  onListChanged?: (serverName: string) => void;
  /** Fired when a live connection drops on its own (process crash / transport loss), never via close(). */
  onConnectionLost?: (serverName: string) => void;
  /** Builds the transport from the resolved definition instead of stdio / streamable HTTP. */
  transportFactory?: (serverName: string, definition: McpServerDefinition) => McpTransport | Promise<McpTransport>;
}

/** Keeps line breaks, flattens every other control character, and keeps the tail. */
function sanitizeStderrTail(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((line) => stripBidiControls(stripControlChars(line)));
  const text = lines.join('\n').trim();
  return text ? Array.from(text).slice(-MCP_STDERR_TAIL_CHARS).join('') : undefined;
}

export class McpServerManager {
  private readonly bundle: McpClientBundle;
  private readonly clientVersion: string;
  private readonly authProviderFactory: AuthProviderFactory | undefined;
  private readonly shellPath: (() => string | undefined) | undefined;
  private readonly onListChanged: ((serverName: string) => void) | undefined;
  private readonly onConnectionLost: ((serverName: string) => void) | undefined;
  private readonly transportFactory: McpServerManagerOptions['transportFactory'];
  private elicitationHandler: McpElicitationHandler | undefined;

  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  /** Servers whose close() landed while a connect() was still in flight: the connect must tear down its
   *  result on resolution instead of registering a live connection for a server we're closing (M2). */
  private closeRequested = new Set<string>();
  /** Per-server serialized refetch chain so racing list_changed notifications can't resolve out of order. */
  private refetchChains = new Map<string, Promise<void>>();

  constructor(options: McpServerManagerOptions) {
    this.bundle = options.client;
    this.clientVersion = options.clientVersion;
    this.authProviderFactory = options.authProviderFactory;
    this.shellPath = options.shellPath;
    this.onListChanged = options.onListChanged;
    this.onConnectionLost = options.onConnectionLost;
    this.transportFactory = options.transportFactory;
  }

  /** Enable elicitation (form) capability + register the request handler on every client (US-014.7). */
  setElicitationHandler(handler: McpElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  async connect(name: string, spec: McpServerSpec): Promise<ServerConnection> {
    const inflight = this.connectPromises.get(name);
    if (inflight) return inflight;

    const existing = this.connections.get(name);
    if (existing?.status === 'connected') {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const promise = this.createConnection(name, spec);
    this.connectPromises.set(name, promise);
    try {
      const connection = await promise;
      if (this.closeRequested.has(name)) {
        // close() ran while this connect was in flight. Tear the fresh connection down instead of
        // registering it, so a just-removed server doesn't leak a live child (M2).
        connection.status = 'closed';
        if (!connection.transportClosed) await this.tearDown(connection.client);
        throw new Error(`MCP server "${name}" was closed during connect`);
      }
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
      this.closeRequested.delete(name);
    }
  }

  /** Resolve the spec's values for this connect (rotated tokens apply), then connect over the matching transport. */
  private async createConnection(name: string, spec: McpServerSpec): Promise<ServerConnection> {
    const shellPath = this.shellPath?.();
    const resolution = await resolveMcpServerValues(spec.config, {
      format: spec.valueFormat,
      trusted: spec.trusted,
      folderScoped: spec.folderScoped,
      ...(shellPath !== undefined ? { shellPath } : {}),
    });
    if (!resolution.ok) throw new McpServerConnectError(resolution.error, { errorInfo: resolution.errorInfo });
    const definition = normalizeServerConfig(resolution.config);
    const authProvider = definition.url ? this.authProviderFactory?.(name, definition.url, definition) : undefined;

    let transport: McpTransport;
    if (this.transportFactory) transport = await this.transportFactory(name, definition);
    else if (definition.command) transport = await this.createStdioTransport(name, definition);
    else if (definition.url) transport = this.createHttpTransport(name, definition, authProvider);
    else throw new Error(`MCP server "${name}" has no command or url`);
    return this.establish(name, definition, transport, authProvider !== undefined);
  }

  private createClient(serverName: string, definition: McpServerDefinition): McpClient {
    // Advertise elicitation (form only) when wired; never advertise sampling (US-014.1).
    const client = new this.bundle.mcp.McpClient({
      name: 'Damocles',
      version: this.clientVersion,
      requestTimeoutMs: timeoutMsOf(definition),
      ...(this.elicitationHandler ? { capabilities: { elicitation: { form: {} } } } : {}),
    });
    const handler = this.elicitationHandler;
    if (handler) client.setRequestHandler('elicitation/create', (params) => handler(params, serverName));
    // The client forwards its transport's errors here too.
    client.onError((error) => log('[McpServerManager] %s reported an error: %s', serverName, failureForLog(error)));
    return client;
  }

  /**
   * Connect a fresh client over `transport`, discover tools/resources, and build the live connection.
   * With an auth provider, an authorization failure resolves to a `needs-auth` connection (already torn
   * down); any other failure tears down and throws, carrying a stdio server's stderr tail.
   */
  private async establish(
    name: string,
    definition: McpServerDefinition,
    transport: McpTransport,
    authenticates: boolean,
  ): Promise<ServerConnection> {
    const client = this.createClient(name, definition);
    try {
      await client.connect(transport);
      this.attachListChangedHandlers(name, client);

      // Servers without a capability do not answer its list method.
      const [tools, resources] = await Promise.all([
        client.serverCapabilities?.tools ? client.listTools() : Promise.resolve([]),
        client.serverCapabilities?.resources ? this.fetchResources(name, client) : Promise.resolve([]),
      ]);

      const connection: ServerConnection = {
        client,
        transport,
        definition,
        tools: tools as McpTool[],
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: 'connected',
        authenticates,
      };
      const serverInfo = client.serverInfo;
      if (serverInfo) connection.serverInfo = { name: serverInfo.name, version: serverInfo.version };
      const instructions = client.instructions?.trim();
      if (instructions) connection.instructions = instructions;
      // A deliberate close() deletes the connection from the map (or marks it needs-auth) first, so the
      // guard fires the lost-callback only for an unsolicited drop, never for our own teardown.
      client.onClose(() => {
        if (this.connections.get(name) !== connection || connection.status !== 'connected') return;
        connection.status = 'closed';
        this.connections.delete(name);
        this.refetchChains.delete(name);
        this.onConnectionLost?.(name);
      });
      return connection;
    } catch (error) {
      await this.tearDown(client);
      if (authenticates && this.isAuthRequired(error)) {
        const connection: ServerConnection = {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: 'needs-auth',
          authenticates,
          transportClosed: true,
        };
        const errorInfo = this.scopeChallengeInfo(name, definition);
        if (errorInfo) connection.errorInfo = errorInfo;
        return connection;
      }
      const stderrTail = transport instanceof this.bundle.mcp.StdioTransport ? sanitizeStderrTail(transport.stderr) : undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new McpServerConnectError(message, { ...(stderrTail ? { stderrTail } : {}), logText: failureForLog(error) });
    }
  }

  private isAuthRequired(error: unknown): boolean {
    return error instanceof this.bundle.mcp.McpAuthRequiredError || error instanceof this.bundle.oauth.McpOAuthAuthorizationRequiredError;
  }

  private scopeChallengeInfo(name: string, definition: McpServerDefinition): McpServerErrorInfo | undefined {
    return definition.url && hasScopeChallenge(name, definition.url) ? { code: 'insufficientScope' } : undefined;
  }

  /** `client.close()` closes the transport, which for stdio terminates the whole process tree. */
  private async tearDown(client: McpClient): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      log('[McpServerManager] closing an MCP client failed: %O', error);
    }
  }

  private async createStdioTransport(name: string, definition: McpServerDefinition): Promise<McpTransport> {
    let command = definition.command as string;
    let args = definition.args ?? [];

    if (command === 'npx' || command === 'npm') {
      const resolved = await resolveNpxBinary(command, args);
      if (resolved) {
        command = resolved.isJs ? 'node' : resolved.binPath;
        args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
        log('[McpServerManager] %s resolved to %s (skipping npm parent)', name, resolved.binPath);
      }
    }

    // The host resolved `cwd` to an absolute directory when it read the config (`McpManager` `serverSpec`).
    const cwd = definition.cwd;
    return new this.bundle.mcp.StdioTransport({
      command,
      args,
      // Only the allowlisted host variables plus the server's own env: never the host's provider keys.
      env: stdioEnvironment(definition.env),
      inheritEnv: false,
      stderr: definition.debug ? 'inherit' : 'pipe',
      ...(cwd !== undefined ? { cwd } : {}),
    });
  }

  private createHttpTransport(serverName: string, definition: McpServerDefinition, authProvider: AuthProvider | undefined): McpTransport {
    const headers: Record<string, string> = { ...definition.headers };
    if (definition.auth === 'bearer') {
      const token = this.bearerToken(serverName, definition);
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return new this.bundle.mcp.StreamableHttpTransport({
      url: definition.url as string,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(authProvider ? { authProvider } : {}),
    });
  }

  /** The resolved inline token, else the variable `bearerTokenEnv` names; an unset variable fails closed. */
  private bearerToken(serverName: string, definition: McpServerDefinition): string | undefined {
    if (definition.bearerToken !== undefined) return definition.bearerToken;
    const variable = definition.bearerTokenEnv;
    if (!variable) return undefined;
    const value = process.env[variable];
    if (!value) {
      throw new McpServerConnectError(`MCP server "${serverName}": environment variable ${variable} is not set (bearerTokenEnv)`, {
        errorInfo: { code: 'missingVariable', params: { variable, field: 'bearerTokenEnv' } },
      });
    }
    return value;
  }

  /** A server whose resource list fails still connects; its resources are simply not offered. */
  private async fetchResources(serverName: string, client: McpClient): Promise<McpResource[]> {
    try {
      return (await client.listResources()) as McpResource[];
    } catch (error) {
      log('[McpServerManager] resources/list failed for %s: %s', serverName, failureForLog(error));
      return [];
    }
  }

  private attachListChangedHandlers(serverName: string, client: McpClient): void {
    client.onNotification('notifications/tools/list_changed', () => {
      this.queueRefetch(serverName, () => this.refetchTools(serverName));
    });
    client.onNotification('notifications/resources/list_changed', () => {
      this.queueRefetch(serverName, () => this.refetchResources(serverName));
    });
  }

  /** Append a refetch to the server's serialized chain so paginated fetches can't interleave (L7). */
  private queueRefetch(serverName: string, task: () => Promise<void>): void {
    const prev = this.refetchChains.get(serverName) ?? Promise.resolve();
    this.refetchChains.set(serverName, prev.then(task, task));
  }

  private async refetchTools(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') return;
    try {
      connection.tools = (await connection.client.listTools()) as McpTool[];
      this.onListChanged?.(serverName);
    } catch (error) {
      log('[McpServerManager] refetch tools failed for %s: %s', serverName, failureForLog(error));
    }
  }

  private async refetchResources(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') return;
    try {
      connection.resources = (await connection.client.listResources()) as McpResource[];
      this.onListChanged?.(serverName);
    } catch (error) {
      log('[McpServerManager] refetch resources failed for %s: %s', serverName, failureForLog(error));
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    const connection = this.requireConnected(serverName);
    return this.run(serverName, connection, () =>
      connection.client.callTool(toolName, args, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        // Passing a progress listener is what lets the server's progress notifications reset the timeout.
        onProgress: () => {},
      }),
    );
  }

  async readResource(
    serverName: string,
    uri: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ReadResourceResult> {
    const connection = this.requireConnected(serverName);
    return this.run(serverName, connection, () =>
      connection.client.readResource(uri, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        onProgress: () => {},
      }),
    );
  }

  /**
   * Whether the server answers a ping within `HEALTH_PING_TIMEOUT_MS`. Any JSON-RPC reply proves it
   * alive, an error reply included (a server without `ping` answers -32601); no reply means it is not.
   */
  async answersPing(serverName: string): Promise<boolean> {
    const connection = this.requireConnected(serverName);
    try {
      await connection.client.ping({ timeoutMs: HEALTH_PING_TIMEOUT_MS });
      return true;
    } catch (error) {
      if (error instanceof this.bundle.mcp.McpError) return true;

      log('[McpServerManager] %s did not answer ping: %s', serverName, failureForLog(error));
      return false;
    }
  }

  private requireConnected(serverName: string): ServerConnection {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    return connection;
  }

  /**
   * Track one request against the connection. An expired HTTP session closes the connection so the next
   * call reconnects; an authorization failure leaves it at needs-auth.
   */
  private async run<T>(serverName: string, connection: ServerConnection, request: () => Promise<T>): Promise<T> {
    try {
      this.touch(serverName);
      this.incrementInFlight(serverName);
      return await request();
    } catch (error) {
      const current = this.connections.get(serverName) === connection;
      if (current && error instanceof this.bundle.mcp.McpSessionExpiredError) {
        await this.close(serverName);
      } else if (current && connection.authenticates && this.isAuthRequired(error)) {
        await this.markNeedsAuth(serverName, connection);
      }
      throw error;
    } finally {
      this.decrementInFlight(serverName);
      this.touch(serverName);
    }
  }

  private async markNeedsAuth(serverName: string, connection: ServerConnection): Promise<void> {
    connection.status = 'needs-auth';
    connection.tools = [];
    connection.resources = [];
    connection.transportClosed = true;
    const errorInfo = this.scopeChallengeInfo(serverName, connection.definition);
    if (errorInfo) connection.errorInfo = errorInfo;
    this.refetchChains.delete(serverName);
    await this.tearDown(connection.client);
  }

  async close(name: string): Promise<void> {
    // A connect() for this server is still in flight (not yet stored): flag it so its resolution tears the
    // fresh connection down instead of registering a live child for a server we're closing (M2).
    if (this.connectPromises.has(name) && !this.connections.has(name)) {
      this.closeRequested.add(name);
    }
    const connection = this.connections.get(name);
    if (!connection) return;
    // Delete before async cleanup so a concurrent connect() does not get clobbered.
    connection.status = 'closed';
    this.connections.delete(name);
    this.refetchChains.delete(name);
    // A needs-auth connection's client/transport were already torn down — don't re-tear them.
    if (connection.transportClosed) return;
    await this.tearDown(connection.client);
  }

  /** Also closes connects still in flight, which are not in `connections` yet. */
  async closeAll(): Promise<void> {
    const names = new Set([...this.connections.keys(), ...this.connectPromises.keys()]);
    await Promise.all([...names].map((name) => this.close(name)));
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) connection.lastUsedAt = Date.now();
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) connection.inFlight = (connection.inFlight ?? 0) + 1;
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) connection.inFlight--;
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== 'connected') return false;
    if (connection.inFlight > 0) return false;
    return Date.now() - connection.lastUsedAt > timeoutMs;
  }
}

/** The server's `timeout` in milliseconds, else the default. */
export function timeoutMsOf(definition: Pick<McpServerDefinition, 'timeout'>): number {
  return definition.timeout !== undefined ? definition.timeout * 1000 : DEFAULT_MCP_TIMEOUT_MS;
}
