import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageBlock } from '@shared/types/content';
import { cacheResultImages, dropResultImages, holdResultImages, holdResultImageUrl, releaseResultImages } from '../result-image-cache';

const block = (): ImageBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });

let revoked: string[] = [];
let run = 0;
// the cache is module state, so each test names its own keys
const key = (name: string): string => `test-${run}-${name}`;

beforeEach(() => {
  run += 1;
  revoked = [];
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the page\'s result image cache', () => {
  it('decodes images once per key and hands the same URLs to every holder', () => {
    const urls = cacheResultImages(key('a'), [block(), block()]);
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.startsWith('blob:'))).toBe(true);
    expect(cacheResultImages(key('a'), [block()])).toBe(urls);
    expect(holdResultImages(key('a'))).toBe(urls);
    expect(holdResultImages(key('missing'))).toBeUndefined();
    for (let i = 0; i < 3; i++) releaseResultImages(key('a'));
  });

  it('keeps a released entry for the next view, and lets it go only to make room, never one that is held', () => {
    const kept = cacheResultImages(key('held'), [block()]);
    const freed = cacheResultImages(key('freed'), [block()]);
    releaseResultImages(key('freed'));
    expect(revoked).not.toContain(freed[0]);
    expect(holdResultImages(key('freed'))).toBe(freed);
    releaseResultImages(key('freed'));

    for (let i = 0; i < 40; i++) {
      cacheResultImages(key(`fill-${i}`), [block()]);
      releaseResultImages(key(`fill-${i}`));
    }
    expect(revoked).toContain(freed[0]);
    expect(revoked).not.toContain(kept[0]);
    expect(holdResultImages(key('freed'))).toBeUndefined();
    releaseResultImages(key('held'));
  });

  it('forgets a dropped entry at once, unless another holder still shows it', () => {
    const urls = cacheResultImages(key('thumb'), [block()]);
    const release = holdResultImageUrl(urls[0]!);
    dropResultImages(key('thumb'));
    expect(revoked).not.toContain(urls[0]);
    release();
    release();
    dropResultImages(key('thumb'));
    expect(revoked).toContain(urls[0]);
    expect(holdResultImages(key('thumb'))).toBeUndefined();
    dropResultImages(key('thumb'));
    expect(revoked.filter((url) => url === urls[0])).toHaveLength(1);
  });
});
