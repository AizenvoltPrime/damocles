// Export: font license rules (Restricted refused, OFL / Apache / Ubuntu confirm, anything else warn), file names Windows accepts,
// nothing of this computer in the file, and every file an export writes reads back through the import's own checks.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import { BUILTIN_EXAMPLE_IDS, BUILTIN_THEME_ID } from '../../../shared/themes/builtin';
import type { ThemeExportFontBytes } from '../../../shared/themes/install';
import type { ThemeFile } from '../../../shared/themes/schema';
import { systemTheme } from '../../../shared/themes/system-theme';
import { readThemeArchive, writeThemeArchive } from '../archive';
import { sha256Of } from '../blobs';
import { buildExport, exportFileName, planExport, type ExportSource } from '../export';
import { createThemeService, type ThemeService } from '../index';
import { sfntFont } from './font-fixtures';
import { gif, png } from '../../../shared/themes/testing/image-fixtures';

const COLORS = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const ID = '0a1b2c3d-1111-4222-8333-444455556666';

const font = (fsType: number, license?: string, url?: string): Uint8Array =>
  sfntFont({ fsType, names: { 1: 'Fixture Sans', 2: 'Regular', 4: 'Fixture Sans Regular', 6: 'FixtureSans-Regular', ...(license !== undefined ? { 13: license } : {}), ...(url !== undefined ? { 14: url } : {}) } });

const installedTheme = (ui: string, mono?: string): ThemeFile => ({
  schemaVersion: 1, id: ID, name: 'Shared', looks: { dark: { colors: COLORS } },
  style: { fonts: { ui: { installed: ui }, ...(mono !== undefined ? { mono: { installed: mono } } : {}) } },
});

const source = (theme: ThemeFile): ExportSource => ({ theme, builtin: false, readAsset: async () => { throw new Error('no assets'); } });
const given = (family: string, bytes: Uint8Array): ThemeExportFontBytes => ({ family, bytes });

describe('export file names', () => {
  it.each([
    ['Aurora Borealis', 'Aurora Borealis.damocles-theme'],
    ['Dusk: <dark>/"light" | a\\b?*', 'Dusk darklight  ab.damocles-theme'],
    ['Night...  ', 'Night.damocles-theme'],
    ['tab\there\u0007', 'tabhere.damocles-theme'],
    ['spoof\u202Eeht-pmed', 'spoofeht-pmed.damocles-theme'],
    ['CON', 'theme.damocles-theme'],
    ['con.backup', 'backup.damocles-theme'],
    ['nul', 'theme.damocles-theme'],
    ['COM1', 'theme.damocles-theme'],
    ['lpt9.txt', 'txt.damocles-theme'],
    ['COM\u00b9', 'theme.damocles-theme'],
    ['CONIN$', 'theme.damocles-theme'],
    ['Console', 'Console.damocles-theme'],
    ['???', 'theme.damocles-theme'],
    ['   ', 'theme.damocles-theme'],
  ])('%j becomes %j', (name, file) => {
    expect(exportFileName(name)).toBe(file);
  });
});

