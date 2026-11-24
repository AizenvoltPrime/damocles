import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import {
  characterFor, characterIndex, characterState, frameView, MAX_SPRITE_BYTES, parseProjectsFile, PROJECTS_FILE, shownCharacters, type FrameSources, type ProjectsFile,
} from '../../../shared/themes/characters';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import type { CharacterSet, LookColors, ThemeFile } from '../../../shared/themes/schema';
import { BLOB_GRACE_MS } from '../blobs';
import { createThemeService, type SpriteAnalyzer } from '../index';
import { applyPinEdits } from '../characters';
import { parsePixelSprite, pixelSpriteSvg } from '../pixel-sprite';
import { png } from '../../../shared/themes/testing/image-fixtures';

// Project characters (docs/themes.md "Characters"): which character a project shows, its pins and every-theme pin, and the
// sprite checks before a sprite is stored.

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const sources: FrameSources = { url: (sha) => `app://damocles/theme-blob/${sha}`, flash: () => undefined };
const still = { kind: 'sprite' as const, mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} };
const SET: CharacterSet = { name: 'Arcade', characters: ['Pip', 'Mochi', 'Bolt'].map((name, i) => ({ name, states: { idle: { asset: SHA(i + 1) } } })) };
const ASSETS = Object.fromEntries([1, 2, 3, 9].map((n) => [SHA(n), still]));
const every = { name: 'Gloop', states: { idle: { asset: SHA(9) } }, assets: { [SHA(9)]: still } };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-characters-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeSettings(file: string): SettingsStore {
  return {
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? file : undefined),
  } as unknown as SettingsStore;
}

describe('which character a project shows', () => {
  it('assigns one by a stable hash of the project key, spread over the set', () => {
    expect(characterIndex('local:/work/api-server', 6)).toBe(characterIndex('local:/work/api-server', 6));
    const picked = new Set(Array.from({ length: 60 }, (_, i) => characterIndex(`local:/work/project-${i}`, 6)));
    expect(picked.size).toBe(6);
    expect(characterIndex('anything', 0)).toBe(0);
  });

  it('shows a pin of the shown theme first, then the character kept in every theme, then the hash', () => {
    const projects: ProjectsFile = { version: 1, pins: { a: { byTheme: { [ID]: 'Bolt' }, everyTheme: every }, b: { everyTheme: every }, c: { byTheme: { other: 'Pip' } } } };
    const shown = shownCharacters({ themeId: ID, characters: SET, assets: ASSETS }, projects, sources, 'always')!;
    expect(characterFor(shown, 'a')?.name).toBe('Bolt');
    expect(characterFor(shown, 'b')?.name).toBe('Gloop');
    expect(characterFor(shown, 'c')?.name).toBe(SET.characters[characterIndex('c', 3)]!.name);
    // a theme with no set still shows the every-theme pin, and the letter for the rest
    const bare = shownCharacters({ themeId: 'damocles' }, projects, sources, 'always');
    expect(characterFor(bare, 'b')?.name).toBe('Gloop');
    expect(characterFor(bare, 'c')).toBeUndefined();
    expect(shownCharacters({ themeId: 'damocles' }, { version: 1, pins: {} }, sources, 'always')).toBeUndefined();
  });

  it('carries the shown set\'s selection, and an outline where the set names none or the theme has no set', () => {
    const projects: ProjectsFile = { version: 1, pins: { b: { everyTheme: every } } };
    expect(shownCharacters({ themeId: ID, characters: SET, assets: ASSETS }, projects, sources, 'always')?.selection).toBe('outline');
    expect(shownCharacters({ themeId: ID, characters: { ...SET, selection: 'none' }, assets: ASSETS }, projects, sources, 'always')?.selection).toBe('none');
    expect(shownCharacters({ themeId: 'damocles' }, projects, sources, 'always')?.selection).toBe('outline');
  });

  it('reads the state from the chats: waiting over running over idle', () => {
    expect(characterState({ running: 2, waiting: 1 })).toBe('waiting');
    expect(characterState({ running: 1, waiting: 0 })).toBe('running');
    expect(characterState({ running: 0, waiting: 0 })).toBe('idle');
  });

  it('moves a strip at 6 fps or less without a flash check, and a faster one or an animated image only once it passed or was allowed', () => {
    const strip = (fps: number) => ({ strip: { asset: SHA(1), frameWidth: 16, frameHeight: 16, frames: 4, fps } });
    expect(frameView(strip(6), ASSETS, sources)).toMatchObject({ moves: true, playable: true });
    expect(frameView(strip(12), ASSETS, sources)).toMatchObject({ moves: true, playable: false });
    // the allowance counts for the cut the flash check ran on: four frames, one loop in 333 ms
    const checked = { [SHA(1)]: { ...still, width: 64, frames: 4, durationMs: 333 } };
    expect(frameView(strip(12), checked, { ...sources, flash: () => ({ flagged: true, atMs: 0, allowed: true }) })).toMatchObject({ playable: true });
    expect(frameView(strip(12), ASSETS, { ...sources, flash: () => ({ flagged: true, atMs: 0, allowed: true }) })).toMatchObject({ playable: false });
    const gif = { [SHA(5)]: { kind: 'sprite' as const, mime: 'image/gif', bytes: 10, width: 16, height: 16, frames: 8, license: {} } };
    // an animated image with no still frame yet shows nothing safe, so the project keeps its letter
    expect(frameView({ asset: SHA(5) }, gif, sources)).toBeUndefined();
    expect(frameView({ asset: SHA(5) }, gif, { ...sources, flash: () => ({ flagged: true, atMs: 100 }) })).toEqual({ url: sources.url(SHA(5)), still: `app://damocles/theme-cache/${SHA(5)}/still.png`, moves: true, playable: false });
  });
});

