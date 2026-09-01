import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from '../agent-runner';
import { MessageBus } from '../message-bus';
import type { AgentRunConfig } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { FakeSession } from './fake-session';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../../shared/types/session';

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
    specialization: 'do the task',
    createSession: overrides.createSession ?? (async () => { throw new Error('no session'); }),
    forgetSession: vi.fn(),
    abortSignal: new AbortController().signal,
    messageBus,
    onMessage: vi.fn<(m: ExtensionToWebviewMessage) => void>(),
    teamId: 'team-1',
    persistence: { appendAgentEntry: vi.fn(), appendTeamEntry: vi.fn(), flush: async () => {} },
    bindNoteDelivery: () => () => undefined,
    ...overrides,
  } as AgentRunConfig;
}

/** Captures the note sink the runner publishes, plus whether its teardown has run. */
function noteSink(): { deliver: (text: string) => boolean; unbound: boolean; bind: AgentRunConfig['bindNoteDelivery'] } {
  const sink: { deliver: (text: string) => boolean; unbound: boolean; bind: AgentRunConfig['bindNoteDelivery'] } = {
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

  it('loses a SYNCHRONOUS send from onReconcileBeforeEnd (lost-wakeup guard) — the agent parks with the message unflushed and never re-prompts', async () => {
    // The lost-wakeup rule for the reconcile path: a synchronous MessageBus.send from inside
    // onReconcileBeforeEnd pushes to pendingMessages and tries to wake, but waitResolve is not armed yet
    // (the park await is set up AFTER onTurnEnd). The wake is a no-op and the message sits unflushed — the
    // agent parks forever. This is exactly why reconcileTerminalContract defers the nudge via queueMicrotask.
    const ac = new AbortController();
    let alive = false;
    let sent = false;
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
        if (!sent) {
          sent = true;
          alive = true; // arm the hold so the runner parks (the send must survive to be meaningful)
          messageBus.send('system', 'worker', 'SYNC nudge'); // synchronous — lost
        }
      },
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
    });

    const idle1 = nextIdle();
    const run = new AgentRunner().startAgent(config);
    await idle1;             // parked; the synchronous nudge was delivered into pendingMessages but lost
    expect(fake.prompts).toEqual(['do the task']); // never re-prompted — the wake was a no-op
    ac.abort();
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(fake.prompts).toEqual(['do the task']);
  });

  it('reclaims a message pi still holds when the turn ends, instead of ending with it undelivered', async () => {
    // pi runs shouldStopAfterTurn before it drains the queue, so a message steered in that window is
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
    const entries: Array<Record<string, unknown>> = [];
    const sink = noteSink();
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => alive,
      onTurnEnd: () => { idleResolve?.(); idleResolve = null; },
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      persistence: { appendAgentEntry: (_t, _a, e) => { entries.push(e); }, appendTeamEntry: () => undefined, flush: async () => undefined },
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
    const persisted = entries.filter((e) => e['type'] === 'user' && e['content'] === '[cancel] the shell command was stopped');
    expect(persisted).toHaveLength(1);
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
 * has to happen here. Both destinations are asserted: the live `teamAgentToolCall` message AND the
 * entry given to `persistence.appendAgentEntry`, which nothing reads until a user reopens the team.
 */

interface PiToolCallBlock { id: string; name: string; arguments: Record<string, unknown> }
/** `appendAgentEntry` takes an open record, so the entry is read by key rather than by a shaped type. */
type PersistedEntry = Record<string, unknown>;

/** Runs one turn whose single assistant message carries the given pi `toolCall` blocks. */
async function runWithToolCalls(blocks: PiToolCallBlock[]): Promise<{ messages: ExtensionToWebviewMessage[]; entries: PersistedEntry[] }> {
  const messages: ExtensionToWebviewMessage[] = [];
  const entries: PersistedEntry[] = [];
  const fake = new FakeSession({
    onPrompt: (_t, s) => {
      s.emit({ type: 'message_end', message: { role: 'assistant', content: blocks.map((b) => ({ type: 'toolCall', ...b })) } });
      s.emit({ type: 'turn_end' });
    },
  });
  const config = baseConfig({
    createSession: async () => fake as never,
    keepAlive: () => false,
    onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
    persistence: { appendAgentEntry: (_t: string, _a: string, e: PersistedEntry) => { entries.push(e); }, appendTeamEntry: vi.fn(), flush: async () => {} },
  });

  await new AgentRunner().startAgent(config);
  return { messages, entries };
}

function toolCallMessages(messages: ExtensionToWebviewMessage[]): Array<{ toolName: string; toolInput: Record<string, unknown> }> {
  return messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolCall' }> => m.type === 'teamAgentToolCall');
}

/** The persisted `tool_use` block for an id, from the assistant entry the runner appended. */
function persistedToolUse(entries: PersistedEntry[], id: string): { name: string; input: Record<string, unknown> } {
  for (const entry of entries) {
    if (entry['type'] !== 'assistant' || !Array.isArray(entry['content'])) continue;
    for (const block of entry['content'] as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
      if (block.type === 'tool_use' && block.id === id) {
        return { name: block.name ?? '', input: (block.input ?? {}) as Record<string, unknown> };
      }
    }
  }
  throw new Error(`expected a persisted tool_use block '${id}', found none in ${entries.length} entries`);
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
  it('maps a pi bash call to Bash in the message, the live block and the persisted entry', async () => {
    const { messages, entries } = await runWithToolCalls([{ id: 'tc-1', name: 'bash', arguments: { command: 'ls -la' } }]);

    expect(toolCallMessages(messages)).toEqual([
      expect.objectContaining({ toolName: 'Bash', toolInput: { command: 'ls -la' } }),
    ]);
    expect(assistantToolUse(messages, 'tc-1').name).toBe('Bash');
    expect(persistedToolUse(entries, 'tc-1').name).toBe('Bash');
  });

  it('rewrites read.path to file_path in the message, the live block and the persisted entry', async () => {
    const { messages, entries } = await runWithToolCalls([{ id: 'tc-2', name: 'read', arguments: { path: 'c:/x.ts', limit: 20 } }]);

    const sent = toolCallMessages(messages)[0];
    expect(sent?.toolName).toBe('Read');
    expect(sent?.toolInput).toEqual({ file_path: 'c:/x.ts', limit: 20 });
    expect(sent?.toolInput).not.toHaveProperty('path');

    const persisted = persistedToolUse(entries, 'tc-2');
    expect(persisted.name).toBe('Read');
    expect(persisted.input).toEqual({ file_path: 'c:/x.ts', limit: 20 });
    expect(persisted.input).not.toHaveProperty('path');

    const live = assistantToolUse(messages, 'tc-2');
    expect(live.name).toBe('Read');
    expect(live.input).toEqual({ file_path: 'c:/x.ts', limit: 20 });
  });

  it('maps find to Glob and grep.ignoreCase to -i', async () => {
    const { messages, entries } = await runWithToolCalls([
      { id: 'tc-3', name: 'find', arguments: { pattern: '**/*.ts' } },
      { id: 'tc-4', name: 'grep', arguments: { pattern: 'todo', ignoreCase: true } },
    ]);

    expect(toolCallMessages(messages).map((m) => m.toolName)).toEqual(['Glob', 'Grep']);
    expect(persistedToolUse(entries, 'tc-3').name).toBe('Glob');
    const grep = persistedToolUse(entries, 'tc-4');
    expect(grep.input).toEqual({ pattern: 'todo', '-i': true });
    expect(grep.input).not.toHaveProperty('ignoreCase');
  });

  it('passes an unmapped tool name and its arguments through untouched', async () => {
    // Custom and MCP tools are already Damocles-shaped, so the mapping must be identity for them.
    const { messages, entries } = await runWithToolCalls([
      { id: 'tc-5', name: 'mcp__pi__team_send_message', arguments: { to: 'lead', content: 'done' } },
    ]);

    expect(toolCallMessages(messages)[0]?.toolName).toBe('mcp__pi__team_send_message');
    expect(persistedToolUse(entries, 'tc-5').input).toEqual({ to: 'lead', content: 'done' });
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

/**
 * A team reopened from history is rebuilt from the persisted entries alone, so a result the runner
 * emits to the webview and never writes down leaves the reloaded card with no outcome to render.
 */
describe('AgentRunner tool result persistence', () => {
  async function persistedEntries(emitEvents: (s: FakeSession) => void): Promise<PersistedEntry[]> {
    const entries: PersistedEntry[] = [];
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        emitEvents(s);
        s.emit({ type: 'turn_end' });
      },
    });
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      persistence: { appendAgentEntry: (_t: string, _a: string, e: PersistedEntry) => { entries.push(e); }, appendTeamEntry: vi.fn(), flush: async () => {} },
    });

    await new AgentRunner().startAgent(config);
    return entries;
  }

  /** The persisted `tool_result` block for an id, from the entry the runner appended. */
  function persistedToolResult(entries: PersistedEntry[], id: string): Record<string, unknown> {
    for (const entry of entries) {
      if (entry['type'] !== 'tool_result' || !Array.isArray(entry['content'])) continue;
      for (const block of entry['content'] as Array<Record<string, unknown>>) {
        if (block['type'] === 'tool_result' && block['tool_use_id'] === id) return block;
      }
    }
    throw new Error(`expected a persisted tool_result block '${id}', found none in ${entries.length} entries`);
  }

  it('writes the result text down under the id of the call it belongs to', async () => {
    const entries = await persistedEntries((s) => {
      s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file body' }] }, isError: false });
    });

    expect(persistedToolResult(entries, 'tc-1')).toEqual({ type: 'tool_result', tool_use_id: 'tc-1', content: 'file body', is_error: false });
  });

  it('records an errored result as an error', async () => {
    const entries = await persistedEntries((s) => {
      s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'command not found' }] }, isError: true });
    });

    expect(persistedToolResult(entries, 'tc-1')['is_error']).toBe(true);
  });

  it('carries the cancelled marker, which is the only thing that tells a stopped call from a finished one', async () => {
    const entries = await persistedEntries((s) => {
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'partial' }], details: { [CANCELLED_TOOL_DETAIL_KEY]: true, fullOutputPath: '/tmp/full.log' } },
        isError: false,
      });
    });

    const block = persistedToolResult(entries, 'tc-1');
    expect(block['is_error']).toBe(false);
    expect(block['metadata']).toEqual({ [CANCELLED_TOOL_DETAIL_KEY]: true, fullOutputPath: '/tmp/full.log' });
  });

  it('writes one result entry per call, each addressed to its own id', async () => {
    const entries = await persistedEntries((s) => {
      s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { content: [{ type: 'text', text: 'first' }] }, isError: false });
      s.emit({ type: 'tool_execution_end', toolCallId: 'tc-2', toolName: 'read', result: { content: [{ type: 'text', text: 'second' }] }, isError: false });
    });

    expect(persistedToolResult(entries, 'tc-1')['content']).toBe('first');
    expect(persistedToolResult(entries, 'tc-2')['content']).toBe('second');
  });

  it('keeps a bare-string result instead of blanking both the card and the log', async () => {
    // A custom tool or an MCP shim can answer with a plain string rather than a content array. Both
    // consumers read the same joined text, so blanking it loses the result on the card and writes the
    // blank into the log a reopened team replays as authoritative.
    const messages: ExtensionToWebviewMessage[] = [];
    const entries: PersistedEntry[] = [];
    const fake = new FakeSession({
      onPrompt: (_t, s) => {
        s.emit({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: 'plain string result' } as never);
        s.emit({ type: 'turn_end' });
      },
    });
    const config = baseConfig({
      createSession: async () => fake as never,
      keepAlive: () => false,
      onMessage: (m: ExtensionToWebviewMessage) => { messages.push(m); },
      persistence: { appendAgentEntry: (_t: string, _a: string, e: PersistedEntry) => { entries.push(e); }, appendTeamEntry: vi.fn(), flush: async () => {} },
    });

    await new AgentRunner().startAgent(config);

    expect(persistedToolResult(entries, 'tc-1')['content']).toBe('plain string result');
    const card = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolResult' }> => m.type === 'teamAgentToolResult');
    expect(card?.result).toBe('plain string result');
  });
});

