import { describe, expect, it } from 'vitest';
import { channelTransport } from '../channel-transport';
import { CodecError, encode } from '../codec';
import type { MessageChannel } from '../mux';

function fakeChannel(): MessageChannel & { readonly sent: Uint8Array[]; deliver(bytes: Uint8Array): void } {
  const sent: Uint8Array[] = [];
  const listeners = new Set<(message: Uint8Array) => void>();
  return {
    id: 2,
    sent,
    send: (message) => {
      sent.push(message);
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    deliver: (bytes) => {
      for (const listener of [...listeners]) listener(bytes);
    },
  };
}

describe('channelTransport', () => {
  it('refuses to post a message its peer would refuse, sending nothing, so only that message fails', () => {
    const channel = fakeChannel();
    const transport = channelTransport(channel, 1024, () => undefined);
    expect(() => transport.post({ text: 'x'.repeat(2048) })).toThrow(CodecError);
    expect(channel.sent).toEqual([]);
    transport.post({ text: 'fits' });
    expect(channel.sent).toEqual([encode({ text: 'fits' })]);
  });

  it('decodes each message once for every listener, and reports a bad one once', () => {
    const channel = fakeChannel();
    const violations: string[] = [];
    const transport = channelTransport(channel, 1024, (reason) => violations.push(reason));
    const first: unknown[] = [];
    const second: unknown[] = [];
    transport.onMessage((value) => first.push(value));
    transport.onMessage((value) => second.push(value));
    channel.deliver(encode({ a: 1 }));
    expect(first).toEqual([{ a: 1 }]);
    expect(second[0]).toBe(first[0]);
    channel.deliver(Uint8Array.from([99]));
    expect(violations).toEqual(['channel 2: an unknown tag 99']);
  });
});
