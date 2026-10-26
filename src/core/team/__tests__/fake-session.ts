/**
 * A fake of pi 1.4.0's `AgentSession` for the team suites, held to a real session by
 * `fake-session.contract.test.ts`. A plain `prompt()` on an idle session starts a run: the session is busy from
 * `_startRun` until `_emitAgentSettled` clears it, and `prompt()` resolves after `agent_settled`
 * (`agent-session.js:1423-1473`, `:683-706`). Each model call waits for the test to answer it (`endTurn`,
 * `callTools`, `failCall`, or an abort); the fake then makes pi-agent-core's turn decision (`agent-loop.js:84-213`)
 * and the session's continue-or-settle decision (`agent-session.js:1531-1589`) itself.
 */
import type { AgentTurnContext, AgentTurnDecision, FinishTurn } from '@earendil-works/pi-agent-core';
import { contentText, isRetryableAssistantError, type AssistantMessage, type ImageContent } from '@earendil-works/pi-ai';

export const BUSY_PROMPT_ERROR = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

/** Events only the fake's run emits, so a test cannot hand-emit a partial lifecycle. */
const RUN_EVENTS = new Set(['agent_start', 'turn_start', 'turn_end', 'agent_end', 'agent_settled', 'auto_retry_start', 'auto_retry_end', 'queue_update']);

/** One request pi makes to the model. */
export interface FakeModelCall {
  /** 0-based, counted across the session. */
  index: number;
  /** The text of each user message pi committed since the previous call, in order. */
  texts: string[];
}

export interface FakeSessionOptions {
  /** Called once pi has asked the model; the call stays open until the test answers it. */
  onModelCall?: (call: FakeModelCall, fake: FakeSession) => void;
  /** pi's `retry.maxRetries` setting. */
  maxRetries?: number;
  /** An extension `turn_end` handler, given the run's signal: pi runs the boundary inside `agent.finishTurn`, before Damocles' deciders. */
  onTurnBoundary?: (turn: AgentTurnContext, fake: FakeSession, signal: AbortSignal | undefined) => void;
}

type FakeTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** pi's per-message `usage`, of which the fake reads the token kinds and the cost total. */
type FakeMessageUsage = Partial<FakeTokens> & { cost?: { total: number } };

type FakeMessage = {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: FakeMessageUsage;
  customType?: string;
  [key: string]: unknown;
};

type Listener = (event: unknown) => void;

/** What a session file holds before a reopened run adds to it. */
export interface FakeOpeningTotals {
  cost: number;
  tokens: FakeTokens;
}

/** The prompt options this fake records, so a test can pin the ones that carry a guarantee. */
export interface FakePromptOptions {
  streamingBehavior?: 'steer' | 'followUp';
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  /** Called once pi has queued the prompt, or right before the run it opens starts (`agent-session.js:1675`, `:1441`); never recorded. */
  preflightResult?: (disposition: 'handled' | 'queued' | 'started') => void;
}

/** An Agent listener, which pi-agent-core awaits for each run event in subscription order (`agent.js:436-437`). */
type AgentListener = (event: unknown) => void | Promise<void>;

/** The writes of pi's `SessionManager` a mirrored fake session repeats. */
export interface FakeSessionMirror {
  appendMessage: (message: unknown) => void;
  appendCustomEntry: (customType: string, data: unknown) => void;
}

/** The tool-call blocks a turn's assistant message carries, in pi's raw `toolCall` shape. */
export interface FakeToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  /** The tool's result: a failed one is what the gate or a throwing tool returns. */
  isError?: boolean;
  /** The result's `terminate`, which a user's deny without feedback sets. */
  terminate?: boolean;
}

type CallAnswer =
  | { kind: 'turn'; text?: string; toolCalls?: FakeToolCall[] }
  | { kind: 'error'; errorMessage: string; partial?: string; toolCall?: boolean }
  | { kind: 'aborted' };

interface PendingCall {
  answered: boolean;
  resolve: (answer: CallAnswer) => void;
  /** The assistant message the test emitted during the call, its unfinished start, and its tool results. */
  message: FakeMessage | null;
  started: FakeMessage | null;
  toolResults: FakeMessage[];
  /** Tools the test started in this call and has not ended. */
  running: Map<string, string>;
  decided: (decision: AgentTurnDecision | undefined) => void;
}

