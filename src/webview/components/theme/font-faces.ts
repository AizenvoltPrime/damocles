import { bundledFonts } from '@shared/themes/fonts';
import type { ThemeFile } from '@shared/themes/schema';
import { themeBlobUrl } from '@shared/themes/wallpapers';

// one FontFace per family in the page, whichever miniature declared it first
const declared = new Set<string>();

/**
 * Declares a theme's bundled fonts in this page, for its miniature's sample text from 34rem. A face added this way loads only
 * once text uses it, and main serves a blob only while a theme or draft it read names it, so a face that failed to load is
 * taken out again and the next miniature of the font declares it afresh.
 */
export function declareBundledFonts(theme: Pick<ThemeFile, 'style' | 'assets'>): void {
  if (typeof FontFace === 'undefined') return;
  for (const font of bundledFonts(theme)) {
    if (declared.has(font.family)) continue;
    declared.add(font.family);
    const face = new FontFace(font.family, `url(${themeBlobUrl(font.sha256)})`, { display: 'swap' });
    document.fonts.add(face);
    face.loaded.catch(() => {
      document.fonts.delete(face);
      declared.delete(font.family);
    });
  }
}
