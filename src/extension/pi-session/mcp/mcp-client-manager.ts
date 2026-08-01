import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig, McpServerStatusInfo, McpToolInfo } from '../../../shared/types/mcp';
import {
  normalizeServerConfig,
  type McpServerDefinition,
  type McpToolDescriptor,
  type McpTool,
  type McpResource,
  type McpContent,
  type McpElicitationHandler,
} from './types';
import { loadMcpSdk, type McpSdkBundle } from './mcp-sdk-loader';
import { McpServerManager, type AuthProviderFactory, type McpServerManagerOptions } from './server-manager';
import { McpLifecycleManager } from './lifecycle';
import {
  loadServerCache,
  saveServerCache,
  clearServerCache,
  cachedToolsToMcp,
  cachedResourcesToMcp,
  stableStringify,
} from './metadata-cache';
import { formatMcpToolName, buildServerPrefixMap, resourceNameToToolName } from './naming';
import { parallelLimit } from './utils';
import { supportsOAuth, authenticateMcpServer, shutdownOAuth, revokeAndRemoveAuth } from './mcp-auth-flow';
import { createElicitationHandler, type ElicitationUI } from './elicitation-handler';
import { log } from '../../logger';

const FAILURE_BACKOFF_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const EAGER_CONNECT_CONCURRENCY = 4;

export interface McpClientManagerOptions {
  authProviderFactory?: AuthProviderFactory;
  /** Builds the OAuth provider factory once the SDK bundle is loaded (resolves the SDK-needs-bundle cycle). */
  authProviderFactoryBuilder?: (sdk: McpSdkBundle) => AuthProviderFactory;
  callTimeoutMs?: number;
  idleTimeoutMinutes?: number;
  healthCheckMs?: number;
  /** Test seam: override the connection-pool constructor (avoids spawning real processes). */
  serverManagerFactory?: (options: McpServerManagerOptions) => McpServerManager;
}

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
}

/**
 * Process/workspace-scoped MCP client (PiRuntime-owned). Loads the SDK, eagerly connects enabled
 * servers, maintains the pi-facing tool descriptors (live tools/list, cache fallback), and exposes
 * cancellable tool/resource calls. The shared Damocles extension registers tools from the
 * descriptors and re-registers them whenever `onToolsChanged` fires.
 */
export class McpClientManager {
  private sdk: McpSdkBundle | null = null;
  private serverManager: McpServerManager | null = null;
  private lifecycle: McpLifecycleManager | null = null;

  private servers = new Map<string, McpServerDefinition>();
  private serverPrefixes = new Map<string, string>();
  private descriptors = new Map<string, McpToolDescriptor>();

  private failureAt = new Map<string, number>();
  private lastError = new Map<string, string>();
  private needsAuth = new Set<string>();
  /** Last time an onclose-driven immediate reconnect fired per server. Throttles a crash loop — a server
   *  that handshakes successfully then dies can't register as a connect-failure (each handshake clears
   *  `failureAt`), so onclose would otherwise respawn it with no delay. A re-drop within the backoff
   *  window defers recovery to the implicitly-throttled 30s health check instead. */
  private lastDropReconnectAt = new Map<string, number>();
  /** Servers with an interactive OAuth flow in progress; transport connects skip them so they can't race
   *  the interactive flow's single-slot PKCE verifier/state (M4). */
  private authInFlight = new Set<string>();

  /** Per-server stack of each in-flight tool call's panel UI, so a server's elicitation renders in the
   *  panel whose call triggered it (H2). Top of stack wins for the rare concurrent same-server case. */
  private activeCallUis = new Map<string, ElicitationUI[]>();
  /** Signature of the last-applied enabled-server set; lets redundant per-panel reconciles no-op (M8). */
  private serversSignature = '';
  /** In-memory metadata for non-connected servers so descriptor rebuilds don't re-read+re-hash disk (M2).
   *  Invalidated on a server-set change and whenever fresh live metadata is cached for a server. */
  private metadataMemo = new Map<string, { tools: McpTool[]; resources: McpResource[] }>();

