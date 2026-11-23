// readImport: which format a file is read as, what each refuses, and what an imported theme never keeps from its file.
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import { gif, png } from '../../../shared/themes/testing/image-fixtures';
import type { AssetMeta } from '../../../shared/themes/schema';
import { ArchiveRefusedError, writeThemeArchive, type ArchiveAsset } from '../archive';
import { sha256Of } from '../blobs';
import { readImport, type ImportedTheme } from '../import';
import { MAX_THEME_FILE_BYTES } from '../store';
import { sfntFont } from './font-fixtures';

const ID = '7b0e6f4c-3a2d-4e1f-9c8b-5a6d7e8f9012';
const COLORS = { background: '#141413', panel: '#1f1e1c', text: '#ece8df', accent: '#d97757', success: '#7fb069', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' };
const themeJson = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ schemaVersion: 1, id: '0f6c5c1e-8f1d-4c39-9d3b-6c8a0f5b2a11', name: 'Shared', looks: { dark: { colors: COLORS } }, ...extra });
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): Uint8Array => text(JSON.stringify(value));

const archive = (theme: Record<string, unknown>, assets: ReadonlyArray<readonly [Uint8Array, string]> = []): Promise<Uint8Array> =>
  writeThemeArchive(JSON.stringify(theme), new Map(assets.map(([bytes, ext]): [string, ArchiveAsset] => [sha256Of(bytes), { ext, bytes }])));

const refusal = async (bytes: Uint8Array | Promise<Uint8Array>, fileName = 'shared.damocles-theme'): Promise<string> => {
  try {
    await readImport(await bytes, fileName, ID);
  } catch (err) {
    if (err instanceof LocalizedError) return englishText(err.text);
    throw err;
  }
  throw new Error('not refused');
};

const WALL = png(64, 48);
const wallMeta = (extra: Partial<AssetMeta> = {}): AssetMeta => ({ kind: 'image', mime: 'image/png', bytes: WALL.length, width: 64, height: 48, license: {}, ...extra });

describe('readImport refuses', () => {
  it('a theme that names an asset the file does not hold', async () => {
    const sha = sha256Of(WALL);
    expect(await refusal(archive(themeJson({ assets: { [sha]: wallMeta() } })))).toBe(`This theme file names the asset ${sha} but does not hold it.`);
  });

  it('a font that forbids embedding, and one under a family Damocles keeps for its own fonts', async () => {
    const restricted = sfntFont({ fsType: 0x0002 });
    const font = (bytes: Uint8Array, family: string): Record<string, unknown> => themeJson({ assets: { [sha256Of(bytes)]: { kind: 'font', mime: 'font/ttf', bytes: bytes.length, family, license: {} } } });
    expect(await refusal(archive(font(restricted, 'Fixture Sans'), [[restricted, 'ttf']]))).toBe(`The asset ${sha256Of(restricted)} was refused: the font forbids embedding.`);
    const free = sfntFont();
    expect(await refusal(archive(font(free, 'Geist Variable'), [[free, 'ttf']]))).toBe(`The asset ${sha256Of(free)} was refused: Geist Variable is a name Damocles keeps for its own fonts.`);
  });

  it('an asset whose bytes are another kind than the theme declares, naming both kinds', async () => {
    const sha = sha256Of(WALL);
    expect(await refusal(archive(themeJson({ assets: { [sha]: wallMeta({ kind: 'animated', frames: 2 }) } }), [[WALL, 'png']])))
      .toBe(`The asset ${sha} was refused: it is declared an animated image but holds a still image.`);
    const moving = gif(10, 10, 3);
    expect(await refusal(archive(themeJson({ assets: { [sha256Of(moving)]: { kind: 'image', mime: 'image/gif', bytes: moving.length, width: 10, height: 10, license: {} } } }), [[moving, 'gif']])))
      .toBe(`The asset ${sha256Of(moving)} was refused: it is declared a still image but holds an animated image.`);
  });

  it('a theme of a newer format version, in a theme file and as a bare theme.json', async () => {
    expect(await refusal(archive(themeJson({ schemaVersion: 2 })))).toBe('This theme needs a newer Damocles (format version 2).');
    expect(await refusal(json(themeJson({ schemaVersion: 7 })), 'theme.json')).toBe('This theme needs a newer Damocles (format version 7).');
  });

  it('a bare theme.json that names assets, which only a theme file carries', async () => {
    expect(await refusal(json(themeJson({ assets: { [sha256Of(WALL)]: wallMeta() } })), 'theme.json')).toBe('This theme.json names images or fonts, which only a .damocles-theme file carries.');
  });

  it('a theme the format refuses, with the path and the reason', async () => {
    expect(await refusal(json(themeJson({ looks: {} })), 'theme.json')).toBe('This theme is not valid: /looks: needs a dark or a light look');
    expect(await refusal(json([1, 2]), 'theme.json')).toMatch(/is not a VS Code theme/);
    expect(await refusal(archive([] as unknown as Record<string, unknown>))).toBe('theme.json is not a theme.');
  });

  it('text over 4 MB, bytes that are not UTF-8 and text that is not JSON', async () => {
    expect(await refusal(new Uint8Array(MAX_THEME_FILE_BYTES + 1).fill(0x20), 'big.json')).toBe('This file is larger than 4 MB and is not a theme file.');
    expect(await refusal(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 'odd.json')).toBe('odd.json is not a theme file Damocles reads: a .damocles-theme, a VS Code theme (.json) or a .vsix.');
    expect(await refusal(text('{ "schemaVersion": 1, '), 'cut.json')).toBe('cut.json is not JSON.');
  });
});