describe('projects.json', () => {
  it('drops a pin that does not check, never the file', () => {
    const parsed = parseProjectsFile({ version: 1, pins: { a: { byTheme: { [ID]: 'Pip', x: 3 } }, b: { everyTheme: { name: 'Gloop', states: { idle: { asset: 'nope' } }, assets: {} } }, c: 'x', d: { everyTheme: every } } });
    expect(parsed.pins).toEqual({ a: { byTheme: { [ID]: 'Pip' } }, d: { everyTheme: every } });
    expect(parseProjectsFile({ version: 2, pins: {} }).pins).toEqual({});
  });

  it('applies the editor\'s pins for one theme, keeping keys it does not know, and keeps only the sprites a pin names', () => {
    const theme: ThemeFile = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, characters: { name: 'Arcade', characters: [...SET.characters, { name: 'Gloop', states: { idle: { asset: SHA(9) } } }] }, assets: ASSETS };
    const next = applyPinEdits({ version: 1, looks: { kept: true }, pins: { a: { byTheme: { other: 'Pip' } } } }, theme, [
      { projectKey: 'a', character: 'Bolt', everyTheme: 'Gloop' },
      { projectKey: 'b', character: 'Nobody' },
    ]);
    expect(next).toEqual({ version: 1, looks: { kept: true }, pins: { a: { byTheme: { other: 'Pip', [ID]: 'Bolt' }, everyTheme: every } } });
    expect(applyPinEdits(next, theme, [{ projectKey: 'a', character: null, everyTheme: null }])['pins']).toEqual({ a: { byTheme: { other: 'Pip' } } });
  });

  it('keeps a pin under the key __proto__ as a key of the file, never as the prototype of its pins', () => {
    const theme: ThemeFile = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, characters: SET, assets: ASSETS };
    const pins = applyPinEdits(undefined, theme, [{ projectKey: '__proto__', character: 'Bolt' }])['pins'] as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(pins, '__proto__')?.value).toEqual({ byTheme: { [ID]: 'Bolt' } });
    expect(Object.getPrototypeOf(pins)).toBe(Object.prototype);
  });
});

