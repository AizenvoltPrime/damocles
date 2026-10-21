import { describe, expect, it } from 'vitest';
import { createParentPortTransport, type ParentPort } from '../parent-port';

function fakePort(): ParentPort & { readonly posted: unknown[]; deliver(data: unknown): void } {
  const listeners: Array<(event: { readonly data: unknown }) => void> = [];
  const posted: unknown[] = [];
  return {
    posted,
    on: (_event, listener) => listeners.push(listener),
    postMessage: (message) => posted.push(message),
    deliver: (data) => {
      for (const listener of listeners) listener({ data });
    },
  };
}

describe('the parentPort transport', () => {
  it('takes main\'s first message as the init and holds the rest until core opens, in order', async () => {
    const port = fakePort();
    const transport = createParentPortTransport(port);
    port.deliver({ init: true });
    port.deliver({ kind: 'mirror', n: 1 });
    port.deliver({ kind: 'request', n: 2 });
    expect(await transport.init).toEqual({ init: true });
    const received: unknown[] = [];
    transport.onMessage((raw) => received.push(raw));
    expect(received).toEqual([]);
    transport.open();
    expect(received).toEqual([{ kind: 'mirror', n: 1 }, { kind: 'request', n: 2 }]);
    port.deliver({ kind: 'event', n: 3 });
    expect(received).toEqual([{ kind: 'mirror', n: 1 }, { kind: 'request', n: 2 }, { kind: 'event', n: 3 }]);
  });

  it('posts to main through the port, and stops delivering to a listener once disposed', () => {
    const port = fakePort();
    const transport = createParentPortTransport(port);
    port.deliver({ init: true });
    transport.post({ kind: 'event', name: 'x' });
    expect(port.posted).toEqual([{ kind: 'event', name: 'x' }]);
    const received: unknown[] = [];
    const subscription = transport.onMessage((raw) => received.push(raw));
    transport.open();
    subscription.dispose();
    port.deliver({ kind: 'event' });
    expect(received).toEqual([]);
  });
});