  private initialized = false;
  private disposed = false;
  private sdkUnavailable = false;
  private readyPromise: Promise<void> | null = null;
  /** Serializes startBackend + every reconcile so concurrent panel feeds / toggles can't race the
   *  shared servers/descriptors state or interleave close/connect (US-014.9; M7). */
  private opChain: Promise<void> = Promise.resolve();
  private toolsChangedListeners = new Set<() => void>();

  private authProviderFactory: AuthProviderFactory | undefined;
  private readonly authProviderFactoryBuilder: ((sdk: McpSdkBundle) => AuthProviderFactory) | undefined;
  private readonly callTimeoutMs: number;
  private readonly idleTimeoutMinutes: number;
  private readonly healthCheckMs: number;
  private readonly serverManagerFactory: (options: McpServerManagerOptions) => McpServerManager;

  constructor(options: McpClientManagerOptions = {}) {
    if (options.authProviderFactory) this.authProviderFactory = options.authProviderFactory;
    if (options.authProviderFactoryBuilder) this.authProviderFactoryBuilder = options.authProviderFactoryBuilder;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.idleTimeoutMinutes = options.idleTimeoutMinutes ?? 10;
    this.healthCheckMs = options.healthCheckMs ?? 30_000;
    this.serverManagerFactory = options.serverManagerFactory ?? ((o) => new McpServerManager(o));
  }