describe('character sprites in the theme service', () => {
  const flagged: SpriteAnalyzer = async () => ({ flash: { flagged: true, atMs: 250, kind: 'general' } });
  const passed: SpriteAnalyzer = async () => ({ flash: { flagged: false } });
  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (err) {
      return err instanceof LocalizedError ? englishText(err.text) : String(err);
    }
    return 'not refused';
  };

  it('refuses a sprite over 256 KB or 256 px a frame, and an image that does not cut into its frames', async () => {
    const themes = createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')) });
    themes.setSpriteAnalyzer(passed);
    const big = new Uint8Array(257 * 1024);
    big.set(png(16, 16));
    expect(await refusal(themes.importSprite({ bytes: big, name: 'big.png' }))).toBe('This image is larger than 256 KB, the most a character sprite may be.');
    expect(await refusal(themes.importSprite({ bytes: png(257, 16), name: 'wide.png' }))).toBe('This sprite is 257 by 16 pixels; a character frame may be at most 256 pixels on a side.');
    expect(await refusal(themes.importSprite({ bytes: png(16 * 4, 300), name: 'tall.png' }, { frames: 4, fps: 4 }))).toBe('This sprite is 16 by 300 pixels; a character frame may be at most 256 pixels on a side.');
    expect(await refusal(themes.importSprite({ bytes: png(30, 16), name: 'strip.png' }, { frames: 4, fps: 4 }))).toBe('This image is 30 pixels wide, which does not cut into 4 equal frames.');
    expect(await refusal(themes.importSprite({ bytes: png(16, 16), name: 'sprite.jpg' }))).toBe('This file is named .jpg but holds a PNG file.');
    expect(fs.existsSync(path.join(root, 'blobs'))).toBe(false);
    // a strip of 256 px frames is within the caps, however wide the whole image is
    expect((await themes.importSprite({ bytes: png(256 * 4, 256), name: 'strip.png' }, { frames: 4, fps: 4 })).strip).toEqual({ frameWidth: 256, frameHeight: 256, frames: 4, fps: 4 });
  });

  it('blocks a flashing sprite until this computer\'s user allows it, which no theme file carries', async () => {
    const themes = createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')) });
    themes.setSpriteAnalyzer(flagged);
    const strip = pixelSpriteSvg(parsePixelSprite({ palette: ['#000000', '#ffffff'], frames: [['00', '00'], ['11', '11']], fps: 12 }));
    const sprite = await themes.importSprite({ bytes: new TextEncoder().encode(strip.svg), name: 'flash.svg' }, { frames: 2, fps: 12 });
    expect(sprite.flash).toEqual({ flagged: true, atMs: 250, kind: 'general' });
    expect(sprite.asset.flash).toEqual({ flagged: true, atMs: 250 });
    const frame = { strip: { asset: sprite.sha256, ...sprite.strip! } };
    const flash = (sha: string) => JSON.parse(fs.readFileSync(path.join(root, 'cache', sha, 'flash.json'), 'utf8'));
    expect(frameView(frame, { [sprite.sha256]: sprite.asset }, { ...sources, flash })).toMatchObject({ moves: true, playable: false });
    expect(await themes.allowFlash(sprite.sha256)).toBe(true);
    expect(frameView(frame, { [sprite.sha256]: sprite.asset }, { ...sources, flash })).toMatchObject({ moves: true, playable: true });
    expect(flash(sprite.sha256)).toMatchObject({ flagged: true, atMs: 250, kind: 'general', allowed: true });
  });

  it("keeps the blob of a sprite only a draft's names hold, reads a stored sprite only as its sha256 says, and leaves out a draft whose names do not check", async () => {
    let now = Date.now();
    const themes = createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')), now: () => now });
    themes.setSpriteAnalyzer(passed);
    const svg = new TextEncoder().encode(pixelSpriteSvg(parsePixelSprite({ palette: ['#ff6bb5'], frames: [['0.', '.0']] })).svg);
    const sprite = await themes.importSprite({ bytes: svg, name: 'pip.svg' });
    const draft = { id: themes.drafts.newId(), owner: { authority: 'local', sessionId: 's', toolCallId: 'c' }, createdAt: now, baseThemeId: null, baseHash: null, theme: { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } } } } as const;
    await themes.drafts.put({ ...draft, sprites: { pip: { sha256: sprite.sha256, asset: sprite.asset } } }, null);
    expect((await themes.drafts.get(draft.id))?.sprites).toEqual({ pip: { sha256: sprite.sha256, asset: sprite.asset } });
    now += BLOB_GRACE_MS * 2;
    await themes.collectBlobs();
    expect(fs.existsSync(path.join(root, 'blobs', sprite.sha256))).toBe(true);
    expect(new Uint8Array(await themes.readSprite(sprite.sha256, sprite.asset))).toEqual(svg);

    fs.writeFileSync(path.join(root, 'blobs', sprite.sha256), new TextEncoder().encode('<svg/>'));
    expect(await refusal(themes.readSprite(sprite.sha256, sprite.asset))).toBe(`The stored file ${sprite.sha256} is not the file its name says.`);
    fs.writeFileSync(path.join(root, 'blobs', sprite.sha256), new Uint8Array(MAX_SPRITE_BYTES + 1));
    expect(await refusal(themes.readSprite(sprite.sha256, sprite.asset))).toBe(`The stored file ${sprite.sha256} is larger than 256 KB, the most a character sprite may be.`);
    expect(await refusal(themes.readSprite('e'.repeat(64), sprite.asset))).toBe(`No sprite ${'e'.repeat(64)} is stored.`);
    expect(await refusal(themes.readSprite(sprite.sha256, { ...sprite.asset, kind: 'image' }))).toBe(`No sprite ${sprite.sha256} is stored.`);

    const file = path.join(root, 'drafts', `${draft.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...stored, sprites: { pip: { sha256: sprite.sha256, asset: { ...sprite.asset, kind: 'font' } } } }));
    expect(await themes.drafts.get(draft.id)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ ...stored, sprites: { 'no spaces': { sha256: sprite.sha256, asset: sprite.asset } } }));
    expect(await themes.drafts.get(draft.id)).toBeUndefined();
  });

  it('keeps a character kept in every theme after its theme is deleted: the pin stays and its sprite blob stays referenced', async () => {
    let now = Date.now();
    const themes = createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')), now: () => now });
    themes.setSpriteAnalyzer(passed);
    const strip = pixelSpriteSvg(parsePixelSprite({ palette: ['#ff6bb5'], frames: [['0.', '.0'], ['.0', '0.']], fps: 4 }));
    const sprite = await themes.importSprite({ bytes: new TextEncoder().encode(strip.svg), name: 'pip.svg' }, { frames: 2, fps: 4 });
    const theme: ThemeFile = {
      schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } },
      characters: { name: 'Night', characters: [{ name: 'Pip', states: { idle: { strip: { asset: sprite.sha256, ...sprite.strip! } } } }] },
      assets: { [sprite.sha256]: sprite.asset },
    };
    fs.mkdirSync(path.join(root, 'themes', ID), { recursive: true });
    fs.writeFileSync(path.join(root, 'themes', ID, 'theme.json'), JSON.stringify({ ...theme, characters: undefined, assets: undefined }));
    await themes.saveTheme(ID, theme, undefined, [{ projectKey: 'local:/work/api', character: 'Pip', everyTheme: 'Pip' }]);
    const pins = (): ProjectsFile => parseProjectsFile(JSON.parse(fs.readFileSync(path.join(root, PROJECTS_FILE), 'utf8')));
    expect(pins().pins['local:/work/api']?.everyTheme?.name).toBe('Pip');

    await themes.remove(ID);
    now += BLOB_GRACE_MS * 2;
    // the history's snapshots hold the theme file too, so the history is cleared to show projects.json alone keeps the blob
    fs.rmSync(path.join(root, 'history'), { recursive: true, force: true });
    await themes.collectBlobs();
    expect(fs.existsSync(path.join(root, 'themes', ID))).toBe(false);
    expect(fs.existsSync(path.join(root, 'blobs', sprite.sha256))).toBe(true);
    const shown = shownCharacters({ themeId: 'damocles' }, pins(), sources, 'always');
    expect(characterFor(shown, 'local:/work/api')).toMatchObject({ name: 'Pip', states: { idle: { url: sources.url(sprite.sha256), moves: true, playable: true } } });

    // with the pin gone, nothing references the blob and the next collection removes it
    fs.writeFileSync(path.join(root, PROJECTS_FILE), JSON.stringify({ version: 1, pins: {} }));
    await themes.collectBlobs();
    expect(fs.existsSync(path.join(root, 'blobs', sprite.sha256))).toBe(false);
  });

  it('saves pins in the theme\'s own history entry, which Undo reverses', async () => {
    const themes = createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')) });
    const theme: ThemeFile = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, characters: SET, assets: ASSETS };
    for (const n of [1, 2, 3, 9]) {
      fs.mkdirSync(path.join(root, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'blobs', SHA(n)), png(16, 16));
    }
    fs.mkdirSync(path.join(root, 'themes', ID), { recursive: true });
    fs.writeFileSync(path.join(root, 'themes', ID, 'theme.json'), JSON.stringify({ ...theme, characters: undefined, assets: undefined }));
    await themes.saveTheme(ID, theme, undefined, [{ projectKey: 'k', character: 'Mochi' }]);
    expect(JSON.parse(fs.readFileSync(path.join(root, PROJECTS_FILE), 'utf8')).pins).toEqual({ k: { byTheme: { [ID]: 'Mochi' } } });
    expect((await themes.history())).toHaveLength(1);
    await themes.undo();
    expect(fs.existsSync(path.join(root, PROJECTS_FILE))).toBe(false);
  });
});
