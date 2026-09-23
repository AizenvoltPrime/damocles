/**
 * A fake pi `AgentSession` for the team suites: it records every `prompt()` it receives, resolves a
 * prompt at the turn boundary (mirroring real pi), and lets a test emit session events by hand. Shared
 * by `agent-runner.test.ts` (the runner loop in isolation) and `team-wiring.test.ts` (the real
 * TeamRunner<->AgentRunner seam), so both observe what an agent's session ACTUALLY receives.
 */
import type { AgentTurnContext, FinishTurn } from '@earendil-works/pi-agent-core';

export interface FakeSessionOptions {
  /** Per-`prompt()` behavior: emit assistant text, then resolve at the turn boundary. */
  onPrompt: (text: string, fake: FakeSession) => void;
  isStreaming?: boolean;
}

type Listener = (event: unknown) => void;

/** The prompt options this fake records, so a test can pin the ones that carry a guarantee. */
export interface FakePromptOptions {
  streamingBehavior?: 'steer' | 'followUp';
  expandPromptTemplates?: boolean;
}

/** The tool-call blocks a turn's assistant message carries, in pi's raw `toolCall` shape. */
export interface FakeToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export class FakeSession {
  readonly prompts: string[] = [];
  /** Options for each prompt, index-aligned with `prompts`. */
  readonly promptOptions: Array<FakePromptOptions | undefined> = [];
  isStreaming = false;
  get isIdle(): boolean { return !this.isStreaming; }
  aborted = false;
  private listeners = new Set<Listener>();
  private readonly onPrompt: FakeSessionOptions['onPrompt'];
  /** Resolves the in-flight `prompt()` — mirrors real pi (prompt resolves at the turn boundary). */
  private pendingTurn: (() => void) | null = null;
  /** Deterministic prompt-count waiters — resolve `whenPrompted(n)` when the nth prompt lands. */
  private readonly promptWaiters = new Map<number, () => void>();

  constructor(opts: FakeSessionOptions) {
    this.onPrompt = opts.onPrompt;
    this.isStreaming = opts.isStreaming ?? false;
  }