  /** Register a callback fired whenever the registered tool set changes (connect / list_changed). */
  onToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => this.toolsChangedListeners.delete(listener);
  }

  setAuthProviderFactory(factory: AuthProviderFactory): void {
    this.authProviderFactory = factory;
  }

  /**
   * The single elicitation handler installed on every MCP client (the connections are process-shared
   * across panels). It routes each `elicitation/create` to the UI of the in-flight tool call for that
   * server, so a server prompt renders in the panel that triggered it (H2). With no active call (a
   * server eliciting unsolicited) it declines.
   */
  private readonly routeElicitation: McpElicitationHandler = (params, serverName) => {
    const stack = this.activeCallUis.get(serverName) ?? [];
    const top = stack.at(-1);
    if (!top) {
      log('[McpClientManager] elicitation from %s outside an active tool call; declining', serverName);
      return Promise.resolve({ action: 'decline' as const });
    }
    // MCP's `elicitation/create` carries NO tool-call correlation — the only thing tying it to a caller
    // is the server name. With one in-flight call, top-of-stack IS the caller. With several (N agents
    // sharing a server), it is a GUESS, and a confidently wrong agent name is worse than none: the user
    // would grant input believing a different agent asked for it. Drop the attribution instead — the
    // dialog still names the server, which is the part we actually know.
    const ui = stack.length > 1 ? (top.unattributed?.() ?? top) : top;
    return createElicitationHandler(ui)(params, serverName);
  };

  /** Eager-connect enabled servers (background). Cached tool defs register immediately. */
  initialize(servers: Record<string, McpServerConfig>): void {
    if (this.initialized) {
      void this.reconcile(servers);
      return;
    }
    this.initialized = true;
    this.serversSignature = signatureOf(servers);
    this.setServers(servers);
    this.emitToolsChanged();
    this.readyPromise = this.enqueue(() => this.startBackend());
  }

  /** Resolves once the initial SDK load + eager connect have settled (no-op if not initialized). */
  async whenReady(): Promise<void> {
    await this.readyPromise;
  }

  /** Append an operation to the serialized chain; failures are logged, never break the chain. After
   *  dispose() no new work is admitted, so a late reconcile can't connect a server past teardown (M1). */
  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.opChain = this.opChain.then(task, task).catch((error) => {
      log('[McpClientManager] serialized MCP op failed: %O', error);
    });
    return this.opChain;
  }

  private async startBackend(): Promise<void> {
    const sdk = await loadMcpSdk();
    if (!sdk) {
      this.sdkUnavailable = true;
      log('[McpClientManager] MCP disabled: @modelcontextprotocol/sdk unavailable');
      return;
    }
    this.sdk = sdk;
    const authProviderFactory = this.authProviderFactoryBuilder
      ? this.authProviderFactoryBuilder(sdk)
      : this.authProviderFactory;
    const managerOptions = {
      sdk,
      onListChanged: (name: string) => this.onServerListChanged(name),
      onConnectionLost: (name: string) => this.onServerConnectionLost(name),
      ...(authProviderFactory ? { authProviderFactory } : {}),
    };
    this.serverManager = this.serverManagerFactory(managerOptions);
    this.serverManager.setElicitationHandler(this.routeElicitation);
    this.lifecycle = new McpLifecycleManager(this.serverManager);
    this.lifecycle.setReconnectFn((name, def) => this.connectServer(name, def, { force: false }));
    this.lifecycle.setIdleShutdownCallback(() => {
      this.rebuildDescriptors();
      this.emitToolsChanged();
    });
    this.lifecycle.setGlobalIdleTimeout(this.idleTimeoutMinutes);
    this.registerLifecycleServers();
    this.lifecycle.startHealthChecks(this.healthCheckMs);
    await this.connectEnabledEager();
    this.rebuildDescriptors();
    this.emitToolsChanged();
  }

  /** Reconcile to a new enabled-server set without restarting sessions (US-014.9). Serialized (M7). */
  async reconcile(servers: Record<string, McpServerConfig>): Promise<void> {
    if (!this.initialized) {
      this.initialize(servers);
      await this.readyPromise;
      return;
    }
    // M8: the same enabled set is fed once per panel on every config-change / trust-grant. Skip the
    // redundant reconcile when nothing changed so a single change drives a single reconcile.
    const signature = signatureOf(servers);
    if (signature === this.serversSignature) return;
    this.serversSignature = signature;
    await this.enqueue(() => this.doReconcile(servers));
  }

  private async doReconcile(servers: Record<string, McpServerConfig>): Promise<void> {
    const previous = new Set(this.servers.keys());
    this.setServers(servers);
    const next = new Set(this.servers.keys());

    if (this.serverManager) {
      for (const name of previous) {
        if (!next.has(name)) {
          await this.serverManager.close(name);
          this.failureAt.delete(name);
          this.lastError.delete(name);
          this.needsAuth.delete(name);
          this.lastDropReconnectAt.delete(name);
        }
      }
    }
    if (this.sdk) {
      this.registerLifecycleServers();
      await this.connectEnabledEager();
    }
    this.rebuildDescriptors();
    this.emitToolsChanged();
  }

  /**
   * Drive the webview's reconnect / Authenticate action (US-014.5/9). A server in the needs-auth state
   * that supports OAuth runs the interactive browser flow first; otherwise it is a plain force-reconnect.
   * Returns whether the server ended up connected.
   */
  async reconnectOrAuthenticate(name: string): Promise<boolean> {
    const def = this.servers.get(name);
    if (!def || !this.serverManager || !this.sdk) return false;

    const needsAuth = this.needsAuth.has(name) || this.serverManager.getConnection(name)?.status === 'needs-auth';
    if (needsAuth && supportsOAuth(def)) {
      // The interactive browser OAuth step runs OUTSIDE the serialization lock (it can block for
      // minutes on user action); only the credential-state mutation + close/connect below is serialized.
      // Mark the server auth-in-flight so a concurrent transport connect (health check / tool call) can't
      // start a second authorization_code flow and overwrite this flow's single-slot PKCE verifier (M4).
      this.authInFlight.add(name);
      let result: { ok: boolean; error?: string };
      try {
        result = await authenticateMcpServer(this.sdk, name, def);
      } finally {
        this.authInFlight.delete(name);
      }
      if (!result.ok) {
        await this.enqueue(() => {
          this.lastError.set(name, result.error ?? 'authentication failed');
          this.rebuildDescriptors();
          this.emitToolsChanged();
          return Promise.resolve();
        });
        return false;
      }
    }
    await this.reconnectLive(name);
    return this.serverManager.getConnection(name)?.status === 'connected';
  }

  /** Clear stored OAuth creds + the stale connection/cache, then run a fresh interactive login
   *  and reconnect. Returns whether the server ended up connected. */
  async reauthenticate(name: string): Promise<boolean> {
    const def = this.servers.get(name);
    if (!def || !supportsOAuth(def)) return false;
    // Tear down the live (token-holding) connection even if revoke/remove rejects — sign-out intent wins.
    try {
      await revokeAndRemoveAuth(this.sdk, name, def);
    } finally {
      await this.enqueue(() => this.doClearConnection(name));
    }
    return this.reconnectOrAuthenticate(name);
  }

  /** Clear stored OAuth creds and disconnect, leaving the server at needs-auth (Authenticate reappears). */
  async signOut(name: string): Promise<void> {
    const def = this.servers.get(name);
    if (!def || !supportsOAuth(def)) return;
    // Tear down the live (token-holding) connection even if revoke/remove rejects — sign-out intent wins.
    try {
      await revokeAndRemoveAuth(this.sdk, name, def);
    } finally {
      await this.enqueue(() => this.doClearConnection(name));
    }
  }

  /** Force a fresh connection (e.g. after authentication) (US-014.9). Serialized via the op chain so it
   *  can't interleave close/connect with a concurrent reconcile / panel feed (H1). */
  async reconnectLive(name: string): Promise<void> {
    await this.enqueue(() => this.doReconnectLive(name));
  }

  /** Op-chain body: drop the live (still-bearer-holding) connection, evict the now-stale tool
   *  cache, mark needs-auth, and clear transient error/backoff state. */
  private async doClearConnection(name: string): Promise<void> {
    await this.serverManager?.close(name);
    clearServerCache(name);
    this.metadataMemo.delete(name);
    this.failureAt.delete(name);
    this.lastError.delete(name);
    this.lastDropReconnectAt.delete(name);
    this.needsAuth.add(name);
    this.rebuildDescriptors();
    this.emitToolsChanged();
  }

  private async doReconnectLive(name: string): Promise<void> {
    const def = this.servers.get(name);
    if (!def || !this.serverManager) return;
    this.failureAt.delete(name);
    this.needsAuth.delete(name);
    this.lastError.delete(name);
    await this.serverManager.close(name);
    try {
      await this.connectServer(name, def, { force: true });
    } catch (error) {
      log('[McpClientManager] reconnectLive failed for %s: %O', name, error);
    }
  }

  private setServers(servers: Record<string, McpServerConfig>): void {
    this.servers = new Map(
      Object.entries(servers).map(([name, cfg]) => [name, normalizeServerConfig(cfg)]),
    );
    this.serverPrefixes = buildServerPrefixMap([...this.servers.keys()]);
    // A config change can alter each server's cache identity (configHash); drop memoized metadata.
    this.metadataMemo.clear();
    this.rebuildDescriptors();
  }

  private registerLifecycleServers(): void {
    if (!this.lifecycle) return;
    this.lifecycle.clearServers();
    for (const [name, def] of this.servers) {
      const settings = def.idleTimeout !== undefined ? { idleTimeout: def.idleTimeout } : undefined;
      this.lifecycle.registerServer(name, def, settings);
      // An enabled server is supervised (kept connected + auto-reconnected, never idle-shut-down) unless
      // it opted out: `lazy` connects on use, and an explicit `idleTimeout` opts into idle-shutdown. This
      // is why a default/eager server no longer silently dies after 10 min and gets stuck "Connecting".
      if (isSupervised(def)) this.lifecycle.markSupervised(name, def);
    }
  }

  private async connectEnabledEager(): Promise<void> {
    const targets = [...this.servers.entries()].filter(([, def]) => def.lifecycle !== 'lazy');
    await parallelLimit(targets, EAGER_CONNECT_CONCURRENCY, async ([name, def]) => {
      try {
        await this.connectServer(name, def, { force: false, emit: false });
      } catch {
        // Failure recorded in connectServer; eager init never throws.
      }
    });
  }

  private async connectServer(
    name: string,
    def: McpServerDefinition,
    opts: { force?: boolean; emit?: boolean } = {},
  ): Promise<void> {
    if (!this.serverManager) throw new Error('MCP SDK not loaded');
    // Don't spawn a connection during/after teardown — closeAll already ran, so it would orphan a child (M1).
    if (this.disposed) return;
    // An interactive OAuth flow owns this server's PKCE verifier/state slot; a transport connect now would
    // start a competing authorization_code flow and clobber it (→ invalid_grant). Defer until it finishes (M4).
    if (this.authInFlight.has(name)) return;
    if (!opts.force) {
      const failed = this.failureAt.get(name);
      if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS) return;
    }
    try {
      const connection = await this.serverManager.connect(name, def);
      if (connection.status === 'needs-auth') {
        this.needsAuth.add(name);
      } else {
        this.needsAuth.delete(name);
        this.failureAt.delete(name);
        this.lastError.delete(name);
        saveServerCache(name, def, connection.tools, connection.resources);
        this.metadataMemo.delete(name);
      }
    } catch (error) {
      this.failureAt.set(name, Date.now());
      this.lastError.set(name, error instanceof Error ? error.message : String(error));
      this.needsAuth.delete(name);
      throw error;
    } finally {
      this.rebuildDescriptors();
      if (opts.emit !== false) this.emitToolsChanged();
    }
  }

  private async ensureConnected(name: string): Promise<void> {
    const connection = this.serverManager?.getConnection(name);
    if (connection?.status === 'connected') return;
    const def = this.servers.get(name);
    if (!def) throw new Error(`Unknown MCP server "${name}"`);
    await this.connectServer(name, def, { force: true });
  }

  private onServerListChanged(name: string): void {
    const connection = this.serverManager?.getConnection(name);
    const def = this.servers.get(name);
    if (connection && def && connection.status === 'connected') {
      saveServerCache(name, def, connection.tools, connection.resources);
      this.metadataMemo.delete(name);
    }
    this.rebuildDescriptors();
    this.emitToolsChanged();
  }

  /**
   * A live connection dropped on its own (process crash / transport loss). Refresh the descriptors so
   * the UI reflects the loss, then reconnect a server meant to stay connected (default/eager + keep-alive).
   * A `lazy` server is left disconnected — it reconnects on next use. The reconnect runs through the
   * serialized op chain; `def` is re-read INSIDE the closure so a reconcile that removed the server in the
   * meantime wins (no orphan-child resurrection).
   *
   * Crash-loop throttle (H1): a server that handshakes successfully then dies seconds later can't register
   * as a connect-failure (each successful handshake clears `failureAt`), so an immediate force-reconnect
   * would respawn it with zero delay forever. Cap the immediate path to once per FAILURE_BACKOFF_MS per
   * server; a re-drop inside that window is left to the implicitly-throttled 30s health check.
   */
  private onServerConnectionLost(name: string): void {
    if (this.disposed) return;
    this.rebuildDescriptors();
    this.emitToolsChanged();
    const def = this.servers.get(name);
    if (!def || def.lifecycle === 'lazy') return;

    const lastImmediate = this.lastDropReconnectAt.get(name);
    if (lastImmediate !== undefined && Date.now() - lastImmediate < FAILURE_BACKOFF_MS) return;
    this.lastDropReconnectAt.set(name, Date.now());

    void this.enqueue(() => {
      // Re-validate against current state: a reconcile/dispose between the drop and this task running must
      // win, else we'd resurrect a live child for a server no longer enabled (orphan leak until dispose).
      if (this.disposed) return Promise.resolve();
      const current = this.servers.get(name);
      if (!current || current.lifecycle === 'lazy') return Promise.resolve();
      // A spontaneous drop isn't a connect failure, so don't let a stale backoff suppress this reconnect.
      this.failureAt.delete(name);
      return this.connectServer(name, current, { force: true });
    });
  }

  private rebuildDescriptors(): void {
    const next = new Map<string, McpToolDescriptor>();
    for (const [name, def] of this.servers) {
      const prefix = this.serverPrefixes.get(name) ?? name;
      const { tools, resources } = this.metadataFor(name, def);

      for (const tool of tools) {
        if (!tool.name) continue;
        const piName = formatMcpToolName(prefix, tool.name);
        next.set(piName, {
          piName,
          serverName: name,
          kind: 'tool',
          originalName: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          // readOnlyHint is server-advertised and a hostile server could lie to win silent auto-approval.
          // Only treat a tool as read-only (→ skips the approval gate) when it also disclaims being
          // destructive or open-world; anything ambiguous routes through canUseTool / plan-mode (H1).
          readOnly:
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint !== true &&
            tool.annotations.openWorldHint !== true,
        });
      }

      if (def.exposeResources !== false) {
        for (const resource of resources) {
          if (!resource.name || !resource.uri) continue;
          const base = `get_${resourceNameToToolName(resource.name)}`;
          const piName = formatMcpToolName(prefix, base);
          next.set(piName, {
            piName,
            serverName: name,
            kind: 'resource',
            originalName: base,
            resourceUri: resource.uri,
            description: resource.description ?? `Read resource: ${resource.uri}`,
            readOnly: true,
          });
        }
      }
    }
    this.descriptors = next;
  }

  private metadataFor(name: string, def: McpServerDefinition): { tools: McpTool[]; resources: McpResource[] } {
    const connection = this.serverManager?.getConnection(name);
    if (connection && connection.status === 'connected') {
      return { tools: connection.tools, resources: connection.resources };
    }
    const memo = this.metadataMemo.get(name);
    if (memo) return memo;
    const cached = loadServerCache(name, def);
    const result = cached
      ? { tools: cachedToolsToMcp(cached), resources: cachedResourcesToMcp(cached) }
      : { tools: [], resources: [] };
    this.metadataMemo.set(name, result);
    return result;
  }

  private emitToolsChanged(): void {
    for (const listener of this.toolsChangedListeners) {
      try {
        listener();
      } catch (error) {
        log('[McpClientManager] tools-changed listener threw: %O', error);
      }
    }
  }

  getAllToolDescriptors(): McpToolDescriptor[] {
    return [...this.descriptors.values()];
  }

  getToolDescriptor(piName: string): McpToolDescriptor | undefined {
    return this.descriptors.get(piName);
  }

  /** Active-set tool names for a set of enabled server keys (US-014.3). */
  toolNamesForServers(serverNames: Iterable<string>): string[] {
    const set = new Set(serverNames);
    const names: string[] = [];
    for (const d of this.descriptors.values()) {
      if (set.has(d.serverName)) names.push(d.piName);
    }
    return names;
  }

  allToolNames(): string[] {
    return [...this.descriptors.keys()];
  }

  /** Read-only classification for the permission gate (US-014.4); unknown = not read-only. */
  isMcpReadOnly(piName: string): boolean {
    return this.descriptors.get(piName)?.readOnly === true;
  }

  enabledServerNames(): string[] {
    return [...this.servers.keys()];
  }

  isSdkUnavailable(): boolean {
    return this.sdkUnavailable;
  }

  async callTool(
    piName: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number; elicitationUi?: ElicitationUI } = {},
  ): Promise<McpCallResult> {
    const descriptor = this.descriptors.get(piName);
    if (!descriptor) throw new Error(`Unknown MCP tool "${piName}"`);
    if (!this.serverManager) throw new Error('MCP client is not initialized');

    await this.ensureConnected(descriptor.serverName);
    // A reconcile during the await above may have removed this tool; don't run a stale tool the model
    // still holds in context against a server being torn down (M6).
    if (!this.descriptors.has(piName)) {
      throw new Error(`MCP tool "${piName}" is no longer available`);
    }
    const callOpts = {
      timeoutMs: opts.timeoutMs ?? this.callTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    // Bind the calling panel's UI for the duration of the call so a mid-call elicitation renders here (H2).
    const releaseUi = opts.elicitationUi ? this.pushCallUi(descriptor.serverName, opts.elicitationUi) : undefined;

    try {
      if (descriptor.kind === 'resource') {
        const result = await this.serverManager.readResource(
          descriptor.serverName,
          descriptor.resourceUri as string,
          callOpts,
        );
        return { content: resourceReadToContent(result), isError: false };
      }

      const result = await this.serverManager.callTool(
        descriptor.serverName,
        descriptor.originalName,
        args,
        callOpts,
      );
      return { content: (result.content ?? []) as McpContent[], isError: result.isError === true };
    } finally {
      releaseUi?.();
    }
  }

  /** Push a call's UI onto the per-server elicitation stack; returns a release that pops exactly it. */
  private pushCallUi(serverName: string, ui: ElicitationUI): () => void {
    const stack = this.activeCallUis.get(serverName) ?? [];
    stack.push(ui);
    this.activeCallUis.set(serverName, stack);
    return () => {
      const current = this.activeCallUis.get(serverName);
      if (!current) return;
      const index = current.lastIndexOf(ui);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.activeCallUis.delete(serverName);
    };
  }

  getServerStatuses(): McpServerStatusInfo[] {
    return [...this.servers.keys()].map((name) => this.statusFor(name));
  }

  getServerStatus(name: string): McpServerStatusInfo | undefined {
    return this.servers.has(name) ? this.statusFor(name) : undefined;
  }

  private statusFor(name: string): McpServerStatusInfo {
    const connection = this.serverManager?.getConnection(name);
    let status: McpServerStatusInfo['status'];
    if (connection?.status === 'connected') status = 'connected';
    else if (connection?.status === 'needs-auth' || this.needsAuth.has(name)) status = 'needs-auth';
    else if (this.lastError.has(name)) status = 'failed';
    else if (this.servers.get(name)?.lifecycle === 'lazy') status = 'idle';
    else status = 'pending';

    const info: McpServerStatusInfo = { name, status, enabled: true };
    const def = this.servers.get(name);
    // Advertise OAuth capability regardless of status; the webview gates the re-auth/sign-out buttons on status === 'connected'.
    if (def && supportsOAuth(def)) info.supportsOAuth = true;
    if (connection?.serverInfo) info.serverInfo = connection.serverInfo;
    const error = this.lastError.get(name);
    if (error && status !== 'connected') info.error = error;
    const tools = this.toolInfosFor(name);
    if (tools.length > 0) info.tools = tools;
    return info;
  }

  private toolInfosFor(name: string): McpToolInfo[] {
    const infos: McpToolInfo[] = [];
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.serverName !== name) continue;
      infos.push({
        name: descriptor.originalName,
        description: descriptor.description,
        annotations: { readOnly: descriptor.readOnly },
      });
    }
    return infos;
  }

  async dispose(): Promise<void> {
    // Fence the op chain first so no queued/late reconcile connects a server after teardown, then let any
    // in-flight serialized op drain before we close everything — otherwise it could orphan a child (M1).
    this.disposed = true;
    await this.opChain.catch(() => {});
    if (this.lifecycle) {
      await this.lifecycle.gracefulShutdown();
    } else if (this.serverManager) {
      await this.serverManager.closeAll();
    }
    this.descriptors.clear();
    this.toolsChangedListeners.clear();
    try {
      await shutdownOAuth();
    } catch (error) {
      log('[McpClientManager] OAuth shutdown error: %O', error);
    }
  }
}