describe('readImport reads each format by its name and its bytes', () => {
  const vscodeText = json({ name: 'Code', type: 'dark', colors: { 'editor.background': '#111111' } });

  it('a zip named .vsix as a VS Code extension, whatever it holds', async () => {
    expect(await refusal(archive(themeJson()), 'shared.vsix')).toBe('This .vsix holds no extension/package.json, so it is not a VS Code extension.');
  });

  it('a zip that holds extension/package.json as a VS Code extension, whatever it is named', async () => {
    const vsix = zipSync({
      'extension/package.json': json({ name: 'pack', contributes: { themes: [{ label: 'Dark', uiTheme: 'vs-dark', path: './dark.json' }] } }),
      'extension/dark.json': json({ colors: { 'editor.background': '#111111' } }),
    });
    expect((await readImport(vsix, 'download', ID)).format).toBe('vscode');
    expect((await readImport(vsix, 'pack.zip', ID)).theme).toMatchObject({ id: ID, name: 'Dark' });
  });

  it('any other zip as a theme file, and a file named .damocles-theme as one even when it is no zip', async () => {
    expect((await readImport(await archive(themeJson()), 'download', ID)).format).toBe('damocles');
    await expect(readImport(vscodeText, 'code.damocles-theme', ID)).rejects.toBeInstanceOf(ArchiveRefusedError);
    await expect(readImport(vscodeText, 'code.damocles-theme', ID)).rejects.toMatchObject({ reason: 'notZip' });
    // the entry limit of a theme file holds for a zip that is read as one under another name
    const crowded = zipSync(Object.fromEntries([['theme.json', json(themeJson())], ...Array.from({ length: 512 }, (_, n): [string, Uint8Array] => [`LICENSES/l${n}.txt`, text('x')])]));
    await expect(readImport(crowded, 'download', ID)).rejects.toMatchObject({ reason: 'tooManyEntries' });
  });

  it('text that names schemaVersion as a Damocles theme, unless it also names tokenColors', async () => {
    expect((await readImport(json(themeJson()), 'anything.json', ID)).format).toBe('damocles');
    expect((await readImport(json({ schemaVersion: 1, name: 'Code', tokenColors: [], colors: { 'editor.background': '#111111' } }), 'code.json', ID)).format).toBe('vscode');
    expect((await readImport(vscodeText, 'code.json', ID)).theme).toMatchObject({ id: ID, name: 'Code' });
    // a byte order mark is read past
    expect((await readImport(new Uint8Array([0xef, 0xbb, 0xbf, ...json(themeJson())]), 'bom.json', ID)).format).toBe('damocles');
  });
});