describe('export font licenses', () => {
  it('refuses a font marked Restricted License embedding, at plan and at write', async () => {
    const restricted = font(0x0002, 'SIL Open Font License, Version 1.1');
    const plan = await planExport(source(installedTheme('Fixture Sans')), [given('Fixture Sans', restricted)]);
    expect(plan.fonts).toEqual([expect.objectContaining({ family: 'Fixture Sans', source: 'installed', verdict: 'refused', refusal: expect.objectContaining({ message: '{0} is marked Restricted License embedding, so it cannot be shared in a theme file.' }) })]);
    await expect(buildExport(source(installedTheme('Fixture Sans')), [given('Fixture Sans', restricted)])).rejects.toBeInstanceOf(LocalizedError);
  });

  it('confirms a font a less restrictive bit allows, even with the restricted bit set', async () => {
    const plan = await planExport(source(installedTheme('Fixture Sans')), [given('Fixture Sans', font(0x0002 | 0x0004, 'SIL Open Font License, Version 1.1'))]);
    expect(plan.fonts[0]!.verdict).toBe('confirm');
  });

  it.each([
    ['SIL Open Font License, Version 1.1', undefined, 'OFL-1.1'],
    [undefined, 'https://openfontlicense.org', 'OFL-1.1'],
    ['Licensed under the Apache License, Version 2.0', undefined, 'Apache-2.0'],
    [undefined, 'http://www.apache.org/licenses/LICENSE-2.0', 'Apache-2.0'],
    ['Licensed under the Ubuntu Font Licence 1.0', undefined, 'LicenseRef-Ubuntu-Font-1.0'],
  ])('packs %s %s after one confirm (%s)', async (license, url, spdx) => {
    const plan = await planExport(source(installedTheme('Fixture Sans')), [given('Fixture Sans', font(0, license, url))]);
    expect(plan.fonts).toEqual([expect.objectContaining({ verdict: 'confirm', spdx })]);
  });

  it('warns for any other license, and for none', async () => {
    const plan = await planExport(source(installedTheme('Fixture Sans', 'Other Mono')), [given('Fixture Sans', font(0, 'Copyright Foundry. All rights reserved.')), given('Other Mono', font(0))]);
    expect(plan.fonts.map((entry) => entry.verdict)).toEqual(['warn', 'warn']);
  });

  it('exports an installed font whose bytes the overlay did not send as its name only', async () => {
    const plan = await planExport(source(installedTheme('Fixture Sans')), []);
    expect(plan.fonts).toEqual([{ family: 'Fixture Sans', role: 'ui', source: 'installed', verdict: 'nameOnly' }]);
    const archive = await readThemeArchive(await buildExport(source(installedTheme('Fixture Sans')), []));
    expect((archive.themeJson as ThemeFile).style?.fonts?.ui).toEqual({ installed: 'Fixture Sans' });
  });

  it('packs a shareable installed font as a bundled one, with its license text in LICENSES/', async () => {
    const bytes = font(0, 'SIL Open Font License, Version 1.1', 'https://openfontlicense.org');
    const archive = await readThemeArchive(await buildExport(source(installedTheme('Fixture Sans')), [given('Fixture Sans', bytes)]));
    const theme = archive.themeJson as ThemeFile;
    const sha = sha256Of(bytes);
    expect(theme.style?.fonts?.ui).toEqual({ asset: sha, family: 'Fixture Sans' });
    expect(theme.assets?.[sha]).toEqual(expect.objectContaining({ kind: 'font', family: 'Fixture Sans', license: expect.objectContaining({ spdx: 'OFL-1.1' }) }));
    expect(archive.assets.get(sha)?.bytes).toEqual(bytes);
    expect(archive.licenses.get('Fixture-Sans.txt')).toBe('SIL Open Font License, Version 1.1');
  });
});

