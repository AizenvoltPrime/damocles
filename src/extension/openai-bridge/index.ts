import * as vscode from 'vscode';
import { OpenAIBridgeProxy, type BridgeProxyDeps } from './proxy-server';
import type { BridgeEndpoint, BridgeRouteEntry, OpenAIBridgeAuthMode } from './types';

export type { OpenAIBridgeAuthMode, BridgeEndpoint, BridgeHealth, BridgeRouteEntry } from './types';
export { OPENAI_BRIDGE_SECRET_KEYS } from './types';
export {
  OpenAIAuthRequiredError,
  provisionOpenAIBridge,
  buildOpenAIBridgeEnv,
  resolveSdkModel,
  SMALL_FAST_OPENAI_MODEL,
} from './provision';
export type { OpenAIBridgeProvisioning, OpenAIBridgeProvisionDeps } from './provision';

/**
 * Deps the bridge facade needs from sibling stories. The proxy itself is VS Code-agnostic; the
 * facade is the integration site where `ExtensionContext`-bound callbacks (resolveAuth,
 * getAuthStatus) are wired up by the caller (`ChatPanelProvider`) in US-006.
 */
export type OpenAIBridgeDeps = Omit<BridgeProxyDeps, 'recordModelForPanel' | 'output' | 'promptCacheKeyForPanel'>;

/**
 * Owner-side facade for the OpenAI bridge. One instance per `ChatPanelProvider`. Lifecycle:
 *
 *   1. `ensureRunning(panelId, authMode)` starts the loopback proxy on demand and mints/rotates
 *      a per-panel bearer. Returns `{ url, bearer }` — the caller pipes these into the SDK via
 *      `query-manager.ts` env overrides (US-006 wires that).
 *   2. `dispose()` drains in-flight requests for up to 5s, then closes all sockets. Safe to call
 *      multiple times.
 *
 * Workspace-trust gating happens inside `proxy.start()` so the trust state is re-checked every
 * time the bridge transitions from stopped→running.
 */
export class OpenAIBridge {
  private proxy: OpenAIBridgeProxy | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly output: vscode.OutputChannel;
  private readonly modelByPanel = new Map<string, string>();
  private readonly sessionIdByPanel = new Map<string, string>();
  private readonly rotationListeners = new Set<() => void>();
  private disposed = false;
  private readonly deps: OpenAIBridgeDeps;

  constructor(deps: OpenAIBridgeDeps) {
    this.deps = deps;
    this.output = vscode.window.createOutputChannel('Damocles: OpenAI Bridge');
  }

  /**
   * Subscribe to bearer-rotation events. Fires once per `rotateBearersForAllPanels()` call;
   * subscribers (e.g. team AgentRunner) get a chance to abort + re-provision before the
   * SDK subprocess hits an upstream 401 with the stale bearer. Returns an unsubscribe.
   */
  onBearersRotated(listener: () => void): vscode.Disposable {
    this.rotationListeners.add(listener);
    return {
      dispose: () => {
        this.rotationListeners.delete(listener);
      },
    };
  }

  /**
   * Ensure the proxy is running and return per-panel routing credentials. If the panel already
   * has a route with the requested auth mode, returns the existing bearer; otherwise rotates.
   */
  async ensureRunning(panelId: string, authMode: OpenAIBridgeAuthMode): Promise<BridgeEndpoint> {
    if (this.disposed) {
      throw new Error('OpenAI bridge has been disposed');
    }
    if (!this.proxy) {
      this.proxy = new OpenAIBridgeProxy({
        translateAnthropicToCodex: this.deps.translateAnthropicToCodex,
        CodexToAnthropicStream: this.deps.CodexToAnthropicStream,
        resolveAuth: this.deps.resolveAuth,
        getAuthStatus: this.deps.getAuthStatus,
        recordModelForPanel: (id, model) => this.modelByPanel.set(id, model),
        output: this.output,
        promptCacheKeyForPanel: (id) => this.buildPromptCacheKeyForPanel(id),
        effortForPanelAndModel: this.deps.effortForPanelAndModel,
      });
    }
    if (!this.startPromise) {
      const proxy = this.proxy;
      this.startPromise = proxy.start().catch(err => {
        this.startPromise = null;
        if (this.proxy === proxy) this.proxy = null;
        throw err;
      });
    }
    await this.startPromise;

    const currentModel = this.modelByPanel.get(panelId) ?? '';
    const entry = this.proxy.registerRoute(panelId, authMode, currentModel);
    return { url: this.proxy.url, bearer: entry.bearer };
  }

  /**
   * Record the panel↔session mapping so the proxy can emit a stable `prompt_cache_key`
   * to the upstream Codex endpoint. Called by `ChatPanelProvider` whenever a session
   * id is assigned to a panel.
   */
  setSessionIdForPanel(panelId: string, sessionId: string | null): void {
    if (sessionId === null) {
      this.sessionIdByPanel.delete(panelId);
      return;
    }
    this.sessionIdByPanel.set(panelId, sessionId);
  }

  /**
   * Evict every panel's bearer. Used when "Prefer API key" flips: stale Team/main-chat
   * subprocesses cached the previous bearer and must be forced into a 401-retry cycle that
   * rebuilds env via `ensureRunning()` and re-mints a fresh bearer with the new authMode.
   * Idempotent.
   */
  rotateBearersForAllPanels(): void {
    this.proxy?.rotateAllBearers();
    for (const listener of this.rotationListeners) {
      try {
        listener();
      } catch {
        // listener errors do not block other subscribers
      }
    }
  }

  private buildPromptCacheKeyForPanel(panelId: string): string | undefined {
    const sessionId = this.sessionIdByPanel.get(panelId);
    if (!sessionId) return undefined;
    return `damocles-${sessionId}`.slice(0, 64);
  }

  /**
   * Look up the routing entry for a bearer. Used by the proxy internals; exposed on the facade
   * for tests and for the optional `OpenAIAuthPanel.vue` live-status view.
   */
  getRouteEntry(bearer: string): BridgeRouteEntry | null {
    return this.proxy?.getRouteEntry(bearer) ?? null;
  }

  /** Drop all routes for a panel when its session ends. */
  releasePanel(panelId: string): void {
    this.modelByPanel.delete(panelId);
    this.sessionIdByPanel.delete(panelId);
    this.proxy?.removeRoutesForPanel(panelId);
  }

  /** Idempotent. Safe from `deactivate()` or panel-disposal hooks. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const proxy = this.proxy;
    this.proxy = null;
    this.startPromise = null;
    this.modelByPanel.clear();
    this.sessionIdByPanel.clear();
    this.rotationListeners.clear();
    if (proxy) await proxy.dispose();
    if (!this.outputDisposed) {
      this.outputDisposed = true;
      this.output.dispose();
    }
  }

  private outputDisposed = false;
}
