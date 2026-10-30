import { describe, it, expect, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { formatAgentConversation, runSubagent, normalizeMaxTurns } from '../subagent-runner';
import { trackRunLifecycle } from '../../run-lifecycle';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * A fake session that lets the test drive turn_end events and observe steer/abort. A prompt holds the session busy
 * until `finishPrompt`, which ends a run whose `agent_start` the test emitted as pi does: `agent_end`, then
 * `agent_settled` once the busy flag dropped, before `prompt()` resolves (`agent-session.js:683-706`, `:1423-1473` in pi 1.4.0).
 */
function makeSession() {
  const cbs: ((e: unknown) => void)[] = [];
  const agentCbs: ((e: { type: string }) => void)[] = [];
  const steerCalls: string[] = [];
  let aborts = 0;
  let agentAborts = 0;
  let prompted = 0;
  let busy = false;
  let started = false;
  let idleWaiters: Array<() => void> = [];
  let resolvePrompt!: () => void;

  const session = {
    subscribe: (fn: (e: unknown) => void) => {
      cbs.push(fn);
      return () => {};
    },
    get isStreaming() { return busy; },
    isCompacting: false,
    waitForIdle: () => (busy ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve()),
    agent: {
      state: { isStreaming: false },
      subscribe: (fn: (e: { type: string }) => void) => {
        agentCbs.push(fn);
        return () => { agentCbs.splice(agentCbs.indexOf(fn), 1); };
      },
      abort: () => { agentAborts++; },
    },
    prompt: () => {
      prompted++;
      busy = true;
      return new Promise<void>((r) => (resolvePrompt = r));
    },
    messages: [] as unknown[],
    steer: async (m: string) => {
      steerCalls.push(m);
    },
    abort: async () => {
      aborts++;
    },
  };
  const emit = (event: { type: string }): void => cbs.forEach((fn) => fn(event));

  return {
    session: session as unknown as AgentSession,
    emit: (event: unknown) => cbs.forEach((fn) => fn(event)),
    emitTurnEnd: () => emit({ type: 'turn_end' }),
    emitAgentStart: () => {
      started = true;
      [...agentCbs].forEach((fn) => fn({ type: 'agent_start' }));
      emit({ type: 'agent_start' });
    },
    finishPrompt: () => {
      if (started) {
        [...agentCbs].forEach((fn) => fn({ type: 'agent_end' }));
        emit({ type: 'agent_end' });
      }
      busy = false;
      if (started) emit({ type: 'agent_settled' });
      started = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
      resolvePrompt();
    },
    steerCalls,
    wasAborted: () => aborts > 0,
    abortCount: () => aborts,
    agentAbortCount: () => agentAborts,
    promptCount: () => prompted,
  };
}

/** Binds the session's run lifecycle, as `AgentManager` does. */
const bind = (session: AgentSession): void => { trackRunLifecycle(session); };

describe('normalizeMaxTurns', () => {
  it('treats undefined and 0 as unlimited, clamps to a minimum of 1', () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
    expect(normalizeMaxTurns(0)).toBeUndefined();
    expect(normalizeMaxTurns(5)).toBe(5);
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe('runSubagent turn-limit enforcement', () => {
  it('steers to wrap up at the soft limit, then hard-aborts after the grace turns', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go', maxTurns: 2, graceTurns: 1 });
    await flush(); // createSession resolved + subscriptions registered + prompt() awaited

    f.emitTurnEnd(); // turn 1 — under the limit
    expect(f.steerCalls).toHaveLength(0);

    f.emitTurnEnd(); // turn 2 — soft limit reached → one steer
    expect(f.steerCalls).toHaveLength(1);
    expect(f.steerCalls[0]).toContain('turn limit');
    expect(f.wasAborted()).toBe(false);

    f.emitTurnEnd(); // turn 3 = maxTurns + grace → hard abort
    expect(f.wasAborted()).toBe(true);
    expect(f.steerCalls).toHaveLength(1); // steer fires only once

    f.finishPrompt();
    const res = await p;
    // A hard abort subsumes the soft-limit steer: the flags must not contradict, so only `aborted` is set.
    expect(res.aborted).toBe(true);
    expect(res.steered).toBe(false);
  });

  it('never steers or aborts when no maxTurns is set (unlimited)', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go' });
    await flush();

    for (let i = 0; i < 25; i++) f.emitTurnEnd();
    expect(f.steerCalls).toHaveLength(0);
    expect(f.wasAborted()).toBe(false);

    f.finishPrompt();
    const res = await p;
    expect(res.steered).toBe(false);
    expect(res.aborted).toBe(false);
  });

  it('treats maxTurns: 0 as unlimited', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go', maxTurns: 0 });
    await flush();

    for (let i = 0; i < 10; i++) f.emitTurnEnd();
    expect(f.steerCalls).toHaveLength(0);
    expect(f.wasAborted()).toBe(false);

    f.finishPrompt();
    await p;
  });

  // pi's session.abort() only stops a run that has started, so an abort during creation must skip prompt().
  it('never prompts when the signal fired while the session was being created', async () => {
    const f = makeSession();
    const controller = new AbortController();
    const created: AgentSession[] = [];

    const p = runSubagent({
      createSession: async () => {
        await flush();
        controller.abort();
        return f.session;
      },
      prompt: 'go',
      signal: controller.signal,
      onSessionCreated: (s) => { bind(s); created.push(s); },
    });
    await vi.waitFor(() => expect(created).toEqual([f.session]));

    expect(f.promptCount()).toBe(0);
    expect(await p).toEqual({ responseText: '', session: f.session, aborted: false, steered: false });
  });

  it('stops the run at its start when an abort landed during prompt() preflight', async () => {
    const f = makeSession();
    const controller = new AbortController();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go', signal: controller.signal });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    controller.abort(); // pi has no active run yet, so this abort marks nothing there
    expect(f.abortCount()).toBe(1);
    expect(f.agentAbortCount()).toBe(0);
    f.emitAgentStart();
    expect(f.agentAbortCount()).toBe(1);

    f.finishPrompt();
    await p;
  });

  it('does not abort at run start when the signal never fired', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go', signal: new AbortController().signal });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    f.emitAgentStart();
    expect(f.wasAborted()).toBe(false);
    expect(f.agentAbortCount()).toBe(0);

    f.finishPrompt();
    await p;
  });
});