/**
 * `team_standby` and `team_report_complete` both promise the agent stops here, but each only records
 * state and hands control back to the model, which keeps working unless the engine ends the turn. The
 * runner installs pi's `shouldStopAfterTurn` hook so it does. These tests drive the hook the runner
 * installed on the session's `agent`, which is the object pi consults after each turn.
 */

type StopHook = NonNullable<FakeSession['agent']['shouldStopAfterTurn']>;

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
  const hook = fake.agent.shouldStopAfterTurn;
  if (!hook) throw new Error('the runner installed no shouldStopAfterTurn hook');
  await body(hook, fake);
  // pi drains its queue once the turn ends, so leave nothing held that would re-prompt this session.
  fake.clearQueue();
  fake.emit({ type: 'turn_end' });
  await run;
}

/**
 * A completed assistant message carrying one tool call per name, each paired with the successful result
 * pi builds for it (`agent-loop.js:534` keys the result to the call id and carries `isError`).
 */
function turnWith(...names: string[]): Parameters<StopHook>[0] {
  return {
    message: { role: 'assistant', content: names.map((name, i) => ({ type: 'toolCall', id: `tc-${i}`, name, arguments: {} })) },
    toolResults: names.map((name, i) => ({ role: 'toolResult', toolCallId: `tc-${i}`, toolName: name, content: [], isError: false })),
    context: {},
    newMessages: [],
  } as unknown as Parameters<StopHook>[0];
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

  it('chains to a hook the session already carried instead of replacing it', async () => {
    const fake = heldSession();
    let priorCalls = 0;
    let priorStops = false;
    fake.agent.shouldStopAfterTurn = () => { priorCalls++; return priorStops; };

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
