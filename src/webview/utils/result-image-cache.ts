import type { ImageBlock } from '@shared/types/content';

// Decoded tool-result images and design question thumbnails of this page as object URLs, least recently used first. Module
// state, never a store, so a card or question grid that mounts again reuses its images instead of asking core for them again.
const MAX_IMAGES = 36;

interface Entry {
  readonly urls: readonly string[];
  // mounted cards and an open lightbox; an entry held by any is never evicted, so no shown image loses its URL
  holds: number;
}

const entries = new Map<string, Entry>();

const imageTotal = (): number => [...entries.values()].reduce((total, entry) => total + entry.urls.length, 0);

function evict(): void {
  for (const [key, entry] of entries) {
    if (imageTotal() <= MAX_IMAGES) return;
    if (entry.holds > 0) continue;
    entries.delete(key);
    for (const url of entry.urls) URL.revokeObjectURL(url);
  }
}

function objectUrl(block: ImageBlock): string {
  const binary = atob(block.source.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: block.source.media_type }));
}

/** The images cached under `key`, held until `releaseResultImages`; undefined when none are. */
export function holdResultImages(key: string): readonly string[] | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  entry.holds += 1;
  return entry.urls;
}

/** Caches `blocks` under `key`, held until `releaseResultImages`. */
export function cacheResultImages(key: string, blocks: readonly ImageBlock[]): readonly string[] {
  const held = holdResultImages(key);
  if (held) return held;
  const urls = blocks.map(objectUrl);
  entries.set(key, { urls, holds: 1 });
  evict();
  return urls;
}

export function releaseResultImages(key: string): void {
  const entry = entries.get(key);
  if (entry && entry.holds > 0) entry.holds -= 1;
  evict();
}

/** Holds the entry that owns `url` (an open lightbox), until the returned release; a URL no entry owns needs no hold. */
export function holdResultImageUrl(url: string): () => void {
  const key = [...entries].find(([, entry]) => entry.urls.includes(url))?.[0];
  if (key === undefined) return () => undefined;
  holdResultImages(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseResultImages(key);
  };
}
