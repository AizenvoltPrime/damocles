import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../agent-runner';
import { MessageBus } from '../message-bus';
import type { AgentRunConfig, NoteSink, UndeliveredMessage } from '../types';
import type { ImageBlock } from '../../../shared/types/content';
import { wrapSteerMessage } from '../../../shared/steer';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { FakeSession } from './fake-session';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../../shared/types/session';
import { memberHistoryMessages } from '../content-blocks';
import type { PersistedAgentMessage } from '../../pi-session/agent-records';
import type { AgentTurnContext, AgentTurnDecision } from '@earendil-works/pi-agent-core';

/**
 * The pi-native team agent runner (US-024b). These tests drive a FAKE pi `AgentSession` to assert the
 * event-driven prompt/re-prompt loop: the initial task is prompted once, a MessageBus delivery while
 * idle re-prompts the agent, and the keepAlive predicate gates the idle wait (no timers).
 */

function baseConfig(overrides: Partial<AgentRunConfig>): AgentRunConfig {
  const messageBus = new MessageBus('team-1');
  return {
    agentId: 'a1',
    name: 'worker',
    role: 'specialist',
    initial: { kind: 'prompt', text: 'do the task' },
    createSession: overrides.createSession ?? (async () => { throw new Error('no session'); }),
    forgetSession: vi.fn(),
    abortSignal: new AbortController().signal,
    messageBus,
    onMessage: vi.fn<(m: ExtensionToWebviewMessage) => void>(),
    teamId: 'team-1',
    bindNoteDelivery: () => () => undefined,
    bindTakeUndelivered: () => () => undefined,
    ...overrides,
  } as AgentRunConfig;
}

/** Captures the note sink the runner publishes, plus whether its teardown has run. */
function noteSink(): { deliver: NoteSink; unbound: boolean; bind: AgentRunConfig['bindNoteDelivery'] } {
  const sink: { deliver: NoteSink; unbound: boolean; bind: AgentRunConfig['bindNoteDelivery'] } = {
    deliver: () => { throw new Error('the runner never published a note sink'); },
    unbound: false,
    bind: () => () => undefined,
  };
  sink.bind = (deliver) => {
    sink.deliver = deliver;
    return () => { sink.unbound = true; };
  };
  return sink;
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
    // A holder, not a `let`: control-flow analysis cannot see the assignment made inside `onPrompt`.
    const opening: { end: (() => void) | null } = { end: null };
    const fake = new FakeSession({
      isStreaming: true,
      // Hold the opening turn open until we end it; the steered prompt injects without ending the turn.
      onPrompt: (text, s) => {
        if (text === 'do the task') opening.end = () => s.emit({ type: 'turn_end' });
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
    if (!opening.end) throw new Error('the opening prompt never reached the fake session');
    opening.end();
    await run;

    expect(fake.prompts).toContain('[Message from peer]: steer me');
  });

  it('accumulates every usage component across turns, cacheRead included', async () => {
    // Two turns, each emitting one assistant message with usage. Every component sums, cacheRead too:
    // each request pays for its own cached-prefix re-read, so the running total is what cost reflects.
    let alive = true;
    const messageBus = new MessageBus('team-1');
    let turn = 0;
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        turn += 1;
        if (turn === 1) {
          s.emitAssistantUsage({ input: 100, output: 30, cacheRead: 500, cacheWrite: 10 }, 0.01);
        } else {
          s.emitAssistantUsage({ input: 200, output: 50, cacheRead: 800, cacheWrite: 20 }, 0.02);
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

    // Lifetime: input 100+200, output 30+50, cacheWrite 10+20, cacheRead 500+800, all summed.
    expect(result.totalInputTokens).toBe(300);
    expect(result.totalOutputTokens).toBe(80);
    expect(result.cacheCreationTokens).toBe(30);
    expect(result.cacheReadTokens).toBe(1300);
    // Cost is cumulative session cost (NOT summed) — the final result carries the latest cumulative value.
    expect(result.costUsd).toBe(0.03);
    // The last live update reflects the same latest cumulative value.
    expect(usageUpdates.at(-1)).toMatchObject({ inputTokens: 300, outputTokens: 80, cacheCreationTokens: 30, cacheReadTokens: 1300, costUsd: 0.03 });
    // Cost rolled into the budget as positive deltas summing to the cumulative cost.
    expect(costDeltas.reduce((a, b) => a + b, 0)).toBeCloseTo(0.03, 5);
  });

  it('counts compaction and cache-warm tokens, so the tokens agree with the cost', async () => {
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        s.emitAssistantUsage({ input: 100, output: 30, cacheRead: 500, cacheWrite: 10 }, 0.02);
        // pi writes the compaction entry, then emits `compaction_end`; its summary call is billed spend.
        s.tokens.input += 4000;
        s.tokens.output += 600;
        s.cost += 0.03;
        s.emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
        s.emit({ type: 'turn_end' });
      },
    });
    const usageUpdates: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }> = [];
    const costDeltas: number[] = [];
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      // A cache warm writes a `usage` entry and raises no event, so only the settle reading sees it.
      onReconcileBeforeEnd: () => { fake.tokens.cacheRead += 900; fake.cost += 0.01; },
      onUsageUpdate: (u) => usageUpdates.push(u),
      onCost: (d) => costDeltas.push(d),
    });

    const result = await new AgentRunner().startAgent(config);

    expect(usageUpdates.find((u) => u.inputTokens === 4100)).toMatchObject({ outputTokens: 630, costUsd: 0.05 });
    expect(result).toMatchObject({ totalInputTokens: 4100, totalOutputTokens: 630, cacheReadTokens: 1400, cacheCreationTokens: 10, costUsd: expect.closeTo(0.06, 10) });
    expect(usageUpdates.at(-1)).toMatchObject({ inputTokens: 4100, cacheReadTokens: 1400, costUsd: expect.closeTo(0.06, 10) });
    expect(costDeltas.reduce((a, b) => a + b, 0)).toBeCloseTo(0.06, 10);
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

  it('wakes a parked agent when the nudge is sent synchronously from the settle path', async () => {
    // The send lands before the wait is armed; the loop must see it pending rather than wait over it.
    const ac = new AbortController();
    let sent = false;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
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
      },
    });

    const run = new AgentRunner().startAgent(config);
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2));
    ac.abort();
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(fake.prompts).toEqual(['do the task', '[Message from system]: SYNC nudge']);
  });

  it('calls onReconcileBeforeEnd at the keepAlive-false boundary and ends when it leaves keepAlive false (break path: onTurnEnd never fires)', async () => {
    // Terminal-contract wiring: when keepAlive is false the runner calls onReconcileBeforeEnd BEFORE
    // breaking. If the hook does not arm a hold, the re-checked keepAlive is still false → break → the
    // agent settles WITHOUT ever entering the idle wait (onTurnEnd must not fire on the break path).
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    let reconciles = 0;
    let turnEnds = 0;
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      onReconcileBeforeEnd: () => { reconciles += 1; },
      onTurnEnd: () => { turnEnds += 1; },
    });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('completed');
    expect(reconciles).toBe(1);       // reconcile fired exactly once at the boundary
    expect(turnEnds).toBe(0);         // break path — never parked
    expect(fake.prompts).toEqual(['do the task']);
  });

  it('parks instead of ending when onReconcileBeforeEnd flips keepAlive true; a deferred nudge wakes it for another turn (park path: onTurnEnd fires)', async () => {
    // The grace-hold path: onReconcileBeforeEnd arms owedTerminalAction (models here as alive=true) so the
    // runner's re-checked keepAlive is now true → it does NOT break, it parks. The nudge is delivered
    // deferred (queueMicrotask) — landing AFTER the wait-resolver is armed — and wakes it for a grace turn.
    const ac = new AbortController();
    let alive = false;
    let reconciles = 0;
    let turnEnds = 0;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const config = baseConfig({
      abortSignal: ac.signal,
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onReconcileBeforeEnd: () => {
        reconciles += 1;
        if (reconciles === 1) {
          alive = true; // arm the grace hold → keepAlive re-check is now true → park, don't break
          queueMicrotask(() => messageBus.send('system', 'worker', 'GRACE NUDGE'));
        }
      },
      onTurnEnd: () => { turnEnds += 1; idleResolve?.(); idleResolve = null; },
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;              // reconcile armed the hold; onTurnEnd fired (park path); nudge scheduled
    const idle2 = nextIdle();
    await idle2;              // woke on the deferred nudge, re-prompted it, parked again
    ac.abort();
    await run;

    // The nudge was prompted (proves it woke for another turn) and the agent never settled as completed.
    expect(fake.prompts.some((p) => p.includes('GRACE NUDGE'))).toBe(true);
    expect(reconciles).toBe(1);   // only the first bare end reconciled; the grace turn had keepAlive true
    expect(turnEnds).toBeGreaterThanOrEqual(2); // parked after the bare end AND after the grace turn
  });

  it('prompts a SYNCHRONOUS send from onReconcileBeforeEnd instead of parking over it', async () => {
    // The send lands before the wait is armed; the loop must see it pending rather than wait over it.
    const ac = new AbortController();
    let alive = false;
    let sent = false;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const config = baseConfig({
      abortSignal: ac.signal,
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onReconcileBeforeEnd: () => {
        if (!sent) {
          sent = true;
          alive = true;
          messageBus.send('system', 'worker', 'SYNC nudge');
        }
      },
    });

    const run = new AgentRunner().startAgent(config);
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(2));
    ac.abort();
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(fake.prompts).toEqual(['do the task', '[Message from system]: SYNC nudge']);
  });

  it('reclaims a message pi still holds when the turn ends, instead of ending with it undelivered', async () => {
    // pi runs finishTurn before it drains the queue, so a message steered in that window is
    // still held when the loop comes back around. The bus subscriber already echoed it to the overlay.
    const messages: ExtensionToWebviewMessage[] = [];
    const fake = new FakeSession({
      // Only the opening turn is held for the test; a re-prompt ends on its own so the run can settle.
      onPrompt: (_t, s) => { if (s.prompts.length > 1) s.emit({ type: 'turn_end' }); },
    });
    const run = new AgentRunner().startAgent(baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
    }));

    await fake.whenPrompted(1);
    fake.holdSteeredMessage('[Message from Lead]: revise section 3');
    fake.emit({ type: 'turn_end' });
    await run;

    expect(fake.prompts).toEqual(['do the task', '[Message from Lead]: revise section 3']);
    expect(fake.pendingMessageCount).toBe(0);
    const echoed = messages.filter((m) => m.type === 'teamAgentUserMessage').map((m) => m.content);
    expect(echoed).toEqual(['do the task']);
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

/**
 * A user-authored note reaches a team agent through the sink the runner publishes, not through the
 * MessageBus. The bus drops such a note silently in two ways the caller cannot see: the run's
 * `unsubscribeBus()` may already have fired, and the subscriber's `msg.from === config.name` filter
 * discards it outright for an agent the model named `user`. The sink answers the caller instead.
 */
describe('AgentRunner user note delivery', () => {
  it('echoes an idle note exactly once and prompts it verbatim', async () => {
    let alive = true;
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const messages: ExtensionToWebviewMessage[] = [];
    const sink = noteSink();
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      bindNoteDelivery: sink.bind,
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;

    expect(sink.deliver('[cancel] the shell command was stopped')).toBe(true);
    await fake.whenPrompted(2);
    alive = false;
    await run;

    // Prompted verbatim: a note is the user speaking, so it carries no `[Message from X]` peer prefix.
    expect(fake.prompts[1]).toBe('[cancel] the shell command was stopped');
    const echoes = messages.filter((m) => m.type === 'teamAgentUserMessage' && m.content === '[cancel] the shell command was stopped');
    expect(echoes).toHaveLength(1);
  });

  it('steers a note that arrives mid-stream, still echoing it once', async () => {
    const opening: { end: (() => void) | null } = { end: null };
    const fake = new FakeSession({
      isStreaming: true,
      onPrompt: (text, s) => {
        if (text === 'do the task') opening.end = () => s.emit({ type: 'turn_end' });
      },
    });
    const messages: ExtensionToWebviewMessage[] = [];
    const sink = noteSink();
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      bindNoteDelivery: sink.bind,
    });

    const run = new AgentRunner().startAgent(config);
    await fake.whenPrompted(1);
    expect(sink.deliver('stopped by the user')).toBe(true);
    await fake.whenPrompted(2);
    if (!opening.end) throw new Error('the opening prompt never reached the fake session');
    opening.end();
    await run;

    expect(fake.prompts[1]).toBe('stopped by the user');
    expect(messages.filter((m) => m.type === 'teamAgentUserMessage' && m.content === 'stopped by the user')).toHaveLength(1);
  });

  it('prompts a note beginning with a slash as literal text, never as a command', async () => {
    // pi's `prompt` defaults `expandPromptTemplates` to true, dispatches a leading-slash string as an
    // extension command and returns without prompting the agent at all. The note is the one queued
    // string with no `[Message from X]:` prefix, so it is the only one that can begin with `/`, and the
    // echo has already been written by the time the prompt is issued.
    let alive = true;
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const sink = noteSink();
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
      bindNoteDelivery: sink.bind,
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;
    expect(sink.deliver('/compact and stop')).toBe(true);
    await fake.whenPrompted(2);
    alive = false;
    await run;

    expect(fake.prompts[1]).toBe('/compact and stop');
    expect(fake.promptOptions[1]?.expandPromptTemplates).toBe(false);
  });

  it('keeps the guard on the steered path, where a note is injected mid-turn', async () => {
    const opening: { end: (() => void) | null } = { end: null };
    const fake = new FakeSession({
      isStreaming: true,
      onPrompt: (text, s) => {
        if (text === 'do the task') opening.end = () => s.emit({ type: 'turn_end' });
      },
    });
    const sink = noteSink();
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      bindNoteDelivery: sink.bind,
    });

    const run = new AgentRunner().startAgent(config);
    await fake.whenPrompted(1);
    expect(sink.deliver('/help me')).toBe(true);
    await fake.whenPrompted(2);
    if (!opening.end) throw new Error('the opening prompt never reached the fake session');
    opening.end();
    await run;

    expect(fake.prompts[1]).toBe('/help me');
    expect(fake.promptOptions[1]).toEqual({ streamingBehavior: 'steer', expandPromptTemplates: false });
  });

  it('tears the sink down when the run ends normally, not only when it is aborted', async () => {
    // The ordinary exit is the wait loop finding nothing left to wait for, which is the route a late
    // note actually takes; the abort exit below is the other one. Both leave through the same `finally`.
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const sink = noteSink();
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      bindNoteDelivery: sink.bind,
    });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('completed');
    expect(sink.unbound).toBe(true);
  });

  it('tears the sink down with the bus subscription and refuses a note after the abort', async () => {
    const ac = new AbortController();
    let idleResolve: (() => void) | null = null;
    const nextIdle = (): Promise<void> => new Promise((r) => { idleResolve = r; });
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const messages: ExtensionToWebviewMessage[] = [];
    const sink = noteSink();
    const config = baseConfig({
      abortSignal: ac.signal,
      createSession: async () => fake as never,
      keepAlive: () => true,
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      bindNoteDelivery: sink.bind,
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;
    expect(sink.unbound).toBe(false);
    ac.abort();
    await run;

    expect(sink.unbound).toBe(true);
    const before = messages.length;
    expect(sink.deliver('too late')).toBe(false);
    expect(fake.prompts).toEqual(['do the task']);
    expect(messages).toHaveLength(before);
  });
});

