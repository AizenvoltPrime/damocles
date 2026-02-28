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
  private _sessionConflict = false;
  private _budgetLimit: number | null = null;
  private _localPromptPending = false;

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

  setProcessing(value: boolean): void {
    this._isProcessing = value;
    this.callbacks.onMessage({ type: 'processing', isProcessing: value });
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

  get streamingText(): string {
    return this._streamingContent.text;
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
