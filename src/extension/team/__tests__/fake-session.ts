/**
 * A fake pi `AgentSession` for the team suites: it records every `prompt()` it receives, resolves a
 * prompt at the turn boundary (mirroring real pi), and lets a test emit session events by hand. Shared
 * by `agent-runner.test.ts` (the runner loop in isolation) and `team-wiring.test.ts` (the real
 * TeamRunner<->AgentRunner seam), so both observe what an agent's session ACTUALLY receives.
 */
export interface FakeSessionOptions {
  /** Per-`prompt()` behavior: emit assistant text, then resolve at the turn boundary. */
  onPrompt: (text: string, fake: FakeSession) => void;
  isStreaming?: boolean;
}

type Listener = (event: unknown) => void;

export class FakeSession {
  readonly prompts: string[] = [];
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

  async prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    this.prompts.push(text);
    const waiter = this.promptWaiters.get(this.prompts.length);
    if (waiter) {
      this.promptWaiters.delete(this.prompts.length);
      waiter();
    }
    // A steered prompt is injected into the in-flight turn (real pi), so it does NOT open a new turn
    // await — resolve immediately and leave the opening prompt's pending resolver intact.
    if (options?.streamingBehavior === 'steer') {
      this.onPrompt(text, this);
      return;
    }
    return new Promise<void>((resolve) => {
      this.pendingTurn = resolve;
      this.onPrompt(text, this);
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
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

  getLastAssistantText(): string {
    return '';
  }

  get messages(): unknown[] {
    return [];
  }
}
