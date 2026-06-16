import type { MessageCallbacks, PendingAssistantMessage, StreamingContent } from '../types';
import { createEmptyStreamingContent } from '../types';
import type { TurnCompleteCallback } from './types';

/**
 * StreamingState manages all mutable state for streaming operations.
 *
 * This centralizes state management with proper change notifications,
 * making it easier for processors to read and update state consistently.
 */
export class StreamingState {
  private _sessionId: string | null = null;
  private _pendingAssistant: PendingAssistantMessage | null = null;
  private _streamingContent: StreamingContent = createEmptyStreamingContent();
  private _lastUserMessageId: string | null = null;
  private _isProcessing = false;
  private _onTurnComplete: TurnCompleteCallback | null = null;
  private _silentAbort = false;
  private _queryGeneration = 0;
  private _currentQueryGeneration = 0;
  private _onTurnEndFlush: (() => boolean) | null = null;
  private _lastContextTokens = 0;
  /** How the active turn is being served: 'warm' (turn 1 consumed a pre-spawned warm subprocess), 'cold' (turn 1 cold-started a fresh subprocess), or 'reused' (a later turn riding the already-live persistent query). Set by QueryManager at each ensureStreamingQuery; read by the cache telemetry log. */
  private _queryOrigin: 'warm' | 'cold' | 'reused' = 'cold';
  /** Running session cost, summed from each SDK result's per-turn total_cost_usd (US-002 confirmed the result is per-prompt-scoped, not cumulative). Surfaced as costΣ in the cache telemetry. */
  private _cumulativeCostUsd = 0;
  /** Message id of the last model call logged by the cache telemetry, so the dual emission sites (assistant + stream_event) log exactly one line per call. */
  private _cacheLoggedMessageId: string | null = null;
  private _sessionConflict = false;
  private _budgetLimit: number | null = null;
  private _localPromptPending = false;
  private _cumulativeOutputTokens = 0;
  /** Cross-turn output total. Only reset on resetStreaming(). Live dispatch sends sessionTotal + perTurnCumulative for across-prompts continuity. */
  private _sessionTotalOutputTokens = 0;
  private _processingGeneration = 0;
  /** Turn-scoped "has any visible output streamed". Set once on the first text/thinking/tool block, survives per-message buffer resets, cleared only when a new processing cycle begins. Authoritative source for the ESC recovery-vs-abort decision. */
  private _turnHasStreamedOutput = false;
  private readonly _workflowToolUseIds = new Set<string>();
  private readonly _workflowTaskToToolUse = new Map<string, string>();
  private readonly _workflowTranscriptDirs = new Map<string, string>();
  private readonly _workflowTranscriptLastPush = new Map<string, number>();
  private readonly _workflowTranscriptSeq = new Map<string, number>();

  private callbacks: MessageCallbacks;

  constructor(callbacks: MessageCallbacks) {
    this.callbacks = callbacks;
  }

  get lastContextTokens(): number {
    return this._lastContextTokens;
  }

  set lastContextTokens(value: number) {
    this._lastContextTokens = value;
  }

  get queryOrigin(): 'warm' | 'cold' | 'reused' {
    return this._queryOrigin;
  }

  set queryOrigin(value: 'warm' | 'cold' | 'reused') {
    this._queryOrigin = value;
  }

  get cumulativeCostUsd(): number {
    return this._cumulativeCostUsd;
  }

  /** Accumulate one turn's engine-reported cost into the running session total. */
  addTurnCost(turnCostUsd: number): void {
    this._cumulativeCostUsd += turnCostUsd;
  }

