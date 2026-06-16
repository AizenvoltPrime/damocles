import type { AgentSession, AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import type { Model, Api, ImageContent } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ChatSession } from '../claude-session/chat-session';
import type { SessionOptions, ContentInput, RewindOption } from '../claude-session/types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { ModelInfo, AccountInfo, PermissionMode } from '../../shared/types/settings';
import type { SlashCommandInfo } from '../../shared/types/commands';
import type { McpServerConfig, McpServerStatusInfo } from '../../shared/types/mcp';
import type { PluginConfig } from '../../shared/types/plugins';
import type { LoopJob } from '../../shared/types/loop-jobs';
import type { RemoteControlStatus } from '../../shared/types/remote-control';
import type { MemoryInjectionDisplay } from '../../shared/types/context-injection';
import type { RecallConfig, RecallTrajectory } from '../recall/types';
import type { RecallService } from '../recall';
import type { TeamService } from '../team';
import type { BrowserService } from '../browser';
import type { UserContentBlock } from '../../shared/types/content';
import { DEFAULT_CONTEXT_WINDOW } from '../../shared/types/constants';
import { log } from '../logger';
import { PiRuntime } from './pi-runtime';
import { getPiCodingAgent } from './pi-loader';
import { PI_AGENT_DIR } from './agent-dir';
import { PiStreamAdapter } from './pi-stream-adapter';
import { READ_ONLY_PI_TOOLS, piSupportedModels, resolvePiModel, effortToThinkingLevel } from './pi-models';

const DISABLED_REMOTE_CONTROL: RemoteControlStatus = {
  enabled: false,
  connectionState: 'disconnected',
  sessionUrl: null,
  connectUrl: null,
  environmentId: null,
  error: null,
};

function extractText(content: ContentInput): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Convert webview Anthropic-shaped image blocks to pi `ImageContent`. */
function extractImages(content: ContentInput): ImageContent[] {
  if (typeof content === 'string') return [];
  return content
    .filter((b): b is Extract<UserContentBlock, { type: 'image' }> => b.type === 'image')
    .map((b) => ({ type: 'image', data: b.source.data, mimeType: b.source.media_type }));
}

/**
 * `ChatSession` implementation backed by the pi harness (US-P1-4). Owns one `AgentSessionRuntime`
 * whose factory reuses the process-singleton `PiRuntime.services` (B1) and a `PiStreamAdapter` that
 * reproduces the existing webview message contract. Deferred subsystems (write/edit/bash, the
 * permission gate, recall, team, checkpoints, btw, remote control) degrade gracefully — no method
 * reachable from a live handler throws (FR-10).
 */
export class PiSession implements ChatSession {
  private readonly options: SessionOptions;
  private readonly cwd: string;
  private readonly adapter: PiStreamAdapter;

  private runtime: AgentSessionRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;

  private desiredModel: Model<Api> | undefined;
  private modelValue: string;
  private supportedModelsCache: ModelInfo[] = [];
  private permissionMode: PermissionMode;
  private processingFlag = false;
  private promptIndexCounter = -1;
  private _planPath: string | null = null;
  private thinkingDisabledNextQuery = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.modelValue = options.model ?? '';
    this.permissionMode = 'default';
    this.adapter = new PiStreamAdapter({
      onMessage: options.onMessage,
      cwd: options.cwd,
      sessionId: () => this.runtime?.session.sessionId ?? '',
      modelValue: () => this.modelValue,
      contextWindow: () => this.contextWindowForCurrentModel(),
      supportedModels: () => this.supportedModelsCache,
      accountInfo: () => this.buildAccountInfo(),
      permissionMode: () => this.permissionMode,
      apiKeySource: () => this.apiKeySource(),
      ...(options.onAssistantTextFinal ? { onAssistantTextFinal: options.onAssistantTextFinal } : {}),
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.start().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    await piRuntime.init();
    const pi = getPiCodingAgent();
    const services = piRuntime.services;
    if (!pi || !services) throw new Error('PiSession.start: pi runtime not initialized');

    this.supportedModelsCache = piSupportedModels();
    this.resolveInitialModel(piRuntime);

    const factory: CreateAgentSessionRuntimeFactory = async (opts) => {
      const shared = PiRuntime.get(this.cwd, PI_AGENT_DIR).services;
      if (!shared) throw new Error('PiSession factory: pi services unavailable (B1)');
      const result = await pi.createAgentSessionFromServices({
        services: shared,
        sessionManager: opts.sessionManager,
        ...(this.desiredModel ? { model: this.desiredModel } : {}),
        tools: READ_ONLY_PI_TOOLS,
        thinkingLevel: this.resolveThinkingLevel(),
      });
      return { ...result, services: shared, diagnostics: shared.diagnostics ?? [] };
    };

    const sessionManager = pi.SessionManager.create(this.cwd);
    this.runtime = await pi.createAgentSessionRuntime(factory, { cwd: this.cwd, agentDir: PI_AGENT_DIR, sessionManager });

    this.bindSession(this.runtime.session);

    this.runtime.setBeforeSessionInvalidate(() => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    });
    this.runtime.setRebindSession(async (session) => {
      this.bindSession(session);
      // A replacement session (reset/clear → newSession) carries a fresh sessionId; the consumer
      // re-arms the watcher and re-registers the session off this callback, so it must fire here too.
      this.options.onSessionIdChange?.(session.sessionId);
    });

    const sid = this.runtime.session.sessionId;
    this.options.onSessionIdChange?.(sid);
  }

