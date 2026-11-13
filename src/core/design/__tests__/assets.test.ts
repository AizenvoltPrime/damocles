import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { AssetRefusedError, importAsset, importAssetFile, importAssetUrl, MAX_ASSET_BYTES, sniffAsset } from '../assets';
import { ProjectFiles } from '../citations';
import { resolveReadPath, resolveToCwd } from '../../pi-session/tools/search-tools';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn(async (_host: string, _options: unknown) => [{ address: '93.184.215.14', family: 4 }]) }));
vi.mock('node:dns/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:dns/promises')>(), lookup }));
vi.mock('undici', async (importOriginal) => (await import('../../pi-session/web-access/__tests__/support/undici-through-global-fetch')).undiciThroughGlobalFetch(await importOriginal()));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  lookup.mockClear();
});
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
function setUp(): { project: string; folder: string; files: ProjectFiles } {
  const project = tempDir('design-assets-project-');
  return { project, folder: tempDir('design-assets-folder-'), files: new ProjectFiles(project, createVsCodeFileConfinement()) };
}

describe('ImportAsset (PD-46)', () => {
  it('copies a project font or image into assets/, reusing an identical copy and numbering a different one', async () => {
    const { project, folder, files } = setUp();
    fs.mkdirSync(path.join(project, 'img'));
    fs.writeFileSync(path.join(project, 'img', 'logo.png'), 'png-1');
    fs.mkdirSync(path.join(project, 'other'));
    fs.writeFileSync(path.join(project, 'other', 'logo.png'), 'png-2');
    expect(await importAsset(files, 'img/logo.png', folder)).toEqual({ asset: 'assets/logo.png', bytes: 5, source: 'img/logo.png' });
    expect(await importAsset(files, 'img\\logo.png', folder)).toEqual({ asset: 'assets/logo.png', bytes: 5, source: 'img\\logo.png' });
    expect(await importAsset(files, 'other/logo.png', folder)).toEqual({ asset: 'assets/logo-2.png', bytes: 5, source: 'other/logo.png' });
    expect(fs.readFileSync(path.join(folder, 'assets', 'logo-2.png'), 'utf8')).toBe('png-2');
  });

  it('refuses a path outside the working folder, a missing file, a type it does not copy and a folder', async () => {
    const { project, folder, files } = setUp();
    fs.writeFileSync(path.join(project, 'run.sh'), 'x');
    fs.mkdirSync(path.join(project, 'dir.png'));
    for (const [file, reason] of [['../x.png', /does not exist|outside/], [path.join(project, 'a.png'), /not a path relative/], ['missing.png', /does not exist/], ['run.sh', /not a font or image/], ['dir.png', /not a regular file|could not be read/]] as const) {
      const refused = importAsset(files, file, folder);
      await expect(refused).rejects.toBeInstanceOf(AssetRefusedError);
      await expect(refused).rejects.toThrow(reason);
    }
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(false);
  });

  it('refuses a file past 5 MiB and a hard link', async () => {
    const { project, folder, files } = setUp();
    fs.writeFileSync(path.join(project, 'big.png'), Buffer.alloc(MAX_ASSET_BYTES + 1));
    await expect(importAsset(files, 'big.png', folder)).rejects.toThrow(/larger than 5 MiB/);
    fs.writeFileSync(path.join(project, 'a.png'), 'x');
    fs.linkSync(path.join(project, 'a.png'), path.join(project, 'b.png'));
    await expect(importAsset(files, 'b.png', folder)).rejects.toThrow(/more than one hard link/);
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest of a jpeg')]);
// an ISO BMFF ftyp box of 28 bytes: major brand avif, minor version 0, compatible brands avif, mif1, miaf
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif'), Buffer.from([0, 0, 0, 0]), Buffer.from('avifmif1miaf'), Buffer.from('meta and pixels')]);
const HTML = Buffer.from('<!doctype html><html><body>Not found</body></html>');

/** A fetch whose every answer is `answer(url)`, recording each URL asked. */
function stubFetch(answer: (url: string) => Response): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    return answer(url);
  }));
  return asked;
}

