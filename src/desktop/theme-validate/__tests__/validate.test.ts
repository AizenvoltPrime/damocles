// The store validator's verdict on a file, with the renderer's jobs faked: host.ts runs the real ones under Electron.
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { gif, png } from '../../../shared/themes/testing/image-fixtures';
import type { AssetMeta, ThemeFile } from '../../../shared/themes/schema';
import { checkImported, licenseErrors, textErrors, thumbnailPlan, validateStoreTheme, type RenderJobs } from '../validate';

const COLORS = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const IMAGE = png(640, 400);
const OTHER = png(320, 200);
const MOVING = gif(64, 64, 4);
const license = { spdx: 'CC0-1.0' };
const still = (bytes: Uint8Array, width: number, height: number): AssetMeta => ({ kind: 'image', mime: 'image/png', bytes: bytes.length, width, height, license });

function theme(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Dusk',
    description: 'A fixture.',
    author: 'Ada',
    version: '1.0.0',
    license: 'CC0-1.0',
    looks: { dark: { colors: COLORS, wallpapers: [{ span: { asset: sha(OTHER), panels: ['sidebar', 'editor'], fit: 'fill' }, panels: { chat: { asset: sha(IMAGE), fit: 'fill', dim: 0.3, blur: 0 } } }] } },
    assets: { [sha(IMAGE)]: still(IMAGE, 640, 400), [sha(OTHER)]: still(OTHER, 320, 200) },
    ...extra,
  };
}
const archive = (json: Record<string, unknown>, files: readonly Uint8Array[] = [IMAGE, OTHER], ext = 'png'): Uint8Array =>
  zipSync({ 'theme.json': new TextEncoder().encode(JSON.stringify(json)), ...Object.fromEntries(files.map((bytes) => [`assets/${sha(bytes)}.${ext}`, bytes])) });

function jobs(overrides: Partial<RenderJobs> = {}): { readonly render: () => Promise<RenderJobs>; readonly analyzed: string[]; readonly checked: string[] } {
  const analyzed: string[] = [];
  const checked: string[] = [];
  const real: RenderJobs = {
    analyze: async (sha256) => {
      analyzed.push(sha256);
      // each wallpaper's thumbnail differs, as its bytes do
      return { flagged: false, thumb: new TextEncoder().encode(`thumb of ${sha256}`) };
    },
    sprite: async (sha256) => {
      checked.push(sha256);
      return { flagged: false };
    },
  };
  return { render: async () => ({ ...real, ...overrides }), analyzed, checked };
}

describe('validateStoreTheme', () => {
  it('accepts a theme with every license declared, and writes its thumbnails in the order the look shows them', async () => {
    const { render, analyzed } = jobs();
    const written: string[] = [];
    const bytes = archive(theme());
    const verdict = await validateStoreTheme(bytes, 'C:\\themes\\dusk.damocles-theme', render, async (file) => {
      written.push(file);
    });
    expect(verdict).toMatchObject({ ok: true, sha256: sha(bytes), bytes: bytes.length, entry: { name: 'Dusk', author: 'Ada', version: '1.0.0', kinds: ['dark'], licenses: ['CC0-1.0'], hasCss: false, hasMoving: false } });
    expect(analyzed.sort()).toEqual([sha(IMAGE), sha(OTHER)].sort());
    const thumbs = verdict.ok ? verdict.entry.thumbnails.dark! : [];
    // the spanning image first, by its first panel, then each panel's own
    expect(thumbs.map((thumb) => thumb.panel)).toEqual(['sidebar', 'chat']);
    expect(written).toEqual(thumbs.map((thumb) => thumb.file));
    expect(thumbs[0]!.file).toBe(`${sha(new TextEncoder().encode(`thumb of ${sha(OTHER)}`))}.webp`);
  });

  it('refuses a file that is not a .damocles-theme, and one the import refuses, before any renderer job', async () => {
    const { render, analyzed } = jobs();
    const started = vi.fn(render);
    const none = async (): Promise<void> => undefined;
    expect(await validateStoreTheme(archive(theme()), 'dusk.zip', started, none)).toMatchObject({ ok: false, errors: ['dusk.zip is not a .damocles-theme file'] });
    const broken = await validateStoreTheme(archive(theme({ looks: {} })), 'dusk.damocles-theme', started, none);
    expect(broken.ok).toBe(false);
    expect(started).not.toHaveBeenCalled();
    expect(analyzed).toEqual([]);
  });

  it('refuses a theme with no license of its own or an asset with none, naming each', async () => {
    const { render } = jobs();
    const unlicensed = theme({ license: undefined, assets: { [sha(IMAGE)]: { ...still(IMAGE, 640, 400), license: {} }, [sha(OTHER)]: still(OTHER, 320, 200) } });
    const verdict = await validateStoreTheme(archive(unlicensed), 'dusk.damocles-theme', render, async () => undefined);
    expect(verdict).toEqual({ ok: false, sha256: expect.any(String), bytes: expect.any(Number), errors: [
      'the theme declares no license (Details › License)',
      `the image ${sha(IMAGE)} declares no license (an SPDX id or its license text)`,
    ] });
  });

  it('refuses custom CSS the sanitizer removes, part by part', async () => {
    const { render } = jobs();
    const verdict = await validateStoreTheme(archive(theme({ css: { sidebar: '[data-trusted] { color: red }' } })), 'dusk.damocles-theme', render, async () => undefined);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.errors[0]).toContain('custom CSS in sidebar that the sanitizer removes (selector)');
  });

  it('says how many removed parts of custom CSS its list of 100 leaves out', async () => {
    const { render } = jobs();
    const verdict = await validateStoreTheme(archive(theme({ css: { sidebar: 'p { display: none }'.repeat(103) } })), 'dusk.damocles-theme', render, async () => undefined);
    expect(!verdict.ok && verdict.errors).toHaveLength(101);
    expect(!verdict.ok && verdict.errors.at(-1)).toBe('3 more parts of custom CSS that the sanitizer removes');
  });

  it('refuses a wallpaper the renderer flags, with the time it names, and one whose job fails, and writes no thumbnail', async () => {
    const written = vi.fn(async () => undefined);
    const flagged = jobs({ analyze: async (sha256) => (sha256 === sha(IMAGE) ? { flagged: true, atMs: 250, thumb: new Uint8Array(1) } : Promise.reject(new Error('the image did not decode'))) });
    const verdict = await validateStoreTheme(archive(theme()), 'dusk.damocles-theme', flagged.render, written);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && [...verdict.errors].sort()).toEqual([
      `the image wallpaper ${sha(IMAGE)} flashes more than 3 times in a second from 250 ms, which the store refuses`,
      `the wallpaper ${sha(OTHER)} could not be analyzed: the image did not decode`,
    ].sort());
    expect(written).not.toHaveBeenCalled();
  });
});

