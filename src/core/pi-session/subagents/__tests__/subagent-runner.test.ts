import { describe, it, expect, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { runSubagent, normalizeMaxTurns } from '../subagent-runner';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake session that lets the test drive turn_end events and observe steer/abort. */
function makeSession() {
  const cbs: ((e: unknown) => void)[] = [];
  const steerCalls: string[] = [];
  let aborts = 0;
  let prompted = 0;
  let resolvePrompt!: () => void;

  const session = {
    subscribe: (fn: (e: unknown) => void) => {
      cbs.push(fn);
      return () => {};
    },
    prompt: () => {
      prompted++;
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

  return {
    session: session as unknown as AgentSession,
    emitTurnEnd: () => cbs.forEach((fn) => fn({ type: 'turn_end' })),
    emitAgentStart: () => cbs.forEach((fn) => fn({ type: 'agent_start' })),
    finishPrompt: () => resolvePrompt(),
    steerCalls,
    wasAborted: () => aborts > 0,
    abortCount: () => aborts,
    promptCount: () => prompted,
  };
}

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
    const p = runSubagent({ createSession: async () => f.session, prompt: 'go', maxTurns: 2, graceTurns: 1 });
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
    const p = runSubagent({ createSession: async () => f.session, prompt: 'go' });
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
    const p = runSubagent({ createSession: async () => f.session, prompt: 'go', maxTurns: 0 });
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
      onSessionCreated: (s) => created.push(s),
    });
    await vi.waitFor(() => expect(created).toEqual([f.session]));

    expect(f.promptCount()).toBe(0);
    expect(await p).toEqual({ responseText: '', session: f.session, aborted: false, steered: false });
  });

  it('repeats an abort that landed during prompt() preflight once the run starts', async () => {
    const f = makeSession();
    const controller = new AbortController();
    const p = runSubagent({ createSession: async () => f.session, prompt: 'go', signal: controller.signal });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    controller.abort(); // pi has no active run yet, so this first abort is a no-op there
    expect(f.abortCount()).toBe(1);
    f.emitAgentStart();
    expect(f.abortCount()).toBe(2);

    f.finishPrompt();
    await p;
  });

  it('does not abort at run start when the signal never fired', async () => {
    const f = makeSession();
    const p = runSubagent({ createSession: async () => f.session, prompt: 'go', signal: new AbortController().signal });
    await vi.waitFor(() => expect(f.promptCount()).toBe(1));

    f.emitAgentStart();
    expect(f.wasAborted()).toBe(false);

    f.finishPrompt();
    await p;
  });
});
