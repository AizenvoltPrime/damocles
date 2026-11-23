import { shallowRef } from 'vue';
import type { ThemeInstallPreview } from '@shared/themes/install';
import { cacheResultImages, dropResultImages } from './result-image-cache';

// The wallpaper thumbnails of this page's open install prompts, as object URLs in the result image cache. Module state, never a
// store: a prompt's entries are held until it is dropped, and no later view can ask for them again, so they go at once.
const WEBP = 'data:image/webp;base64,';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

type Thumbs = Readonly<Record<string, string>>;
const NONE: Thumbs = {};
// by prompt id, then by the wallpaper's sha256; replaced on every change, so a card that reads it follows it
const held = shallowRef<ReadonlyMap<string, Thumbs>>(new Map());

const keyOf = (promptId: string, sha256: string): string => `themeInstall\0${promptId}\0${sha256}`;

/** Moves the thumbnails of `preview` into the page's cache under `promptId` and answers the preview without them. */
export function takeInstallThumbs(promptId: string, preview: ThemeInstallPreview): ThemeInstallPreview {
  const known = held.value.get(promptId) ?? NONE;
  const added: Record<string, string> = {};
  const wallpapers = preview.wallpapers.map(({ thumb, ...wallpaper }) => {
    const data = thumb?.startsWith(WEBP) === true ? thumb.slice(WEBP.length) : '';
    if (known[wallpaper.sha256] === undefined && added[wallpaper.sha256] === undefined && BASE64.test(data)) {
      const [url] = cacheResultImages(keyOf(promptId, wallpaper.sha256), [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data } }]);
      if (url !== undefined) added[wallpaper.sha256] = url;
    }
    return wallpaper;
  });
  if (Object.keys(added).length > 0) held.value = new Map(held.value).set(promptId, { ...known, ...added });
  return { ...preview, wallpapers };
}

/** The thumbnails this page holds for a prompt, by the wallpaper's sha256. */
export function installThumbs(promptId: string): Thumbs {
  return held.value.get(promptId) ?? NONE;
}

/** Lets go of a prompt's thumbnails, or of every prompt's when none is named. */
export function dropInstallThumbs(promptId?: string): void {
  const next = new Map(held.value);
  for (const [id, thumbs] of held.value) {
    if (promptId !== undefined && id !== promptId) continue;
    for (const sha256 of Object.keys(thumbs)) dropResultImages(keyOf(id, sha256));
    next.delete(id);
  }
  if (next.size !== held.value.size) held.value = next;
}
