// Account pictures main serves at app://damocles/forge/avatar/<key> (docs/invariants.md "GitHub and GitLab accounts", avatar
// route): bytes this computer's core fetched and sniffed, kept in an LRU bounded by count and bytes.

export const AVATAR_CACHE_ENTRIES = 300;
export const AVATAR_CACHE_BYTES: number = 32 * 1024 * 1024;

export interface AvatarImage {
  readonly bytes: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface AvatarCache {
  /** The picture for key: from the cache, else from fetch, which answers undefined for a key it does not know. */
  get(key: string): Promise<AvatarImage | undefined>;
}

export function createAvatarCache(fetchAvatar: (key: string) => Promise<AvatarImage | undefined>, limits: { readonly entries: number; readonly bytes: number } = { entries: AVATAR_CACHE_ENTRIES, bytes: AVATAR_CACHE_BYTES }): AvatarCache {
  // Map keeps insertion order: the first entry is the least recently used
  const entries = new Map<string, AvatarImage>();
  const pending = new Map<string, Promise<AvatarImage | undefined>>();
  let total = 0;

  function remember(key: string, image: AvatarImage): void {
    if (image.bytes.byteLength > limits.bytes) return;
    entries.set(key, image);
    total += image.bytes.byteLength;
    for (const [oldest, old] of entries) {
      if (entries.size <= limits.entries && total <= limits.bytes) break;
      entries.delete(oldest);
      total -= old.bytes.byteLength;
    }
  }

  return {
    get(key) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return Promise.resolve(hit);
      }
      const running = pending.get(key);
      if (running) return running;
      const started = fetchAvatar(key).then((image) => {
        if (image) remember(key, image);
        return image;
      }).finally(() => pending.delete(key));
      pending.set(key, started);
      return started;
    },
  };
}
