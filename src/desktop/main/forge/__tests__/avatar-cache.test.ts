import { describe, expect, it, vi } from 'vitest';
import { createAvatarCache, type AvatarImage } from '../avatar-cache';

const image = (bytes: number): AvatarImage => ({ bytes: new Uint8Array(bytes), mime: 'image/png' });

describe('avatar cache', () => {
  it('asks core once per key, also for concurrent loads, and serves hits from memory', async () => {
    const fetch = vi.fn(async () => image(10));
    const cache = createAvatarCache(fetch);
    await Promise.all([cache.get('a'), cache.get('a')]);
    await cache.get('a');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entry past the count or the byte limit, and keeps no miss', async () => {
    const fetch = vi.fn(async (key: string) => (key === 'none' ? undefined : image(key === 'big' ? 60 : 10)));
    const cache = createAvatarCache(fetch, { entries: 2, bytes: 64 });
    await cache.get('a');
    await cache.get('b');
    await cache.get('a');
    await cache.get('c');
    await cache.get('a');
    expect(fetch).toHaveBeenCalledTimes(3);
    await cache.get('b');
    expect(fetch).toHaveBeenCalledTimes(4);
    await cache.get('big');
    await cache.get('a');
    expect(fetch).toHaveBeenCalledTimes(6);
    await cache.get('none');
    await cache.get('none');
    expect(fetch.mock.calls.filter(([key]) => key === 'none')).toHaveLength(2);
  });
});
