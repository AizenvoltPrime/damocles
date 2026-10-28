import { describe, expect, it, vi } from 'vitest';
import type { BrokerAnswer, HeldAuth } from '../../../../shared/remote-user';
import type { PushedCredential } from '../../../core-protocol/messages';
import { keepRunningAtShutdown, PUSH_TIMEOUT_MS, runKey, startKeepRunningRefresh, type KeepRunningDeps, type KeepRunningHost, type KeepRunningRun } from '../keep-running-refresh';

const NOW = 1_000_000_000;
const MIN = 60_000;
const auth: HeldAuth = {
  providers: {
    anthropic: { type: 'oauth', expires: NOW + 23 * MIN + 30_000, hasKey: false, flatFee: false },
    'openai-codex': { type: 'oauth', expires: NOW + 90 * MIN, hasKey: false, flatFee: false },
    'github-copilot': { type: 'oauth', expires: NOW + 7 * MIN, hasKey: false, flatFee: false },
    openai: { type: 'api_key', hasKey: true, flatFee: false },
  },
};

function deps(resolve: (provider: string) => Promise<BrokerAnswer>): KeepRunningDeps & { resolveCredential: ReturnType<typeof vi.fn> } {
  return { resolveCredential: vi.fn((provider: string, _force: boolean) => resolve(provider)), clientAuth: vi.fn(async () => auth), log: vi.fn(), now: () => NOW };
}

const fresh = (provider: string): BrokerAnswer => ({ type: 'oauth', access: `fresh-${provider}`, expiresIn: 8 * 60 * MIN, refresh: '' });

function host(hostId: string, push: KeepRunningHost['push'] = async () => undefined) {
  const pushed: Array<[string, PushedCredential]> = [];
  return {
    pushed,
    host: { hostId, push: vi.fn(async (provider: string, credential: PushedCredential, signal: AbortSignal) => { pushed.push([provider, credential]); await push(provider, credential, signal); }) },
  };
}

const runs: KeepRunningRun[] = [
  { hostId: 'prod-1', panelId: 'chat-1', providers: ['anthropic', 'openai'] },
  { hostId: 'prod-1', panelId: 'chat-2', providers: [] },
  { hostId: 'prod-2', panelId: 'chat-3', providers: ['openai-codex'] },
];

