import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserRelays, type LocalUserScope } from '../user-relays';
import { GLOBAL_MEMORY_APPLY_TIMEOUT_MS, GLOBAL_MEMORY_READ_TIMEOUT_MS } from '../../../../shared/remote-user';

const relays = (local: Partial<LocalUserScope>) => new UserRelays({
  resolveCredential: async () => ({ type: 'none' }),
  clientAuth: async () => ({ providers: {} }),
  voice: false,
  homedir: '/home/u',
  userSettingKeys: () => [],
  userValue: () => undefined,
  hostPolicy: () => ({ allowBypass: false }),
  local: local as LocalUserScope,
  log: () => undefined,
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe('a remote core\'s global memory relays through main', () => {
  it('passes a search\'s filters to this computer\'s core', async () => {
    const memorySearch = vi.fn(async () => []);
    await relays({ memorySearch }).memorySearch('ssh+h', '', 5, ['global'], false, { since: 1, until: 2, includeForgotten: true });
    expect(memorySearch).toHaveBeenCalledWith('', 5, ['global'], false, { since: 1, until: 2, includeForgotten: true });
  });

  it('fails a read this computer\'s core leaves unanswered once GLOBAL_MEMORY_READ_TIMEOUT_MS pass', async () => {
    vi.useFakeTimers();
    const user = relays({ memorySearch: never, memoryProfile: never, memoryResolve: never });
    const reads = [user.memorySearch('ssh+h', 'kiwi', 5, ['global']), user.memoryProfile(), user.memoryResolve(['g1'])];
    const outcomes = reads.map((read) => read.then(() => 'answered', (err: Error) => err.message));
    await vi.advanceTimersByTimeAsync(GLOBAL_MEMORY_READ_TIMEOUT_MS - 1);
    let settled = 0;
    for (const outcome of outcomes) void outcome.then(() => settled++);
    await Promise.resolve();
    expect(settled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(outcomes)).toEqual([
      `This computer's core did not answer user.memory.search within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`,
      `This computer's core did not answer user.memory.profile within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`,
      `This computer's core did not answer user.memory.resolve within ${GLOBAL_MEMORY_READ_TIMEOUT_MS} ms`,
    ]);
  });

  it('gives an apply GLOBAL_MEMORY_APPLY_TIMEOUT_MS, longer than a read, before it fails', async () => {
    vi.useFakeTimers();
    const user = relays({ memoryApply: never });
    const outcome = user.memoryApply('ssh+h', [{ end: 10, write: { uuid: 'u1', kind: 'fact', content: 'c' } }]).then(() => 'answered', (err: Error) => err.message);
    let settled = false;
    void outcome.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(GLOBAL_MEMORY_APPLY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(`This computer's core did not answer user.memory.apply within ${GLOBAL_MEMORY_APPLY_TIMEOUT_MS} ms`);
  });

  it('answers as soon as this computer\'s core does, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const user = relays({ memoryResolve: async () => [{ id: 'g1', gone: true, byUser: false }] });
    expect(await user.memoryResolve(['g1'])).toEqual([{ id: 'g1', gone: true, byUser: false }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
