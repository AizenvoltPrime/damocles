import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../agent-runner';
import { MessageBus } from '../message-bus';
import type { AgentRunConfig } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

/**
 * The pi-native team agent runner (US-024b). These tests drive a FAKE pi `AgentSession` to assert the
 * event-driven prompt/re-prompt loop: the initial task is prompted once, a MessageBus delivery while
 * idle re-prompts the agent, and the keepAlive predicate gates the idle wait (no timers).
 */

interface FakeSessionOptions {
  /** Per-`prompt()` behavior: emit assistant text, then resolve at the turn boundary. */
  onPrompt: (text: string, fake: FakeSession) => void;
  isStreaming?: boolean;
}

type Listener = (event: unknown) => void;

class FakeSession {
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

function baseConfig(overrides: Partial<AgentRunConfig>): AgentRunConfig {
  const messageBus = new MessageBus('team-1');
  return {
    agentId: 'a1',
    name: 'worker',
    role: 'specialist',
    specialization: 'do the task',
    createSession: overrides.createSession ?? (async () => { throw new Error('no session'); }),
    forgetSession: vi.fn(),
    abortSignal: new AbortController().signal,
    messageBus,
    onMessage: vi.fn<(m: ExtensionToWebviewMessage) => void>(),
    teamId: 'team-1',
    persistence: { appendAgentEntry: vi.fn(), appendTeamEntry: vi.fn(), flush: async () => {} },
    ...overrides,
  } as AgentRunConfig;
}

describe('AgentRunner (pi-native team agent)', () => {
  it('prompts the opening task once and completes when keepAlive is false', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
    });

    const result = await new AgentRunner().startAgent(config);

    expect(fake.prompts).toEqual(['do the task']);
    expect(result.status).toBe('completed');
    expect(config.forgetSession).toHaveBeenCalledWith(fake);
  });

  it('re-prompts on a MessageBus delivery while idle, then ends when keepAlive flips false', async () => {
    let alive = true;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({
      onPrompt: (_t, s) => s.emit({ type: 'turn_end' }),
    });
    // `onTurnEnd` fires exactly when the runner enters its idle wait — a deterministic barrier (no timers).
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    // Wait until the runner is idle-waiting after the opening prompt, then deliver a peer message.
    await idle1;
    const idle2 = nextIdle();
    messageBus.send('peer', 'worker', 'here is some context');
    // Wait until it re-prompts and returns to idle, then stop keepAlive and nudge it to finish.
    await idle2;
    alive = false;
    messageBus.send('peer', 'worker', 'last one');
    const result = await run;

    expect(result.status).toBe('completed');
    // The opening task plus at least the first delivered message were prompted.
    expect(fake.prompts[0]).toBe('do the task');
    expect(fake.prompts.some((p) => p.includes('here is some context'))).toBe(true);
  });

  it('steers (delivers immediately) when a message arrives mid-stream', async () => {
    // The opening prompt stays in-flight (does not resolve its turn) until we end it, so the bus
    // delivery lands while `isStreaming` is true → the runner steers it immediately as a prompt.
    let endOpening: (() => void) | null = null;
    const fake = new FakeSession({
      isStreaming: true,
      // Hold the opening turn open until we end it; the steered prompt injects without ending the turn.
      onPrompt: (text, s) => {
        if (text === 'do the task') endOpening = () => s.emit({ type: 'turn_end' });
      },
    });
    const messageBus = new MessageBus('team-1');
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => false,
    });

    const run = new AgentRunner().startAgent(config);
    // Wait until the opening prompt is in-flight (1st prompt), then deliver while streaming.
    await fake.whenPrompted(1);
    // Deliver while streaming → the runner steers via prompt() immediately (does not wait for the turn).
    messageBus.send('peer', 'worker', 'steer me');
    // Wait until the steered prompt is issued (2nd prompt), then end the opening turn so the run settles.
    await fake.whenPrompted(2);
    endOpening?.();
    await run;

    expect(fake.prompts).toContain('[Message from peer]: steer me');
  });

  it('accumulates input/output/cacheWrite across turns; keeps the latest cacheRead snapshot', async () => {
    // Two turns, each emitting one assistant message with usage. Lifetime totals must SUM input/output/
    // cacheWrite, while cacheRead (a per-call cached-prefix snapshot) must NOT sum — keep the latest.
    let alive = true;
    const messageBus = new MessageBus('team-1');
    let turn = 0;
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        turn += 1;
        if (turn === 1) {
          s.cost = 0.01;
          s.emitAssistantUsage({ input: 100, output: 30, cacheRead: 500, cacheWrite: 10 });
        } else {
          s.cost = 0.03;
          s.emitAssistantUsage({ input: 200, output: 50, cacheRead: 800, cacheWrite: 20 });
          // Stop after this second turn so the loop ends without a third prompt.
          alive = false;
        }
        s.emit({ type: 'turn_end' });
      },
    });
    const usageUpdates: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }> = [];
    const costDeltas: number[] = [];
    // `onTurnEnd` fires when the runner enters its idle wait after turn 1 — deterministic barrier.
    let idleResolve: (() => void) | null = null;
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onUsageUpdate: (u) => usageUpdates.push(u),
      onCost: (d) => costDeltas.push(d),
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
    });

    const idle1 = new Promise<void>((r) => { idleResolve = r; });
    const run = new AgentRunner().startAgent(config);
    // Wait until idle after turn 1, then deliver the message that drives turn 2.
    await idle1;
    messageBus.send('peer', 'worker', 'second turn');
    const result = await run;

    // Lifetime: input 100+200, output 30+50, cacheWrite 10+20 SUMMED; cacheRead = latest (800).
    expect(result.totalInputTokens).toBe(300);
    expect(result.totalOutputTokens).toBe(80);
    expect(result.cacheCreationTokens).toBe(30);
    expect(result.cacheReadTokens).toBe(800);
    // Cost is cumulative session cost (NOT summed) — the final result carries the latest cumulative value.
    expect(result.costUsd).toBe(0.03);
    // The last live update reflects the same latest cumulative value.
    expect(usageUpdates.at(-1)).toMatchObject({ inputTokens: 300, outputTokens: 80, cacheCreationTokens: 30, cacheReadTokens: 800, costUsd: 0.03 });
    // Cost rolled into the budget as positive deltas summing to the cumulative cost.
    expect(costDeltas.reduce((a, b) => a + b, 0)).toBeCloseTo(0.03, 5);
  });

  it('wakes a parked standby agent when a system nudge is delivered deferred through a microtask', async () => {
    // Models the stranded-standby fix: TeamRunner.resolveStrandedStandbys schedules the nudge via
    // queueMicrotask FROM the settle path (onTurnEnd) so it lands AFTER the runner arms its wait-resolver.
    let alive = true;
    let firstPark = true;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => {
        if (firstPark) {
          firstPark = false;
          queueMicrotask(() => messageBus.send('system', 'worker', 'NUDGE: report complete now'));
        }
        idleResolve?.(); idleResolve = null;
      },
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;              // parked after the opening prompt; nudge scheduled + fired via microtask
    const idle2 = nextIdle();
    await idle2;              // woke, re-prompted the nudge, parked again
    alive = false;
    messageBus.send('system', 'worker', 'end');
    const result = await run;

    expect(result.status).toBe('completed');
    expect(fake.prompts.some((p) => p.includes('NUDGE: report complete now'))).toBe(true);
  });

  it('does NOT wake a parked agent when the nudge is sent synchronously from the settle path (lost wakeup)', async () => {
    // A synchronous send from inside onTurnEnd lands BEFORE the runner arms waitResolve → the wake is a
    // no-op and the message sits unflushed. This is exactly why resolveStrandedStandbys must defer.
    const ac = new AbortController();
    let sent = false;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const config = baseConfig({
      abortSignal: ac.signal,
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => true,
      onTurnEnd: () => {
        if (!sent) {
          sent = true;
          messageBus.send('system', 'worker', 'SYNC nudge');
        }
        idleResolve?.(); idleResolve = null;
      },
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;             // parked; the synchronous nudge was already delivered and lost
    expect(fake.prompts).toEqual(['do the task']);
    ac.abort();
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(fake.prompts).toEqual(['do the task']);
  });

  it('returns cancelled when the abort signal fires before start', async () => {
    const ac = new AbortController();
    ac.abort();
    const config = baseConfig({
      abortSignal: ac.signal,
      createSession: async () => new FakeSession({ onPrompt: () => {} }) as never,
    });

    const result = await new AgentRunner().startAgent(config);
    expect(result.status).toBe('cancelled');
  });
});