describe('checkImported', () => {
  const SPRITE = 'a'.repeat(64);
  const SLOW = 'b'.repeat(64);
  const characters = { name: 'Crew', characters: [{ name: 'Bit', states: { idle: { asset: SPRITE }, running: { strip: { asset: SLOW, frameWidth: 16, frameHeight: 16, frames: 4, fps: 4 } } } }] };
  const sprites: Record<string, AssetMeta> = {
    [SPRITE]: { kind: 'sprite', mime: 'image/gif', bytes: MOVING.length, width: 64, height: 64, frames: 4, license },
    [SLOW]: { kind: 'sprite', mime: 'image/png', bytes: IMAGE.length, width: 64, height: 16, frames: 4, durationMs: 1000, license },
  };
  const spriteTheme = { ...theme({ looks: { dark: { colors: COLORS } }, assets: sprites, characters }) } as unknown as ThemeFile;
  const file = { sha256: 'f'.repeat(64), bytes: 10 };

  it('checks a sprite that moves fast enough to flash, leaves a slow strip alone, and refuses a flagged one', async () => {
    const held = new Map([[SPRITE, MOVING], [SLOW, IMAGE]]);
    const clear = jobs();
    expect(await checkImported({ theme: spriteTheme, assets: held }, [], file, clear.render, async () => undefined)).toMatchObject({ ok: true, entry: { hasCharacters: true } });
    expect(clear.checked).toEqual([SPRITE]);
    const flagged = jobs({ sprite: async () => ({ flagged: true, atMs: 100 }) });
    expect(await checkImported({ theme: spriteTheme, assets: held }, [], file, flagged.render, async () => undefined)).toEqual({
      ok: false, ...file, errors: [`the character sprite ${SPRITE} flashes more than 3 times in a second from 100 ms, which the store refuses`],
    });
  });

  it('refuses a wallpaper or a sprite the file does not hold: one nobody checked is never accepted', async () => {
    const { render, analyzed, checked } = jobs();
    const wallpaperTheme = theme() as unknown as ThemeFile;
    const verdict = await checkImported({ theme: wallpaperTheme, assets: new Map([[sha(IMAGE), IMAGE]]) }, [], file, render, async () => undefined);
    expect(verdict).toEqual({ ok: false, ...file, errors: [`the wallpaper ${sha(OTHER)} is not an image or video the file holds, so it could not be analyzed`] });
    expect(analyzed).toEqual([sha(IMAGE)]);
    const noSprite = await checkImported({ theme: spriteTheme, assets: new Map([[SLOW, IMAGE]]) }, [], file, render, async () => undefined);
    expect(noSprite).toEqual({ ok: false, ...file, errors: [`the character sprite ${SPRITE} is not a sprite the file holds, so it could not be checked`] });
    expect(checked).toEqual([]);
  });
});

describe('the Node checks', () => {
  it('names a text that cleans to nothing', () => {
    expect(textErrors({ ...(theme() as unknown as ThemeFile), description: '\u202e\u202c' })).toEqual(['the description is empty once control and bidi characters are removed']);
    expect(textErrors(theme() as unknown as ThemeFile)).toEqual([]);
    expect(licenseErrors(theme() as unknown as ThemeFile)).toEqual([]);
  });

  it('plans one thumbnail per image a look shows first, each once', () => {
    const twice = theme({ looks: { dark: { colors: COLORS, wallpapers: [{ span: { asset: sha(IMAGE), panels: ['chat', 'editor'], fit: 'fill' }, panels: { sidebar: { asset: sha(IMAGE), fit: 'fill', dim: 0.3, blur: 0 } } }, { panels: { chat: { asset: sha(OTHER), fit: 'fill', dim: 0.3, blur: 0 } } }] } } });
    expect(thumbnailPlan(twice as unknown as ThemeFile)).toEqual([{ look: 'dark', panel: 'chat', sha256: sha(IMAGE) }]);
  });
});