/**
 * The team runner is the only producer that used to hand the webview pi's raw tool names and raw
 * argument keys. `ToolCallCard` keys its icon and its IN line off the Damocles names, so the mapping
 * has to happen here. Both live destinations are asserted: the `teamAgentToolCall` message and the
 * `teamAgentAssistant` block.
 */

interface PiToolCallBlock { id: string; name: string; arguments: Record<string, unknown> }

/** Runs one turn whose single assistant message carries the given pi `toolCall` blocks. */
async function runWithToolCalls(blocks: PiToolCallBlock[]): Promise<{ messages: ExtensionToWebviewMessage[] }> {
  const messages: ExtensionToWebviewMessage[] = [];
  const fake = new FakeSession({
    onPrompt: (_t, s) => {
      s.emit({ type: 'message_end', message: { role: 'assistant', content: blocks.map((b) => ({ type: 'toolCall', ...b })) } });
      for (const b of blocks) s.emit({ type: 'tool_execution_start', toolCallId: b.id, toolName: b.name, args: b.arguments });
      s.emit({ type: 'turn_end' });
    },
  });
  const config = baseConfig({
    createSession: async () => fake as never,
    keepAlive: () => false,
    onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
  });

  await new AgentRunner().startAgent(config);
  return { messages };
}

function toolCallMessages(messages: ExtensionToWebviewMessage[]): Array<{ toolName: string; toolInput: Record<string, unknown> }> {
  return messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolCall' }> => m.type === 'teamAgentToolCall');
}

/** The live assistant `tool_use` block for an id, from the message the store consumes. */
function assistantToolUse(messages: ExtensionToWebviewMessage[], id: string): { name: string; input: Record<string, unknown> } {
  for (const m of messages) {
    if (m.type !== 'teamAgentAssistant') continue;
    for (const block of m.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
      if (block.type === 'tool_use' && block.id === id) {
        return { name: block.name ?? '', input: (block.input ?? {}) as Record<string, unknown> };
      }
    }
  }
  throw new Error(`expected a live tool_use block '${id}', found none`);
}

