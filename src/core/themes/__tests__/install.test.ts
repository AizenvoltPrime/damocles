// Staged installs end to end through the theme service: a file or https URL becomes a staged install, and only commit installs
// it, under a new id, with core's own origin and this computer's own flash check. Downloads go through the real safeFetch with
// DNS and undici's fetch mocked, so its redirect and SSRF checks run on every hop.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock, fetchMock } = vi.hoisted(() => ({ lookupMock: vi.fn(), fetchMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: fetchMock }));

import type { SettingsStore } from '../../../platform/settings-store';
import { createThemeService, type ThemeService } from '../index';
import { writeThemeArchive } from '../archive';
import { sha256Of } from '../blobs';
import { createThemeInstalls, DownloadRefusedError, downloadTheme, keepBothName, MAX_STAGED_INSTALLS, originKind, STAGED_INSTALL_TTL_MS, type StagedInstall, type StageInput, type ThemeInstallDeps } from '../install';
import { gif } from '../../../shared/themes/testing/image-fixtures';
import { CACHE_FOLDER, FLASH_CHECK_VERSION, FLASH_FILE } from '../../../shared/themes/wallpapers';
import type { ThemeInstallFormat, ThemeInstallPreview, ThemeInstallSourceKind } from '../../../shared/themes/install';
import { failWrites, named, recolor } from './service-fixtures';

const COLORS = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const ARCHIVE_ID = '11111111-2222-4333-8444-555555555555';
const WALL = gif(10, 10, 3);
const SHA = sha256Of(WALL);

function themeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: ARCHIVE_ID,
    name: 'Aurora Borealis',
    looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: SHA, fit: 'fill', dim: 0.5, blur: 4 } } }] } },
    assets: { [SHA]: { kind: 'animated', mime: 'image/gif', bytes: WALL.length, width: 10, height: 10, frames: 3, flash: { flagged: false, allowed: true }, license: { spdx: 'CC0-1.0' } } },
    origin: { kind: 'store', installedAt: 1, store: { entryId: 'aurora', version: '1.0.0', sha256: SHA }, layoutOptIn: true },
    ...overrides,
  };
}

const archive = (theme: Record<string, unknown> = themeJson()): Promise<Uint8Array> => writeThemeArchive(JSON.stringify(theme), new Map([[SHA, { ext: 'gif', bytes: WALL }]]));

let root: string;
let themes: ThemeService;
let analyses: number;

function fakeSettings(file: string): SettingsStore {
  return {
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? file : undefined),
  } as unknown as SettingsStore;
}

function service(options: { readonly e2eThemeDownloads?: string } = {}): ThemeService {
  const created = createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')), ...options });
  analyses = 0;
  created.setAnalyzer(async (_sha, image) => {
    analyses++;
    return { thumb: new Uint8Array([1, 2, 3]), stats: { p10: 0.1, p90: 0.6, mean: 0.3 }, palette: { dark: COLORS, light: COLORS }, width: image.width, height: image.height, still: new Uint8Array([4]), flash: { flagged: true, atMs: 500 } };
  });
  return created;
}

const writeFile = (name: string, bytes: Uint8Array): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
};

const prepareFile = async (bytes?: Promise<Uint8Array>, name = 'aurora.damocles-theme'): Promise<ThemeInstallPreview> =>
  themes.installPrepare({ kind: 'file', path: writeFile(name, await (bytes ?? archive())) });

