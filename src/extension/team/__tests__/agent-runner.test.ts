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
  aborted = false;
  private listeners = new Set<Listener>();
  private readonly onPrompt: FakeSessionOptions['onPrompt'];
  /** Resolves the in-flight `prompt()` — mirrors real pi (prompt resolves at the turn boundary). */
  private pendingTurn: (() => void) | null = null;

  constructor(opts: FakeSessionOptions) {
    this.onPrompt = opts.onPrompt;
    this.isStreaming = opts.isStreaming ?? false;
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

  getSessionStats(): { cost: number } {
    return { cost: 0 };
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
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
    });

    const run = new AgentRunner().startAgent(config);
    // Let the opening prompt settle, then deliver a peer message while idle.
    await new Promise((r) => setTimeout(r, 5));
    messageBus.send('peer', 'worker', 'here is some context');
    await new Promise((r) => setTimeout(r, 5));
    // Now stop keeping the agent alive and nudge the wait with another (filtered-in) delivery.
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
    await new Promise((r) => setTimeout(r, 5));
    // Deliver while streaming → the runner steers via prompt() immediately (does not wait for the turn).
    messageBus.send('peer', 'worker', 'steer me');
    await new Promise((r) => setTimeout(r, 5));
    endOpening?.();
    await run;

    expect(fake.prompts).toContain('[Message from peer]: steer me');
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