describe('ImportAsset\'s content sniffing (D101)', () => {
  it('names each type it copies by its magic bytes, and SVG only as XML with an <svg> root', () => {
    expect(sniffAsset(PNG)).toBe('png');
    expect(sniffAsset(JPEG)).toBe('jpeg');
    expect(sniffAsset(AVIF)).toBe('avif');
    expect(sniffAsset(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffAsset(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffAsset(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('ico');
    expect(sniffAsset(Buffer.from('wOFF\0\x01\0\0'))).toBe('woff');
    expect(sniffAsset(Buffer.from('wOF2\0\x01\0\0'))).toBe('woff2');
    expect(sniffAsset(Buffer.from([0, 1, 0, 0, 0, 12]))).toBe('sfnt');
    expect(sniffAsset(Buffer.from('OTTO\0\x0c'))).toBe('sfnt');
    expect(sniffAsset(Buffer.from('\ufeff<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    for (const other of [HTML, Buffer.from('<html><svg></svg></html>'), Buffer.from('<svgx/>'), Buffer.from([0, 0, 2, 0, 1, 0]), Buffer.from([0, 0, 1, 0, 0, 0]), Buffer.from([0xc3, 0x28, 0x3c, 0x73, 0x76, 0x67]), Buffer.alloc(0)]) {
      expect(sniffAsset(other), other.toString('latin1')).toBeUndefined();
    }
  });
});

describe('ImportAsset from a URL (D101)', () => {
  const signal = new AbortController().signal;
  const none = (): boolean => false;

  it('imports an AVIF over https, naming the source, and gives a URL with no extension the sniffed one', async () => {
    const folder = tempDir('design-assets-folder-');
    const asked = stubFetch((url) => new Response(url.endsWith('.avif') ? AVIF : JPEG, { status: 200 }));
    expect(await importAssetUrl('https://images.example.com/photos/wallpaper.avif', folder, signal, none)).toEqual({ asset: 'assets/wallpaper.avif', bytes: AVIF.length, source: 'https://images.example.com/photos/wallpaper.avif' });
    expect(fs.readFileSync(path.join(folder, 'assets', 'wallpaper.avif')).equals(AVIF)).toBe(true);
    expect((await importAssetUrl('https://images.example.com/photo-123?fm=jpg&w=1200', folder, signal, none)).asset).toBe('assets/photo-123.jpg');
    expect(asked).toEqual(['https://images.example.com/photos/wallpaper.avif', 'https://images.example.com/photo-123?fm=jpg&w=1200']);
    expect(lookup).toHaveBeenCalledWith('images.example.com', { all: true, family: 0 });
  });

  it('refuses a .png URL that serves HTML, and a .jpg URL that serves a PNG, writing nothing', async () => {
    const folder = tempDir('design-assets-folder-');
    stubFetch((url) => new Response(url.endsWith('.png') ? HTML : PNG, { status: 200 }));
    await expect(importAssetUrl('https://example.com/logo.png', folder, signal, none)).rejects.toThrow(/holds no font or image ImportAsset copies/);
    await expect(importAssetUrl('https://example.com/logo.jpg', folder, signal, none)).rejects.toThrow(/is named \.jpg but holds a PNG file/);
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(false);
  });

  it('refuses a private-network address through the SSRF guard, as a literal, by DNS and after a redirect, before any request reaches it', async () => {
    const folder = tempDir('design-assets-folder-');
    const asked = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin.png' } }));
    await expect(importAssetUrl('https://192.168.1.10/a.png', folder, signal, none)).rejects.toThrow(/Blocked private address/);
    lookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(importAssetUrl('https://intranet.example.com/a.png', folder, signal, none)).rejects.toThrow(/Blocked private address: intranet\.example\.com/);
    await expect(importAssetUrl('https://example.com/a.png', folder, signal, none)).rejects.toThrow(/Blocked private address: 127\.0\.0\.1/);
    expect(asked).toEqual(['https://example.com/a.png']);
  });

  it('refuses a redirect to http before it reaches the http address', async () => {
    const folder = tempDir('design-assets-folder-');
    const asked = stubFetch(() => new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/a.png' } }));
    await expect(importAssetUrl('https://example.com/a.png', folder, signal, none)).rejects.toThrow(/Blocked URL scheme: http: \(only https is fetched\)/);
    expect(asked).toEqual(['https://example.com/a.png']);
  });

  it('refuses http, a URL that does not parse, an error status and a body past 5 MiB', async () => {
    const folder = tempDir('design-assets-folder-');
    stubFetch((url) => (url.includes('missing') ? new Response('gone', { status: 404 }) : new Response(Buffer.alloc(MAX_ASSET_BYTES + 1), { status: 200 })));
    await expect(importAssetUrl('http://example.com/a.png', folder, signal, none)).rejects.toThrow(/not an https URL/);
    await expect(importAssetUrl('example.com/a.png', folder, signal, none)).rejects.toThrow(/not a URL/);
    await expect(importAssetUrl('https://example.com/missing.png', folder, signal, none)).rejects.toThrow(/answered HTTP 404/);
    await expect(importAssetUrl('https://example.com/huge.png', folder, signal, none)).rejects.toThrow(/Response too large/);
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(false);
  });

  it('refuses an SSRF block and a timeout as ImportAsset refusals, while a user abort stays an abort', async () => {
    const folder = tempDir('design-assets-folder-');
    stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin.png' } }));
    await expect(importAssetUrl('https://example.com/a.png', folder, signal, none)).rejects.toBeInstanceOf(AssetRefusedError);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      init.signal!.throwIfAborted();
      return new Response(PNG, { status: 200 });
    }));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    try {
      const timedOut = importAssetUrl('https://example.com/a.png', folder, signal, none);
      await expect(timedOut).rejects.toBeInstanceOf(AssetRefusedError);
      await expect(timedOut).rejects.toThrow('https://example.com/a.png did not answer within 30 seconds');
    } finally {
      timeout.mockRestore();
    }
    const stop = new AbortController();
    stop.abort();
    const aborted = importAssetUrl('https://example.com/a.png', folder, stop.signal, none);
    await expect(aborted).rejects.not.toBeInstanceOf(AssetRefusedError);
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops at a redirect to a host a WebFetch rule covers and names it, and follows one on the named host', async () => {
    const folder = tempDir('design-assets-folder-');
    const refused = (url: string): boolean => ['tracker.org', 'example.com'].includes(new URL(url).hostname);
    const asked = stubFetch((url) => (url.endsWith('/away.png') ? new Response(null, { status: 302, headers: { location: 'https://tracker.org/a.png' } })
      : url.endsWith('/moved.png') ? new Response(null, { status: 301, headers: { location: '/a.png' } }) : new Response(PNG, { status: 200 })));
    const stopped = importAssetUrl('https://example.com/away.png', folder, signal, refused);
    await expect(stopped).rejects.toBeInstanceOf(AssetRefusedError);
    await expect(stopped).rejects.toThrow('https://example.com/away.png redirects to https://tracker.org/a.png, whose host a WebFetch rule');
    expect((await importAssetUrl('https://example.com/moved.png', folder, signal, refused)).asset).toBe('assets/moved.png');
    expect(asked).toEqual(['https://example.com/away.png', 'https://example.com/moved.png', 'https://example.com/a.png']);
  });

  it('saves a JPEG as .jpg from a URL, a file and a project path, and names the saved file', async () => {
    const folder = tempDir('design-assets-folder-');
    stubFetch(() => new Response(JPEG, { status: 200 }));
    expect(await importAssetUrl('https://example.com/photo.jpeg', folder, signal, none)).toEqual({ asset: 'assets/photo.jpg', bytes: JPEG.length, source: 'https://example.com/photo.jpeg' });
    const photos = tempDir('design-assets-photos-');
    fs.writeFileSync(path.join(photos, 'scan.JPEG'), JPEG);
    expect((await importAssetFile(path.join(photos, 'scan.JPEG'), photos, folder)).asset).toBe('assets/scan.jpg');
    const { project, files } = setUp();
    fs.writeFileSync(path.join(project, 'hero.jpeg'), JPEG);
    expect((await importAsset(files, 'hero.jpeg', folder)).asset).toBe('assets/hero.jpg');
    expect(fs.readdirSync(path.join(folder, 'assets')).sort()).toEqual(['hero.jpg', 'photo.jpg', 'scan.jpg']);
  });
});

describe('ImportAsset from a file outside the project (D101)', () => {
  it('copies the file a Read of the same name opens, naming the source as written', async () => {
    const folder = tempDir('design-assets-folder-');
    const photos = tempDir('design-assets-photos-');
    const wallpaper = path.join(photos, 'Wall paper.avif');
    fs.writeFileSync(wallpaper, AVIF);
    expect(await importAssetFile(wallpaper, photos, folder)).toEqual({ asset: 'assets/Wall-paper.avif', bytes: AVIF.length, source: wallpaper });
    fs.writeFileSync(path.join(photos, 'scan'), JPEG);
    expect((await importAssetFile(path.join(photos, 'scan'), photos, folder)).asset).toBe('assets/scan.jpg');
    // Read maps a no-break space to a plain one, takes file:// URLs and resolves a relative name against the chat's folder.
    for (const spelled of [path.join(photos, 'Wall\u00a0paper.avif'), pathToFileURL(wallpaper).href, 'Wall paper.avif']) {
      expect(resolveReadPath(resolveToCwd(spelled, photos)), spelled).toBe(wallpaper);
      expect((await importAssetFile(spelled, photos, folder)).asset, spelled).toBe('assets/Wall-paper.avif');
    }
  });

  it.runIf(process.platform === 'win32')('reads a /c/... spelling as the drive path a Read rule judges on Windows', async () => {
    const folder = tempDir('design-assets-folder-');
    const photos = tempDir('design-assets-photos-');
    const wallpaper = path.join(photos, 'wallpaper.avif');
    fs.writeFileSync(wallpaper, AVIF);
    const msys = `/${wallpaper[0]!.toLowerCase()}${wallpaper.slice(2).split(path.sep).join('/')}`;
    expect(resolveReadPath(resolveToCwd(msys, photos))).toBe(wallpaper);
    expect((await importAssetFile(msys, photos, folder)).asset).toBe('assets/wallpaper.avif');
  });

  it('refuses a missing file, a hard link, a file past 5 MiB, a folder and bytes its name does not say', async () => {
    const folder = tempDir('design-assets-folder-');
    const photos = tempDir('design-assets-photos-');
    fs.writeFileSync(path.join(photos, 'a.png'), PNG);
    fs.linkSync(path.join(photos, 'a.png'), path.join(photos, 'b.png'));
    fs.writeFileSync(path.join(photos, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_ASSET_BYTES)]));
    fs.writeFileSync(path.join(photos, 'page.png'), HTML);
    for (const [file, reason] of [
      [path.join(photos, 'missing.png'), /does not exist/], [path.join(photos, 'b.png'), /more than one hard link/],
      [path.join(photos, 'big.png'), /larger than 5 MiB/], [path.join(photos, 'page.png'), /holds no font or image/], [photos, /not a regular file/],
    ] as const) {
      const refused = importAssetFile(file, photos, folder);
      await expect(refused, file).rejects.toBeInstanceOf(AssetRefusedError);
      await expect(refused, file).rejects.toThrow(reason);
    }
    expect(fs.existsSync(path.join(folder, 'assets'))).toBe(false);
  });

  it('refuses a symbolic link, whose target the Read rules did not judge', async () => {
    const folder = tempDir('design-assets-folder-');
    const photos = tempDir('design-assets-photos-');
    fs.writeFileSync(path.join(photos, 'real.png'), PNG);
    try {
      fs.symlinkSync(path.join(photos, 'real.png'), path.join(photos, 'link.png'), 'file');
    } catch (err) {
      // a file symlink on Windows needs Developer Mode or an elevated shell
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    await expect(importAssetFile(path.join(photos, 'link.png'), photos, folder)).rejects.toThrow(/not a regular file/);
  });
});