describe('an imported theme', () => {
  it('never keeps its file\'s id, origin or flash allowance', async () => {
    const moving = gif(10, 10, 3);
    const sha = sha256Of(moving);
    const imported = await readImport(await archive(themeJson({
      origin: { kind: 'store', installedAt: 1, store: { entryId: 'aurora', version: '1.0.0', sha256: sha } },
      assets: { [sha]: { kind: 'animated', mime: 'image/gif', bytes: moving.length, width: 10, height: 10, frames: 3, flash: { flagged: false, allowed: true }, license: { spdx: 'CC0-1.0' } } },
    }), [[moving, 'gif']]), 'shared.damocles-theme', ID);
    expect(imported.theme.id).toBe(ID);
    expect(imported.theme.origin).toBeUndefined();
    // the asset entry is rebuilt from the bytes: only its license is the file's
    expect(imported.theme.assets).toEqual({ [sha]: { kind: 'animated', mime: 'image/gif', bytes: moving.length, width: 10, height: 10, frames: 3, license: { spdx: 'CC0-1.0' } } });
    expect(imported.warnings).toEqual([]);
    expect([...imported.assets.keys()]).toEqual([sha]);
  });

  it('keeps a font its file holds and may embed, with the bytes the theme names it by', async () => {
    const font = sfntFont();
    const sha = sha256Of(font);
    const imported = await readImport(await archive(themeJson({
      style: { fonts: { ui: { asset: sha, family: 'Fixture Sans' } } },
      assets: { [sha]: { kind: 'font', mime: 'font/ttf', bytes: font.length, family: 'Fixture Sans', license: { spdx: 'OFL-1.1' } } },
    }), [[font, 'ttf']]), 'shared.damocles-theme', ID);
    expect(imported.theme.style?.fonts?.ui).toEqual({ asset: sha, family: 'Fixture Sans' });
    expect(imported.theme.assets?.[sha]).toMatchObject({ kind: 'font', mime: 'font/ttf', bytes: font.length, family: 'Fixture Sans', license: { spdx: 'OFL-1.1' } });
    expect([...imported.assets.keys()]).toEqual([sha]);
    expect(imported.assets.get(sha)).toEqual(font);
  });

  it('lists the settings it does not know, ten at most', async () => {
    const few = await readImport(json(themeJson({ glow: 1, style: { sparkle: true } })), 'theme.json', ID);
    expect(few.warnings.map(englishText)).toEqual(['This theme has settings this version of Damocles does not know, which were left out: /glow, /style/sparkle']);
    expect(few.theme).not.toHaveProperty('glow');
    const many = await readImport(json(themeJson(Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`extra${String(n).padStart(2, '0')}`, n])))), 'theme.json', ID);
    expect(many.warnings.map(englishText)).toEqual([`This theme has settings this version of Damocles does not know, which were left out: ${Array.from({ length: 10 }, (_, n) => `/extra${String(n).padStart(2, '0')}`).join(', ')}, ...`]);
  });
});