describe('AgentRunner tool normalization', () => {
  it('maps a pi bash call to Bash in the message and the live block', async () => {
    const { messages } = await runWithToolCalls([{ id: 'tc-1', name: 'bash', arguments: { command: 'ls -la' } }]);

    expect(toolCallMessages(messages)).toEqual([
      expect.objectContaining({ toolName: 'Bash', toolInput: { command: 'ls -la' } }),
    ]);
    expect(assistantToolUse(messages, 'tc-1').name).toBe('Bash');
  });

  it('rewrites read.path to file_path in the message and the live block', async () => {
    const { messages } = await runWithToolCalls([{ id: 'tc-2', name: 'read', arguments: { path: 'c:/x.ts', limit: 20 } }]);

    const sent = toolCallMessages(messages)[0];
    expect(sent?.toolName).toBe('Read');
    expect(sent?.toolInput).toEqual({ file_path: 'c:/x.ts', limit: 20 });
    expect(sent?.toolInput).not.toHaveProperty('path');

    const live = assistantToolUse(messages, 'tc-2');
    expect(live.name).toBe('Read');
    expect(live.input).toEqual({ file_path: 'c:/x.ts', limit: 20 });
  });

  it('maps find to Glob and grep.ignoreCase to -i', async () => {
    const { messages } = await runWithToolCalls([
      { id: 'tc-3', name: 'find', arguments: { pattern: '**/*.ts' } },
      { id: 'tc-4', name: 'grep', arguments: { pattern: 'todo', ignoreCase: true } },
    ]);

    expect(toolCallMessages(messages).map((m) => m.toolName)).toEqual(['Glob', 'Grep']);
    expect(assistantToolUse(messages, 'tc-3').name).toBe('Glob');
    const grep = assistantToolUse(messages, 'tc-4');
    expect(grep.input).toEqual({ pattern: 'todo', '-i': true });
    expect(grep.input).not.toHaveProperty('ignoreCase');
  });

  it('passes an unmapped tool name and its arguments through untouched', async () => {
    // Custom and MCP tools are already Damocles-shaped, so the mapping must be identity for them.
    const { messages } = await runWithToolCalls([
      { id: 'tc-5', name: 'mcp__pi__team_send_message', arguments: { to: 'lead', content: 'done' } },
    ]);

    expect(toolCallMessages(messages)[0]?.toolName).toBe('mcp__pi__team_send_message');
    expect(assistantToolUse(messages, 'tc-5').input).toEqual({ to: 'lead', content: 'done' });
  });
});

