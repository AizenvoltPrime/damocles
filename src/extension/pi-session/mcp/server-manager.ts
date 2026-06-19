/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Connection pool for MCP servers: transport selection (stdio / streamable-HTTP w/ SSE fallback),
 * connect dedup, tool/resource discovery, list_changed handling, and cancellable tool calls.
 * SDK value classes are obtained from the dynamically-imported bundle (the SDK is esbuild-external).
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkBundle } from './mcp-sdk-loader';
import type { McpTool, McpResource, McpServerDefinition, McpElicitationHandler } from './types';
import { resolveNpxBinary } from './npx-resolver';
import { interpolateEnvRecord, killProcessTree, resolveBearerToken, resolveConfigPath } from './utils';
import { log } from '../../logger';

export type ConnectionStatus = 'connected' | 'closed' | 'needs-auth';

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: McpServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  serverInfo?: { name: string; version: string };
  lastUsedAt: number;
  inFlight: number;
  status: ConnectionStatus;
  /** True when the client/transport were already torn down (a needs-auth result), so `close()` must not re-tear them. */
  transportClosed?: boolean;
}

/** Produces an OAuth provider for a remote server, or undefined for unauthenticated servers (US-014.5). */
export type AuthProviderFactory = (
  serverName: string,
  url: string,
  definition: McpServerDefinition,
) => OAuthClientProvider | undefined;

export interface McpServerManagerOptions {
  sdk: McpSdkBundle;
  authProviderFactory?: AuthProviderFactory;
  /** Fired after a server's tool/resource list changes (list_changed notification → refetch done). */
  onListChanged?: (serverName: string) => void;
}

export class McpServerManager {
  private readonly sdk: McpSdkBundle;
  private readonly authProviderFactory?: AuthProviderFactory;
  private readonly onListChanged?: (serverName: string) => void;
  private elicitationHandler: McpElicitationHandler | undefined;

  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  /** Servers whose close() landed while a connect() was still in flight: the connect must tear down its
   *  result on resolution instead of registering a live connection for a server we're closing (M2). */
  private closeRequested = new Set<string>();
  /** Per-server serialized refetch chain so racing list_changed notifications can't resolve out of order. */
  private refetchChains = new Map<string, Promise<void>>();

  constructor(options: McpServerManagerOptions) {
    this.sdk = options.sdk;
    if (options.authProviderFactory) this.authProviderFactory = options.authProviderFactory;
    if (options.onListChanged) this.onListChanged = options.onListChanged;
  }