describe('a name from a file', () => {
  const strip = (asset: string, frames: number, fps: number, frameWidth: number): unknown => ({ strip: { asset, frameWidth, frameHeight: 8, frames, fps } });
  const SPRITE = png(16, 8);
  const spriteMeta = (extra: Partial<AssetMeta> = {}): AssetMeta => ({ kind: 'sprite', mime: 'image/png', bytes: SPRITE.length, width: 16, height: 8, license: {}, ...extra });

  it('is made one line wherever the format has a one-line name: the theme, a wallpaper set, the character set and a character', async () => {
    const sha = sha256Of(SPRITE);
    const wall = sha256Of(WALL);
    const imported = await readImport(await archive(themeJson({
      name: 'Evil\u202Eeht\nName',
      looks: { dark: { colors: COLORS, wallpapers: [{ name: 'Fo\u2066rest\r\nat dusk', panels: { chat: { asset: wall, fit: 'fill', dim: 0.5, blur: 4 } } }] } },
      characters: { name: 'The\u0000 \u200Fcrew', characters: [{ name: 'Cap\u202Dtain\tHook', states: { idle: { asset: sha } } }] },
      assets: { [sha]: spriteMeta(), [wall]: wallMeta() },
    }), [[SPRITE, 'png'], [WALL, 'png']]), 'shared.damocles-theme', ID);
    expect(imported.theme.name).toBe('Evileht Name');
    expect(imported.theme.looks.dark?.wallpapers?.[0]?.name).toBe('Forest at dusk');
    expect(imported.theme.characters?.name).toBe('The crew');
    expect(imported.theme.characters?.characters[0]?.name).toBe('Captain Hook');
  });

  it('is refused when nothing of it is left, and when two characters end up with one name', async () => {
    expect(await refusal(json(themeJson({ name: '\u202E\u0007' })), 'theme.json')).toBe('This theme is not valid: /name: must be one line, with no control or text direction characters');
    const sha = sha256Of(SPRITE);
    const twins = themeJson({ characters: { name: 'Crew', characters: [{ name: 'Hook', states: { idle: { asset: sha } } }, { name: 'Ho\u202Eok', states: { idle: { asset: sha } } }] }, assets: { [sha]: spriteMeta() } });
    expect(await refusal(archive(twins, [[SPRITE, 'png']]))).toBe('This theme is not valid: /characters/characters: names a character twice');
  });

  it('of a VS Code theme is made one line and cut to 64 characters, whether its file or its file name gives it', async () => {
    const colors = { colors: { 'editor.background': '#111111' } };
    expect((await readImport(json(colors), 'ni\u202Eght\u0007owl.json', ID)).theme.name).toBe('night owl');
    const long = (await readImport(json(colors), `${'n'.repeat(100)}.json`, ID)).theme.name;
    expect([...long]).toHaveLength(64);
    expect((await readImport(json({ ...colors, name: 'Dra\u2067cula\nPro' }), 'x.json', ID)).theme.name).toBe('Dracula Pro');
  });

  describe('of a strip asset', () => {
    const themed = (states: Record<string, unknown>, meta: AssetMeta, bytes: Uint8Array): Record<string, unknown> =>
      themeJson({ characters: { name: 'Crew', characters: [{ name: 'Hook', states }] }, assets: { [sha256Of(bytes)]: meta } });
    const importedAsset = (imported: ImportedTheme, bytes: Uint8Array): AssetMeta | undefined => imported.theme.assets?.[sha256Of(bytes)];

    it('keeps the cut and the loop length its flash check runs at: the fastest rate of the strips that name it', async () => {
      const sha = sha256Of(SPRITE);
      const imported = await readImport(await archive(themed({ idle: strip(sha, 2, 4, 8), running: strip(sha, 2, 8, 8) }, spriteMeta(), SPRITE), [[SPRITE, 'png']]), 'shared.damocles-theme', ID);
      expect(importedAsset(imported, SPRITE)).toEqual(spriteMeta({ frames: 2, durationMs: 250 }));
    });

    it('is refused when two strips cut it into different numbers of frames', async () => {
      const sha = sha256Of(SPRITE);
      expect(await refusal(archive(themed({ idle: strip(sha, 2, 4, 8), running: strip(sha, 4, 4, 4) }, spriteMeta(), SPRITE), [[SPRITE, 'png']])))
        .toBe(`The asset ${sha} was refused: the characters cut it into strips of different frame counts.`);
    });

    it('is refused when the image is animated already, a strip of one frame included', async () => {
      const moving = gif(8, 8, 2);
      const sha = sha256Of(moving);
      const meta: AssetMeta = { kind: 'sprite', mime: 'image/gif', bytes: moving.length, width: 8, height: 8, license: {} };
      expect(await refusal(archive(themed({ idle: strip(sha, 1, 4, 8) }, meta, moving), [[moving, 'gif']])))
        .toBe(`The asset ${sha} was refused: A sprite strip is one still image; this one is animated already.`);
    });
  });
});
