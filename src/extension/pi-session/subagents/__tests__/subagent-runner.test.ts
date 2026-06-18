import { describe, it, expect } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { runSubagent, normalizeMaxTurns } from '../subagent-runner';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake session that lets the test drive turn_end events and observe steer/abort. */
function makeSession() {
  const cbs: ((e: unknown) => void)[] = [];
  const steerCalls: string[] = [];
  let aborted = false;
  let resolvePrompt!: () => void;

  const session = {
    subscribe: (fn: (e: unknown) => void) => {
      cbs.push(fn);
      return () => {};
    },
    prompt: () => new Promise<void>((r) => (resolvePrompt = r)),
    messages: [] as unknown[],
    steer: async (m: string) => {
      steerCalls.push(m);
    },
    abort: async () => {
      aborted = true;
    },
  };

  return {
    session: session as unknown as AgentSession,
    emitTurnEnd: () => cbs.forEach((fn) => fn({ type: 'turn_end' })),
    finishPrompt: () => resolvePrompt(),
    steerCalls,
    wasAborted: () => aborted,
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

  it('aborts the session when the signal is already aborted before the listener attaches (created mid-spawn)', async () => {
    const f = makeSession();
    const controller = new AbortController();
    controller.abort(); // aborted while createSession is still pending — the event passed before the listener

    const p = runSubagent({
      // Resolve createSession on a later tick so the abort genuinely precedes listener attachment.
      createSession: async () => { await flush(); return f.session; },
      prompt: 'go',
      signal: controller.signal,
    });
    await flush();
    await flush();

    expect(f.wasAborted()).toBe(true);

    f.finishPrompt();
    await p;
  });
});
