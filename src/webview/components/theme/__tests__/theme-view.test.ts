import { describe, expect, it } from 'vitest';
import { BUILTIN_PALETTES, BUILTIN_THEME } from '@shared/themes/builtin';
import { BUILTIN_UI_STACK } from '@shared/themes/fonts';
import type { ThemeFile } from '@shared/themes/schema';
import { thumbUrl } from '@shared/themes/wallpapers';
import { isHexColor, lookPalette, miniatureNodes, miniatureStyle, miniCharacters, shownKinds, type MiniNode } from '../theme-view';

// The miniature draws a theme's characters in place of the sample projects' letters, each its idle state's first frame.

const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const THEME: ThemeFile = {
  ...BUILTIN_THEME,
  id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10',
  name: 'Arcade copy',
  characters: {
    name: 'Arcade',
    characters: [
      { name: 'Pip', states: { idle: { strip: { asset: SHA(1), frameWidth: 10, frameHeight: 10, frames: 2, fps: 2 } } } },
      { name: 'Gif', states: { idle: { asset: SHA(2) } } },
    ],
  },
  assets: {
    [SHA(1)]: { kind: 'sprite', mime: 'image/svg+xml', bytes: 10, width: 20, height: 10, frames: 2, durationMs: 1000, license: {} },
    [SHA(2)]: { kind: 'sprite', mime: 'image/gif', bytes: 10, width: 16, height: 16, frames: 8, license: {} },
  },
};

const all = (nodes: readonly MiniNode[]): MiniNode[] => nodes.flatMap((n) => [n, ...all(n.children ?? [])]);

describe('the miniature\'s characters', () => {
  it('takes each character\'s first idle frame: a strip clipped to one frame, an animated image its still frame', () => {
    expect(miniCharacters(THEME)).toEqual([
      { href: `app://damocles/theme-blob/${SHA(1)}`, width: 10, height: 10, frames: 2 },
      { href: `app://damocles/theme-cache/${SHA(2)}/still.png`, width: 16, height: 16, frames: 1 },
    ]);
    expect(miniCharacters(BUILTIN_THEME)).toEqual([]);
  });

  it('draws them in place of the first projects\' letters, one frame wide and with square pixels', () => {
    const nodes = all(miniatureNodes(THEME, 'dark', 'm1'));
    const images = nodes.filter((n) => n.tag === 'image' && String(n.attrs['href']).includes(SHA(1)));
    expect(images).toHaveLength(1);
    expect(images[0]!.attrs).toMatchObject({ width: 20, height: 10, preserveAspectRatio: 'none', style: 'image-rendering:pixelated', 'data-testid': 'mini-character' });
    expect(nodes.find((n) => n.tag === 'svg' && n.children?.includes(images[0]!))!.attrs).toMatchObject({ width: 8, height: 8, viewBox: '0 0 10 10' });
    // the letters of the two projects with characters are gone; the other two keep theirs
    const letters = nodes.filter((n) => n.tag === 'text' && /^[A-Z]$/.test(n.text ?? '')).map((n) => n.text);
    expect(letters).toEqual(['I', 'N']);
  });
});