describe('AgentRunner tool count', () => {
  const read = (id: string) => ({ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}.ts` } });
  const started = (id: string) => ({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: `/${id}.ts` } });
  const ended = (id: string, text: string, isError: boolean) => ({
    type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text }], details: {} }, isError,
  });

  // pi emits `tool_execution_start` (agent-loop.js:379, :415) before `beforeToolCall`, where the gate blocks a call (:493).
  it('counts each call as pi starts it, a blocked call included', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const counts: Array<[string, number]> = [];
    let countedAtSeal = -1;
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [read('tc-ok'), read('tc-blocked')], stopReason: 'toolUse' } });
        countedAtSeal = counts.length;
        s.emit(started('tc-ok'));
        s.emit(ended('tc-ok', 'contents', false));
        s.emit(started('tc-blocked'));
        s.emit(ended('tc-blocked', 'Blocked by policy', true));
        s.emit({ type: 'turn_end' });
      },
    });
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      onToolCall: (name, count) => { counts.push([name, count]); },
    });

    const result = await new AgentRunner().startAgent(config);

    expect(countedAtSeal).toBe(0);
    expect(counts).toEqual([['Read', 1], ['Read', 2]]);
    expect(result.toolCallCount).toBe(2);
    expect(toolCallMessages(messages)).toEqual([
      expect.objectContaining({ toolName: 'Read', toolInput: { file_path: '/tc-ok.ts' } }),
      expect.objectContaining({ toolName: 'Read', toolInput: { file_path: '/tc-blocked.ts' } }),
    ]);
  });

  // pi starts no call after the one an abort lands in (agent-loop.js:402-404, :429-431, :449-451).
  it('counts no call a batch cut short by an abort skipped', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onToolCall = vi.fn();
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [read('tc-ran'), read('tc-skipped')], stopReason: 'toolUse' } });
        s.emit(started('tc-ran'));
        s.emit(ended('tc-ran', 'Operation aborted', true));
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } });
        s.emit({ type: 'agent_settled', aborted: true });
      },
    });
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      onToolCall,
    });

    const result = await new AgentRunner().startAgent(config);

    expect(onToolCall.mock.calls).toEqual([['Read', 1]]);
    expect(result.toolCallCount).toBe(1);
    expect(toolCallMessages(messages).map((m) => m.toolInput)).toEqual([{ file_path: '/tc-ran.ts' }]);
  });
});

/**
 * Live shell output for team agents. The runner pushes `tool_execution_update` frames through the same
 * 250ms keep-latest coalescer the session and subagent paths use, so the first frame for a call is a
 * leading edge and lands synchronously.
 */

type ProgressMessage = Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolProgress' }>;

/**
 * A pi partial tool result, shaped exactly as `pi/packages/coding-agent/src/core/tools/bash.ts:353`
 * emits it: `details` is always present and `truncation` is set to `undefined`, not omitted, when the
 * output is not truncated. Never change this to omit `details` without re-reading that emitter.
 */
function partialResult(text: string, truncated?: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    details: { truncation: truncated === true ? { truncated: true } : undefined },
  };
}

async function runEmitting(emitEvents: (s: FakeSession) => void): Promise<ExtensionToWebviewMessage[]> {
  const messages: ExtensionToWebviewMessage[] = [];
  const fake = new FakeSession({
    onPrompt: (_t, s) => {
      emitEvents(s);
      s.emit({ type: 'turn_end' });
    },
  });
  const config = baseConfig({
    createSession: async () => fake as never,
    keepAlive: () => false,
    onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
  });

  await new AgentRunner().startAgent(config);
  return messages;
}

function progressMessages(messages: ExtensionToWebviewMessage[]): ProgressMessage[] {
  return messages.filter((m): m is ProgressMessage => m.type === 'teamAgentToolProgress');
}

describe('AgentRunner live tool output', () => {
  it('emits a progress frame for a shell call, keyed by tool call id', async () => {
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: partialResult('compiling...') });
    });

    expect(progressMessages(messages)).toEqual([
      expect.objectContaining({ agentId: 'a1', toolUseId: 'tc-1', output: 'compiling...', outputTruncated: false }),
    ]);
  });

  it('carries the truncated flag when pi reports the accumulator dropped output', async () => {
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: partialResult('tail of a long log', true) });
    });

    expect(progressMessages(messages)[0]?.outputTruncated).toBe(true);
  });

  it('emits the empty first frame instead of swallowing it', async () => {
    // The waiting-for-output state is exactly this frame, so a truthiness guard here would delete it.
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: partialResult('') });
    });

    const progress = progressMessages(messages);
    expect(progress).toHaveLength(1);
    expect(progress[0]?.output).toBe('');
  });

  it('reports untruncated when a partial carries no details at all', async () => {
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'output' }] } });
    });

    expect(progressMessages(messages)[0]?.outputTruncated).toBe(false);
  });

  it('emits nothing for a tool with no live output', async () => {
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_update', toolCallId: 'tc-2', toolName: 'read', args: {}, partialResult: partialResult('half a file') });
    });

    expect(progressMessages(messages)).toEqual([]);
  });

  it('drops a coalesced frame that is still pending when the call ends', async () => {
    // A late partial landing after the result would resurrect stale output into a finished card.
    vi.useFakeTimers();
    try {
      const messages = await runEmitting((s) => {
        s.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: partialResult('first') });
        s.emit({ type: 'tool_execution_update', toolCallId: 'tc-1', toolName: 'bash', args: {}, partialResult: partialResult('second') });
        s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: partialResult('final'), isError: false });
        vi.advanceTimersByTime(1000);
      });

      expect(progressMessages(messages).map((m) => m.output)).toEqual(['first']);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The team path has no `toolMetadata` message, so a tool result's `details` reaches the card on
 * `teamAgentToolResult` or never. The cancelled marker rides on `details`, which is why this matters.
 */
describe('AgentRunner tool result metadata', () => {
  function resultMessages(messages: ExtensionToWebviewMessage[]): Array<Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolResult' }>> {
    return messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolResult' }> => m.type === 'teamAgentToolResult');
  }

  it('carries the result details through to the card, normalized the same way the other producers do', async () => {
    const messages = await runEmitting((s) => {
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'partial' }], details: { [CANCELLED_TOOL_DETAIL_KEY]: true, fullOutputPath: '/tmp/full.log' } },
        isError: false,
      });
    });

    const results = resultMessages(messages);
    expect(results).toHaveLength(1);
    expect(results[0]?.metadata).toEqual({ [CANCELLED_TOOL_DETAIL_KEY]: true, fullOutputPath: '/tmp/full.log' });
  });

  it('applies the shared normalizer rather than passing details through raw', async () => {
    const messages = await runEmitting((s) => {
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'edit',
        result: { content: [{ type: 'text', text: 'edited' }], details: { firstChangedLine: 42 } },
        isError: false,
      });
    });

    expect(resultMessages(messages)[0]?.metadata).toEqual({ firstChangedLine: 42, editLineNumber: 42 });
  });

  it('omits metadata entirely when the result carried no details', async () => {
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false });
    });

    const results = resultMessages(messages);
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty('metadata');
  });
});

describe('AgentRunner tool result images', () => {
  const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

  it('sends only the image count of a successful result, and nothing for a text-only or failed one', async () => {
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_end', toolCallId: 'img', toolName: 'browser_screenshot', result: { content: [{ type: 'text', text: 'shot' }, png] }, isError: false });
      s.emit({ type: 'tool_execution_end', toolCallId: 'text', toolName: 'read', result: { content: [{ type: 'text', text: 'a' }] }, isError: false });
      s.emit({ type: 'tool_execution_end', toolCallId: 'fail', toolName: 'read', result: { content: [png] }, isError: true });
    });

    const results = messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolResult' }> => m.type === 'teamAgentToolResult');
    expect(results.find((m) => m.toolUseId === 'img')).toMatchObject({ result: 'shot', imageCount: 1 });
    expect(results.find((m) => m.toolUseId === 'text')).not.toHaveProperty('imageCount');
    expect(results.find((m) => m.toolUseId === 'fail')).not.toHaveProperty('imageCount');
    expect(JSON.stringify(messages)).not.toContain('AAAA');
  });

  it('gives a reopened member the same count the live card had', () => {
    const message = { role: 'toolResult', toolCallId: 'img', toolName: 'browser_screenshot', content: [{ type: 'text', text: 'shot' }, png], isError: false } as unknown as PersistedAgentMessage;
    const [history] = memberHistoryMessages([message], new Map([[message, 'e1']]));

    expect(history?.content).toEqual([{ type: 'tool_result', tool_use_id: 'img', content: 'shot', is_error: false, imageCount: 1 }]);
  });
});

describe('AgentRunner tool result text', () => {
  it('keeps a bare-string result instead of blanking the card', async () => {
    // A custom tool or an MCP shim can answer with a plain string rather than a content array.
    const messages = await runEmitting((s) => {
      s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: 'plain string result' } as never);
    });

    const card = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolResult' }> => m.type === 'teamAgentToolResult');
    expect(card?.result).toBe('plain string result');
  });
});

/**
 * `team_standby` and `team_report_complete` both promise the agent stops here, but each only records
 * state and hands control back to the model, which keeps working unless the engine ends the turn. The
 * runner installs a `finishTurn` decider so it does. These tests drive the hook the runner installed
 * on the session's `agent`, which is the object pi consults after each turn.
 */

/** Answers the decider chain the way pi's loop reads it: `{ action: 'end' }` is the only stop. */
type StopHook = (turn: AgentTurnContext) => Promise<boolean>;

/** A session whose turns end only when the test says so, so a run can be held open mid-flight. */
function heldSession(): FakeSession {
  return new FakeSession({ onPrompt: () => undefined });
}

/**
 * Drives the stop hook while the agent's run is still in flight, the only state pi ever consults it in.
 * The opening prompt is held open for the body, then released so the run settles.
 */
async function withStopHook(body: (hook: StopHook, fake: FakeSession) => Promise<void>, session?: FakeSession): Promise<void> {
  const fake = session ?? heldSession();
  const run = new AgentRunner().startAgent(baseConfig({
    createSession: async () => fake as never,
    keepAlive: () => false,
  }));
  await fake.whenPrompted(1);
  const finishTurn = fake.agent.finishTurn;
  if (!finishTurn) throw new Error('the runner installed no finishTurn decider');
  const hook: StopHook = async (turn) => {
    const decision = (await finishTurn(turn)) as AgentTurnDecision | undefined;
    return decision?.action === 'end';
  };
  await body(hook, fake);
  // pi drains its queue once the turn ends, so leave nothing held that would re-prompt this session.
  fake.clearQueue();
  fake.emit({ type: 'turn_end' });
  await run;
}

/**
 * A completed assistant message carrying one tool call per name, each paired with the successful result
 * pi builds for it (`createToolResultMessage`, `agent-loop.js:656-670` in pi 1.1.0, keys the result to the call id and carries `isError`).
 */
function turnWith(...names: string[]): AgentTurnContext {
  return {
    message: { role: 'assistant', content: names.map((name, i) => ({ type: 'toolCall', id: `tc-${i}`, name, arguments: {} })) },
    toolResults: names.map((name, i) => ({ role: 'toolResult', toolCallId: `tc-${i}`, toolName: name, content: [], isError: false })),
    context: {},
    newMessages: [],
  } as unknown as AgentTurnContext;
}

describe('AgentRunner terminal-tool turn stop', () => {
  it('stops the turn when the completed assistant message contains a team_standby call', async () => {
    await withStopHook(async (hook) => {
      expect(await hook(turnWith('team_write_scratchpad', 'team_standby'))).toBe(true);
    });
  });

  it('does not stop the turn while the session has a queued message', async () => {
    // pi drains its steering queue only after this check, so stopping here would park the agent with
    // the message stranded in the queue.
    await withStopHook(async (hook, fake) => {
      fake.holdSteeredMessage('[Message from Lead]: one more thing');
      expect(await hook(turnWith('team_standby'))).toBe(false);
    });
  });

  it('does not stop the turn for a queued message the session mirror cannot see', async () => {
    // `sendCustomMessage` enqueues straight onto the agent, so `pendingMessageCount` reads 0 while pi
    // still holds the message. Reading the agent's queue is what keeps the guard honest.
    await withStopHook(async (hook, fake) => {
      fake.holdCustomMessage('[Background results]');
      expect(fake.pendingMessageCount).toBe(0);
      expect(await hook(turnWith('team_standby'))).toBe(false);
    });
  });

  it('does not stop a turn whose assistant message has no team_standby call', async () => {
    await withStopHook(async (hook) => {
      expect(await hook(turnWith('read', 'team_read_scratchpad'))).toBe(false);
    });
  });

  it('stops the turn on team_report_complete too', async () => {
    // The summary parameter carries the sign-off, so closing text after the call is a full-context
    // charge for something the team already has.
    await withStopHook(async (hook) => {
      expect(await hook(turnWith('team_write_scratchpad', 'team_report_complete'))).toBe(true);
    });
  });

  it('does not stop the turn on team_report_complete while the session has a queued message', async () => {
    await withStopHook(async (hook, fake) => {
      fake.holdSteeredMessage('[Message from Lead]: one more thing');
      expect(await hook(turnWith('team_report_complete'))).toBe(false);
    });
  });

  it('does not stop the turn when the team_report_complete call was rejected', async () => {
    // reportComplete throws for a lead, a non-running specialist and at the review-round ceiling. The
    // turn the agent gets that error in is the turn it reacts in.
    await withStopHook(async (hook) => {
      const threw = turnWith('team_report_complete');
      (threw.toolResults[0] as { isError: boolean }).isError = true;
      expect(await hook(threw)).toBe(false);

      const noResult = turnWith('team_report_complete');
      noResult.toolResults.length = 0;
      expect(await hook(noResult)).toBe(false);
    });
  });

  it('does not stop the turn when the team_standby call did not park the agent', async () => {
    // `enterStandby` throws for a lead and for a specialist whose status is not running
    // (`team-runner.ts:1270-1279`). The turn the agent gets that error in is the turn it reacts in, so
    // the engine must not take it away. A missing result is the same case: nothing parked.
    await withStopHook(async (hook) => {
      const threw = turnWith('team_standby');
      (threw.toolResults[0] as { isError: boolean }).isError = true;
      expect(await hook(threw)).toBe(false);

      const noResult = turnWith('team_standby');
      noResult.toolResults.length = 0;
      expect(await hook(noResult)).toBe(false);
    });
  });

  it('defers to a hook the session already carried instead of replacing it', async () => {
    const fake = heldSession();
    let priorCalls = 0;
    let priorStops = false;
    fake.agent.finishTurn = (): AgentTurnDecision | undefined => {
      priorCalls++;
      return priorStops ? { action: 'end' } : undefined;
    };

    await withStopHook(async (hook) => {
      expect(await hook(turnWith('read'))).toBe(false);
      expect(priorCalls).toBe(1);
      priorStops = true;
      expect(await hook(turnWith('read'))).toBe(true);
    }, fake);
  });
});

/**
 * Where `AgentResult.finalResponse` comes from. The turn-ending hook means a specialist produces no
 * closing assistant message any more, so the sign-off it passed to `team_report_complete` is the only
 * account of its run that reaches the team card and the `agent-completed` persistence entry.
 */
describe('AgentRunner finalResponse', () => {
  /** A session whose turn emits one assistant text block, so `onAssistantText` has something to take. */
  function sessionEmittingText(text: string): FakeSession {
    return new FakeSession({
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        s.emit({ type: 'turn_end' });
      },
    });
  }

  it('takes the reported summary over trailing assistant text', async () => {
    const fake = sessionEmittingText('thinking out loud on the way to the tool call');

    const result = await new AgentRunner().startAgent(baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      getReportedSummary: () => 'delivered the parser, all suites pass, nothing open',
    }));

    expect(result.finalResponse).toBe('delivered the parser, all suites pass, nothing open');
  });

  it('takes the reported summary over the session fallback when no assistant text was seen', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    fake.getLastAssistantText = (): string => 'stale text from the session';

    const result = await new AgentRunner().startAgent(baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      getReportedSummary: () => 'the sign-off',
    }));

    expect(result.finalResponse).toBe('the sign-off');
  });

  it('falls back to assistant text when the agent never reported a summary', async () => {
    const fake = sessionEmittingText('here is what I found');

    const result = await new AgentRunner().startAgent(baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      getReportedSummary: () => null,
    }));

    expect(result.finalResponse).toBe('here is what I found');
  });
});

/** Captures the undelivered-message taker the runner publishes, plus whether its teardown has run. */
function undeliveredTaker(): { take: () => UndeliveredMessage[]; unbound: boolean; bind: AgentRunConfig['bindTakeUndelivered'] } {
  const sink: { take: () => UndeliveredMessage[]; unbound: boolean; bind: AgentRunConfig['bindTakeUndelivered'] } = {
    take: () => { throw new Error('the runner never published an undelivered-message taker'); },
    unbound: false,
    bind: () => () => undefined,
  };
  sink.bind = (take) => {
    sink.take = take;
    return () => { sink.unbound = true; };
  };
  return sink;
}

function statusesOf(config: AgentRunConfig): string[] {
  return vi.mocked(config.onMessage).mock.calls
    .map(([m]) => m)
    .flatMap((m) => (m.type === 'teamAgentStatusUpdate' ? [m.status] : []));
}

describe('AgentRunner park mode', () => {
  it('opens the session, prompts nothing, emits no running status, and waits', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const abort = new AbortController();
    const turnEnds: string[] = [];
    let bound: (() => void) | null = null;
    const live = new Promise<void>((r) => { bound = r; });
    const config = baseConfig({
      initial: { kind: 'park' },
      createSession: async () => fake as never,
      abortSignal: abort.signal,
      keepAlive: () => true,
      bindNoteDelivery: () => { bound?.(); return () => undefined; },
      onTurnEnd: () => turnEnds.push('turn-end'),
    });

    const run = new AgentRunner().startAgent(config);
    await live;
    abort.abort();
    const result = await run;

    // Asserted after the run settled, so no later prompt can still be on its way.
    expect(result.status).toBe('cancelled');
    expect(fake.prompts).toEqual([]);
    expect(statusesOf(config)).not.toContain('running');
    expect(vi.mocked(config.onMessage).mock.calls.filter(([m]) => m.type === 'teamAgentUserMessage')).toEqual([]);
    expect(turnEnds).toEqual([]);
    expect(config.forgetSession).toHaveBeenCalledWith(fake);
  });

  it('a parked member wakes on a bus message and is prompted with it', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const messageBus = new MessageBus('team-1');
    let alive = true;
    let bound: (() => void) | null = null;
    const live = new Promise<void>((r) => { bound = r; });
    const config = baseConfig({
      initial: { kind: 'park' },
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      bindNoteDelivery: () => { bound?.(); return () => undefined; },
    });

    const run = new AgentRunner().startAgent(config);
    await live;
    alive = false;
    messageBus.send('Lead', 'worker', 'revise section 2');
    const result = await run;

    expect(fake.prompts).toEqual(['[Message from Lead]: revise section 2']);
    expect(result.status).toBe('completed');
  });

  it('a parked member whose keepAlive holds reports the wake through onKeepAliveResume', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const messageBus = new MessageBus('team-1');
    const abort = new AbortController();
    const resumed: string[] = [];
    let parkAgain: (() => void) | null = null;
    const parkedAgain = new Promise<void>((r) => { parkAgain = r; });
    let bound: (() => void) | null = null;
    const live = new Promise<void>((r) => { bound = r; });
    const config = baseConfig({
      initial: { kind: 'park' },
      messageBus,
      abortSignal: abort.signal,
      createSession: async () => fake as never,
      keepAlive: () => true,
      bindNoteDelivery: () => { bound?.(); return () => undefined; },
      onTurnEnd: () => parkAgain?.(),
      onKeepAliveResume: () => resumed.push('resume'),
    });

    const run = new AgentRunner().startAgent(config);
    await live;
    messageBus.send('Lead', 'worker', 'approved? not yet, one fix');
    await parkedAgain;

    expect(resumed).toEqual(['resume']);
    expect(fake.prompts).toEqual(['[Message from Lead]: approved? not yet, one fix']);
    abort.abort();
    await run;
  });

  it('a message sent while the session is still opening is queued and prompted, not lost', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const messageBus = new MessageBus('team-1');
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    let requested: (() => void) | null = null;
    const sessionRequested = new Promise<void>((r) => { requested = r; });
    const config = baseConfig({
      initial: { kind: 'park' },
      messageBus,
      createSession: async () => { requested?.(); await opened; return fake as never; },
      keepAlive: () => false,
    });

    const run = new AgentRunner().startAgent(config);
    await sessionRequested;
    messageBus.send('Lead', 'worker', 'sent during open');
    open();
    await run;

    expect(fake.prompts).toEqual(['[Message from Lead]: sent during open']);
  });

  it.each([
    ['a message sent during the reopen', 'bus'],
    ['a redelivered message', 'redeliver'],
  ] as const)('a parked member woken by %s is resumed before its first prompt', async (_label, source) => {
    const events: string[] = [];
    const fake = new FakeSession({ onPrompt: (t, s) => { events.push(`prompt:${t}`); s.emit({ type: 'turn_end' }); } });
    const messageBus = new MessageBus('team-1');
    const abort = new AbortController();
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    let requested: (() => void) | null = null;
    const sessionRequested = new Promise<void>((r) => { requested = r; });
    let parked: (() => void) | null = null;
    const parkedAfterTurn = new Promise<void>((r) => { parked = r; });
    const config = baseConfig({
      initial: { kind: 'park' },
      messageBus,
      abortSignal: abort.signal,
      ...(source === 'redeliver' ? { redeliver: [{ text: '[Message from Lead]: early', echoed: true }] } : {}),
      createSession: async () => { requested?.(); await opened; return fake as never; },
      keepAlive: () => true,
      onKeepAliveResume: () => events.push('resume'),
      onTurnEnd: () => { if (events.some((e) => e.startsWith('prompt:'))) parked?.(); },
    });

    const run = new AgentRunner().startAgent(config);
    await sessionRequested;
    if (source === 'bus') messageBus.send('Lead', 'worker', 'early');
    open();
    await parkedAfterTurn;

    // The status hook runs first, so a terminal tool called in that turn sees a running member.
    expect(events).toEqual(['resume', 'prompt:[Message from Lead]: early']);
    abort.abort();
    await run;
  });
});

describe('AgentRunner redelivery and undelivered messages', () => {
  it('prompts messages carried over from an earlier run before the member settles', async () => {
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const config = baseConfig({
      initial: { kind: 'prompt', text: 'continue' },
      redeliver: [{ text: '[Message from Lead]: carried over', echoed: true }],
      createSession: async () => fake as never,
      keepAlive: () => false,
    });

    await new AgentRunner().startAgent(config);

    expect(fake.prompts.join('\n')).toContain('[Message from Lead]: carried over');
    expect(fake.prompts[0]).toContain('continue');
  });

  it('undelivered() returns runner-local pending messages plus the pi steering and follow-up queues', async () => {
    const opening: { end: (() => void) | null } = { end: null };
    const fake = new FakeSession({
      onPrompt: (text, s) => { if (text === 'do the task') opening.end = () => s.emit({ type: 'turn_end' }); },
    });
    const messageBus = new MessageBus('team-1');
    const taker = undeliveredTaker();
    const abort = new AbortController();
    const config = baseConfig({
      messageBus,
      abortSignal: abort.signal,
      createSession: async () => fake as never,
      keepAlive: () => true,
      bindTakeUndelivered: taker.bind,
    });

    const run = new AgentRunner().startAgent(config);
    await fake.whenPrompted(1);
    // Not streaming and mid-turn, so the runner holds the message locally until the turn ends.
    messageBus.send('Lead', 'worker', 'held by the runner');
    fake.holdSteeredMessage('held by pi as a steer');
    fake.holdFollowUpMessage('held by pi as a follow-up');

    expect(taker.take()).toEqual([
      { text: 'held by pi as a steer', echoed: true },
      { text: 'held by pi as a follow-up', echoed: true },
      { text: '[Message from Lead]: held by the runner', echoed: false },
    ]);

    abort.abort();
    await run;
    expect(taker.unbound).toBe(true);
  });
});

describe('AgentRunner cost baseline', () => {
  it('reports only spend after the session opened, in costUsd, tokens, usage updates and the budget deltas', async () => {
    let alive = true;
    const messageBus = new MessageBus('team-1');
    let turn = 0;
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        turn += 1;
        s.emitAssistantUsage({ input: 10, output: 5, cacheRead: 200, cacheWrite: 3 }, 0.25);
        if (turn === 2) alive = false;
        s.emit({ type: 'turn_end' });
      },
    });
    // A reopened session reports its whole history's spend, which the earlier run already charged.
    fake.seedOpening({ cost: 1, tokens: { input: 700, output: 90, cacheRead: 40_000, cacheWrite: 600 } });
    const usageUpdates: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }> = [];
    const costDeltas: number[] = [];
    let idleResolve: (() => void) | null = null;
    const idle1 = new Promise<void>((r) => { idleResolve = r; });
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onUsageUpdate: (u) => usageUpdates.push(u),
      onCost: (d) => costDeltas.push(d),
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
    });

    const run = new AgentRunner().startAgent(config);
    await idle1;
    messageBus.send('peer', 'worker', 'second turn');
    const result = await run;

    expect(result).toMatchObject({ totalInputTokens: 20, totalOutputTokens: 10, cacheReadTokens: 400, cacheCreationTokens: 6, costUsd: expect.closeTo(0.5, 10) });
    expect(usageUpdates).toEqual([
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 200, cacheCreationTokens: 3, costUsd: expect.closeTo(0.25, 10) },
      { inputTokens: 20, outputTokens: 10, cacheReadTokens: 400, cacheCreationTokens: 6, costUsd: expect.closeTo(0.5, 10) },
    ]);
    expect(costDeltas.map((c) => Number(c.toFixed(10)))).toEqual([0.25, 0.25]);
  });
});

describe('AgentRunner image steers', () => {
  const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const piImage = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const steer = wrapSteerMessage('use this layout');

  /** A streaming member whose opening turn is held; the prompt after it ends its own turn. */
  function streamingMember(config: Partial<AgentRunConfig> = {}): {
    fake: FakeSession; sink: ReturnType<typeof noteSink>; taker: ReturnType<typeof undeliveredTaker>;
    messages: ExtensionToWebviewMessage[]; abort: AbortController; endOpening: () => void; run: Promise<unknown>;
  } {
    const opening: { end: (() => void) | null } = { end: null };
    const fake = new FakeSession({
      isStreaming: true,
      onPrompt: (text, s) => {
        if (text === 'do the task') opening.end = () => s.emit({ type: 'turn_end' });
        else if (s.promptOptions.at(-1)?.streamingBehavior !== 'steer') s.emit({ type: 'turn_end' });
      },
    });
    const sink = noteSink();
    const taker = undeliveredTaker();
    const messages: ExtensionToWebviewMessage[] = [];
    const abort = new AbortController();
    const run = new AgentRunner().startAgent(baseConfig({
      createSession: async () => fake as never,
      abortSignal: abort.signal,
      keepAlive: () => false,
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      bindNoteDelivery: sink.bind,
      bindTakeUndelivered: taker.bind,
      ...config,
    }));
    const endOpening = (): void => {
      if (!opening.end) throw new Error('the opening prompt never reached the fake session');
      opening.end();
    };
    return { fake, sink, taker, messages, abort, endOpening, run };
  }

  it('echoes an idle image steer with its images and prompts pi with them', async () => {
    let alive = true;
    let idleResolve: (() => void) | null = null;
    const idle = new Promise<void>((r) => { idleResolve = r; });
    const fake = new FakeSession({ onPrompt: (_t, s) => s.emit({ type: 'turn_end' }) });
    const messages: ExtensionToWebviewMessage[] = [];
    const sink = noteSink();
    const run = new AgentRunner().startAgent(baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      bindNoteDelivery: sink.bind,
    }));
    await idle;

    expect(sink.deliver(steer, [image])).toBe(true);
    await fake.whenPrompted(2);
    alive = false;
    await run;

    expect(fake.prompts[1]).toBe(steer);
    expect(fake.promptOptions[1]).toEqual({ images: [piImage], expandPromptTemplates: false });
    const echoes = messages.filter((m) => m.type === 'teamAgentUserMessage' && m.content === steer);
    expect(echoes).toEqual([expect.objectContaining({ images: [image] })]);
  });

  it('steers a mid-stream image steer into pi with its images', async () => {
    const m = streamingMember();
    await m.fake.whenPrompted(1);
    expect(m.sink.deliver(steer, [image])).toBe(true);
    await m.fake.whenPrompted(2);
    m.endOpening();
    await m.run;

    expect(m.fake.promptOptions[1]).toEqual({ streamingBehavior: 'steer', images: [piImage], expandPromptTemplates: false });
    expect(m.fake.prompts).toHaveLength(2);
  });

  it('puts the images back on a steer it reclaims from pi at the turn end', async () => {
    const m = streamingMember();
    await m.fake.whenPrompted(1);
    m.fake.holdSteers = true;
    expect(m.sink.deliver(steer, [image])).toBe(true);
    await m.fake.whenPrompted(2);
    m.endOpening();
    await m.run;

    expect(m.fake.prompts).toEqual(['do the task', steer, steer]);
    expect(m.fake.promptOptions[2]).toEqual({ images: [piImage], expandPromptTemplates: false });
    // Reclaimed messages were echoed when accepted, so the reclaim echoes nothing again.
    expect(m.messages.filter((x) => x.type === 'teamAgentUserMessage' && x.content === steer)).toHaveLength(1);
  });

  it('carries the images of a steer pi still holds in the undelivered snapshot, pairing equal texts in order', async () => {
    const m = streamingMember();
    await m.fake.whenPrompted(1);
    m.fake.holdSteers = true;
    expect(m.sink.deliver(steer)).toBe(true);
    expect(m.sink.deliver(steer, [image])).toBe(true);
    await m.fake.whenPrompted(3);

    expect(m.taker.take()).toEqual([
      { text: steer, echoed: true },
      { text: steer, echoed: true, images: [image] },
    ]);
    m.abort.abort();
    await m.run;
  });

  it('forgets the images of a steer pi has delivered', async () => {
    const m = streamingMember();
    await m.fake.whenPrompted(1);
    expect(m.sink.deliver(steer, [image])).toBe(true);
    await m.fake.whenPrompted(2);
    // A later text-only copy pi holds must not inherit the delivered steer's images.
    m.fake.holdSteeredMessage(steer);

    expect(m.taker.take()).toEqual([{ text: steer, echoed: true }]);
    m.abort.abort();
    await m.run;
  });
});

/**
 * A model call that fails, in the order pi 1.1.0 reports it. pi-agent-core's loop emits the assistant
 * `message_start` (`agent-loop.js:286`), its deltas (`agent-loop.js:299`), the `message_end` carrying
 * `stopReason: 'error'` (`agent-loop.js:319`), then `turn_end` and `agent_end` (`agent-loop.js:151-152`), and
 * `AgentSession` stamps `willRetry` on that `agent_end` (`agent-session.js:750`, `_willRetryAfterAgentEnd`).
 */
function emitFailedCall(s: FakeSession, errorMessage: string, opts: { partial?: string; toolCall?: boolean; willRetry: boolean }): void {
  s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  if (opts.partial) s.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: opts.partial } });
  const content = [
    ...(opts.partial ? [{ type: 'text', text: opts.partial }] : []),
    ...(opts.toolCall ? [{ type: 'toolCall', id: 'tc-failed', name: 'read', arguments: { path: '/a.ts' } }] : []),
  ];
  const message = { role: 'assistant', content, stopReason: 'error', errorMessage };
  s.emit({ type: 'message_end', message });
  s.emit({ type: 'turn_end', message, toolResults: [] });
  s.emit({ type: 'agent_end', messages: [message], willRetry: opts.willRetry });
}

/** A call that answers with `text`, from its `message_start` to its `message_end` (`agent-loop.js:286-319`). */
function emitAnsweredCall(s: FakeSession, text: string): void {
  s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  s.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
}

/** The run's end: `agent_settled` (`agent-session.js:691`), after which pi's `prompt()` resolves. */
function emitSettled(s: FakeSession): void {
  s.emit({ type: 'agent_settled', aborted: false });
}

/**
 * pi's auto-retry, between a failed call's `agent_end { willRetry: true }` and the retried call:
 * `_prepareRetry` emits `auto_retry_start` (`agent-session.js:3041`) and omits the failed call from context
 * (`agent-session.js:3048`), then the retried run opens with `agent_start` (`agent-loop.js:68`).
 */
function emitRetryBackoff(s: FakeSession, attempt: number): void {
  s.emit({ type: 'auto_retry_start', attempt, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' });
  s.emit({ type: 'agent_start' });
}

describe('AgentRunner provider failures', () => {
  const sentOf = (config: AgentRunConfig): ExtensionToWebviewMessage[] => vi.mocked(config.onMessage).mock.calls.map(([m]) => m);

  it('ends the agent failed with the provider message when its last call fails for good, without reconciling it', async () => {
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        emitAnsweredCall(s, 'found the bug in parse()');
        s.emit({ type: 'turn_end' });
        emitFailedCall(s, '529 overloaded_error', { partial: 'Now I will', willRetry: false });
        emitSettled(s);
      },
    });
    const messageBus = new MessageBus('team-1');
    const broadcasts: string[] = [];
    messageBus.subscribe((m) => { if (m.to === null) broadcasts.push(m.content); });
    const config = baseConfig({ messageBus, createSession: async () => fake as never, keepAlive: () => false, onReconcileBeforeEnd: vi.fn() });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('529 overloaded_error');
    expect(result.finalResponse).toBe('529 overloaded_error\n\nPartial output:\nfound the bug in parse()');
    expect(config.onReconcileBeforeEnd).not.toHaveBeenCalled();
    expect(broadcasts).toEqual(['Agent "worker" failed: 529 overloaded_error']);
  });

  it('shows the failure in the transcript once, at the boundary after the call, never at its message_end', async () => {
    let sentAtAgentEnd = -1;
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        emitFailedCall(s, '529 overloaded_error', { partial: 'Now I will', willRetry: false });
        sentAtAgentEnd = sentOf(config).length;
        emitSettled(s);
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });

    await new AgentRunner().startAgent(config);

    const sent = sentOf(config);
    expect(sent.slice(0, sentAtAgentEnd).some((m) => m.type === 'error')).toBe(false);
    expect(sent.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: '529 overloaded_error', parentToolUseId: 'a1' }]);
    // The failed call's text stays, as a reload shows it (`memberHistoryMessages`).
    expect(sent.some((m) => m.type === 'assistantRetracted')).toBe(false);
  });

  it('completes a run whose failed call pi retried and that then answered, withdrawing the failed attempt', async () => {
    let failedMessageId = '';
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        emitFailedCall(s, '529 overloaded_error', { partial: 'Let me', toolCall: true, willRetry: true });
        failedMessageId = sentOf(config).flatMap((m) => (m.type === 'teamAgentAssistant' ? [m.messageId] : [])).at(-1) ?? '';
        emitRetryBackoff(s, 1);
        emitAnsweredCall(s, 'done');
        // pi reports the retry's success after the retried call's `message_end` listeners ran (`agent-session.js:777`).
        s.emit({ type: 'auto_retry_end', success: true, attempt: 1 });
        s.emit({ type: 'turn_end' });
        s.emit({ type: 'agent_end', messages: [], willRetry: false });
        emitSettled(s);
      },
    });
    const onToolCall = vi.fn();
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false, onToolCall });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('completed');
    expect(result).not.toHaveProperty('error');
    expect(result.finalResponse).toBe('done');
    const sent = sentOf(config);
    expect(sent.some((m) => m.type === 'error')).toBe(false);
    expect(failedMessageId).not.toBe('');
    expect(sent.filter((m) => m.type === 'assistantRetracted')).toEqual([{ type: 'assistantRetracted', messageId: failedMessageId, parentToolUseId: 'a1' }]);
    // The failed attempt's tool call never ran: pi ends an errored turn before executing tools (`agent-loop.js:143`).
    expect(onToolCall).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === 'teamAgentToolCall')).toBe(false);
    // The wait ends when the retried call starts, before anything it streams.
    expect(sent.filter((m) => m.type === 'statusUpdate')).toEqual([
      { type: 'statusUpdate', status: 'retrying', attempt: 1, maxAttempts: 3, parentToolUseId: 'a1' },
      { type: 'statusUpdate', status: 'ready', parentToolUseId: 'a1' },
    ]);
    const types = sent.map((m) => (m.type === 'statusUpdate' ? `status:${m.status}` : m.type));
    expect(types.indexOf('status:ready')).toBeLessThan(types.lastIndexOf('teamAgentStreamDelta'));
  });

  it("ends failed when the retries run out, with the last attempt's error", async () => {
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        emitFailedCall(s, '529 first', { willRetry: true });
        emitRetryBackoff(s, 1);
        emitFailedCall(s, '529 second', { willRetry: false });
        // pi gives up after the last attempt's agent_end (`agent-session.js:1437`).
        s.emit({ type: 'auto_retry_end', success: false, attempt: 1, finalError: '529 second' });
        emitSettled(s);
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });

    const result = await new AgentRunner().startAgent(config);

    expect(result).toMatchObject({ status: 'failed', error: '529 second', finalResponse: '529 second' });
    expect(sentOf(config).filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: '529 second', parentToolUseId: 'a1' }]);
  });

  it('ends a parked agent failed when the call of a later wake fails', async () => {
    let alive = true;
    const messageBus = new MessageBus('team-1');
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (text, s) => {
        if (text === 'do the task') {
          emitAnsweredCall(s, 'reported');
        } else {
          alive = false;
          emitFailedCall(s, '503 upstream unavailable', { willRetry: false });
        }
        emitSettled(s);
      },
    });
    let parked: (() => void) | null = null;
    const idle = new Promise<void>((r) => { parked = r; });
    const config = baseConfig({
      messageBus,
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => parked?.(),
    });

    const run = new AgentRunner().startAgent(config);
    await idle;
    messageBus.send('Lead', 'worker', 'revise section 2');
    const result = await run;

    expect(fake.prompts).toEqual(['do the task', '[Message from Lead]: revise section 2']);
    expect(result).toMatchObject({ status: 'failed', error: '503 upstream unavailable', finalResponse: '503 upstream unavailable\n\nPartial output:\nreported' });
  });

  it('reports a Stop that lands on a failing call as cancelled, never failed', async () => {
    const abort = new AbortController();
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        abort.abort();
        emitFailedCall(s, 'socket hang up', { willRetry: false });
        emitSettled(s);
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false, abortSignal: abort.signal });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('cancelled');
    expect(result).not.toHaveProperty('error');
  });
});

describe('AgentRunner reloaded transcript of a failed call', () => {
  const failed = { role: 'assistant', content: [{ type: 'text', text: 'Now I will' }], stopReason: 'error', errorMessage: '529 overloaded_error' } as unknown as PersistedAgentMessage;

  it("shows the failed call's text and then its error, as the live card did", () => {
    expect(memberHistoryMessages([failed], new Map([[failed, 'e7']]))).toEqual([
      { id: 'e7', role: 'assistant', content: [{ type: 'text', text: 'Now I will' }] },
      { id: 'e7:error', role: 'error', content: [{ type: 'text', text: '529 overloaded_error' }] },
    ]);
  });

  // pi returns from the turn before executing any tool of an errored message (agent-loop.js:143-152).
  it('marks the tool calls of a failed call as not executed, with the same blocks the live card was sent', async () => {
    const withTool = { ...failed, content: [{ type: 'text', text: 'Now I will' }, { type: 'toolCall', id: 'tc-failed', name: 'read', arguments: { path: '/a.ts' } }] } as unknown as PersistedAgentMessage;
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        emitFailedCall(s, '529 overloaded_error', { partial: 'Now I will', toolCall: true, willRetry: false });
        emitSettled(s);
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });
    await new AgentRunner().startAgent(config);
    const live = vi.mocked(config.onMessage).mock.calls.flatMap(([m]) => (m.type === 'teamAgentAssistant' ? [m.content] : []));

    const [reloaded] = memberHistoryMessages([withTool], new Map([[withTool, 'e9']]));
    expect(reloaded!.content).toEqual([
      { type: 'text', text: 'Now I will' },
      { type: 'tool_use', id: 'tc-failed', name: 'Read', input: expect.anything(), abandoned: 'failed' },
    ]);
    expect(live).toEqual([reloaded!.content]);
  });

  // pi returns before executing any tool of an aborted message too (agent-loop.js:143).
  it('marks the tool calls of an aborted call as stopped, with the same blocks the live card was sent', async () => {
    const aborted = { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-aborted', name: 'read', arguments: { path: '/a.ts' } }], stopReason: 'aborted', errorMessage: 'Request was aborted' };
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: aborted });
        s.emit({ type: 'turn_end', message: aborted, toolResults: [] });
        s.emit({ type: 'agent_end', messages: [aborted] });
        emitSettled(s);
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });
    await new AgentRunner().startAgent(config);
    const sent = vi.mocked(config.onMessage).mock.calls.map(([m]) => m);
    const live = sent.flatMap((m) => (m.type === 'teamAgentAssistant' ? [m.content] : []));

    const persisted = aborted as unknown as PersistedAgentMessage;
    const [reloaded] = memberHistoryMessages([persisted], new Map([[persisted, 'e10']]));
    expect(reloaded!.content).toEqual([{ type: 'tool_use', id: 'tc-aborted', name: 'Read', input: expect.anything(), abandoned: 'stopped' }]);
    expect(live).toEqual([reloaded!.content]);
    expect(sent.some((m) => m.type === 'teamAgentToolCall')).toBe(false);
  });

  // pi finalizes the call it was running and starts none after it (agent-loop.js:402-404, :429-431, :449-451),
  // drains steers (:186) and makes the next call under the aborted signal, which ends aborted (:141-152);
  // a request setup the signal rejects first ends it on an error stop instead (pi-ai lazy.js:41-44).
  it('re-seals a batch an abort cut short with its skipped calls stopped, the blocks its reload builds', async () => {
    const call = (id: string) => ({ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}.ts` } });
    const batch = { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, call('tc-ran'), call('tc-skipped')], stopReason: 'toolUse' };
    const ranResult = { role: 'toolResult', toolCallId: 'tc-ran', toolName: 'read', content: [{ type: 'text', text: 'Operation aborted' }], isError: true };
    const steer = { role: 'user', content: [{ type: 'text', text: '[Message from Lead]: stop' }] };
    const aborted = { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' };
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: batch });
        s.emit({ type: 'tool_execution_start', toolCallId: 'tc-ran', toolName: 'read', args: { path: '/tc-ran.ts' } });
        s.emit({ type: 'tool_execution_end', toolCallId: 'tc-ran', toolName: 'read', result: ranResult, isError: true });
        s.emit({ type: 'message_start', message: ranResult });
        s.emit({ type: 'message_end', message: ranResult });
        s.emit({ type: 'turn_end', message: batch, toolResults: [ranResult] });
        s.emit({ type: 'message_start', message: steer });
        s.emit({ type: 'message_end', message: steer });
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: aborted });
        s.emit({ type: 'turn_end', message: aborted, toolResults: [] });
        s.emit({ type: 'agent_end', messages: [aborted] });
        s.emit({ type: 'agent_settled', aborted: true });
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });
    await new AgentRunner().startAgent(config);
    const sealed = vi.mocked(config.onMessage).mock.calls.flatMap(([m]) => (m.type === 'teamAgentAssistant' ? [m] : []));

    const persisted = [batch, ranResult, steer, aborted] as unknown as PersistedAgentMessage[];
    const [reloaded] = memberHistoryMessages(persisted, new Map(persisted.map((m, i) => [m, `e${i}`])));
    expect(reloaded!.content).toEqual([
      { type: 'text', text: 'Reading' },
      { type: 'tool_use', id: 'tc-ran', name: 'Read', input: expect.anything() },
      { type: 'tool_use', id: 'tc-skipped', name: 'Read', input: expect.anything(), abandoned: 'stopped' },
    ]);
    expect(sealed).toHaveLength(2);
    expect(sealed[1]!.messageId).toBe(sealed[0]!.messageId);
    expect(JSON.stringify(sealed[1]!.content)).toBe(JSON.stringify(reloaded!.content));
  });

  // The nested extension records a call the abort settled at the gate (agent-loop.js:500-504) and pi emits the
  // entry inside the extension pass, before listeners get that call's tool_execution_end (agent-session.js:749, :2721-2726).
  it('re-seals a call the turn-stopped record names as stopped, sends no result for it, and matches its reload', async () => {
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: `run ${id}` } });
    const batch = { role: 'assistant', content: [call('tc-gated'), call('tc-skipped')], stopReason: 'toolUse' };
    const gatedResult = { role: 'toolResult', toolCallId: 'tc-gated', toolName: 'bash', content: [{ type: 'text', text: 'Operation aborted' }], details: {}, isError: true };
    const record = { type: 'custom', id: 's1', parentId: null, timestamp: '', customType: 'damocles-turn-stopped', data: { toolCallIds: ['tc-gated'], entryIds: [] } };
    const aborted = { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' };
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: batch });
        s.emit({ type: 'tool_execution_start', toolCallId: 'tc-gated', toolName: 'bash', args: { command: 'run tc-gated' } });
        s.emit({ type: 'entry_appended', entry: record });
        s.emit({ type: 'tool_execution_end', toolCallId: 'tc-gated', toolName: 'bash', result: gatedResult, isError: true });
        s.emit({ type: 'message_start', message: gatedResult });
        s.emit({ type: 'message_end', message: gatedResult });
        s.emit({ type: 'turn_end', message: batch, toolResults: [gatedResult] });
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: aborted });
        s.emit({ type: 'turn_end', message: aborted, toolResults: [] });
        s.emit({ type: 'agent_end', messages: [aborted] });
        s.emit({ type: 'agent_settled', aborted: true });
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });
    await new AgentRunner().startAgent(config);
    const sent = vi.mocked(config.onMessage).mock.calls.map(([m]) => m);
    const sealed = sent.flatMap((m) => (m.type === 'teamAgentAssistant' ? [m] : []));

    const persisted = [batch, gatedResult, aborted] as unknown as PersistedAgentMessage[];
    const reloaded = memberHistoryMessages(persisted, new Map(persisted.map((m, i) => [m, `e${i}`])), new Set(['tc-gated']));
    expect(reloaded.map((m) => m.role)).toEqual(['assistant']);
    expect(reloaded[0]!.content).toEqual([
      { type: 'tool_use', id: 'tc-gated', name: 'Bash', input: expect.anything(), abandoned: 'stopped' },
      { type: 'tool_use', id: 'tc-skipped', name: 'Bash', input: expect.anything(), abandoned: 'stopped' },
    ]);
    expect(sent.some((m) => m.type === 'teamAgentToolResult')).toBe(false);
    expect(sealed.map((m) => m.messageId)).toEqual(Array(sealed.length).fill(sealed[0]!.messageId));
    expect(JSON.stringify(sealed.at(-1)!.content)).toBe(JSON.stringify(reloaded[0]!.content));
  });

  it('shows the error of a failed call that streamed nothing', () => {
    const empty = { ...failed, content: [] } as unknown as PersistedAgentMessage;
    expect(memberHistoryMessages([empty], new Map([[empty, 'e8']]))).toEqual([
      { id: 'e8:error', role: 'error', content: [{ type: 'text', text: '529 overloaded_error' }] },
    ]);
  });
});

