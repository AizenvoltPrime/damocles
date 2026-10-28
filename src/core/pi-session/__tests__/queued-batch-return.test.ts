import { describe, expect, it } from 'vitest';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { PiSession } from '../pi-session';

// Messages queued while pi settled a run go out as one send; when core refuses that send, each message goes back on its own.
function sessionWithQueued(refuse: (self: PiSession, prompt: unknown, broadcast: unknown, correlationId: string) => void) {
  const emitted: ExtensionToWebviewMessage[] = [];
  const self = Object.create(PiSession.prototype) as PiSession;
  const session = { sessionId: 'S1' };
  Object.assign(self, {
    runtime: { session },
    processingFlag: false,
    compacting: false,
    runOf: () => ({ settling: false }),
    afterSettleTarget: 'S1',
    afterSettleInputs: [
      { id: 'q-a', text: 'from a', typed: '/fix from a', images: [], content: 'from a' },
      { id: 'q-b', text: 'from b', images: [], content: [{ type: 'text', text: 'from b' }, { type: 'image', data: 'x', mimeType: 'image/png' }] },
    ],
    emit: (message: ExtensionToWebviewMessage) => emitted.push(message),
    sendMessage: async (prompt: unknown, _target: unknown, correlationId: string, broadcast: unknown) => {
      refuse(self, prompt, broadcast, correlationId);
      return 'unsent';
    },
  });
  (self as unknown as { sendAfterSettle(): void }).sendAfterSettle();
  return emitted;
}

const parts = [
  { messageId: 'q-a', content: [{ type: 'text', text: '/fix from a' }] },
  { messageId: 'q-b', content: [{ type: 'text', text: 'from b' }, { type: 'image', data: 'x', mimeType: 'image/png' }] },
];

describe('a refused send of messages queued while pi settled a run', () => {
  it('names the send each chip went into, and returns each message as typed beside the combined text', () => {
    const emitted = sessionWithQueued((self, prompt, broadcast, correlationId) => {
      (self as unknown as { returnPrompt(...args: unknown[]): void }).returnPrompt(prompt, broadcast, 'modelSignInRequired', undefined, correlationId);
    });
    const sentAs = (emitted[0] as { sentAs?: string }).sentAs;
    expect(sentAs).toMatch(/^corr-/);
    expect(emitted.slice(0, 2)).toEqual([
      { type: 'queueCancelled', messageId: 'q-a', sentAs },
      { type: 'queueCancelled', messageId: 'q-b', sentAs },
    ]);
    expect(emitted[2]).toMatchObject({ type: 'promptReturned', reason: 'modelSignInRequired', correlationId: sentAs, parts });
  });

  it('returns each message when a Stop takes the send back before pi had it', () => {
    const emitted = sessionWithQueued((self, prompt, broadcast, correlationId) => {
      Object.assign(self, { adapter: { withdrawEcho: () => undefined } });
      (self as unknown as { returnUnsentMessage(...args: unknown[]): void }).returnUnsentMessage(correlationId, broadcast, prompt);
    });
    expect(emitted.find((message) => message.type === 'interruptRecovery')).toMatchObject({ parts });
  });
});