  /** Records a model-call message id as logged and returns true if it was newly recorded — false on repeats. Lets the two cache-telemetry emission sites log once per call. A null/empty id is treated as always-new (logs through), since dedup needs a stable key. */
  markCacheLoggedIfNew(messageId: string | null | undefined): boolean {
    if (!messageId) return true;
    if (this._cacheLoggedMessageId === messageId) return false;
    this._cacheLoggedMessageId = messageId;
    return true;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  setSessionId(value: string | null): void {
    if (this._sessionId !== value) {
      this._sessionId = value;
      this.callbacks.onSessionIdChange?.(value);
    }
  }

  get pendingAssistant(): PendingAssistantMessage | null {
    return this._pendingAssistant;
  }

  set pendingAssistant(value: PendingAssistantMessage | null) {
    this._pendingAssistant = value;
  }

  get streamingContent(): StreamingContent {
    return this._streamingContent;
  }

  set streamingContent(value: StreamingContent) {
    this._streamingContent = value;
  }

  get lastUserMessageId(): string | null {
    return this._lastUserMessageId;
  }

  set lastUserMessageId(value: string | null) {
    this._lastUserMessageId = value;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get processingGeneration(): number {
    return this._processingGeneration;
  }

  setProcessing(value: boolean): void {
    if (value) {
      this._processingGeneration++;
      this._cumulativeOutputTokens = 0;
      this._turnHasStreamedOutput = false;
    }
    this._isProcessing = value;
    this.callbacks.onMessage({ type: 'processing', isProcessing: value });
  }

  get turnHasStreamedOutput(): boolean {
    return this._turnHasStreamedOutput;
  }

  markStreamedOutput(): void {
    this._turnHasStreamedOutput = true;
  }

  get onTurnComplete(): TurnCompleteCallback | null {
    return this._onTurnComplete;
  }

  set onTurnComplete(value: TurnCompleteCallback | null) {
    this._onTurnComplete = value;
  }

  get silentAbort(): boolean {
    return this._silentAbort;
  }

  set silentAbort(value: boolean) {
    this._silentAbort = value;
  }

  get queryGeneration(): number {
    return this._queryGeneration;
  }

  incrementQueryGeneration(): number {
    return ++this._queryGeneration;
  }

  get currentQueryGeneration(): number {
    return this._currentQueryGeneration;
  }

  set currentQueryGeneration(value: number) {
    this._currentQueryGeneration = value;
  }

  get onTurnEndFlush(): (() => boolean) | null {
    return this._onTurnEndFlush;
  }

  set onTurnEndFlush(value: (() => boolean) | null) {
    this._onTurnEndFlush = value;
  }

  isStaleQuery(): boolean {
    return this._currentQueryGeneration === 0;
  }

  get budgetLimit(): number | null {
    return this._budgetLimit;
  }

  set budgetLimit(value: number | null) {
    this._budgetLimit = value;
  }

  get sessionConflict(): boolean {
    return this._sessionConflict;
  }

  set sessionConflict(value: boolean) {
    this._sessionConflict = value;
  }

  get localPromptPending(): boolean {
    return this._localPromptPending;
  }

  set localPromptPending(value: boolean) {
    this._localPromptPending = value;
  }

  get cumulativeOutputTokens(): number {
    return this._cumulativeOutputTokens;
  }

  set cumulativeOutputTokens(value: number) {
    this._cumulativeOutputTokens = value;
  }

  get sessionTotalOutputTokens(): number {
    return this._sessionTotalOutputTokens;
  }

  set sessionTotalOutputTokens(value: number) {
    this._sessionTotalOutputTokens = value;
  }

  get streamingText(): string {
    return this._streamingContent.text;
  }

  /** Tool-use ids of `Workflow` tool calls, used to route their task notifications to the workflow panel. Persists across turns (a workflow outlives the turn that launched it). */
  get workflowToolUseIds(): Set<string> {
    return this._workflowToolUseIds;
  }

  /** Maps a workflow's task id to its launching tool-use id. The live `system:task_notification` carries `task_id` reliably but `tool_use_id` only optionally, so this binding (captured at `task_started`) lets a notification resolve back to the workflow panel keyed by tool-use id. */
  get workflowTaskToToolUse(): Map<string, string> {
    return this._workflowTaskToToolUse;
  }

  /** Maps a workflow's tool-use id to its on-disk transcript directory (parsed from the launch result). Lets the extension push per-agent transcripts to the webview as the run progresses, independent of whether the panel is open. */
  get workflowTranscriptDirs(): Map<string, string> {
    return this._workflowTranscriptDirs;
  }

  /** Per-workflow timestamp of the last transcript push, used to throttle disk reads while `task_progress` events stream in. */
  get workflowTranscriptLastPush(): Map<string, number> {
    return this._workflowTranscriptLastPush;
  }

  /**
   * Monotonically increasing per-workflow sequence number, captured when a transcript read is
   * dispatched. The webview drops any `workflowTranscripts` whose seq is older than the latest
   * applied, so an out-of-order disk read can't overwrite a newer snapshot. Lives here (not a
   * module global) so it's per-session — cleared with the other workflow maps on resetStreaming
   * and isolated between concurrent panels.
   */
  nextWorkflowTranscriptSeq(toolUseId: string): number {
    const next = (this._workflowTranscriptSeq.get(toolUseId) ?? 0) + 1;
    this._workflowTranscriptSeq.set(toolUseId, next);
    return next;
  }

  resetStreaming(): void {
    this._queryGeneration++;
    this._currentQueryGeneration = 0;
    this._pendingAssistant = null;
    this._streamingContent = createEmptyStreamingContent();
    this._lastUserMessageId = null;
    this._isProcessing = false;
    this._sessionConflict = false;
    this._budgetLimit = null;
    this._localPromptPending = false;
    this._cumulativeOutputTokens = 0;
    this._sessionTotalOutputTokens = 0;
    this._turnHasStreamedOutput = false;
    this._queryOrigin = 'cold';
    this._cumulativeCostUsd = 0;
    this._cacheLoggedMessageId = null;
    this._workflowToolUseIds.clear();
    this._workflowTaskToToolUse.clear();
    this._workflowTranscriptDirs.clear();
    this._workflowTranscriptLastPush.clear();
    this._workflowTranscriptSeq.clear();
  }

  resetTurn(): void {
    this._pendingAssistant = null;
    this._streamingContent = createEmptyStreamingContent();
  }

  fireTurnComplete(): void {
    if (this._onTurnComplete) {
      this._onTurnComplete();
      this._onTurnComplete = null;
    }
  }

  fireTurnEndFlush(): boolean {
    if (this._onTurnEndFlush) {
      return this._onTurnEndFlush();
    }
    return false;
  }
}