/**
 * A team cancel while a member runs a tool, in pi 1.1.0's order: the runner's abort listener aborts the session,
 * pi records the killed call with its `durationMs` (`agent-loop.js:583-591`), and the loop's next call, made under the
 * aborted signal (`:141`), ends on an error stop because its auth setup rejects first (`model-runtime.js:451-455`,
 * `lazy.js:41-44` in pi-ai 1.1.0). The nested extension names its entry at its `turn_end` boundary
 * (`registerWindDownErrorRecord`), which pi commits before the listeners get that `turn_end` (`agent-session.js:515`,
 * `:636-641`).
 */
describe('AgentRunner wind-down error of a cancelled run', () => {
  const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'sleep 20' } });
  const batch = { role: 'assistant', content: [{ type: 'text', text: 'Waiting' }, call('tc-ran'), call('tc-skipped')], stopReason: 'toolUse' };
  const killed = { role: 'toolResult', toolCallId: 'tc-ran', toolName: 'bash', content: [{ type: 'text', text: 'Command aborted' }], details: { [CANCELLED_TOOL_DETAIL_KEY]: true }, isError: true, durationMs: 700 };
  const windDown = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted' };

  /** Append the turn-stopped entry naming `message`'s entry, and emit its `entry_appended`, as pi commits the draft. */
  const recordWindDown = (s: FakeSession, message: unknown): void => {
    const persisted = s.branch.find((e) => (e as { message?: unknown }).message === message) as { id: string };
    const entry = { type: 'custom', id: `st-${persisted.id}`, customType: 'damocles-turn-stopped', data: { toolCallIds: [], entryIds: [persisted.id] } };
    s.branch.push(entry);
    s.emit({ type: 'entry_appended', entry });
  };

  const cancelledRun = (opts: { recorded: boolean }) => {
    const cancel = new AbortController();
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        s.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
        s.emit({ type: 'message_end', message: batch });
        s.emit({ type: 'tool_execution_start', toolCallId: 'tc-ran', toolName: 'bash', args: { command: 'sleep 20' } });
        cancel.abort();
        s.emit({ type: 'tool_execution_end', toolCallId: 'tc-ran', toolName: 'bash', result: killed, isError: true, durationMs: 700 });
        s.emit({ type: 'message_start', message: killed });
        s.emit({ type: 'message_end', message: killed });
        s.emit({ type: 'turn_end', message: batch, toolResults: [killed] });
        s.emit({ type: 'message_start', message: windDown });
        s.emit({ type: 'message_end', message: windDown });
        if (opts.recorded) recordWindDown(s, windDown);
        s.emit({ type: 'turn_end', message: windDown, toolResults: [] });
        s.emit({ type: 'agent_end', messages: [windDown], willRetry: false });
        s.emit({ type: 'agent_settled', aborted: true });
      },
    });
    return baseConfig({ createSession: async () => fake as never, keepAlive: () => false, abortSignal: cancel.signal });
  };

  it('shows no error card for it, stops the calls the abort skipped, and matches its reload', async () => {
    const config = cancelledRun({ recorded: true });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('cancelled');
    const sent = vi.mocked(config.onMessage).mock.calls.map(([m]) => m);
    expect(sent.some((m) => m.type === 'error')).toBe(false);
    const sealed = sent.flatMap((m) => (m.type === 'teamAgentAssistant' ? [m] : []));
    const persisted = [batch, killed, windDown] as unknown as PersistedAgentMessage[];
    const entryIds = new Map(persisted.map((m, i) => [m, `e${i}`]));
    const reloaded = memberHistoryMessages(persisted, entryIds, new Set(), new Set([persisted[2]!]));
    expect(reloaded.map((m) => m.role)).toEqual(['assistant', 'toolResult']);
    expect(reloaded[0]!.content).toEqual([
      { type: 'text', text: 'Waiting' },
      { type: 'tool_use', id: 'tc-ran', name: 'Bash', input: expect.anything() },
      { type: 'tool_use', id: 'tc-skipped', name: 'Bash', input: expect.anything(), abandoned: 'stopped' },
    ]);
    expect(sealed.map((m) => m.messageId)).toEqual(Array(sealed.length).fill(sealed[0]!.messageId));
    expect(JSON.stringify(sealed.at(-1)!.content)).toBe(JSON.stringify(reloaded[0]!.content));
  });

  // No record: the record pass saw a live signal (the abort landed after it) or a later handler discarded the draft.
  it('shows the card and leaves the skipped call when no record names the error, as its reload does', async () => {
    const config = cancelledRun({ recorded: false });

    await new AgentRunner().startAgent(config);

    const sent = vi.mocked(config.onMessage).mock.calls.map(([m]) => m);
    expect(sent.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: 'This operation was aborted', parentToolUseId: 'a1' }]);
    const sealed = sent.flatMap((m) => (m.type === 'teamAgentAssistant' ? [m] : []));
    const persisted = [batch, killed, windDown] as unknown as PersistedAgentMessage[];
    const reloaded = memberHistoryMessages(persisted, new Map(persisted.map((m, i) => [m, `e${i}`])));
    expect(JSON.stringify(sealed.at(-1)!.content)).toBe(JSON.stringify(reloaded[0]!.content));
  });

  it('keeps the error row of a member file written before the record existed', () => {
    const persisted = [windDown] as unknown as PersistedAgentMessage[];
    expect(memberHistoryMessages(persisted, new Map([[persisted[0]!, 'e0']])).map((m) => m.role)).toEqual(['error']);
  });

  it('still shows a provider failure no record names', async () => {
    const fake = new FakeSession({
      settleOn: 'agent_settled',
      onPrompt: (_t, s) => {
        emitFailedCall(s, '529 overloaded_error', { willRetry: false });
        emitSettled(s);
      },
    });
    const config = baseConfig({ createSession: async () => fake as never, keepAlive: () => false });

    const result = await new AgentRunner().startAgent(config);

    expect(result.status).toBe('failed');
    const sent = vi.mocked(config.onMessage).mock.calls.map(([m]) => m);
    expect(sent.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: '529 overloaded_error', parentToolUseId: 'a1' }]);
  });
});