describe('what the miniature puts into a style', () => {
  it('is a hex color and nothing else', () => {
    expect(['#e0a030', '#e0a03080', '#E0A030'].every(isHexColor)).toBe(true);
    for (const value of ['url(https://example.com/a.png)', 'red', '#e0a03', '#e0a030;all:unset', ' #e0a030', undefined, 7]) expect(isHexColor(value), String(value)).toBe(false);
  });

  it('draws no window for a look whose seeds are not all colors', () => {
    const dark = THEME.looks.dark!;
    for (const accent of ['url(https://example.com/a.png)', 'red', '#e0a03080', undefined]) {
      const colors = { ...dark.colors, accent } as typeof dark.colors;
      expect(lookPalette({ ...THEME, looks: { dark: { colors } } }, 'dark'), String(accent)).toBeUndefined();
      expect(miniatureNodes({ ...THEME, looks: { dark: { colors } } }, 'dark', 'm1')).toEqual([]);
    }
    expect(lookPalette({ ...THEME, looks: { dark: { colors: { ...dark.colors, accent: '#E0A030' } } } }, 'dark')).toBeDefined();
  });

  it('leaves out every palette value that is not a lowercase hex color', () => {
    const style = miniatureStyle({ ...BUILTIN_PALETTES.dark, '--d-bg': 'url(https://example.com/a.png)', '--d-text': 'red', '--d-accent-fill': '#E0A030', '--d-card': '#101820' });
    expect(style['--m-card']).toBe('#101820');
    expect(Object.keys(style)).not.toEqual(expect.arrayContaining(['--m-bg', '--m-text', '--m-accent']));
    expect(Object.values(style).every((value) => /^#[0-9a-f]{6,8}$/.test(value))).toBe(true);
  });

  it('names a font only when its name and its asset key hold, so a group\'s style gains no declaration', () => {
    const styled = (fonts: NonNullable<NonNullable<ThemeFile['style']>['fonts']>): string => String(miniatureNodes({ ...THEME, style: { fonts } }, 'dark', 'm1')[0]!.attrs['style']);
    expect(styled({ ui: { installed: 'Iosevka' } })).toContain(`font-family:'Iosevka', ${BUILTIN_UI_STACK};`);
    for (const ui of [{ installed: 'Evil;all:unset' }, { asset: `\\';all:u${'0'.repeat(55)}`, family: 'Name' }]) {
      expect(styled({ ui })).toContain(`font-family:${BUILTIN_UI_STACK};`);
      expect(styled({ ui })).not.toContain('all:u');
    }
  });
});

describe('the looks a miniature draws', () => {
  const darkOnly: ThemeFile = { ...THEME, looks: { dark: THEME.looks.dark! } };
  const lightOnly: ThemeFile = { ...THEME, looks: { light: THEME.looks.light! } };

  it('are both for a split of a theme with both, else the one asked for, else the one it has', () => {
    expect(shownKinds(THEME, 'split')).toEqual(['dark', 'light']);
    expect(shownKinds(THEME, 'light')).toEqual(['light']);
    expect(shownKinds(darkOnly, 'split')).toEqual(['dark']);
    expect(shownKinds(darkOnly, 'light')).toEqual(['dark']);
    expect(shownKinds(lightOnly, 'split')).toEqual(['light']);
    expect(shownKinds(lightOnly, 'dark')).toEqual(['light']);
  });
});

describe('the miniature\'s wallpapers', () => {
  const walled: ThemeFile = {
    ...THEME,
    looks: { dark: { ...THEME.looks.dark!, surfaceOpacity: 0.7, wallpapers: [{ panels: { chat: { asset: SHA(3), fit: 'fill', dim: 0.4, blur: 8 }, sidebar: { asset: SHA(4), fit: 'fit', dim: 0.2, blur: 0 } } }] } },
  };
  const images = (nodes: readonly MiniNode[]): string[] => all(nodes).filter((n) => n.tag === 'image' && !String(n.attrs['href']).includes(SHA(1)) && !String(n.attrs['href']).includes(SHA(2))).map((n) => String(n.attrs['href']));
  const dimmed = (nodes: readonly MiniNode[]): number => all(nodes).filter((n) => n.tag === 'rect' && n.attrs['fill-opacity'] !== undefined && n.attrs['width'] === 144).length;

  it('come from the installed theme\'s cache unless the page names where its thumbnails are', () => {
    expect(images(miniatureNodes(walled, 'dark', 'm1'))).toEqual([thumbUrl(SHA(4)), thumbUrl(SHA(3))]);
    expect(images(miniatureNodes(walled, 'dark', 'm1', (asset) => `blob:${asset}`))).toEqual([`blob:${SHA(4)}`, `blob:${SHA(3)}`]);
  });

  it('draws only the thumbnails the page holds: a panel without one is a plain pane, and with none nothing is see-through', () => {
    const some = miniatureNodes(walled, 'dark', 'm1', (asset) => (asset === SHA(4) ? 'blob:held' : ''));
    expect(images(some)).toEqual(['blob:held']);
    expect(dimmed(some)).toBe(0);

    const none = all(miniatureNodes(walled, 'dark', 'm1', () => ''));
    expect(none.filter((n) => n.tag === 'image' && !String(n.attrs['href']).startsWith('app://damocles/theme-'))).toEqual([]);
    expect(none.some((n) => n.tag === 'clipPath' || n.tag === 'filter')).toBe(false);
    expect(none.filter((n) => n.tag === 'rect' && n.attrs['fill-opacity'] === 0.4)).toEqual([]);
    expect(none.filter((n) => n.tag === 'rect' && n.attrs['fill-opacity'] === 0.7)).toEqual([]);
    expect(all(miniatureNodes(walled, 'dark', 'm1')).filter((n) => n.tag === 'rect' && n.attrs['fill-opacity'] === 0.7).length).toBeGreaterThan(0);
  });

  it('names its clips and filters from the id it is given, the same each time it is drawn', () => {
    const ids = (id: string): string[] => all(miniatureNodes({ ...walled, looks: { ...walled.looks, light: THEME.looks.light! } }, 'split', id)).flatMap((n) => (typeof n.attrs['id'] === 'string' ? [n.attrs['id']] : []));
    expect(ids('m1')).toEqual(['m1-dark-wall-sidebar', 'm1-dark-wall-chat', 'm1-dark-blur-chat', 'm1-split']);
    expect(ids('m1')).toEqual(ids('m1'));
    expect(ids('m2').every((id) => id.startsWith('m2-'))).toBe(true);
  });
});