async function installed(id: string) {
  const entry = (await themes.list()).find((candidate) => candidate.id === id);
  if (entry?.status !== 'ok') throw new Error(`${id} is not installed`);
  return entry;
}

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const redirect = (status: number, location: string): Response =>
  ({ status, ok: false, headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) }, body: null }) as unknown as Response;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-install-'));
  themes = service();
  fetchMock.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('theme install', () => {
  it('stages a file without installing it, and lists what it holds with the flash check running', async () => {
    const preview = await prepareFile();
    expect(preview.source).toEqual({ kind: 'file', fileName: 'aurora.damocles-theme' });
    expect(preview.about.name).toBe('Aurora Borealis');
    expect(preview.theme.id).not.toBe(ARCHIVE_ID);
    expect(preview.theme.origin).toBeUndefined();
    expect(preview.wallpapers).toEqual([expect.objectContaining({ sha256: SHA, kind: 'animated', flash: 'pending', placements: [{ look: 'dark', panels: ['chat'], span: false }] })]);
    expect(preview.arrangement).toBe(false);
    expect((await themes.list()).filter((entry) => !('builtin' in entry && entry.builtin))).toEqual([]);
    // the asset is a blob from prepare on, so the theme renderer can check it
    expect(fs.existsSync(path.join(root, 'blobs', SHA))).toBe(true);
  });

  it('sends the preview again once the flash check ends, the file flagged and its thumbnail inline', async () => {
    const updates: ThemeInstallPreview[] = [];
    themes.onInstallUpdated((preview) => updates.push(preview));
    const preview = await prepareFile();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.installId).toBe(preview.installId);
    expect(updates[0]!.wallpapers[0]).toEqual(expect.objectContaining({ flash: 'flagged', atMs: 500, thumb: `data:image/webp;base64,${Buffer.from([1, 2, 3]).toString('base64')}` }));
  });

  it('allows a flagged wallpaper of a staged install on this computer only when the install lists it flagged, and the card hears it', async () => {
    const updates: ThemeInstallPreview[] = [];
    themes.onInstallUpdated((preview) => updates.push(preview));
    const preview = await prepareFile();
    // before its check ends the file is not flagged yet, so nothing is allowed
    expect(await themes.installAllowFlash(preview.installId, SHA)).toBe(false);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(await themes.installAllowFlash('no-such-install', SHA)).toBe(false);
    expect(await themes.installAllowFlash(preview.installId, 'f'.repeat(64))).toBe(false);
    expect(fs.readFileSync(path.join(root, CACHE_FOLDER, SHA, FLASH_FILE), 'utf8')).not.toContain('allowed');
    expect(await themes.installAllowFlash(preview.installId, SHA)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, CACHE_FOLDER, SHA, FLASH_FILE), 'utf8'))).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 500, allowed: true });
    expect(updates.at(-1)!.wallpapers[0]).toEqual(expect.objectContaining({ flash: 'flagged', allowed: true }));
    // a later install of the same file shows it allowed, since the allowance is this computer's and outlives the install
    const again = await prepareFile();
    await vi.waitFor(() => expect(updates.some((update) => update.installId === again.installId)).toBe(true));
    expect(updates.find((update) => update.installId === again.installId)!.wallpapers[0]).toEqual(expect.objectContaining({ allowed: true }));
  });

  it("tells the cards of staged installs the theme renderer's progress on a wallpaper their check waits on, and only those", async () => {
    let finish: () => void = () => undefined;
    themes.setAnalyzer(async (_sha, image) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { thumb: new Uint8Array([1]), stats: { p10: 0.1, p90: 0.6, mean: 0.3 }, palette: { dark: COLORS, light: COLORS }, width: image.width, height: image.height, still: new Uint8Array([4]), flash: { flagged: false } };
    });
    const progress: unknown[] = [];
    themes.onInstallProgress((step) => progress.push(step));
    const preview = await prepareFile();
    themes.analyzeProgress(SHA, 0.25);
    themes.analyzeProgress('f'.repeat(64), 0.5);
    expect(progress).toEqual([{ installId: preview.installId, sha256: SHA, fraction: 0.25 }]);
    finish();
    await vi.waitFor(async () => expect(fs.existsSync(path.join(root, CACHE_FOLDER, SHA))).toBe(true));
    await themes.installCancel(preview.installId);
    themes.analyzeProgress(SHA, 0.75);
    expect(progress).toHaveLength(1);
  });

  it('installs under a new id with core\'s origin, never the file\'s id, origin or flash allowance, as one history entry', async () => {
    const before = (await themes.history()).length;
    const preview = await prepareFile();
    const result = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    if (!('installed' in result)) throw new Error('refused');
    expect(result.installed.themeId).not.toBe(ARCHIVE_ID);
    expect(result.installed).toEqual(expect.objectContaining({ name: 'Aurora Borealis', replaced: false }));
    const entry = await installed(result.installed.themeId);
    expect(entry.theme.origin).toEqual({ kind: 'import', installedHash: expect.stringMatching(/^[0-9a-f]{64}$/), installedAt: expect.any(Number) });
    expect(entry.theme.assets?.[SHA]?.flash).toEqual({ flagged: true, atMs: 500 });
    const text = fs.readFileSync(path.join(root, 'themes', result.installed.themeId, 'theme.json'), 'utf8');
    expect(text).not.toContain('allowed');
    expect(text).not.toContain(ARCHIVE_ID);
    expect(text).not.toContain('"store"');
    const flash = JSON.parse(fs.readFileSync(path.join(root, CACHE_FOLDER, SHA, FLASH_FILE), 'utf8')) as Record<string, unknown>;
    expect(flash).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 500 });
    expect((await themes.history()).length).toBe(before + 1);
    expect((await themes.history())[0]!.change).toEqual({ kind: 'create', theme: 'Aurora Borealis' });
  });

  it('keeps the arrangement off unless the user turned it on', async () => {
    const layout = { sidebarWidth: 300 };
    const off = await prepareFile(archive(themeJson({ layout })));
    expect(off.arrangement).toBe(true);
    const first = await themes.installCommit({ installId: off.installId, useArrangement: false });
    expect('installed' in first && (await installed(first.installed.themeId)).theme.origin?.layoutOptIn).toBe(false);
    const on = await prepareFile(archive(themeJson({ name: 'Other', layout })), 'other.damocles-theme');
    const second = await themes.installCommit({ installId: on.installId, useArrangement: true });
    expect('installed' in second && (await installed(second.installed.themeId)).theme.origin?.layoutOptIn).toBe(true);
  });

  it('asks Keep both or Replace on a name clash, and Keep both installs under the next free number', async () => {
    const first = await prepareFile();
    await themes.installCommit({ installId: first.installId, useArrangement: false });
    const again = await prepareFile();
    expect(again.clash).toEqual(expect.objectContaining({ name: 'Aurora Borealis', keepBothName: 'Aurora Borealis 2', replaceable: true, keepsCopy: false }));
    expect(await themes.installCommit({ installId: again.installId, useArrangement: false })).toEqual({ refused: expect.objectContaining({ message: 'A theme named {0} is installed. Choose Keep both or Replace.' }) });
    const result = await themes.installCommit({ installId: again.installId, onClash: 'keepBoth', useArrangement: false });
    expect(result).toEqual({ installed: expect.objectContaining({ name: 'Aurora Borealis 2', replaced: false }) });
  });

  it('asks again with the clash on the card when a theme of that name was installed while the card was open', async () => {
    const updates: ThemeInstallPreview[] = [];
    themes.onInstallUpdated((preview) => updates.push(preview));
    const first = await prepareFile();
    const second = await prepareFile();
    expect(second.clash).toBeUndefined();
    await themes.installCommit({ installId: first.installId, useArrangement: false });
    const asked = await themes.installCommit({ installId: second.installId, useArrangement: false });
    if (!('refused' in asked) || !asked.preview) throw new Error('not asked again');
    expect(asked.refused).toEqual(expect.objectContaining({ message: 'A theme named {0} was installed while this card was open. Choose Keep both or Replace, then Install again.' }));
    expect(asked.preview.clash).toEqual(expect.objectContaining({ name: 'Aurora Borealis', keepBothName: 'Aurora Borealis 2', replaceable: true }));
    expect(updates.at(-1)?.clash).toEqual(asked.preview.clash);
    expect(await themes.installCommit({ installId: second.installId, onClash: 'keepBoth', useArrangement: false })).toEqual({ installed: expect.objectContaining({ name: 'Aurora Borealis 2' }) });
  });

  it('asks again when the Keep both name the card showed is taken by then', async () => {
    const first = await prepareFile();
    await themes.installCommit({ installId: first.installId, useArrangement: false });
    const second = await prepareFile();
    const third = await prepareFile();
    expect(third.clash?.keepBothName).toBe('Aurora Borealis 2');
    await themes.installCommit({ installId: second.installId, onClash: 'keepBoth', useArrangement: false });
    const asked = await themes.installCommit({ installId: third.installId, onClash: 'keepBoth', useArrangement: false });
    expect('refused' in asked && asked.preview?.clash?.keepBothName).toBe('Aurora Borealis 3');
  });

  it('Replace keeps the replaced theme\'s id, so the settings and schedules naming it still hold', async () => {
    const first = await prepareFile();
    const one = await themes.installCommit({ installId: first.installId, useArrangement: false });
    if (!('installed' in one)) throw new Error('refused');
    const again = await prepareFile(archive(themeJson({ looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } }, assets: undefined })));
    const result = await themes.installCommit({ installId: again.installId, onClash: 'replace', useArrangement: false });
    expect(result).toEqual({ installed: { themeId: one.installed.themeId, name: 'Aurora Borealis', replaced: true } });
    expect((await installed(one.installed.themeId)).theme.looks.dark?.colors.accent).toBe('#ff00aa');
    expect((await themes.history())[0]!.change).toEqual({ kind: 'save', theme: 'Aurora Borealis' });
    // one Undo gives the replaced theme back
    await themes.undo();
    expect((await installed(one.installed.themeId)).theme.looks.dark?.colors.accent).toBe(COLORS.accent);
  });

  it('Replace of a theme the user edited keeps the edits as a copy under the Keep both name', async () => {
    const first = await prepareFile();
    const one = await themes.installCommit({ installId: first.installId, useArrangement: false });
    if (!('installed' in one)) throw new Error('refused');
    await recolor(themes, one.installed.themeId, 'dark', { ...COLORS, accent: '#00ff00' });
    const again = await prepareFile();
    expect(again.clash?.keepsCopy).toBe(true);
    const result = await themes.installCommit({ installId: again.installId, onClash: 'replace', useArrangement: false });
    if (!('installed' in result)) throw new Error('refused');
    expect(result.installed.keptCopy?.name).toBe('Aurora Borealis 2');
    expect((await installed(result.installed.keptCopy!.themeId)).theme.looks.dark?.colors.accent).toBe('#00ff00');
    expect((await installed(one.installed.themeId)).theme.looks.dark?.colors.accent).toBe(COLORS.accent);
  });

  it('cancel drops the staged install and the blobs only it stored', async () => {
    const preview = await prepareFile();
    await vi.waitFor(() => expect(analyses).toBe(1));
    await themes.installCancel(preview.installId);
    expect(fs.existsSync(path.join(root, 'blobs', SHA))).toBe(false);
    expect(fs.existsSync(path.join(root, CACHE_FOLDER, SHA))).toBe(false);
    expect(await themes.installCommit({ installId: preview.installId, useArrangement: false })).toEqual({ refused: expect.objectContaining({ message: 'This theme install is no longer open. Start it again.' }) });
  });

  it('Replace that cannot write leaves the replaced theme byte for byte, with no history entry', async () => {
    const first = await prepareFile();
    const one = await themes.installCommit({ installId: first.installId, useArrangement: false });
    if (!('installed' in one)) throw new Error('refused');
    const file = path.join(root, 'themes', one.installed.themeId, 'theme.json');
    const before = fs.readFileSync(file, 'utf8');
    const entries = await themes.history();
    const again = await prepareFile(archive(themeJson({ looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } }, assets: undefined })));
    const failing = failWrites(named('theme.json'));
    await expect(themes.installCommit({ installId: again.installId, onClash: 'replace', useArrangement: false })).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(await themes.history()).toEqual(entries);
    // the install is still open, and the same press goes through once the disk has room
    expect(await themes.installCommit({ installId: again.installId, onClash: 'replace', useArrangement: false })).toEqual({ installed: { themeId: one.installed.themeId, name: 'Aurora Borealis', replaced: true } });
  });

  it('cancel keeps a blob an import stored again after the install staged it, for a theme no file names yet', async () => {
    const preview = await prepareFile();
    await vi.waitFor(() => expect(analyses).toBe(1));
    await themes.importImage({ bytes: WALL, name: 'wall.gif' });
    await themes.installCancel(preview.installId);
    expect(fs.existsSync(path.join(root, 'blobs', SHA))).toBe(true);
  });

  it('cancel keeps a blob an installed theme also names', async () => {
    const first = await prepareFile();
    await themes.installCommit({ installId: first.installId, useArrangement: false });
    const again = await prepareFile();
    await themes.installCancel(again.installId);
    expect(fs.existsSync(path.join(root, 'blobs', SHA))).toBe(true);
  });

  it('cleans the name it installs under, as the card showed it', async () => {
    const preview = await prepareFile(archive(themeJson({ name: 'Evil\u202Eeht\u0007 Name' })));
    expect(preview.about.name).toBe('Evileht Name');
    const result = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    expect(result).toEqual({ installed: expect.objectContaining({ name: 'Evileht Name' }) });
  });

  it('lists a CSS region the sanitizer drops whole, with what it drops', async () => {
    const preview = await prepareFile(archive(themeJson({ css: { sidebar: '@import url(https://evil.example/x.css);', transcript: 'p { color: #ff0000 }' } })));
    expect(preview.css).toEqual([
      { region: 'transcript', bytes: 20, dropped: [] },
      { region: 'sidebar', bytes: 40, dropped: [expect.objectContaining({ region: 'sidebar' })] },
    ]);
    expect(preview.theme.css).toEqual({ transcript: expect.any(String) });
  });

  it('names the Keep both copy within 64 characters', () => {
    expect(keepBothName('a'.repeat(64), ['a'.repeat(64)])).toBe(`${'a'.repeat(62)} 2`);
    expect(keepBothName('Dusk', ['Dusk', 'dusk 2'])).toBe('Dusk 3');
  });
});