describe('keep running refresh', () => {
  it('force-refreshes exactly the OAuth providers listRuns reported, never another sign-in or a key', async () => {
    const d = deps(async (provider) => fresh(provider));
    const refresh = startKeepRunningRefresh(d, runs);
    expect(await refresh.notes).toEqual(new Map());
    expect(d.resolveCredential.mock.calls.sort()).toEqual([['anthropic', true], ['openai-codex', true]]);
  });

  it('pushes each host only the tokens its own runs reported, with the refresh token left empty', async () => {
    const one = host('prod-1');
    const two = host('prod-2');
    await startKeepRunningRefresh(deps(async (provider) => fresh(provider)), runs).push([one.host, two.host]);
    expect(one.pushed).toEqual([['anthropic', { type: 'oauth', access: 'fresh-anthropic', expiresIn: 8 * 60 * MIN, refresh: '' }]]);
    expect(two.pushed).toEqual([['openai-codex', { type: 'oauth', access: 'fresh-openai-codex', expiresIn: 8 * 60 * MIN, refresh: '' }]]);
  });

  it('a failed refresh (offline) leaves that run\'s row a note with the minutes its current token has left, and pushes nothing for it', async () => {
    const one = host('prod-1');
    const refresh = startKeepRunningRefresh(deps(async (provider) => {
      if (provider === 'anthropic') throw new Error('fetch failed');
      return fresh(provider);
    }), runs);
    expect(await refresh.notes).toEqual(new Map([[runKey('prod-1', 'chat-1'), { provider: 'anthropic', minutesLeft: 23 }]]));
    await refresh.push([one.host]);
    expect(one.pushed).toEqual([]);
  });

  it('notes the provider with the least time left when several of a run\'s refreshes fail', async () => {
    const refresh = startKeepRunningRefresh(deps(async () => { throw new Error('offline'); }), [{ hostId: 'prod-1', panelId: 'chat-1', providers: ['anthropic', 'github-copilot'] }]);
    expect(await refresh.notes).toEqual(new Map([[runKey('prod-1', 'chat-1'), { provider: 'github-copilot', minutesLeft: 7 }]]));
  });

  it('never refreshes or pushes a provider id this computer does not know, whatever a host reported', async () => {
    const d = deps(async (provider) => fresh(provider));
    const one = host('prod-1');
    await startKeepRunningRefresh(d, [{ hostId: 'prod-1', panelId: 'chat-1', providers: ['evil\nprovider', 'not-signed-in'] }]).push([one.host]);
    expect(d.resolveCredential).not.toHaveBeenCalled();
    expect(one.pushed).toEqual([]);
  });

  it('refuses an answer that carries a refresh token, so it never leaves this computer', async () => {
    const one = host('prod-1');
    const refresh = startKeepRunningRefresh(deps(async () => ({ type: 'oauth', access: 'a', expiresIn: MIN, refresh: 'SECRET' }) as unknown as BrokerAnswer), runs);
    await refresh.push([one.host]);
    expect(one.pushed).toEqual([]);
    expect(await refresh.notes).toEqual(new Map([[runKey('prod-1', 'chat-1'), { provider: 'anthropic', minutesLeft: 23 }], [runKey('prod-2', 'chat-3'), { provider: 'openai-codex', minutesLeft: 90 }]]));
  });

  it('waits at most the push bound for a host that never answers', async () => {
    vi.useFakeTimers();
    try {
      const stuck = host('prod-1', (_provider, _credential, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
      const pushed = startKeepRunningRefresh(deps(async (provider) => fresh(provider)), runs).push([stuck.host]);
      let settled = false;
      void pushed.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // a rejection here would cancel the quit, and an OS shutdown's quit could not end
  it('keeps the runs with nothing pushed when this computer\'s core cannot list its sign-ins', async () => {
    vi.useFakeTimers();
    try {
      const d = { ...deps(async (provider) => fresh(provider)), clientAuth: vi.fn(async (): Promise<HeldAuth> => { throw new Error('The Damocles engine is stopped'); }) };
      const one = host('prod-1');
      const refresh = startKeepRunningRefresh(d, runs);
      await expect(refresh.notes).resolves.toEqual(new Map());
      await expect(refresh.push([one.host])).resolves.toBeUndefined();
      expect(one.pushed).toEqual([]);
      expect(d.resolveCredential).not.toHaveBeenCalled();
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('The Damocles engine is stopped'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('at an OS shutdown refreshes and pushes best effort within the shutdown window, with no dialog', async () => {
    vi.useFakeTimers();
    try {
      const one = host('prod-1');
      const two = host('prod-2');
      const slow = deps((provider) => new Promise((resolve) => setTimeout(() => resolve(fresh(provider)), provider === 'anthropic' ? 100 : 10_000)));
      const done = keepRunningAtShutdown(slow, runs, [one.host, two.host], 2000);
      let settled = false;
      void done.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(true);
      // a token goes as soon as its own refresh is done; one still refreshing when the window ends is not pushed
      expect(one.pushed.map(([provider]) => provider)).toEqual(['anthropic']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(two.pushed).toEqual([]);
      expect(slow.resolveCredential.mock.calls.sort()).toEqual([['anthropic', true], ['openai-codex', true]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('keep running with provider sign-ins', () => {
  it('force-refreshes a sign-in-only provider a run reported and pushes it with the enterprise URL its requests need, never a refresh token', async () => {
    const copilot: HeldAuth = { providers: { 'github-copilot': { type: 'oauth', expires: NOW + 10 * MIN, hasKey: false, flatFee: false }, meta: { type: 'oauth', expires: NOW + 10 * MIN, hasKey: false, flatFee: false } } };
    const resolveCredential = vi.fn(async (provider: string, _force: boolean): Promise<BrokerAnswer> =>
      ({ type: 'oauth', access: `fresh-${provider}`, expiresIn: 8 * 60 * MIN, refresh: '', ...(provider === 'github-copilot' ? { enterpriseUrl: 'ghe.example.com' } : {}) }));
    const one = host('prod-1');
    await startKeepRunningRefresh({ resolveCredential, clientAuth: async () => copilot, log: vi.fn(), now: () => NOW }, [{ hostId: 'prod-1', panelId: 'chat-1', providers: ['github-copilot'] }]).push([one.host]);
    expect(resolveCredential.mock.calls).toEqual([['github-copilot', true]]);
    expect(one.pushed).toEqual([['github-copilot', { type: 'oauth', access: 'fresh-github-copilot', expiresIn: 8 * 60 * MIN, refresh: '', enterpriseUrl: 'ghe.example.com' }]]);
  });
});