/** A model that ends each turn as soon as it is asked. */
export const endTurnAtOnce = (_call: FakeModelCall, fake: FakeSession): void => {
  void fake.endTurn();
};

/** The text pi matches a started user message against its queue mirror by (`agent-session.js:733`). */
const textOf = (content: unknown): string => contentText((content ?? []) as Parameters<typeof contentText>[0], '');

const toolCallsOf = (message: FakeMessage): unknown[] =>
  (Array.isArray(message.content) ? message.content : []).filter((block: { type?: string }) => block.type === 'toolCall');

export class FakeSession {
  readonly prompts: string[] = [];
  /** Options for each prompt, index-aligned with `prompts`. */
  readonly promptOptions: Array<FakePromptOptions | undefined> = [];
  /**
   * Runs right after the before-settle boundary decided to settle the run. pi clears the busy flag a tick later, so a
   * steer it accepts in that tick stays queued and undelivered (`agent-session.js:1457`, `:1566-1568`, `:685`).
   */
  atLastQueueCheck: (() => void) | null = null;
  /** An `agent_before_settle` handler, which pi awaits after the run's last turn and before it settles (`agent-session.js:1566-1589`). */
  beforeSettle: (() => Promise<void>) | null = null;
  /** An extension `input` handler, which pi awaits in `prompt()` before it reads the busy flag (`agent-session.js:1652`, `:1665`). */
  inputHandler: ((text: string) => Promise<void>) | null = null;
  /** `AgentSession.model`, whose provider and id pi-ai writes on every assistant message (`AssistantMessage.provider`, `.model`). */
  model: { provider: string; id: string } | undefined = undefined;

  private readonly listeners = new Set<Listener>();
  private readonly agentListeners = new Set<AgentListener>();
  /** `dispose()` disconnected the session from its agent (`agent-session.js:1001-1006`, `:1023`). */
  private disposed = false;
  private readonly onModelCall: FakeSessionOptions['onModelCall'];
  private readonly maxRetries: number;
  private readonly onTurnBoundary: FakeSessionOptions['onTurnBoundary'];

  /** `_isAgentRunActive`: from `_startRun` until `_emitAgentSettled`. */
  private runActive = false;
  /** `_isBeforeSettle` and `_abortDuringBeforeSettle`. */
  private inBeforeSettle = false;
  private abortDuringBeforeSettle = false;
  /** `_isEmittingAgentSettled` and `_deferredSettledActions` (`agent-session.js:683-706`, `:1632-1635`). */
  private emittingSettled = false;
  private readonly deferredSettled: Array<() => Promise<void>> = [];
  private abortRequested = false;
  /** The agent's own run (`Agent.activeRun`), one per agent loop; a busy session has none between loops. */
  private agentRun: AbortController | null = null;
  private call: PendingCall | null = null;
  private callCount = 0;
  private retryAttempt = 0;
  private lastAssistant: FakeMessage | undefined;
  /** Whether the agent's transcript ends on an assistant message, which decides how `continue()` resumes. */
  private endsOnAssistant = false;
  private runMessages: FakeMessage[] = [];
  private idleWaiters: Array<() => void> = [];
  private readonly promptWaiters: Array<{ n: number; resolve: () => void }> = [];
  private readonly callWaiters: Array<{ n: number; resolve: () => void }> = [];

  /** pi's session mirror, which `pendingMessageCount` counts. */
  private readonly steeringMirror: string[] = [];
  private readonly followUpMirror: string[] = [];
  /** The agent's own queues, both drained whole under `withSettingsPolicy`'s mode `all` (pi-agent-core `agent.js:72-81`). */
  private agentSteering: FakeMessage[] = [];
  private agentFollowUp: FakeMessage[] = [];

  constructor(opts: FakeSessionOptions = {}) {
    this.onModelCall = opts.onModelCall;
    this.maxRetries = opts.maxRetries ?? 3;
    this.onTurnBoundary = opts.onTurnBoundary;
  }

  get isStreaming(): boolean { return this.runActive; }
  get isIdle(): boolean { return !this.runActive; }

