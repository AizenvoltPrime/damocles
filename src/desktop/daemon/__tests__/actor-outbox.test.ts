import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR_INTENT_EXPIRY_MS, createActorOutbox, type ActorOutbox } from '../actor-outbox';

interface FakeSession {
  readonly name: string;
}

let lines: string[];
const always = (): boolean => true;
let outbox: ActorOutbox<FakeSession>;

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  outbox = createActorOutbox<FakeSession>({ expiryMs: ACTOR_INTENT_EXPIRY_MS, timers: { setTimeout, clearTimeout }, log: (line) => lines.push(line) });
});

afterEach(() => {
  outbox.dispose();
  vi.useRealTimers();
});

describe('the actor outbox', () => {
  it('waits a minute for the device that asked', () => {
    expect(ACTOR_INTENT_EXPIRY_MS).toBe(60_000);
  });

  it('delivers what a device\'s work held, in the order it was held, once that device is present, to the session it came back on', async () => {
    const delivered: string[] = [];
    const first = outbox.hold('device-a', { what: 'core\'s notifications.show', deliver: (session) => delivered.push(`notice to ${session.name}`) });
    const second = outbox.hold('device-a', { what: 'the new panel view-1', deliver: (session) => delivered.push(`panel to ${session.name}`) });
    await vi.advanceTimersByTimeAsync(ACTOR_INTENT_EXPIRY_MS - 1);
    expect(delivered).toEqual([]);
    // a fresh attach of the same install is the same client, on a new session
    outbox.present('device-a', { name: 'connection-2' }, always);
    expect(delivered).toEqual(['notice to connection-2', 'panel to connection-2']);
    expect(await Promise.all([first, second])).toEqual(['delivered', 'delivered']);
    // nothing is left to deliver again, and no timer is left behind
    outbox.present('device-a', { name: 'connection-3' }, always);
    expect(delivered).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never delivers one device\'s intents to another device', async () => {
    const delivered: string[] = [];
    const held = outbox.hold('device-a', { what: 'core\'s dialogs.ask', deliver: (session) => delivered.push(session.name) });
    outbox.present('device-b', { name: 'connection-b' }, always);
    expect(delivered).toEqual([]);
    outbox.present('device-a', { name: 'connection-a' }, always);
    expect(await held).toBe('delivered');
    expect(delivered).toEqual(['connection-a']);
  });

  it('expires each intent on its own clock, logs it, and never delivers it after', async () => {
    const delivered: string[] = [];
    const early = outbox.hold('device-a', { what: 'core\'s notifications.show', deliver: () => delivered.push('early') });
    await vi.advanceTimersByTimeAsync(30_000);
    const late = outbox.hold('device-a', { what: 'the new panel view-2', deliver: () => delivered.push('late') });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await early).toBe('expired');
    expect(lines.some((line) => line.includes('core\'s notifications.show') && line.includes('device-a') && line.includes('60000 ms'))).toBe(true);
    outbox.present('device-a', { name: 'connection-a' }, always);
    expect(delivered).toEqual(['late']);
    expect(await late).toBe('delivered');
  });

  it('drops an intent whose work was cancelled, also one cancelled before it was held', async () => {
    const delivered: string[] = [];
    const cancel = new AbortController();
    const held = outbox.hold('device-a', { what: 'core\'s trust.request', signal: cancel.signal, deliver: () => delivered.push('cancelled') });
    cancel.abort();
    expect(await held).toBe('aborted');
    expect(await outbox.hold('device-a', { what: 'core\'s trust.request', signal: cancel.signal, deliver: () => delivered.push('pre-cancelled') })).toBe('aborted');
    outbox.present('device-a', { name: 'connection-a' }, always);
    expect(delivered).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('goes on delivering after an intent whose delivery threw, which counts as not delivered', async () => {
    const delivered: string[] = [];
    const failing = outbox.hold('device-a', { what: 'core\'s dialogs.ask', deliver: () => { throw new Error('the channel closed'); } });
    const next = outbox.hold('device-a', { what: 'core\'s notifications.show', deliver: () => delivered.push('next') });
    outbox.present('device-a', { name: 'connection-a' }, always);
    expect(await failing).toBe('aborted');
    expect(await next).toBe('delivered');
    expect(delivered).toEqual(['next']);
    expect(lines.some((line) => line.includes('the channel closed'))).toBe(true);
  });

  it('stops delivering once the session it delivers to closed, and keeps the rest for the next session on their own clocks', async () => {
    const delivered: string[] = [];
    let open = true;
    const closing = outbox.hold('device-a', { what: 'the new panel view-1', deliver: (session) => {
      delivered.push(`view-1 to ${session.name}`);
      open = false;
    } });
    const early = outbox.hold('device-a', { what: 'core\'s dialogs.ask', deliver: (session) => delivered.push(`ask to ${session.name}`) });
    await vi.advanceTimersByTimeAsync(30_000);
    const late = outbox.hold('device-a', { what: 'the new panel view-2', deliver: (session) => delivered.push(`view-2 to ${session.name}`) });
    outbox.present('device-a', { name: 'connection-1' }, () => open);
    expect(await closing).toBe('delivered');
    expect(delivered).toEqual(['view-1 to connection-1']);
    // the earlier one still expires a minute after it was held
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await early).toBe('expired');
    outbox.present('device-a', { name: 'connection-2' }, always);
    expect(await late).toBe('delivered');
    expect(delivered).toEqual(['view-1 to connection-1', 'view-2 to connection-2']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles every intent as aborted on dispose, clears its timers, and holds nothing after', async () => {
    const held = outbox.hold('device-a', { what: 'core\'s notifications.show', deliver: () => undefined });
    outbox.dispose();
    expect(await held).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
    expect(await outbox.hold('device-a', { what: 'core\'s notifications.show', deliver: () => undefined })).toBe('aborted');
  });
});