  /** Enable elicitation (form) capability + register the request handler on every client (US-014.7). */
  setElicitationHandler(handler: McpElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  async connect(name: string, definition: McpServerDefinition): Promise<ServerConnection> {
    const inflight = this.connectPromises.get(name);
    if (inflight) return inflight;

    const existing = this.connections.get(name);
    if (existing?.status === 'connected') {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const promise = this.createConnection(name, definition);
    this.connectPromises.set(name, promise);
    try {
      const connection = await promise;
      if (this.closeRequested.has(name)) {
        // close() ran while this connect was in flight. Tear the fresh connection down instead of
        // registering it, so a just-removed server doesn't leak a live child (M2).
        if (!connection.transportClosed) {
          await this.tearDownTransport(connection.client, connection.transport);
        }
        connection.status = 'closed';
        throw new Error(`MCP server "${name}" was closed during connect`);
      }
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
      this.closeRequested.delete(name);
    }
  }

  private buildClientCapabilities(): Record<string, unknown> {
    // Advertise elicitation (form only) when wired; never advertise sampling (US-014.1).
    if (!this.elicitationHandler) return {};
    return { elicitation: { form: {} } };
  }

  private createClient(serverName: string): Client {
    const capabilities = this.buildClientCapabilities();
    const client = new this.sdk.client.Client(
      { name: `damocles-mcp-${serverName}`, version: '1.0.0' },
      Object.keys(capabilities).length > 0 ? { capabilities } : undefined,
    );
    if (this.elicitationHandler) {
      const handler = this.elicitationHandler;
      client.setRequestHandler(this.sdk.types.ElicitRequestSchema, async (request) =>
        handler(request.params, serverName),
      );
    }
    return client;
  }

  private async createConnection(name: string, definition: McpServerDefinition): Promise<ServerConnection> {
    if (definition.command) {
      return this.establish(name, definition, await this.createStdioTransport(name, definition));
    }
    if (definition.url) {
      return this.createHttpConnection(name, definition);
    }
    throw new Error(`MCP server "${name}" has no command or url`);
  }

  /**
   * Connect a fresh client over `transport`, discover tools/resources, and build the live connection.
   * `UnauthorizedError` resolves to a `needs-auth` connection (the transport is torn down); any other
   * failure tears down and rethrows so the caller (e.g. HTTP→SSE fallback) can react.
   */
  private async establish(
    name: string,
    definition: McpServerDefinition,
    transport: Transport,
  ): Promise<ServerConnection> {
    const client = this.createClient(name);
    try {
      await client.connect(transport);
      this.attachListChangedHandlers(name, client);

      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client),
        this.fetchAllResources(client),
      ]);

      const version = client.getServerVersion();
      const connection: ServerConnection = {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: 'connected',
      };
      if (version) connection.serverInfo = { name: version.name, version: version.version };
      return connection;
    } catch (error) {
      await this.tearDownTransport(client, transport);
      if (error instanceof this.sdk.auth.UnauthorizedError) {
        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: 'needs-auth',
          transportClosed: true,
        };
      }
      throw error;
    }
  }

  /**
   * Close a client + transport, killing the whole stdio child tree first on Windows. `Client.close()`
   * closes its transport, whose `close()` only SIGTERM/kill()s the direct child — any workers it spawned
   * leak. Tree-killing the live process up front (before the graceful closes) terminates the descendants
   * the SDK would orphan. HTTP/SSE transports own no child, so this is a plain close for them.
   */
  private async tearDownTransport(client: Client, transport: Transport): Promise<void> {
    await this.killStdioTree(transport);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }

  /** Tree-kill a stdio transport's child process on Windows; no-op for non-stdio transports / POSIX. */
  private async killStdioTree(transport: Transport): Promise<void> {
    if (process.platform !== 'win32') return;
    if (!(transport instanceof this.sdk.stdio.StdioClientTransport)) return;
    const pid = transport.pid;
    if (typeof pid === 'number') await killProcessTree(pid);
  }

  private async createStdioTransport(name: string, definition: McpServerDefinition): Promise<Transport> {
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

    const cwd = resolveConfigPath(definition.cwd);
    const stdioOptions: StdioServerParameters = {
      command,
      args,
      env: this.resolveStdioEnv(definition.env),
      stderr: definition.debug ? 'inherit' : 'ignore',
    };
    if (cwd !== undefined) stdioOptions.cwd = cwd;
    return new this.sdk.stdio.StdioClientTransport(stdioOptions);
  }

  private resolveStdioEnv(env?: Record<string, string>): Record<string, string> {
    const base = this.sdk.stdio.getDefaultEnvironment();
    const overrides = interpolateEnvRecord(env);
    return overrides ? { ...base, ...overrides } : base;
  }

  /**
   * Connect a remote server with the real client directly: try streamable HTTP first, falling back to
   * SSE only on a non-auth failure. The earlier throwaway "probe" client doubled every handshake (and
   * defeated its own purpose by reconnecting regardless); a genuine auth failure surfaces as needs-auth
   * via `establish` and is never retried over SSE (US-014.5).
   */
  private async createHttpConnection(serverName: string, definition: McpServerDefinition): Promise<ServerConnection> {
    const url = new URL(definition.url as string);
    const transportOptions = this.buildHttpTransportOptions(serverName, definition);

    try {
      const streamable = new this.sdk.http.StreamableHTTPClientTransport(url, transportOptions) as Transport;
      return await this.establish(serverName, definition, streamable);
    } catch {
      // `establish` resolves auth failures to needs-auth (never throws them), so a throw here is a
      // genuine streamable-transport failure: retry once over SSE.
      const sse = new this.sdk.sse.SSEClientTransport(url, transportOptions) as Transport;
      return this.establish(serverName, definition, sse);
    }
  }

  private buildHttpTransportOptions(
    serverName: string,
    definition: McpServerDefinition,
  ): { requestInit?: { headers: Record<string, string> }; authProvider?: OAuthClientProvider } {
    const headers = interpolateEnvRecord(definition.headers) ?? {};
    if (definition.auth === 'bearer') {
      const token = resolveBearerToken(definition);
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    const authProvider = this.authProviderFactory?.(serverName, definition.url as string, definition);

    const transportOptions: { requestInit?: { headers: Record<string, string> }; authProvider?: OAuthClientProvider } = {};
    if (requestInit) transportOptions.requestInit = requestInit;
    if (authProvider) transportOptions.authProvider = authProvider;
    return transportOptions;
  }

  private async fetchAllTools(client: Client): Promise<McpTool[]> {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      all.push(...((result.tools ?? []) as McpTool[]));
      cursor = result.nextCursor;
    } while (cursor);
    return all;
  }

  private async fetchAllResources(client: Client): Promise<McpResource[]> {
    try {
      const all: McpResource[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        all.push(...((result.resources ?? []) as McpResource[]));
        cursor = result.nextCursor;
      } while (cursor);
      return all;
    } catch {
      return [];
    }
  }

  private attachListChangedHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(this.sdk.types.ToolListChangedNotificationSchema, () => {
      this.queueRefetch(serverName, () => this.refetchTools(serverName));
    });
    client.setNotificationHandler(this.sdk.types.ResourceListChangedNotificationSchema, () => {
      this.queueRefetch(serverName, () => this.refetchResources(serverName));
    });
  }

  /** Append a refetch to the server's serialized chain so paginated fetches can't interleave (L7). */
  private queueRefetch(serverName: string, task: () => Promise<void>): void {
    const prev = this.refetchChains.get(serverName) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => {});
    this.refetchChains.set(serverName, next);
  }

  private async refetchTools(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') return;
    try {
      connection.tools = await this.fetchAllTools(connection.client);
      this.onListChanged?.(serverName);
    } catch (error) {
      log('[McpServerManager] refetch tools failed for %s: %O', serverName, error);
    }
  }

  private async refetchResources(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') return;
    try {
      connection.resources = await this.fetchAllResources(connection.client);
      this.onListChanged?.(serverName);
    } catch (error) {
      log('[McpServerManager] refetch resources failed for %s: %O', serverName, error);
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    const options = this.buildRequestOptions(opts);
    try {
      this.touch(serverName);
      this.incrementInFlight(serverName);
      return (await connection.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        options,
      )) as CallToolResult;
    } finally {
      this.decrementInFlight(serverName);
      this.touch(serverName);
    }
  }

  async readResource(
    serverName: string,
    uri: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ReadResourceResult> {
    const connection = this.connections.get(serverName);
    if (!connection || connection.status !== 'connected') {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    const options = this.buildRequestOptions(opts);
    try {
      this.touch(serverName);
      this.incrementInFlight(serverName);
      return await connection.client.readResource({ uri }, options);
    } finally {
      this.decrementInFlight(serverName);
      this.touch(serverName);
    }
  }

  private buildRequestOptions(opts: { signal?: AbortSignal; timeoutMs?: number }): {
    signal?: AbortSignal;
    timeout?: number;
  } {
    const options: { signal?: AbortSignal; timeout?: number } = {};
    if (opts.signal) options.signal = opts.signal;
    if (opts.timeoutMs !== undefined) options.timeout = opts.timeoutMs;
    return options;
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
    // A needs-auth connection's client/transport were already torn down in establish — don't re-tear them.
    if (connection.transportClosed) return;
    await this.tearDownTransport(connection.client, connection.transport);
  }

  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((name) => this.close(name)));
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