describe('theme install downloads', () => {
  it('refuses a link that is not https before anything is fetched', async () => {
    await expect(themes.installPrepare({ kind: 'link', url: 'http://themes.example/aurora.damocles-theme' })).rejects.toThrow(/only from https links/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the host and installs nothing on its own', async () => {
    fetchMock.mockResolvedValueOnce(new Response(await archive(), { status: 200 }));
    const preview = await themes.installPrepare({ kind: 'url', url: 'https://themes.example/dl/aurora.damocles-theme' });
    expect(preview.source).toEqual({ kind: 'url', host: 'themes.example', fileName: 'aurora.damocles-theme' });
    expect((await themes.list()).some((entry) => entry.status === 'ok' && entry.name === 'Aurora Borealis')).toBe(false);
  });

  it('follows a redirect on the same host, through the SSRF guard on each hop', async () => {
    fetchMock.mockResolvedValueOnce(redirect(302, '/files/aurora.damocles-theme')).mockResolvedValueOnce(new Response(await archive(), { status: 200 }));
    const preview = await themes.installPrepare({ kind: 'link', url: 'https://themes.example/latest' });
    expect(preview.source.host).toBe('themes.example');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://themes.example/latest', 'https://themes.example/files/aurora.damocles-theme']);
    expect(fetchMock.mock.calls.every(([, init]) => (init as { redirect?: string }).redirect === 'manual')).toBe(true);
  });

  it('refuses a redirect to another host, naming it, without contacting it', async () => {
    fetchMock.mockResolvedValueOnce(redirect(302, 'https://cdn.elsewhere.example/aurora.damocles-theme'));
    await expect(themes.installPrepare({ kind: 'link', url: 'https://themes.example/latest' })).rejects.toThrow(/another host, cdn\.elsewhere\.example/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect on the same host that leaves https', async () => {
    fetchMock.mockResolvedValueOnce(redirect(301, 'http://themes.example/aurora.damocles-theme'));
    await expect(themes.installPrepare({ kind: 'link', url: 'https://themes.example/latest' })).rejects.toThrow(/not https/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a link to a private address through the SSRF guard', async () => {
    await expect(themes.installPrepare({ kind: 'link', url: 'https://10.0.0.5/aurora.damocles-theme' })).rejects.toThrow(/Blocked private address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops a body past 100 MB as it streams, whatever its length header says', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 101) controller.enqueue(chunk);
        else controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-length': '10' } }));
    await expect(themes.installPrepare({ kind: 'url', url: 'https://themes.example/huge.damocles-theme' })).rejects.toThrow(/larger than 100 MB/);
    expect(sent).toBeLessThanOrEqual(102);
  });

  it('refuses an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(themes.installPrepare({ kind: 'url', url: 'https://themes.example/gone' })).rejects.toThrow(/answered HTTP 404/);
  });

  it('reads https://e2e.test/<name> from the e2e folder only when core was given one, every check still running', async () => {
    const folder = fs.mkdtempSync(path.join(root, 'e2e-'));
    fs.writeFileSync(path.join(folder, 'aurora.damocles-theme'), await archive());
    fs.writeFileSync(path.join(folder, 'broken.damocles-theme'), new Uint8Array([1, 2, 3]));
    const seamed = service({ e2eThemeDownloads: folder });
    const preview = await seamed.installPrepare({ kind: 'link', url: 'https://e2e.test/aurora.damocles-theme' });
    expect(preview.source.host).toBe('e2e.test');
    await expect(seamed.installPrepare({ kind: 'link', url: 'https://e2e.test/broken.damocles-theme' })).rejects.toThrow(/not a zip archive/);
    await expect(seamed.installPrepare({ kind: 'link', url: 'https://e2e.test/.hidden' })).rejects.toThrow(/not a link Damocles can open/);
    await expect(seamed.installPrepare({ kind: 'link', url: 'http://e2e.test/aurora.damocles-theme' })).rejects.toThrow(/only from https links/);
    expect(fetchMock).not.toHaveBeenCalled();
    // without the folder the host is an ordinary one, fetched through the guard
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(themes.installPrepare({ kind: 'link', url: 'https://e2e.test/aurora.damocles-theme' })).rejects.toThrow(/answered HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a download\'s time bounds', () => {
  // a body as undici gives one: it ends in an error when the request's signal aborts
  const bodyOf = (init: RequestInit | undefined, start: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Response =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        start(controller);
      },
    }), { status: 200 });
  const download = (): Promise<unknown> => downloadTheme('https://themes.example/aurora.damocles-theme', { signal: new AbortController().signal }).then(() => 'downloaded', (err: unknown) => err);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops a body that sends nothing for 30 seconds, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => bodyOf(init, (controller) => controller.enqueue(new Uint8Array(10))));
    const pending = download();
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = await pending;
    expect(failure).toBeInstanceOf(DownloadRefusedError);
    expect((failure as Error).message).toBe('themes.example sent nothing for 30 seconds, so the download stopped.');
  });

  it('stops a body that still drips at the whole download\'s 10 minutes, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => bodyOf(init, (controller) => {
      const timer = setInterval(() => controller.enqueue(new Uint8Array(1)), 20_000);
      init.signal?.addEventListener('abort', () => clearInterval(timer));
    }));
    const pending = download();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const failure = await pending;
    expect(failure).toBeInstanceOf(DownloadRefusedError);
    expect((failure as Error).message).toBe('The download from themes.example took longer than 10 minutes, so it stopped.');
  });

  it('words a refused redirect as the caller\'s own rule words it', async () => {
    fetchMock.mockResolvedValueOnce(redirect(302, 'https://cdn.elsewhere.example/aurora.damocles-theme'));
    const refusals: string[][] = [];
    const failure = await downloadTheme('https://themes.example/latest', {
      signal: new AbortController().signal,
      redirect: { allowed: () => false, refusal: (host, target) => {
        refusals.push([host, target]);
        return { message: 'Not one of ours: {0}', args: [target] };
      } },
    }).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(DownloadRefusedError);
    expect((failure as Error).message).toBe('Not one of ours: cdn.elsewhere.example');
    expect(refusals).toEqual([['themes.example', 'cdn.elsewhere.example']]);
  });

  it('answers the SHA-256 of the bytes, hashed chunk by chunk as they arrive', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array(70_000).fill(9), new Uint8Array([4])];
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => bodyOf(init, (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }));
    const downloaded = await downloadTheme('https://themes.example/aurora.damocles-theme', { signal: new AbortController().signal });
    const whole = Buffer.concat(chunks);
    expect(Buffer.from(downloaded.bytes).equals(whole)).toBe(true);
    expect(downloaded.sha256).toBe(createHash('sha256').update(whole).digest('hex'));
  });
});

