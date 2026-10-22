import { afterEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { runLifecycleOf, trackRunLifecycle, type RunLifecycle } from '../run-lifecycle';
import { heldSettleSessions } from './held-settle-fixture';

/**
 * The run lifecycle read against a real pi 1.4.0 session, whose user extension holds each window open: the
 * `agent_before_settle` handlers (pi still streams), the `agent_settled` handlers (pi is idle but defers a prompt,
 * agent-session.js:685-689, :1632-1634), and the run pi opens after a settle from a prompt it deferred into it (:695-703).
 */

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const state = (run: RunLifecycle) => ({ phase: run.phase, streaming: run.streaming, settling: run.settling, mayQueue: run.mayQueue, busy: run.busy });

const settledEvents = (session: AgentSession, order: string[]): void => {
  session.subscribe((event) => {
    if (event.type === 'agent_settled') order.push('agent_settled');
  });
};

describe('the run lifecycle of a real pi session', () => {
  it('reports each window of a run, and waits for none once pi is idle', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.')], { beforeSettle: true });
    const run = trackRunLifecycle(held.session);
    const idle = { phase: 'start', streaming: false, settling: false, mayQueue: false, busy: false };
    expect(state(run)).toEqual(idle);
    expect(run.untilSettled()).toBeNull();
    expect(run.untilRunEnds()).toBeNull();
    expect(run.untilIdle()).toBeNull();

    const beforeSettle = held.holdBeforeSettle();
    const settle = held.hold();
    const prompt = held.session.prompt('first');
    await within(beforeSettle.waiting, 10_000, 'the agent_before_settle handler');
    expect(state(run)).toEqual({ phase: 'settle', streaming: true, settling: false, mayQueue: true, busy: true });
    expect(run.untilSettled()).toBeNull();

    beforeSettle.release();
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    expect(state(run)).toEqual({ phase: 'settle', streaming: false, settling: true, mayQueue: true, busy: true });
    const settled = run.untilSettled();
    expect(settled).not.toBeNull();

    settle.release();
    await within(settled!, 10_000, 'the settle');
    await within(prompt, 10_000, 'the prompt');
    expect(state(run)).toEqual(idle);
    run.dispose();
  }, 30_000);

  it('ends a wait for the run open now at its agent_settled, and a wait for idle only after the run pi opens from that settle', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Follow-up.')], { input: true });
    const run = trackRunLifecycle(held.session);
    const order: string[] = [];
    settledEvents(held.session, order);
    const settle = held.hold();
    held.sendFromNextSettle('follow-up');
    const prompt = held.session.prompt('first');
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    const ended = run.untilRunEnds()!.then(() => order.push('run ended'));
    const idle = run.untilIdle()!.then(() => order.push('idle'));
    // The prompt pi deferred into the settle waits in its input handlers, with no run open yet.
    const input = held.holdInput();
    settle.release();
    await within(input.waiting, 10_000, "the deferred prompt's input handler");
    await sleep(200);
    expect(order).toEqual(['agent_settled', 'run ended']);
    expect(run.streaming).toBe(false);

    input.release();
    await within(Promise.all([ended, idle, prompt]), 10_000, 'the waits');
    expect(order).toEqual(['agent_settled', 'run ended', 'agent_settled', 'idle']);
    run.dispose();
  }, 30_000);

  it('ends its waits as their signal aborts, and as the lifecycle is disposed', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.')]);
    const run = trackRunLifecycle(held.session);
    const settle = held.hold();
    const prompt = held.session.prompt('first');
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    const stop = new AbortController();
    const settled = run.untilSettled(stop.signal)!;
    const idle = run.untilIdle(stop.signal)!;
    stop.abort();
    await within(Promise.all([settled, idle]), 1_000, 'the waits their signal ended');
    expect(run.untilSettled(stop.signal)).toBeNull();

    const ended = run.untilRunEnds()!;
    run.dispose();
    await within(ended, 1_000, 'the wait the disposal ended');
    expect(() => runLifecycleOf(held.session)).toThrow('No run lifecycle is bound to this pi session.');
    settle.release();
    await within(prompt, 10_000, 'the prompt');
  }, 30_000);

  it('is one per session: a second bind throws until the first is disposed', async () => {
    const held = await sessions.boot([]);
    const run = trackRunLifecycle(held.session);
    expect(runLifecycleOf(held.session)).toBe(run);
    expect(() => trackRunLifecycle(held.session)).toThrow('This pi session already has a run lifecycle.');
    run.dispose();
    const next = trackRunLifecycle(held.session);
    expect(runLifecycleOf(held.session)).toBe(next);
    next.dispose();
  });
});