describe('runSubagent provider failures', () => {
  const ended = (stopReason: string, errorMessage?: string) => ({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) },
  });

  // pi reports a failed call only on its assistant message_end, and prompt() resolves normally after it.
  it('reports the error the run ended on', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go' });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    f.emit(ended('error', '400 invalid_request_error'));
    f.finishPrompt();
    expect((await p).error).toBe('400 invalid_request_error');
  });

  // pi's text for a call whose provider has no credential (pinned against pi in provider-account.test.ts).
  it("reports a call that had no credential in Damocles' words, naming the provider and model", async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go' });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    f.emit({ type: 'message_end', message: { role: 'assistant', content: [], provider: 'cerebras', model: 'gpt-oss-120b', stopReason: 'error', errorMessage: 'Provider is not configured: cerebras' } });
    f.finishPrompt();
    expect((await p).error).toBe('No credential is set up for cerebras, so gpt-oss-120b could not run. Pick a model from a provider you are signed in to.');
  });

  // The run's error is the parent model's `Agent` result, so it stays English whatever the UI language.
  it('reports a call that had no credential in English', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go' });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    f.emit({ type: 'message_end', message: { role: 'assistant', content: [], provider: 'anthropic', model: 'claude-sonnet-5-5', stopReason: 'error', errorMessage: 'Provider is not configured: anthropic' } });
    f.finishPrompt();
    expect((await p).error).toBe('No Anthropic credential is saved, so Sonnet 5.5 could not run. Sign in or add an API key in Settings › Models & accounts.');
  });

  // pi's auto-retry re-runs the failed call before prompt() resolves, so only the run's last call decides.
  it('reports no error when pi retried the failed call into an answer', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go' });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    f.emit(ended('error', '529 overloaded_error'));
    f.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded_error' });
    f.emit(ended('stop'));
    f.finishPrompt();
    expect(await p).not.toHaveProperty('error');
  });

  // A reopened agent's session already holds its earlier runs, whose answers are not this run's output.
  it("reports only this run's text as its output", async () => {
    const f = makeSession();
    const messages = (f.session as unknown as { messages: unknown[] }).messages;
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'the earlier run answered' }] });
    const p = runSubagent({ createSession: async () => f.session, onSessionCreated: bind, prompt: 'go on' });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded_error' });
    f.emit(ended('error', '529 overloaded_error'));
    f.finishPrompt();
    expect((await p).responseText).toBe('');
  });
});

describe('formatAgentConversation', () => {
  it('formats persisted messages: user and assistant text, tool calls, and tool results cut at 200 characters', () => {
    const out = formatAgentConversation([
      { role: 'user', content: [{ type: 'text', text: ' find the bug ' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'toolCall', name: 'grep', arguments: {} }] },
      { role: 'toolResult', toolName: 'grep', content: [{ type: 'text', text: 'x'.repeat(250) }] },
      { role: 'custom', content: 'ignored' },
      { role: 'assistant', content: [{ type: 'text', text: 'fixed it' }] },
    ]);
    expect(out).toBe(
      ['[User]: find the bug', '[Assistant]: looking', '[Tool Calls]:\n  Tool: grep', `[Tool Result (grep)]: ${'x'.repeat(200)}...`, '[Assistant]: fixed it'].join('\n\n'),
    );
  });

  it('is empty for an agent with no messages', () => {
    expect(formatAgentConversation([])).toBe('');
  });
});