describe('staged installs', () => {
  const bare = (name: string): Uint8Array => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, id: ARCHIVE_ID, name, looks: { dark: { colors: COLORS } } }));
  const input = (bytes: Uint8Array, fileName = 'theme.json'): StageInput => ({ bytes, fileName, source: { kind: 'file', fileName } });

  function installs(overrides: Partial<ThemeInstallDeps> = {}) {
    const dropped: Array<ReadonlyMap<string, number>> = [];
    const logged: string[] = [];
    const service = createThemeInstalls({
      list: async () => [],
      putBlobs: async (assets) => new Map([...assets.keys()].map((sha256) => [sha256, 1])),
      dropBlobs: async (staged) => {
        dropped.push(staged);
      },
      analyzeWallpaper: async () => ({}),
      analyzeSprite: async () => ({}),
      newId: () => '7b0e6f4c-3a2d-4e1f-9c8b-5a6d7e8f9012',
      now: () => 0,
      log: (line) => logged.push(line),
      ...overrides,
    });
    return { service, dropped, logged };
  }

  it('never number more than eight, however many are staged at once', async () => {
    const { service } = installs();
    const outcomes = await Promise.allSettled(Array.from({ length: MAX_STAGED_INSTALLS + 1 }, (_, n) => service.stage(input(bare(`Theme ${n}`)))));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(MAX_STAGED_INSTALLS);
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(refused.map((outcome) => (outcome.reason as Error).message)).toEqual(['8 theme installs are already open. Install or cancel one first.']);
    // a place a refused or cancelled install held is free again
    const [first] = outcomes;
    await service.cancel((first as PromiseFulfilledResult<ThemeInstallPreview>).value.installId);
    await expect(service.stage(input(bare('Theme 9')))).resolves.toMatchObject({ about: { name: 'Theme 9' } });
    await expect(service.stage(input(bare('Theme 10')))).rejects.toThrow(/already open/);
  });

  it('gives its place back when the file is refused', async () => {
    const { service } = installs();
    for (let n = 0; n < MAX_STAGED_INSTALLS + 2; n++) await expect(service.stage(input(new TextEncoder().encode('{ "schemaVersion": 1 ')))).rejects.toThrow(/is not JSON/);
    await expect(service.stage(input(bare('Fits')))).resolves.toMatchObject({ about: { name: 'Fits' } });
  });

  it('expires on its own after an hour, its blobs dropped, with no other install starting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, dropped } = installs();
      const preview = await service.stage(input(await archive(), 'aurora.damocles-theme'));
      await vi.advanceTimersByTimeAsync(STAGED_INSTALL_TTL_MS - 1);
      expect(service.open(preview.installId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(service.open(preview.installId)).toBe(false);
      await vi.waitFor(() => expect(dropped).toEqual([new Map([[SHA, 1]])]));
      expect(await service.settled(preview.installId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind an install that was cancelled or committed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, dropped } = installs();
      const cancelled = await service.stage(input(bare('One')));
      const committed = await service.stage(input(bare('Two')));
      await service.cancel(cancelled.installId);
      service.forget(committed.installId);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(STAGED_INSTALL_TTL_MS);
      // only the cancel dropped blobs
      expect(dropped).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells its listeners when an install expires, and not when it is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service } = installs();
      const expired: string[] = [];
      service.onExpired((installId) => expired.push(installId));
      const cancelled = await service.stage(input(bare('One')));
      const waiting = await service.stage(input(bare('Two')));
      await service.cancel(cancelled.installId);
      await vi.advanceTimersByTimeAsync(STAGED_INSTALL_TTL_MS);
      await vi.waitFor(() => expect(expired).toEqual([waiting.installId]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one check of a file two staged installs name, and ends it only once no staged install waits on it', async () => {
    const signals: AbortSignal[] = [];
    const { service } = installs({
      analyzeWallpaper: (_sha256, _asset, signal) => {
        signals.push(signal);
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
      },
    });
    const bytes = await archive();
    const first = await service.stage(input(bytes, 'aurora.damocles-theme'));
    const second = await service.stage(input(bytes, 'aurora.damocles-theme'));
    expect(signals).toHaveLength(1);
    // this cancel neither ends the check the second install waits on nor waits for it to end
    await service.cancel(first.installId);
    expect(signals[0]!.aborted).toBe(false);
    await service.cancel(second.installId);
    expect(signals[0]!.aborted).toBe(true);
    // an install staged after the check was ended starts its own
    await service.stage(input(bytes, 'aurora.damocles-theme'));
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  });

  it('takes back the blobs it stored when staging fails after they were stored', async () => {
    const { service, dropped } = installs({
      now: () => {
        throw new Error('the clock failed');
      },
    });
    await expect(service.stage(input(await archive(), 'aurora.damocles-theme'))).rejects.toThrow('the clock failed');
    expect(dropped).toEqual([new Map([[SHA, 1]])]);
  });

  it('tells every listener, whatever another listener throws, and no failure escapes', async () => {
    let finish!: () => void;
    const analyzed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { service, logged } = installs({ analyzeWallpaper: () => analyzed.then(() => ({ flash: { flagged: true } })) });
    const heard: string[] = [];
    const progress: number[] = [];
    service.onUpdated(() => {
      throw new Error('a listener broke');
    });
    service.onUpdated((preview) => heard.push(preview.wallpapers[0]!.flash));
    service.onProgress(() => {
      throw new Error('a progress listener broke');
    });
    service.onProgress((update) => progress.push(update.fraction));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const preview = await service.stage(input(await archive(), 'aurora.damocles-theme'));
      service.progress(SHA, 0.5);
      finish();
      await vi.waitFor(() => expect(heard).toEqual(['flagged']));
      service.flashAllowed(SHA);
      expect(service.setClash(preview.installId, undefined)).toBeDefined();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(heard).toEqual(['flagged', 'flagged', 'flagged']);
    expect(progress).toEqual([0.5]);
    expect(unhandled).toEqual([]);
    expect(logged.filter((line) => line.includes('a listener broke'))).toHaveLength(3);
    expect(logged.filter((line) => line.includes('a progress listener broke'))).toHaveLength(1);
  });
});

describe('the blobs of a staged install', () => {
  it('are stored all or not at all: a store that fails on the second asset leaves the first out too', async () => {
    const second = gif(12, 12, 2);
    const sha2 = sha256Of(second);
    const theme = themeJson({
      assets: {
        [SHA]: { kind: 'animated', mime: 'image/gif', bytes: WALL.length, width: 10, height: 10, frames: 3, license: {} },
        [sha2]: { kind: 'animated', mime: 'image/gif', bytes: second.length, width: 12, height: 12, frames: 2, license: {} },
      },
    });
    const bytes = await writeThemeArchive(JSON.stringify(theme), new Map([[SHA, { ext: 'gif', bytes: WALL }], [sha2, { ext: 'gif', bytes: second }]]));
    const failing = failWrites(named(sha2));
    try {
      await expect(themes.installPrepare({ kind: 'file', path: writeFile('two.damocles-theme', bytes) })).rejects.toThrow(/ENOSPC/);
    } finally {
      failing.restore();
    }
    expect(fs.existsSync(path.join(root, 'blobs', SHA))).toBe(false);
    expect(fs.existsSync(path.join(root, 'blobs', sha2))).toBe(false);
  });
});

describe('originKind', () => {
  const staged = (format: ThemeInstallFormat, kind: ThemeInstallSourceKind): StagedInstall => ({ source: { kind }, imported: { format } }) as unknown as StagedInstall;

  it('gives a converted format its own kind, picked or downloaded, and a Damocles theme import or link', () => {
    for (const format of ['vscode', 'base16', 'gtk', 'kde', 'qt'] as const) {
      for (const kind of ['file', 'url', 'link', 'agent'] as const) expect(originKind(staged(format, kind))).toBe(format);
    }
    expect(originKind(staged('damocles', 'file'))).toBe('import');
    expect(originKind(staged('damocles', 'url'))).toBe('link');
  });
});