  /** Resolves once at least `n` prompts have been issued (event-driven, no timers). */
  whenPrompted(n: number): Promise<void> {
    if (this.prompts.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) => this.promptWaiters.set(n, resolve));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown): void {
    if ((event as { type?: string }).type === 'turn_end' && this.pendingTurn) {
      const resolve = this.pendingTurn;
      this.pendingTurn = null;
      resolve();
    }
    for (const l of this.listeners) l(event);
  }

  async prompt(text: string, options?: FakePromptOptions): Promise<void> {
    this.prompts.push(text);
    this.promptOptions.push(options);
    const waiter = this.promptWaiters.get(this.prompts.length);
    if (waiter) {
      this.promptWaiters.delete(this.prompts.length);
      waiter();
    }
    // A steered prompt is injected into the in-flight turn (real pi), so it does NOT open a new turn
    // await. Resolve immediately and leave the opening prompt's pending resolver intact.
    if (options?.streamingBehavior === 'steer') {
      // pi holds a steered message in its queue until it drains it, so it is pending for exactly as
      // long as delivery takes and anything that reads the count during delivery sees it.
      this.queued.push(text);
      this.onPrompt(text, this);
      this.queued.shift();
      return;
    }
    return new Promise<void>((resolve) => {
      this.pendingTurn = resolve;
      this.onPrompt(text, this);
    });
  }

  /**
   * Mirrors a real run starting: pi marks the session streaming (`agent-session.js:1080`) and then emits
   * `agent_start` (`agent-loop.js:50`). Opt-in, since most tests model a held turn as not streaming.
   */
  startStreaming(): void {
    this.isStreaming = true;
    this.emit({ type: 'agent_start' });
  }

  /** Real pi ends the in-flight turn on abort, so the aborted `prompt()` resolves. */
  async abort(): Promise<void> {
    this.aborted = true;
    const resolve = this.pendingTurn;
    this.pendingTurn = null;
    resolve?.();
  }

  /** Cumulative session cost (real pi semantics) — driven by the test via `cost`. */
  cost = 0;
  getSessionStats(): { cost: number } {
    return { cost: this.cost };
  }

  /** Emit one assistant `message_end` carrying per-message usage (mirrors real pi's event shape). */
  emitAssistantUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    this.emit({ type: 'message_end', message: { role: 'assistant', content: [], usage } });
  }

  /** Custom entries appended through `sessionManager`, in order. */
  readonly customEntries: Array<{ customType: string; data: unknown }> = [];
  sessionFile: string | undefined = undefined;
  readonly sessionManager = {
    appendCustomEntry: (customType: string, data: unknown): string => {
      this.customEntries.push({ customType, data });
      return `entry-${this.customEntries.length}`;
    },
    getSessionFile: (): string | undefined => this.sessionFile,
  };

  getLastAssistantText(): string {
    return '';
  }

  get messages(): unknown[] {
    return [];
  }

  /** Mirrors pi's `AgentSession.agent`: the mutable `Agent` a consumer installs its hooks on. */
  readonly agent: { finishTurn?: FinishTurn; peekQueuedMessages: () => unknown[] } = {
    peekQueuedMessages: () => [...this.queued, ...this.agentOnlyQueued],
  };

  /** Messages held in pi's `AgentSession` mirror, which is what `pendingMessageCount` counts. */
  private readonly queued: string[] = [];

  /**
   * Messages pi enqueued straight onto the agent, which its mirror never sees
   * (`sendCustomMessage`, `agent-session.js:1481`, steers the agent directly). Only `peekQueuedMessages` reports these.
   */
  private readonly agentOnlyQueued: string[] = [];

  /** The follow-up half of pi's mirror, which `holdFollowUpMessage` fills. */
  private readonly followUps: string[] = [];

  /** Mirrors pi's `AgentSession.pendingMessageCount`: messages queued for steering or follow-up. */
  get pendingMessageCount(): number {
    return this.queued.length + this.followUps.length;
  }

  /** Mirrors pi's `AgentSession.getSteeringMessages`. */
  getSteeringMessages(): readonly string[] {
    return this.queued;
  }

  /** Mirrors pi's `AgentSession.getFollowUpMessages`. */
  getFollowUpMessages(): readonly string[] {
    return this.followUps;
  }

  /** Mirrors pi's `AgentSession.clearQueue`: hands back the mirror and empties both queues. */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.queued];
    const followUp = [...this.followUps];
    this.queued.length = 0;
    this.followUps.length = 0;
    this.agentOnlyQueued.length = 0;
    return { steering, followUp };
  }

  /** Queue a follow-up message without delivering it. */
  holdFollowUpMessage(text: string): void {
    this.followUps.push(text);
  }

  /**
   * Queue a steered message without delivering it, the window pi leaves open by running `finishTurn`
   * before it drains the queue.
   */
  holdSteeredMessage(text: string): void {
    this.queued.push(text);
  }

  /** Queue a message the way `sendCustomMessage` does: onto the agent, invisible to the mirror. */
  holdCustomMessage(text: string): void {
    this.agentOnlyQueued.push(text);
  }

  /**
   * One turn the way pi's loop runs it: emit the completed assistant message, then consult
   * `agent.finishTurn`. The turn ends (resolving the in-flight `prompt()`) only on `{ action: 'end' }`,
   * so a test sees whether the agent parks or would have kept going.
   */
  async runTurn(toolCalls: FakeToolCall[]): Promise<boolean> {
    const content = toolCalls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: c.arguments ?? {} }));
    const message = { role: 'assistant', content };
    this.emit({ type: 'message_end', message });
    // pi pairs every executed call with a result message, keyed by the call id (`createToolResultMessage`,
    // `agent-loop.js:620-626`).
    const toolResults = toolCalls.map((c) => ({ role: 'toolResult', toolCallId: c.id, toolName: c.name, content: [], isError: false }));
    const turn = { message, toolResults, context: {}, newMessages: [] } as unknown as AgentTurnContext;
    const decision = await this.agent.finishTurn?.(turn);
    const stop = decision?.action === 'end';
    if (stop) this.emit({ type: 'turn_end' });
    return stop;
  }
}