  /** Subscribe the adapter and re-apply the B3 compaction-off invariant for a (re)bound session. */
  private bindSession(session: AgentSession): void {
    this.unsubscribe = this.adapter.subscribe(session);
    session.setAutoCompactionEnabled(false);
  }

  /**
   * Pick the starting model: the saved value if its canonical provider is authed, otherwise the
   * first curated model the user is actually signed in for (so a codex-only user defaults to a GPT
   * model rather than an unusable Claude/gateway one). Leaves the model unset if nothing is authed.
   */
  private resolveInitialModel(piRuntime: PiRuntime): void {
    const services = piRuntime.services;
    if (!services) return;
    const registry = services.modelRegistry;
    const openai = piRuntime.getOpenAIAuthStatus();

    const preferApiKey = this.preferOpenAIApiKey();
    const isCurated = (value: string): boolean => this.supportedModelsCache.some((m) => m.value === value);
    const trySet = (value: string): boolean => {
      const res = resolvePiModel(value, registry, openai, preferApiKey);
      if (res.model && res.authed) {
        this.desiredModel = res.model;
        this.modelValue = value;
        return true;
      }
      return false;
    };

    // Honor the saved model only if it's a curated value AND authed; else fall back to the first
    // curated model the user is signed in for (keeps the active model in sync with the dropdown).
    if (this.modelValue && isCurated(this.modelValue) && trySet(this.modelValue)) return;
    for (const m of this.supportedModelsCache) {
      if (trySet(m.value)) return;
    }
  }

  // ---- messaging ----------------------------------------------------------

  async sendMessage(
    prompt: ContentInput,
    _agentId?: string,
    correlationId?: string,
    userBroadcast?: { content: string; contentBlocks?: UserContentBlock[] },
    options?: { isInternal?: boolean },
  ): Promise<void> {
    if (this.processingFlag) {
      this.adapter.emitAlreadyInProgress();
      return;
    }
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: 'error', message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const session = this.runtime?.session;
    if (!session) {
      this.emit({ type: 'error', message: 'Failed to initialize pi session' });
      return;
    }

    const isInternal = options?.isInternal === true;
    if (!isInternal) this.promptIndexCounter += 1;

    if (userBroadcast && correlationId) {
      this.emit({
        type: 'userMessage',
        content: userBroadcast.content,
        ...(userBroadcast.contentBlocks ? { contentBlocks: userBroadcast.contentBlocks } : {}),
        correlationId,
        promptIndex: Math.max(0, this.promptIndexCounter),
        nodeId: null,
        ...(isInternal ? { isInjected: true } : {}),
      });
    }

    this.processingFlag = true;
    session.setThinkingLevel(this.resolveThinkingLevel());
    this.adapter.beginTurn(correlationId);

    const text = extractText(prompt);
    const images = extractImages(prompt);
    try {
      await session.prompt(text, images.length > 0 ? { images } : undefined);
    } catch (err) {
      log('[PiSession] prompt failed: %O', err);
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      this.emit({ type: 'processing', isProcessing: false });
    } finally {
      this.processingFlag = false;
    }
  }

  queueInput(content: ContentInput, _messageId?: string): 'queued' | 'flushed' | false {
    const session = this.runtime?.session;
    if (!session || !this.processingFlag) return false;
    const images = extractImages(content);
    // Route through prompt() (not raw steer()) so slash-command/skill handling and images are
    // preserved — steer() throws on `/`-prefixed input and would drop it silently.
    void session
      .prompt(extractText(content), { streamingBehavior: 'steer', ...(images.length > 0 ? { images } : {}) })
      .catch((err) => log('[PiSession] steered prompt failed: %O', err));
    return 'flushed';
  }

  async interrupt(): Promise<void> {
    this.processingFlag = false;
    this.adapter.markAborted();
    this.emit({ type: 'sessionCancelled' });
    this.emit({ type: 'processing', isProcessing: false });
    try {
      await this.runtime?.session.abort();
    } catch (err) {
      log('[PiSession] interrupt abort failed: %O', err);
    }
  }

