import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeldTimers } from '../held-timers';
import { THEME_APPLIED_TIMEOUT_MS, ThemeAcks } from '../theme-acks';

// A draft capture waits until the shell and the visible chat view painted the theme revision main sends now.

let revision = 0;
const shell = {};
const chat = {};
const acks = (more: Partial<ConstructorParameters<typeof ThemeAcks>[0]> = {}): ThemeAcks => new ThemeAcks({ revision: () => revision, ...more });

beforeEach(() => {
  vi.useFakeTimers();
  revision = 1;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ThemeAcks.until', () => {
  it('answers at once when every page already painted the revision or a newer one', async () => {
    const theme = acks();
    theme.acknowledged(shell, 1);
    theme.acknowledged(chat, 1);
    await expect(theme.until([shell, chat], new AbortController().signal)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for every page, then clears its timer and its abort listener', async () => {
    const theme = acks();
    const stop = new AbortController();
    const remove = vi.spyOn(stop.signal, 'removeEventListener');
    const waiting = theme.until([shell, chat], stop.signal);
    theme.acknowledged(shell, 1);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    theme.acknowledged(chat, 1);
    await expect(waiting).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    // a timeout that cannot fire after success, and a later abort that reaches nobody
    stop.abort(new Error('late'));
    await vi.advanceTimersByTimeAsync(THEME_APPLIED_TIMEOUT_MS);
  });

  it('answers false once the timeout passes without every page', async () => {
    const theme = acks();
    const waiting = theme.until([shell, chat], new AbortController().signal);
    theme.acknowledged(shell, 1);
    await vi.advanceTimersByTimeAsync(THEME_APPLIED_TIMEOUT_MS - 1);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe(false);
    // a page that acknowledges after the timeout wakes no waiter
    theme.acknowledged(chat, 1);
  });

  it('rejects with the reason when the signal aborts, and clears its timer', async () => {
    const theme = acks();
    const stop = new AbortController();
    const waiting = theme.until([shell], stop.signal);
    stop.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    expect(vi.getTimerCount()).toBe(0);
    const aborted = new AbortController();
    aborted.abort(new Error('before'));
    expect(() => theme.until([shell], aborted.signal)).toThrow('before');
  });

  it('ignores an older acknowledgement that lands late', async () => {
    const theme = acks();
    revision = 3;
    theme.acknowledged(shell, 3);
    theme.acknowledged(shell, 2);
    await expect(theme.until([shell], new AbortController().signal)).resolves.toBe(true);
  });

  it('drops an acknowledgement of a revision main never sent', async () => {
    const theme = acks();
    theme.acknowledged(shell, Number.MAX_SAFE_INTEGER);
    revision = 2;
    const waiting = theme.until([shell], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(THEME_APPLIED_TIMEOUT_MS);
    await expect(waiting).resolves.toBe(false);
  });

  it('forgets what a page painted once its document goes, so a reloaded page must paint again', async () => {
    const theme = acks();
    theme.acknowledged(shell, 1);
    theme.forget(shell);
    const waiting = theme.until([shell], new AbortController().signal);
    await Promise.resolve();
    theme.acknowledged(shell, 1);
    await expect(waiting).resolves.toBe(true);
  });

  it('waits again, within the same timeout, when the revision moved on while it waited', async () => {
    const theme = acks();
    const waiting = theme.until([shell], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(THEME_APPLIED_TIMEOUT_MS - 10);
    // the paint started a read that changed the look again before the page acknowledged the first revision
    revision = 2;
    theme.acknowledged(shell, 1);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await expect(waiting).resolves.toBe(false);

    const again = theme.until([shell], new AbortController().signal);
    theme.acknowledged(shell, 2);
    await expect(again).resolves.toBe(true);
  });

  it('times out by the timers it was given, which an end-to-end run holds', async () => {
    const held = new HeldTimers();
    held.hold(THEME_APPLIED_TIMEOUT_MS);
    const theme = acks({ setTimer: held.setTimer, clearTimer: held.clearTimer });
    const waiting = theme.until([shell], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(THEME_APPLIED_TIMEOUT_MS * 4);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    theme.acknowledged(shell, 1);
    await expect(waiting).resolves.toBe(true);
    expect(held.fire()).toBe(0);
  });
});