  /** Resolves once at least `n` prompts were accepted (event-driven, no timers). */
  whenPrompted(n: number): Promise<void> {
    if (this.prompts.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) => this.promptWaiters.push({ n, resolve }));
  }

  /** Resolves once pi has made its `n`th model request; a request it made under a live signal is then open. */
  whenModelCalled(n: number): Promise<void> {
    if (this.callCount >= n) return Promise.resolve();
    return new Promise<void>((resolve) => this.callWaiters.push({ n, resolve }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit a session event inside a model call: its stream, a tool's execution, an appended entry. */
  emit(event: unknown): void {
    const type = (event as { type?: string }).type ?? '';
    if (RUN_EVENTS.has(type)) throw new Error(`the fake's run emits ${type}; answer the model call instead`);
    this.dispatch(event);
  }

  async prompt(text: string, options?: FakePromptOptions): Promise<void> {
    if (this.emittingSettled) {
      this.deferredSettled.push(() => this.prompt(text, options));
      return;
    }
    // pi awaits its input handlers (`agent-session.js:1652`) before it decides between queueing and a run (`:1665`).
    if (this.inputHandler) await this.inputHandler(text);
    else await Promise.resolve();
    if (this.runActive) {
      if (!options?.streamingBehavior) throw new Error(BUSY_PROMPT_ERROR);
      this.accept(text, options);
      if (options.streamingBehavior === 'followUp') this.queueFollowUp(text, options.images);
      else this.queueSteer(text, options.images);
      options.preflightResult?.('queued');
      return;
    }
    this.accept(text, options);
    await this.startRun(this.userMessage(text, options?.images), options?.preflightResult);
  }

  /** `AgentSession.abort`: marks a busy run's abort, aborts the agent, and waits for the run to settle. */
  async abort(): Promise<void> {
    if (this.runActive) this.abortRequested = true;
    if (this.inBeforeSettle) this.abortDuringBeforeSettle = true;
    this.agentRun?.abort();
    await this.waitForIdle();
  }

  /** `AgentSession.dispose`: aborts the agent's run and disconnects the session from the agent, so only agent listeners hear a later run. */
  dispose(): void {
    this.agentRun?.abort();
    this.disposed = true;
    this.listeners.clear();
  }

  waitForIdle(): Promise<void> {
    if (!this.runActive) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * The open model call answers without an error. With no tool calls the turn ends; `text` is the reply, and is
   * omitted when the test already emitted the call's assistant `message_end`. Resolves with `finishTurn`'s decision
   * once pi emitted the turn's `turn_end`.
   */
  endTurn(text?: string): Promise<AgentTurnDecision | undefined> {
    return this.answer({ kind: 'turn', ...(text !== undefined ? { text } : {}) });
  }

  /** The open model call answers with tool calls after `text`, and pi runs them before it ends the turn. */
  callTools(toolCalls: FakeToolCall[], text?: string): Promise<AgentTurnDecision | undefined> {
    return this.answer({ kind: 'turn', toolCalls, ...(text !== undefined ? { text } : {}) });
  }

  /** The open model call fails, after streaming `partial` and a tool call when asked to. */
  failCall(errorMessage: string, opts: { partial?: string; toolCall?: boolean } = {}): void {
    void this.answer({ kind: 'error', errorMessage, ...opts });
  }

  /** A steer queued in pi as `_queueSteer` does (`agent-session.js:1795`), which `session.steer()` does even while idle. */
  queueSteer(text: string, images?: ImageContent[]): void {
    this.steeringMirror.push(text);
    this.emitQueueUpdate();
    this.agentSteering.push(this.userMessage(text, images));
  }

  /** A follow-up queued in pi as `_queueFollowUp` does (`agent-session.js:1811`). */
  queueFollowUp(text: string, images?: ImageContent[]): void {
    this.followUpMirror.push(text);
    this.emitQueueUpdate();
    this.agentFollowUp.push(this.userMessage(text, images));
  }

  /** A custom message queued the way a busy `sendCustomMessage` does: onto the agent, never the mirror (`agent-session.js:1862`). */
  queueCustomMessage(text: string): void {
    this.agentSteering.push({ role: 'custom', customType: 'fake', content: [{ type: 'text', text }] });
  }

  /** `AgentSession.pendingMessageCount`: the mirror's steering and follow-up messages. */
  get pendingMessageCount(): number {
    return this.steeringMirror.length + this.followUpMirror.length;
  }

  getSteeringMessages(): readonly string[] {
    return this.steeringMirror;
  }

  getFollowUpMessages(): readonly string[] {
    return this.followUpMirror;
  }

  /** `AgentSession.clearQueue`: hands back the mirror and empties it and the agent's queues. */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.steeringMirror];
    const followUp = [...this.followUpMirror];
    this.steeringMirror.length = 0;
    this.followUpMirror.length = 0;
    this.agentSteering = [];
    this.agentFollowUp = [];
    this.emitQueueUpdate();
    return { steering, followUp };
  }

  /** pi's `AgentSession.agent`, whose `finishTurn` starts as the session's extension `turn_end` boundary. */
  readonly agent: {
    finishTurn?: FinishTurn;
    peekQueuedMessages: () => unknown[];
    hasQueuedMessages: () => boolean;
    subscribe: (listener: AgentListener) => () => void;
    abort: () => void;
    /** `Agent.state.isStreaming`: true while an agent loop runs (`runWithLifecycle`, `agent.js:355-386` in pi-agent-core 1.4.0). */
    readonly state: { readonly isStreaming: boolean };
  } = {
    state: Object.defineProperty({}, 'isStreaming', { get: () => this.agentRun !== null }) as { readonly isStreaming: boolean },
    finishTurn: (turn, signal) => {
      this.onTurnBoundary?.(turn, this, signal);
      return Promise.resolve(undefined);
    },
    peekQueuedMessages: () => (this.agentSteering.length > 0 ? [...this.agentSteering] : [...this.agentFollowUp]),
    hasQueuedMessages: () => this.agentSteering.length > 0 || this.agentFollowUp.length > 0,
    subscribe: (listener) => {
      this.agentListeners.add(listener);
      return () => this.agentListeners.delete(listener);
    },
    abort: () => this.agentRun?.abort(),
  };

  /**
   * The session file's cumulative cost and tokens, summed from each assistant `message_end` as pi's
   * persisted entries are. A test seeds them for a reopened file, or raises them for spend pi writes
   * with no message, such as a compaction or a cache warm.
   */
  cost = 0;
  readonly tokens: FakeTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  /** Seed the totals a reopened session file already holds. */
  seedOpening(opening: FakeOpeningTotals): void {
    this.cost = opening.cost;
    Object.assign(this.tokens, opening.tokens);
  }

  /** Emit one assistant `message_end` carrying per-message usage and its cost (mirrors real pi's event shape). */
  emitAssistantUsage(usage: FakeTokens, cost: number): void {
    this.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { ...usage, cost: { total: cost } } } });
  }

  /** Custom entries appended through `sessionManager`, in order. */
  readonly customEntries: Array<{ customType: string; data: unknown }> = [];
  /** The session's branch: each message pi persisted at its `message_end`, each custom entry, and what a test appends. */
  readonly branch: unknown[] = [];
  /** A real session file that receives every entry this session persists, in the same order, so a test can read it back. */
  mirror: FakeSessionMirror | null = null;
  sessionFile: string | undefined = undefined;
  readonly sessionManager = {
    appendCustomEntry: (customType: string, data: unknown): string => {
      this.customEntries.push({ customType, data });
      const id = `entry-${this.customEntries.length}`;
      this.branch.push({ type: 'custom', id, customType, data });
      this.mirror?.appendCustomEntry(customType, data);
      return id;
    },
    getSessionFile: (): string | undefined => this.sessionFile,
    getBranch: (): unknown[] => this.branch,
    // One `usage` entry carrying the running totals sums to what pi's file would.
    getEntries: (): unknown[] => [{ type: 'usage', usage: { ...this.tokens, cost: { total: this.cost } } }],
  };

  getLastAssistantText(): string {
    return '';
  }

  get messages(): unknown[] {
    return [];
  }

  private accept(text: string, options: FakePromptOptions | undefined): void {
    this.prompts.push(text);
    if (options) {
      const { preflightResult: _observer, ...recorded } = options;
      this.promptOptions.push(recorded);
    } else {
      this.promptOptions.push(undefined);
    }
    for (const waiter of this.promptWaiters.filter((w) => this.prompts.length >= w.n)) {
      this.promptWaiters.splice(this.promptWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  private notifyCallWaiters(): void {
    for (const waiter of this.callWaiters.filter((w) => this.callCount >= w.n)) {
      this.callWaiters.splice(this.callWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  private userMessage(text: string, images: ImageContent[] | undefined): FakeMessage {
    return { role: 'user', content: [{ type: 'text', text }, ...(images ?? [])] };
  }

  private emitQueueUpdate(): void {
    this.dispatch({ type: 'queue_update', steering: [...this.steeringMirror], followUp: [...this.followUpMirror] });
  }

  private answer(answer: CallAnswer): Promise<AgentTurnDecision | undefined> {
    const call = this.call;
    if (!call || call.answered) throw new Error('no model call is open');
    return new Promise((resolve) => {
      call.decided = resolve;
      call.answered = true;
      call.resolve(answer);
    });
  }

  /** `_handleAgentEvent` and `_emit`: the mirror drops a started user message before listeners run, which persist after. */
  private dispatch(event: unknown): void {
    const { type, message } = event as { type: string; message?: FakeMessage };
    if (!this.disposed && type === 'message_start' && message?.role === 'user') {
      const text = textOf(message.content);
      const steering = this.steeringMirror.indexOf(text);
      const followUp = steering === -1 ? this.followUpMirror.indexOf(text) : -1;
      if (steering !== -1) this.steeringMirror.splice(steering, 1);
      else if (followUp !== -1) this.followUpMirror.splice(followUp, 1);
      if (steering !== -1 || followUp !== -1) this.emitQueueUpdate();
    }
    if (this.call && message?.role === 'assistant') {
      if (type === 'message_start' || type === 'message_update') this.call.started = message;
      if (type === 'message_end') {
        this.call.message = message;
        this.call.started = null;
      }
    }
    if (this.call && type === 'message_end' && message?.role === 'toolResult') this.call.toolResults.push(message);
    const tool = event as { toolCallId?: string; toolName?: string };
    if (this.call && type === 'tool_execution_start') this.call.running.set(tool.toolCallId ?? '', tool.toolName ?? '');
    if (this.call && type === 'tool_execution_end') this.call.running.delete(tool.toolCallId ?? '');
    if (this.agentRun && type === 'message_end' && message) this.runMessages.push(message);
    if (type === 'message_end' && message) this.endsOnAssistant = message.role === 'assistant';
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener(event);
    if (type === 'message_end' && message) this.persist(message);
  }

  private persist(message: FakeMessage): void {
    if (message.role === 'custom') {
      this.branch.push({ type: 'custom_message', id: `m${this.branch.length}`, customType: message.customType, content: message.content });
    } else {
      this.branch.push({ type: 'message', id: `m${this.branch.length}`, message });
      this.mirror?.appendMessage(message);
    }
    if (message.role !== 'assistant') return;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) this.tokens[key] += message.usage?.[key] ?? 0;
    this.cost += message.usage?.cost?.total ?? 0;
    this.lastAssistant = message;
    if (message.stopReason !== 'error' && this.retryAttempt > 0) {
      this.dispatch({ type: 'auto_retry_end', success: true, attempt: this.retryAttempt });
      this.retryAttempt = 0;
    }
  }

  /** pi awaits its extension runner before it notifies listeners of every loop event. */
  private async emitRunEvent(event: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    if (!this.disposed && event['type'] === 'agent_start' && this.abortRequested) this.agentRun?.abort();
    // Only the session's copy of `agent_end` carries `willRetry` (`agent-session.js:753`).
    this.dispatch(event['type'] === 'agent_end' ? { ...event, willRetry: this.willRetry(event['messages'] as FakeMessage[]) } : event);
    // The session subscribed to its agent first, so agent listeners hear each event after it (`agent-session.js:202`).
    for (const listener of [...this.agentListeners]) await listener(event);
  }

  private async deliver(message: FakeMessage, texts: string[]): Promise<void> {
    await this.emitRunEvent({ type: 'message_start', message });
    await this.emitRunEvent({ type: 'message_end', message });
    if (message.role === 'user') texts.push(textOf(message.content));
  }

  private willRetry(messages: FakeMessage[]): boolean {
    if (this.abortRequested || this.retryAttempt >= this.maxRetries) return false;
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    return last !== undefined && isRetryableAssistantError(last as unknown as AssistantMessage);
  }

  private drainSteering(): FakeMessage[] {
    const drained = this.agentSteering;
    this.agentSteering = [];
    return drained;
  }

  private drainFollowUp(): FakeMessage[] {
    const drained = this.agentFollowUp;
    this.agentFollowUp = [];
    return drained;
  }

  /** `_startRun`. */
  private async startRun(prompt: FakeMessage, onStarted?: FakePromptOptions['preflightResult']): Promise<void> {
    this.runActive = true;
    this.abortRequested = false;
    try {
      // `_prepareRun`, before the agent's run exists.
      await Promise.resolve();
      onStarted?.('started');
      await this.agentLoop([prompt], false);
      while (!this.abortRequested) {
        if (await this.postAgentRun()) {
          if (this.abortRequested) break;
          await this.agentContinue();
          continue;
        }
        if (this.abortRequested || !(await this.beforeSettleBoundary())) break;
        if (this.abortRequested) break;
        await this.agentContinue();
      }
    } finally {
      if (this.abortRequested) this.finishCancelledRetry();
      await this.settle();
    }
  }

  /**
   * `_runBeforeSettleBoundary`: pi awaits the `agent_before_settle` handlers, settles a run an abort landed on meanwhile,
   * then checks its queues a last time (`agent-session.js:1566-1589`).
   */
  private async beforeSettleBoundary(): Promise<boolean> {
    const continues = await this.beforeSettleDecision();
    if (!continues) this.atLastQueueCheck?.();
    return continues;
  }

  private async beforeSettleDecision(): Promise<boolean> {
    if (!this.beforeSettle) return this.agent.hasQueuedMessages();
    this.inBeforeSettle = true;
    this.abortDuringBeforeSettle = false;
    try {
      await this.beforeSettle();
      return !this.abortDuringBeforeSettle && this.agent.hasQueuedMessages();
    } finally {
      this.inBeforeSettle = false;
    }
  }

  /** `_emitAgentSettled`: a prompt sent while its handlers run waits for them, and the settling prompt waits for it. */
  private async settle(): Promise<void> {
    this.runActive = false;
    this.emittingSettled = true;
    try {
      await this.emitSettledHandlers();
      this.dispatch({ type: 'agent_settled', aborted: this.abortRequested });
    } finally {
      this.emittingSettled = false;
    }
    try {
      for (const action of this.deferredSettled.splice(0)) await action();
    } finally {
      // `_resolveIdleWaitIfIdle`: a run a late prompt started meanwhile keeps the waiters waiting for its own settle.
      if (!this.runActive) for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** `ExtensionRunner.emit` awaiting a team session's async `agent_settled` handler, which returns at once with no hook configured (`subagent-extension-factory.ts:168`). */
  private async emitSettledHandlers(): Promise<void> {
    await (async () => undefined)();
  }

  /** `_handlePostAgentRun`: retry a retryable failure, else continue only on a queued message. */
  private async postAgentRun(): Promise<boolean> {
    const message = this.lastAssistant;
    this.lastAssistant = undefined;
    if (this.abortRequested) {
      this.finishCancelledRetry();
      return false;
    }
    if (!message) return this.agent.hasQueuedMessages();
    if (isRetryableAssistantError(message as unknown as AssistantMessage) && (await this.prepareRetry(message))) {
      if (this.abortRequested) this.finishCancelledRetry();
      return !this.abortRequested;
    }
    if (this.abortRequested) {
      this.finishCancelledRetry();
      return false;
    }
    if (message.stopReason === 'error' && this.retryAttempt > 0) {
      this.dispatch({ type: 'auto_retry_end', success: false, attempt: this.retryAttempt, finalError: message.errorMessage });
      this.retryAttempt = 0;
    }
    return this.agent.hasQueuedMessages();
  }

  /** `_prepareRetry`: the failed call leaves the model's context, and the backoff can be aborted. */
  private async prepareRetry(message: FakeMessage): Promise<boolean> {
    this.retryAttempt++;
    if (this.retryAttempt > this.maxRetries) {
      this.retryAttempt--;
      return false;
    }
    this.dispatch({
      type: 'auto_retry_start',
      attempt: this.retryAttempt,
      maxAttempts: this.maxRetries,
      delayMs: 2000 * 2 ** (this.retryAttempt - 1),
      errorMessage: message.errorMessage || 'Unknown error',
    });
    this.endsOnAssistant = false;
    await Promise.resolve();
    if (this.abortRequested) {
      this.finishCancelledRetry();
      return false;
    }
    return true;
  }

  private finishCancelledRetry(): void {
    if (this.retryAttempt === 0) return;
    const attempt = this.retryAttempt;
    this.retryAttempt = 0;
    this.dispatch({ type: 'auto_retry_end', success: false, attempt, finalError: 'Retry cancelled' });
  }

  /** `Agent.continue`: a transcript ending on an assistant message resumes from the queues, else from its context. */
  private async agentContinue(): Promise<void> {
    if (!this.endsOnAssistant) return this.agentLoop([], false);
    const steering = this.drainSteering();
    if (steering.length > 0) return this.agentLoop(steering, true);
    const followUps = this.drainFollowUp();
    if (followUps.length > 0) return this.agentLoop(followUps, false);
    throw new Error('Cannot continue from message role: assistant');
  }

  /** `runAgentLoop` and `runLoop` (`agent-loop.js:48-213`), under the agent's own abort signal. */
  private async agentLoop(prompts: FakeMessage[], skipInitialSteeringPoll: boolean): Promise<void> {
    const run = new AbortController();
    this.agentRun = run;
    this.runMessages = [];
    // `createLoopConfig` (`agent.js:306-322` in pi-agent-core 1.4.0): a decider installed mid-loop applies from the next loop.
    const finishTurn = this.agent.finishTurn;
    try {
      await this.emitRunEvent({ type: 'agent_start' });
      await this.emitRunEvent({ type: 'turn_start' });
      const texts: string[] = [];
      for (const message of prompts) await this.deliver(message, texts);
      let pending = skipInitialSteeringPoll ? [] : this.drainSteering();
      let completedTurn = false;
      let explicitContinuation = false;
      for (;;) {
        let hasMoreToolCalls = true;
        while (hasMoreToolCalls || pending.length > 0) {
          if (completedTurn) {
            await Promise.resolve();
            if (pending.length === 0) pending = this.drainSteering();
            await this.emitRunEvent({ type: 'turn_start' });
          }
          for (const message of pending) await this.deliver(message, texts);
          pending = [];
          const { message, toolResults, decided, terminate } = await this.modelCall(run.signal, texts.splice(0));
          const turn = { message, toolResults, context: {}, newMessages: [] } as unknown as AgentTurnContext;
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            const decision = (await finishTurn?.(turn, run.signal)) as AgentTurnDecision | undefined;
            await this.emitRunEvent({ type: 'turn_end', message, toolResults: [] });
            decided?.(decision);
            await this.emitRunEvent({ type: 'agent_end', messages: [...this.runMessages] });
            return;
          }
          hasMoreToolCalls = toolCallsOf(message).length > 0 && terminate !== true;
          const decision = (await finishTurn?.(turn, run.signal)) as AgentTurnDecision | undefined;
          await this.emitRunEvent({ type: 'turn_end', message, toolResults });
          decided?.(decision);
          if (decision?.action === 'end') {
            await this.emitRunEvent({ type: 'agent_end', messages: [...this.runMessages] });
            return;
          }
          explicitContinuation = decision?.action === 'continue';
          pending = this.drainSteering();
          if (hasMoreToolCalls || pending.length > 0) explicitContinuation = false;
          completedTurn = true;
        }
        const followUps = this.drainFollowUp();
        if (followUps.length > 0) {
          explicitContinuation = false;
          pending = followUps;
          continue;
        }
        if (explicitContinuation) {
          explicitContinuation = false;
          continue;
        }
        break;
      }
      await this.emitRunEvent({ type: 'agent_end', messages: [...this.runMessages] });
    } finally {
      this.agentRun = null;
    }
  }

  /** One request: the test answers it, or an abort ends it the way pi-ai's stream ends an aborted request. */
  private async modelCall(
    signal: AbortSignal,
    texts: string[],
  ): Promise<{ message: FakeMessage; toolResults: FakeMessage[]; decided?: PendingCall['decided']; terminate?: boolean }> {
    const index = this.callCount++;
    // The request's setup rejects on the aborted signal before any provider streams (`model-runtime.js:518-521`,
    // pi-ai `lazy.js:45-65`), so it ends on an error stop rather than an aborted one.
    if (signal.aborted) {
      this.notifyCallWaiters();
      return { message: await this.endResponse(null, 'error', 'This operation was aborted'), toolResults: [] };
    }
    const call: PendingCall = {
      answered: false, resolve: () => undefined, message: null, started: null, toolResults: [], running: new Map(), decided: () => undefined,
    };
    const answer = await new Promise<CallAnswer>((resolve) => {
      call.resolve = resolve;
      this.call = call;
      // A test that answers in the same tick as the abort, as a tool that finishes under it does, answers first.
      signal.addEventListener('abort', () => queueMicrotask(() => {
        if (call.answered) return;
        call.answered = true;
        resolve({ kind: 'aborted' });
      }), { once: true });
      this.notifyCallWaiters();
      this.onModelCall?.({ index, texts }, this);
    });
    this.call = null;
    if (answer.kind === 'aborted') {
      // A response that ended before the abort lands in its tools, which the abort cuts short.
      if (call.message) return { message: call.message, toolResults: [...call.toolResults, ...(await this.endAbortedTools(call.running))] };
      return { message: await this.endResponse(call.started, 'aborted', 'Request was aborted'), toolResults: [] };
    }
    if (answer.kind === 'error') {
      const content = [
        ...(answer.partial ? [{ type: 'text', text: answer.partial }] : []),
        ...(answer.toolCall ? [{ type: 'toolCall', id: 'tc-failed', name: 'read', arguments: { path: '/a.ts' } }] : []),
      ];
      if (!call.started) await this.emitRunEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
      if (answer.partial) await this.emitRunEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: answer.partial } });
      const message = { role: 'assistant', content, ...this.modelOfMessage(), stopReason: 'error', errorMessage: answer.errorMessage };
      await this.emitRunEvent({ type: 'message_end', message });
      return { message, toolResults: [], decided: call.decided };
    }
    let message = call.message;
    if (message && (answer.text !== undefined || answer.toolCalls)) throw new Error('the call already emitted its assistant message');
    if (!message) {
      const content = [
        ...(answer.text ? [{ type: 'text', text: answer.text }] : []),
        ...(answer.toolCalls ?? []).map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.arguments ?? {} })),
      ];
      message = { role: 'assistant', content, ...this.modelOfMessage(), stopReason: answer.toolCalls?.length ? 'toolUse' : 'stop' };
      if (!call.started) await this.emitRunEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
      if (answer.text) await this.emitRunEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: answer.text } });
      await this.emitRunEvent({ type: 'message_end', message });
    }
    const toolResults = [...call.toolResults];
    // pi-agent-core's parallel execution: every call starts, every call ends, then each result message (`agent-loop.js:417-464`).
    const calls = answer.toolCalls ?? [];
    for (const c of calls) await this.emitRunEvent({ type: 'tool_execution_start', toolCallId: c.id, toolName: c.name, args: c.arguments ?? {} });
    const results = calls.map((c) => ({ role: 'toolResult', toolCallId: c.id, toolName: c.name, content: [], isError: c.isError === true }));
    for (const r of results) await this.emitRunEvent({ type: 'tool_execution_end', toolCallId: r.toolCallId, toolName: r.toolName, result: { content: [], details: {} }, isError: r.isError });
    for (const r of results) {
      await this.emitRunEvent({ type: 'message_start', message: r });
      await this.emitRunEvent({ type: 'message_end', message: r });
      toolResults.push(r);
    }
    // The batch ends the turn only when every result terminates (`agent-loop.js:172`, `:471-473` in pi-agent-core 1.4.0).
    const terminate = calls.length > 0 && calls.every((c) => c.terminate === true);
    return { message, toolResults, decided: call.decided, terminate };
  }

  /** Each running tool throws on the abort, and pi records its error result (`agent-loop.js:417-464`). */
  private async endAbortedTools(running: Map<string, string>): Promise<FakeMessage[]> {
    const results = [...running].map(([toolCallId, toolName]) => ({
      role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: 'Operation aborted' }], isError: true,
    }));
    for (const r of results) {
      await this.emitRunEvent({ type: 'tool_execution_end', toolCallId: r.toolCallId, toolName: r.toolName, result: { content: r.content, details: {} }, isError: true });
    }
    for (const r of results) {
      await this.emitRunEvent({ type: 'message_start', message: r });
      await this.emitRunEvent({ type: 'message_end', message: r });
    }
    return results;
  }

  /** An aborted or wound-down response: its `message_start` unless it already streamed one, then its `message_end`. */
  private async endResponse(started: FakeMessage | null, stopReason: string, errorMessage: string): Promise<FakeMessage> {
    const message = { role: 'assistant', content: Array.isArray(started?.content) ? started.content : [], ...this.modelOfMessage(), stopReason, errorMessage };
    if (!started) await this.emitRunEvent({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await this.emitRunEvent({ type: 'message_end', message });
    return message;
  }

  private modelOfMessage(): { provider?: string; model?: string } {
    return this.model ? { provider: this.model.provider, model: this.model.id } : {};
  }
}