/** A stable signature of an enabled-server set so identical reconcile feeds can be skipped (M8). Uses a
 *  key-order-independent stringify so cosmetic config reordering doesn't trigger a needless reconcile. */
function signatureOf(servers: Record<string, McpServerConfig>): string {
  return stableStringify(servers);
}

/** Whether a server should be kept connected (persistent) rather than idle-shut-down. `keep-alive` is
 *  always supervised (its contract); default/eager is supervised unless it opts into idle-shutdown via an
 *  explicit `idleTimeout`; `lazy` (connect-on-use) is never supervised. Exported for unit testing. */
export function isSupervised(def: McpServerDefinition): boolean {
  if (def.lifecycle === 'keep-alive') return true;
  return def.lifecycle !== 'lazy' && def.idleTimeout === undefined;
}

function resourceReadToContent(result: ReadResourceResult): McpContent[] {
  const out: McpContent[] = [];
  for (const entry of result.contents ?? []) {
    const c = entry as { uri: string; mimeType?: string; text?: string; blob?: string };
    if (typeof c.text === 'string') {
      out.push({ type: 'text', text: `[Resource: ${c.uri}]\n${c.text}` });
    } else if (typeof c.blob === 'string') {
      out.push({
        type: 'text',
        text: `[Resource: ${c.uri}] (binary ${c.mimeType ?? 'application/octet-stream'})`,
      });
    } else {
      out.push({ type: 'text', text: `[Resource: ${c.uri}]` });
    }
  }
  return out;
}
