// An install card's preview as core sends it: the design's Aurora Borealis, from a link, with both looks, a moving wallpaper,
// two bundled fonts, custom CSS in two regions, characters and a window arrangement.
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { ThemeInstallPreview } from '@shared/themes/install';

export const AURORA_ID = '9b2f4c1e-6a7d-4e3b-8c5f-1d2e3f4a5b6c';
const STILL = '1'.repeat(64);
const MOVING = '2'.repeat(64);

export function installPreview(overrides: Partial<ThemeInstallPreview> = {}): ThemeInstallPreview {
  return {
    installId: 'install-1',
    source: { kind: 'link', host: 'raw.githubusercontent.com', fileName: 'aurora-borealis.damocles-theme' },
    format: 'damocles',
    about: { name: 'Aurora Borealis', author: 'nlights', license: 'MIT' },
    theme: { ...BUILTIN_THEME, id: AURORA_ID, name: 'Aurora Borealis' },
    wallpapers: [
      { sha256: STILL, kind: 'image', mime: 'image/webp', bytes: 2_400_000, width: 3840, height: 2160, placements: [{ look: 'light', panels: ['sidebar'], span: false }], flash: 'none' },
      { sha256: MOVING, kind: 'video', mime: 'video/webm', bytes: 18_000_000, width: 1920, height: 1080, durationMs: 38_000, placements: [{ look: 'dark', panels: ['chat', 'sidebar'], span: true }], flash: 'clear' },
    ],
    fonts: [
      { family: 'Iosevka', role: 'mono', source: 'bundled', bytes: 400_000, license: { spdx: 'OFL-1.1' } },
      { family: 'Inter', role: 'ui', source: 'bundled', bytes: 300_000, license: { spdx: 'OFL-1.1' } },
    ],
    css: [{ region: 'transcript', bytes: 400, dropped: [] }, { region: 'sidebar', bytes: 200, dropped: [] }],
    characters: { name: 'Pixel set', count: 6 },
    arrangement: true,
    contrast: [],
    totalBytes: 4_400_000,
    warnings: [],
    ...overrides,
  };
}

export const CLASH = { themeId: '3c4d5e6f-0000-4000-8000-000000000001', name: 'Aurora Borealis', keepBothName: 'Aurora Borealis 2', replaceable: true, keepsCopy: false } as const;