  cancel(): void {
    this.processingFlag = false;
    this.adapter.markAborted();
    this.emit({ type: 'sessionCancelled' });
    this.emit({ type: 'processing', isProcessing: false });
    void this.runtime?.session.abort().catch((err) => log('[PiSession] cancel abort failed: %O', err));
  }

  async cancelAutoCompact(): Promise<void> {
    // Compaction is force-disabled on the pi path (B3); nothing to cancel.
  }

  reset(): void {
    this.processingFlag = false;
    void this.runtime?.newSession().catch((err) => log('[PiSession] reset newSession failed: %O', err));
  }

  clear(): void {
    this.reset();
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      // The runtime owns the AgentSession it created via the factory and disposes it here; the
      // session was never registered with PiRuntime (createSession), so there is nothing to forget.
      await this.runtime?.dispose();
    } catch (err) {
      log('[PiSession] dispose failed: %O', err);
    }
    this.runtime = null;
  }

  async stopTask(_taskId: string): Promise<void> {
    // No background tasks on the read-only pi slice.
  }

  // ---- model --------------------------------------------------------------

  setModel(model?: string): void {
    if (!model) return;
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    const services = piRuntime.services;
    if (!services || !this.runtime) return;
    const resolution = resolvePiModel(model, services.modelRegistry, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
    if (resolution.authRequired) {
      this.emit({ type: 'openaiAuthRequired', modelValue: model });
      return;
    }
    if (!resolution.model) {
      this.emit({ type: 'notification', message: `Model ${model} is unavailable on the pi harness`, notificationType: 'error' });
      return;
    }
    if (resolution.authed === false) {
      this.emit({ type: 'notification', message: `Sign in to Anthropic to use ${model}`, notificationType: 'warning' });
      return;
    }
    // Only commit the active model after the switch is known to succeed — every early return above
    // leaves `modelValue` (and everything derived from it) pointing at the still-current model.
    this.modelValue = model;
    this.desiredModel = resolution.model;
    void this.runtime.session.setModel(resolution.model).catch((err) => log('[PiSession] setModel failed: %O', err));
  }

  setBetas(_betas: string[]): void {
    // Anthropic betas are SDK-only; no-op on the pi path.
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    await this.ensureStarted().catch(() => undefined);
    return this.supportedModelsCache;
  }

  async getSupportedCommands(): Promise<SlashCommandInfo[]> {
    return [];
  }

  getModelInfo(model?: string): ModelInfo | undefined {
    const value = model ?? this.modelValue;
    return this.supportedModelsCache.find((m) => m.value === value);
  }

  get currentModel(): string | null {
    return this.modelValue || null;
  }

  // ---- session identity / state ------------------------------------------

  get currentSessionId(): string | null {
    return this.runtime?.session.sessionId ?? null;
  }

  get persistenceSessionId(): string | null {
    return this.currentSessionId;
  }

  get memorySessionId(): string {
    return this.currentSessionId ?? this.options.panelId ?? '';
  }

  get conversationHead(): string | null {
    return null;
  }

  get processing(): boolean {
    return this.processingFlag;
  }

  get currentPromptIndex(): number {
    return Math.max(0, this.promptIndexCounter);
  }

  async initializeEarly(): Promise<void> {
    await this.ensureStarted().catch((err) => log('[PiSession.initializeEarly] start failed: %O', err));
  }

  setResumeSession(_sessionId: string | null): void {
    // pi sessions start fresh (D1: no SDK-session loading); resume UI lands in a later phase.
  }

  async setRecallSession(_sessionId: string): Promise<void> {
    // Recall is not driven from the pi path in this phase.
  }

  // ---- thinking (deferred) ------------------------------------------------

  disableThinkingForNextQuery(): void {
    this.thinkingDisabledNextQuery = true;
  }

  restoreThinkingConfig(): void {
    this.thinkingDisabledNextQuery = false;
  }

  // ---- permission / fast mode --------------------------------------------

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
  }

  get fastMode(): boolean {
    return false;
  }

  setFastMode(_enabled: boolean): void {
    // Fast mode is an Anthropic-tier feature; no-op on the pi path.
  }

  // ---- mcp / plugins / provider / browser (deferred) ----------------------

  async getMcpServerStatus(): Promise<McpServerStatusInfo[]> {
    return [];
  }

  setMcpServers(_servers: Record<string, McpServerConfig>): void {}
  restartForMcpChanges(): void {}
  async reconnectMcpServerLive(_serverName: string): Promise<boolean> {
    return false;
  }
  async reloadPlugins(): Promise<{ errorCount: number } | null> {
    return null;
  }
  setPlugins(_plugins: PluginConfig[]): void {}
  restartForPluginChanges(): void {}
  setProviderEnv(_env: Record<string, string> | undefined): void {}
  restartForProviderChange(): void {}
  setBrowserService(_service?: BrowserService): void {}
  setChromeEnabled(_enabled: boolean): void {}
  restartForChromeChange(): void {}

  // ---- remote control (dropped subsystem) ---------------------------------

  async enableRemoteControl(): Promise<void> {}
  async disableRemoteControl(): Promise<void> {}
  get remoteControlStatus(): RemoteControlStatus {
    return DISABLED_REMOTE_CONTROL;
  }

  // ---- loop jobs (deferred) -----------------------------------------------

  getLoopJobs(): LoopJob[] {
    return [];
  }
  async cancelLoopJob(_jobId: string, _correlationId?: string, _userBroadcast?: { content: string }): Promise<void> {}

  // ---- checkpoints / cost / rewind ----------------------------------------

  getCheckpointForMessage(_assistantMessageId: string): string | undefined {
    return undefined;
  }
  seedCheckpoints(_userMessageIds: Iterable<string>): void {}
  getAccumulatedCost(): number {
    return this.adapter.accumulatedCost;
  }

  async rewindFiles(_userMessageId: string, _option?: RewindOption, _promptContent?: string): Promise<void> {
    this.emit({ type: 'rewindError', message: 'Rewind is not available on the pi harness yet' });
  }

  // ---- context usage ------------------------------------------------------

  async requestContextUsage(): Promise<void> {
    this.emit({ type: 'contextUsage', data: null });
  }

  // ---- btw / explore / recall / team (deferred) ---------------------------

  async sendBtw(btwId: string, _question: string): Promise<void> {
    this.emit({ type: 'btwError', btwId, message: 'btw is not available on the pi harness yet' });
  }
  cancelBtw(_btwId: string): void {}
  async emitExploreHistory(_sessionId: string): Promise<void> {}

  get recallService(): RecallService | undefined {
    return undefined;
  }
  getRecallService(): RecallService | undefined {
    return undefined;
  }
  get isRecallMode(): boolean {
    return false;
  }
  getRecallTrajectory(_promptIndex: number): RecallTrajectory | undefined {
    return undefined;
  }
  async getMemoryInjection(_promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    return undefined;
  }
  refreshRecallConfig(_config: RecallConfig): void {}

  get teamService(): TeamService | undefined {
    return undefined;
  }

  get planPath(): string | null {
    return this._planPath;
  }
  set planPath(value: string | null) {
    this._planPath = value;
  }

  // ---- helpers ------------------------------------------------------------

  private emit(m: ExtensionToWebviewMessage): void {
    this.options.onMessage(m);
  }

  /** The pi thinking level for the next turn: forced off when bracketed by disableThinkingForNextQuery,
   * else mapped from the panel's resolved effort for the active model. */
  private resolveThinkingLevel(): ThinkingLevel {
    if (this.thinkingDisabledNextQuery) return 'off';
    return effortToThinkingLevel(this.options.resolveThinking(this.modelValue));
  }

  private contextWindowForCurrentModel(): number {
    return this.getModelInfo(this.modelValue)?.contextWindow ?? this.desiredModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  private buildAccountInfo(): AccountInfo {
    const info: AccountInfo = { model: this.modelValue };
    const piRuntime = PiRuntime.get(this.cwd, PI_AGENT_DIR);
    if (this.getModelInfo(this.modelValue)?.backend === 'openai') {
      info.tokenSource = this.openaiTokenSource();
    } else {
      info.subscriptionType = piRuntime.getClaudeAuthStatus().mode;
    }
    return info;
  }

  private apiKeySource(): string {
    if (this.getModelInfo(this.modelValue)?.backend === 'openai') {
      return this.openaiTokenSource();
    }
    return PiRuntime.get(this.cwd, PI_AGENT_DIR).getClaudeAuthStatus().mode;
  }

  /** Whether the user opted to prefer the OpenAI API key over Codex OAuth when both are configured. */
  private preferOpenAIApiKey(): boolean {
    return this.options.getPreferOpenAIApiKey?.() ?? false;
  }

  /** The active OpenAI credential path, honoring the prefer-API-key toggle when a key is configured. */
  private openaiTokenSource(): 'codex-oauth' | 'openai-api-key' {
    const status = PiRuntime.get(this.cwd, PI_AGENT_DIR).getOpenAIAuthStatus();
    if (this.preferOpenAIApiKey() && status.apiKey) return 'openai-api-key';
    return status.codex ? 'codex-oauth' : 'openai-api-key';
  }
}