describe('export of a theme on this computer', () => {
  let root: string;
  let themes: ThemeService;

  const settings = (file: string): SettingsStore => ({
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? file : undefined),
  }) as unknown as SettingsStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-export-'));
    // the packed examples as the shell build lays them out
    const packed = path.join(root, 'resources', 'dist', 'desktop-shell', 'themes');
    for (const id of BUILTIN_EXAMPLE_IDS) fs.cpSync(path.join(__dirname, '../../../../resources/themes', id), path.join(packed, id), { recursive: true });
    themes = createThemeService({ root: path.join(root, 'themes'), settings: settings(path.join(root, 'settings.json')), resourceRoot: path.join(root, 'resources') });
    themes.setAnalyzer(async (_sha, image) => ({ thumb: new Uint8Array([1]), stats: { p10: 0.1, p90: 0.6, mean: 0.3 }, palette: { dark: COLORS, light: COLORS }, width: image.width, height: image.height, still: new Uint8Array([2]), flash: { flagged: true, atMs: 100 } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes nothing of this computer: no origin, flash allowance, project looks, pins or history', async () => {
    const wall = gif(10, 10, 3);
    const sha = sha256Of(wall);
    const file = path.join(root, 'in.damocles-theme');
    fs.writeFileSync(file, await writeThemeArchive(JSON.stringify({
      schemaVersion: 1, id: ID, name: 'Mine', looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: sha, fit: 'fill', dim: 0.5, blur: 4 } } }] } },
      assets: { [sha]: { kind: 'animated', mime: 'image/gif', bytes: wall.length, width: 10, height: 10, frames: 3, license: {} } },
    }), new Map([[sha, { ext: 'gif', bytes: wall }]])));
    const preview = await themes.installPrepare({ kind: 'file', path: file });
    const result = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    if (!('installed' in result)) throw new Error('refused');
    const { themeId } = result.installed;
    expect(await themes.allowFlash(sha)).toBe(true);
    await themes.setProjectLook('C:/projects/secret-project', { mode: 'full', themeId, look: 'auto' }, { name: 'Secret Project' });
    const out = path.join(root, 'out.damocles-theme');
    const bytes = await themes.exportWrite(themeId, out, []);
    expect(fs.statSync(out).size).toBe(bytes);
    const written = fs.readFileSync(out);
    const archive = await readThemeArchive(written);
    const theme = archive.themeJson as Record<string, unknown>;
    expect(theme['origin']).toBeUndefined();
    const text = JSON.stringify(theme);
    for (const secret of ['allowed', 'flagged', 'secret-project', 'Secret Project', 'installedHash', 'import']) expect(text).not.toContain(secret);
    expect([...archive.assets.keys()]).toEqual([sha]);
    expect([...archive.licenses.keys()]).toEqual([]);

    fs.rmSync(path.join(root, 'themes', 'blobs', sha));
    const failure = await themes.exportWrite(themeId, out, []).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(LocalizedError);
    expect(englishText((failure as LocalizedError).text)).toBe('The theme Mine was not exported: a file it names is missing.');
    expect((failure as Error).cause).toMatchObject({ code: 'ENOENT' });
  });

  it.each([BUILTIN_THEME_ID, ...BUILTIN_EXAMPLE_IDS])('exports the built-in %s to a file the import accepts', async (id) => {
    const out = path.join(root, `${id}.damocles-theme`);
    await themes.exportWrite(id, out, []);
    const archive = await readThemeArchive(fs.readFileSync(out));
    expect((archive.themeJson as ThemeFile).name).toBeTruthy();
    const plan = await themes.exportPlan(id);
    expect(plan.fileName).toMatch(/\.damocles-theme$/);
    if (id !== BUILTIN_THEME_ID) expect(archive.licenses.has('theme.txt')).toBe(true);
    // and installs again as a theme of its own
    const preview = await themes.installPrepare({ kind: 'file', path: out });
    expect(preview.theme.id).not.toBe(id);
  });

  // System colors has no packed folder, so a license read for it would fail with ENOENT
  it('exports System colors as the looks of that moment, with no license file and no assets', async () => {
    let colors = { accent: '#0078d4' };
    const system = createThemeService({ root: path.join(root, 'themes'), settings: settings(path.join(root, 'settings.json')), resourceRoot: path.join(root, 'resources'), system: () => systemTheme(colors).looks });
    const plan = await system.exportPlan('damocles-system');
    expect(plan.fileName).toMatch(/\.damocles-theme$/);
    const out = path.join(root, 'system.damocles-theme');
    await system.exportWrite('damocles-system', out, []);
    colors = { accent: '#e81123' };
    const archive = await readThemeArchive(fs.readFileSync(out));
    const exported = archive.themeJson as ThemeFile;
    expect(exported.name).toBe('System colors');
    expect(exported.looks).toEqual(systemTheme({ accent: '#0078d4' }).looks);
    // the file holds the colors of that moment, so it does not say it follows the computer
    expect(exported.description).toBeUndefined();
    expect(exported.origin).toBeUndefined();
    expect([...archive.assets.keys()]).toEqual([]);
    expect([...archive.licenses.keys()]).toEqual([]);
    // and installs again as a theme of the user's own
    const preview = await system.installPrepare({ kind: 'file', path: out });
    expect(preview.theme.id).not.toBe('damocles-system');
    expect(preview.theme.looks).toEqual(systemTheme({ accent: '#0078d4' }).looks);
  });

  it('refuses a path that is not absolute', async () => {
    await expect(themes.exportWrite(BUILTIN_THEME_ID, 'relative.damocles-theme', [])).rejects.toThrow(/not a full path/);
  });
});

describe('archive writing within the import\'s limits', () => {
  it('stores an entry that would deflate past the ratio, so the file still imports', async () => {
    const text = 'a'.repeat(200_000);
    const bytes = await writeThemeArchive(JSON.stringify({ schemaVersion: 1, id: ID, name: 'Big', looks: { dark: { colors: COLORS } } }), new Map(), new Map([['notice.txt', text]]));
    const archive = await readThemeArchive(bytes);
    expect(archive.licenses.get('notice.txt')).toBe(text);
  });
});

describe('an export read back as an import reads it', () => {
  it('is refused when the theme declares an asset as another kind than its bytes are, which the archive layer alone would pass', async () => {
    const still = png(64, 48);
    const sha = sha256Of(still);
    const theme: ThemeFile = {
      schemaVersion: 1, id: ID, name: 'Shared', looks: { dark: { colors: COLORS } },
      assets: { [sha]: { kind: 'animated', mime: 'image/png', bytes: still.length, width: 64, height: 48, frames: 2, license: {} } },
    };
    const failure = await buildExport({ theme, builtin: false, readAsset: async () => still }, []).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(LocalizedError);
    expect(englishText((failure as LocalizedError).text)).toBe(`The theme was not exported, since Damocles would not be able to import the file: The asset ${sha} was refused: it is declared an animated image but holds a still image.`);
  });

  it('keeps theme.txt for the theme\'s own license, so a font family named Theme gets a numbered file', async () => {
    const bytes = await buildExport({ ...source(installedTheme('Theme')), builtin: true, licenseText: 'The theme\'s license' }, [given('Theme', font(0, 'SIL Open Font License, Version 1.1'))]);
    const read = await readThemeArchive(bytes);
    expect(new Map([...read.licenses].sort())).toEqual(new Map([['Theme-2.txt', 'SIL Open Font License, Version 1.1'], ['theme.txt', 'The theme\'s license']]));
  });
});
