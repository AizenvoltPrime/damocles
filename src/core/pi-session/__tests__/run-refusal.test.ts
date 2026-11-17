import { afterEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { promptRefusable, RunRefused } from '../run-refusal';
import { heldSettleSessions } from './held-settle-fixture';

/** A refused run against a real pi 1.5.2 session with patches/README.md's 002, held open by a user extension's handlers. */

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

const refuseStart = { preflightResult: (disposition: string) => { if (disposition === 'started') throw new RunRefused(); } };

const userTexts = (session: AgentSession): string[] =>
  session.sessionManager.getBranch().flatMap((e) => {
    if (e.type !== 'message' || e.message.role !== 'user') return [];
    const content = e.message.content;
    return [typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('')];
  });

describe('a run refused at its start', () => {
  it('resolves false, writes nothing and leaves the session to the next prompt', async () => {
    const held = await sessions.boot([fauxAssistantMessage('Second.')]);
    expect(await within(promptRefusable(held.session, 'first', refuseStart), 10_000, 'the refused prompt')).toBe(false);
    expect(userTexts(held.session)).toEqual([]);

    expect(await within(promptRefusable(held.session, 'second', {}), 10_000, 'the next prompt')).toBe(true);
    expect(userTexts(held.session)).toEqual(['second']);
  }, 30_000);

  it('refuses a deferred prompt without failing the prompt whose settle ran it, and that settle still runs what was deferred after it', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('After.'), fauxAssistantMessage('Third.')]);
    const settle = held.hold();
    const first = held.session.prompt('first');
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    let verdict: string | undefined;
    // pi defers a prompt or a run made while it runs the agent_settled handlers and returns from it at once.
    const deferred = promptRefusable(held.session, 'second', {
      preflightResult: (disposition) => {
        verdict = disposition;
        if (disposition === 'started') throw new RunRefused();
      },
    });
    expect(await within(deferred, 1_000, 'the deferred prompt')).toBe(true);
    expect(verdict).toBeUndefined();
    await within(held.session.sendCustomMessage({ customType: 'after', content: 'after the refusal', display: false }, { triggerTurn: true }), 1_000, 'the deferred run');

    settle.release();
    await within(first, 10_000, 'the settling prompt');
    expect(verdict).toBe('started');
    expect(userTexts(held.session)).toEqual(['first']);
    expect(held.session.sessionManager.getBranch().flatMap((e) => (e.type === 'custom_message' ? [e.customType] : e.type === 'message' && e.message.role !== 'system' ? [e.message.role] : [])))
      .toEqual(['user', 'assistant', 'after', 'assistant']);

    expect(await within(promptRefusable(held.session, 'third', {}), 10_000, 'the next prompt')).toBe(true);
    expect(userTexts(held.session)).toEqual(['first', 'third']);
  }, 30_000);

  it('keeps the nextTurn messages of a refused run for the next run', async () => {
    const requests: string[][] = [];
    const held = await sessions.boot([(context) => {
      requests.push(context.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')}`));
      return fauxAssistantMessage('Next.');
    }]);
    await held.session.sendCustomMessage({ customType: 'note', content: 'context for the next turn', display: false }, { deliverAs: 'nextTurn' });

    expect(await within(promptRefusable(held.session, 'refused', refuseStart), 10_000, 'the refused prompt')).toBe(false);
    expect(await within(promptRefusable(held.session, 'next', {}), 10_000, 'the next prompt')).toBe(true);

    expect(requests).toEqual([['user: next', 'user: context for the next turn']]);
  }, 30_000);

  it('rethrows any other failure of the prompt', async () => {
    const held = await sessions.boot([]);
    const failing = promptRefusable(held.session, 'first', { preflightResult: () => { throw new Error('not a refusal'); } });
    await expect(within(failing, 10_000, 'the failing prompt')).rejects.toThrow('not a refusal');
  }, 30_000);
});
