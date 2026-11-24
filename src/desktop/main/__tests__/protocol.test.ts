import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

import { protocol } from 'electron';
import { ThemeRenderer, type RenderPage, type RenderServed } from '../themes/theme-renderer';
import type { ThemeRenderJob } from '../../../shared/themes/agent';
import { appResourceUri, handleAppProtocol, handleThemeRenderProtocol, mimeTypeFor, NOTIFIER_PAGE_URL, panelPageUrl, registerAppScheme, resolveAppRequest, SHELL_PAGE_URL, THEME_RENDER_PAGE_URL, THEME_SHOT_URL_PREFIX, type AppPages, type ThemeRenderPages } from '../protocol';

const SHOT = 'f'.repeat(32);
const SHOT_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const STORE_THUMB_SHA = 'e'.repeat(64);
const STORE_THUMB_WEBP = new Uint8Array([...new TextEncoder().encode('RIFF'), 4, 0, 0, 0, ...new TextEncoder().encode('WEBP')]);

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-protocol-'));
  fs.mkdirSync(path.join(root, 'dist', 'webview', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'monaco-editor.worker-Ab12.js'), 'self.onmessage = () => {};');
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'monaco-codicon-Cd34.ttf'), Buffer.from([0, 1, 0, 0]));
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'monaco-editor-Ef56.css'), '.monaco-editor{}');
  fs.mkdirSync(path.join(root, 'dist', 'desktop-shell', 'file-icons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'desktop-shell', 'file-icons', 'folder.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'dist', 'desktop', 'main.js'), 'secret');
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, 'outside', 'secret.js'), 'secret');
  // A junction needs no privilege on Windows and is a directory symlink elsewhere.
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'dist', 'webview', 'assets', 'linked'), 'junction');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('registerAppScheme', () => {
  it('registers the design and preview schemes in the same call as app; only the preview scheme gets fetch and CORS (PD-31), only app streams', () => {
    registerAppScheme();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      // a video wallpaper's element reads its blob in byte ranges
      { scheme: 'app', privileges: { standard: true, secure: true, stream: true } },
      { scheme: 'damocles-design', privileges: { standard: true, secure: true } },
      // no service worker, code cache, stream or CSP bypass privilege
      { scheme: 'damocles-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    ]);
  });
});

describe('resolveAppRequest', () => {
  it('serves files inside dist/webview and dist/desktop-shell', () => {
    expect(resolveAppRequest('app://damocles/webview/assets/index.js', root)).toEqual({
      kind: 'file',
      root: path.join(root, 'dist', 'webview'),
      filePath: path.join(root, 'dist', 'webview', 'assets', 'index.js'),
    });
    expect(resolveAppRequest('app://damocles/desktop-shell/assets/index.js', root)).toMatchObject({
      kind: 'file',
      filePath: path.join(root, 'dist', 'desktop-shell', 'assets', 'index.js'),
    });
  });

  it.each([
    'app://damocles/webview/../extension.js',
    'app://damocles/webview/assets/../../extension.js',
    'app://damocles/webview/%2e%2e/extension.js',
    'app://damocles/webview/%2E%2E/%2e%2e/package.json',
    'app://damocles/webview/..%2f..%2fpackage.json',
    'app://damocles/webview/%2fetc%2fpasswd',
    'app://damocles/webview',
    'app://damocles/webview/',
    'app://damocles/resources/grammars/tree-sitter.wasm',
    'app://damocles/package.json',
    'app://damocles/dist/extension.js',
    'app://other/webview/assets/index.js',
    'file:///etc/passwd',
    'app://damocles/webview/%E0%A4%A',
    'app://damocles/webview/assets/index.js%00.png',
    'app://damocles/__proto__/x',
    'app://damocles/constructor/x',
    'app://damocles/webview/index.html',
    'app://damocles/desktop-shell/index.html',
    'app://damocles/webview/assets/page.HTM',
  ])('refuses %s', (url) => {
    expect(resolveAppRequest(url, root)).toBeUndefined();
  });

  // A backslash separates path segments only on Windows; elsewhere it is part of a file name inside the root.
  it.runIf(process.platform === 'win32').each([
    'app://damocles/webview/..%5c..%5cpackage.json',
    'app://damocles/webview/%2e%2e%5c%2e%2e%5cpackage.json',
    'app://damocles/webview/C:%5cWindows%5cwin.ini',
    'app://damocles/webview/assets%5c..%5c..%5c..%5cpackage.json',
  ])('refuses the backslash traversal %s', (url) => {
    expect(resolveAppRequest(url, root)).toBeUndefined();
  });

  it('keeps a double-encoded dot segment as a literal name inside the root', () => {
    const target = resolveAppRequest('app://damocles/webview/%252e%252e/package.json', root);
    expect(target).toMatchObject({ kind: 'file', filePath: path.join(root, 'dist', 'webview', '%2e%2e', 'package.json') });
  });

  it('maps the desktop popup page to its generated page', () => {
    expect(resolveAppRequest(NOTIFIER_PAGE_URL, root)).toEqual({ kind: 'notifier' });
    expect(resolveAppRequest('app://damocles/notifier/other.html', root)).toBeUndefined();
  });

  it('maps a theme blob by its lowercase sha256 only', () => {
    expect(resolveAppRequest(`app://damocles/theme-blob/${'c'.repeat(64)}`, root)).toEqual({ kind: 'themeBlob', sha256: 'c'.repeat(64) });
    expect(resolveAppRequest(`app://damocles/theme-blob/${'C'.repeat(64)}`, root)).toBeUndefined();
    expect(resolveAppRequest('app://damocles/theme-blob/../desktop/main.js', root)).toBeUndefined();
    expect(resolveAppRequest(`app://damocles/theme-cache/${'c'.repeat(64)}/thumb-480.webp`, root)).toEqual({ kind: 'themeCache', sha256: 'c'.repeat(64), file: 'thumb-480.webp' });
    expect(resolveAppRequest(`app://damocles/theme-cache/${'c'.repeat(64)}/still.png`, root)).toEqual({ kind: 'themeCache', sha256: 'c'.repeat(64), file: 'still.png' });
    expect(resolveAppRequest(`app://damocles/theme-cache/${'c'.repeat(64)}/stats.json`, root)).toBeUndefined();
    expect(resolveAppRequest(`app://damocles/theme-cache/${'c'.repeat(64)}/flash.json`, root)).toBeUndefined();
  });

  it('maps the theme renderer page and a screenshot by its 32-hex id only', () => {
    expect(resolveAppRequest(THEME_RENDER_PAGE_URL, root)).toEqual({ kind: 'themeRender' });
    expect(resolveAppRequest(`${THEME_SHOT_URL_PREFIX}${'a'.repeat(32)}`, root)).toEqual({ kind: 'themeShot', id: 'a'.repeat(32) });
    expect(resolveAppRequest(`${THEME_SHOT_URL_PREFIX}${'A'.repeat(32)}`, root)).toBeUndefined();
    expect(resolveAppRequest(`${THEME_SHOT_URL_PREFIX}../desktop/main.js`, root)).toBeUndefined();
  });

  it('maps a panel page to its panel id', () => {
    expect(resolveAppRequest(panelPageUrl('0f8a-42'), root)).toEqual({ kind: 'panel', panelId: '0f8a-42' });
    expect(resolveAppRequest('app://damocles/panel/../index.html', root)).toBeUndefined();
    expect(resolveAppRequest('app://damocles/panel/a/b/index.html', root)).toBeUndefined();
  });

  it('serves the app icon by exact path only', () => {
    expect(resolveAppRequest('app://damocles/resources/icon.png', root)).toMatchObject({ filePath: path.join(root, 'resources', 'icon.png') });
    expect(resolveAppRequest('app://damocles/resources/icon.svg', root)).toBeUndefined();
  });
});

describe('appResourceUri', () => {
  it('maps served paths to app:// URLs and refuses the rest', () => {
    expect(appResourceUri(root, path.join(root, 'dist', 'webview', 'assets', 'index.js'))).toBe('app://damocles/webview/assets/index.js');
    expect(appResourceUri(root, path.join(root, 'resources', 'icon.png'))).toBe('app://damocles/resources/icon.png');
    expect(() => appResourceUri(root, path.join(root, 'package.json'))).toThrow(/outside/);
  });

  it('round-trips through resolveAppRequest', () => {
    const file = path.join(root, 'dist', 'webview', 'assets', 'a b#c.js');
    expect(resolveAppRequest(appResourceUri(root, file), root)).toMatchObject({ filePath: file });
  });
});

describe('mimeTypeFor', () => {
  it('names the types the webview loads', () => {
    expect(mimeTypeFor('x/index.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeTypeFor('x/index.css')).toBe('text/css; charset=utf-8');
    expect(mimeTypeFor('x/a.wasm')).toBe('application/wasm');
    expect(mimeTypeFor('x/icon.PNG')).toBe('image/png');
    expect(mimeTypeFor('x/font.otf')).toBe('font/otf');
    expect(mimeTypeFor('x/font.woff2')).toBe('font/woff2');
    expect(mimeTypeFor('x/loop.mp4')).toBe('video/mp4');
    expect(mimeTypeFor('x/loop.webm')).toBe('video/webm');
    expect(mimeTypeFor('x/unknown.bin')).toBe('application/octet-stream');
  });
});

describe('handleThemeRenderProtocol', () => {
  const ANALYZED = 'c'.repeat(64);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pages: ThemeRenderPages = {
    themeRender: () => '<!DOCTYPE html>render',
    themeBlob: (sha256) => Promise.resolve(sha256 === ANALYZED ? { mime: 'image/png', size: png.length, body: (start, end) => new Blob([png.slice(start, end + 1)]).stream() } : undefined),
    themeCache: () => Promise.resolve(png),
  };

  // the theme renderer's own session's protocol, never the default session's
  function fetchRender(url: string, init: RequestInit = {}, served: ThemeRenderPages = pages): Promise<Response> {
    const sessionProtocol = { handle: vi.fn() };
    vi.mocked(protocol.handle).mockClear();
    handleThemeRenderProtocol(sessionProtocol, root, served);
    expect(protocol.handle).not.toHaveBeenCalled();
    expect(sessionProtocol.handle).toHaveBeenCalledWith('app', expect.any(Function));
    const handler = sessionProtocol.handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;
    return handler(new Request(url, init));
  }

  it('serves the render page as generated HTML, the built files it loads and the blob of its job', async () => {
    const page = await fetchRender(THEME_RENDER_PAGE_URL);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toBe('<!DOCTYPE html>render');
    expect((await fetchRender('app://damocles/desktop-shell/file-icons/folder.svg')).status).toBe(200);
    const blob = await fetchRender(`app://damocles/theme-blob/${ANALYZED}`);
    expect(blob.status).toBe(200);
    expect(blob.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    expect((await fetchRender(`app://damocles/theme-blob/${'d'.repeat(64)}`)).status).toBe(404);
    const still = await fetchRender(`app://damocles/theme-cache/${ANALYZED}/still.png`);
    expect(still.status).toBe(200);
    expect(still.headers.get('content-type')).toBe('image/png');
    // what a job's page loaded is never kept for a later job's page
    for (const served of [blob, still]) expect(served.headers.get('cache-control')).toBe('no-store');
  });

  it("serves a job's blob and still frame under a no-content policy, and an SVG sprite under the SVG policy", async () => {
    const blob = await fetchRender(`app://damocles/theme-blob/${ANALYZED}`);
    expect(blob.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(blob.headers.get('x-content-type-options')).toBe('nosniff');
    const still = await fetchRender(`app://damocles/theme-cache/${ANALYZED}/still.png`);
    expect(still.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(still.headers.get('x-content-type-options')).toBe('nosniff');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const sprite = await fetchRender(`app://damocles/theme-blob/${ANALYZED}`, {}, { ...pages, themeBlob: () => Promise.resolve({ mime: 'image/svg+xml', size: svg.length, body: () => new Blob([svg]).stream() }) });
    expect(sprite.status).toBe(200);
    expect(sprite.headers.get('content-type')).toBe('image/svg+xml');
    expect(sprite.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(sprite.headers.get('cache-control')).toBe('no-store');
  });

  it("answers a byte range of a job's blob with its part, and one past the end with 416, neither kept", async () => {
    const part = await fetchRender(`app://damocles/theme-blob/${ANALYZED}`, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 2-5/${png.length}`);
    expect(part.headers.get('content-length')).toBe('4');
    expect(part.headers.get('cache-control')).toBe('no-store');
    expect(part.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.slice(2, 6));
    const past = await fetchRender(`app://damocles/theme-blob/${ANALYZED}`, { headers: { range: `bytes=${png.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${png.length}`);
    expect(past.headers.get('cache-control')).toBe('no-store');
    // a blob the running job does not name has no range either
    expect((await fetchRender(`app://damocles/theme-blob/${'d'.repeat(64)}`, { headers: { range: 'bytes=0-1' } })).status).toBe(404);
  });

  // the page's handler would answer any thumbnail; the route never asks it
  it('serves no other page or route of the app, no thumbnail, and only GET', async () => {
    for (const url of [SHELL_PAGE_URL, NOTIFIER_PAGE_URL, panelPageUrl('chat-1'), 'app://damocles/overlay/index.html', `${THEME_SHOT_URL_PREFIX}${SHOT}`, `app://damocles/forge/avatar/${'a'.repeat(64)}`, `app://damocles/store-thumb/${STORE_THUMB_SHA}`, `app://damocles/theme-cache/${ANALYZED}/thumb-480.webp`, 'app://damocles/desktop/main.js']) {
      expect((await fetchRender(url)).status, url).toBe(404);
    }
    expect((await fetchRender(THEME_RENDER_PAGE_URL, { method: 'POST' })).status).toBe(404);
  });

  it("serves a draft's sprite, wallpaper and still frame only while the running window job draws them, and never a thumbnail", async () => {
    const SPRITE = '1'.repeat(64);
    const WALLPAPER = '2'.repeat(64);
    const VIDEO = '3'.repeat(64);
    const OTHER = '4'.repeat(64);
    const served: RenderServed = {
      blobs: new Map([[SPRITE, { kind: 'sprite', mime: 'image/png' }], [WALLPAPER, { kind: 'image', mime: 'image/png' }]]),
      stills: new Set([VIDEO]),
    };
    const renderer = new ThemeRenderer({ openPage: async () => page, log: () => undefined });
    // wired as main wires the render session: only the renderer's running job names what it serves
    const jobPages: ThemeRenderPages = {
      themeRender: () => '',
      themeBlob: (sha256) => {
        const named = renderer.currentJobBlob(sha256);
        return Promise.resolve(named ? { mime: named.mime, size: png.length, body: (start, end) => new Blob([png.slice(start, end + 1)]).stream() } : undefined);
      },
      themeCache: (sha256) => Promise.resolve(renderer.currentJobStill(sha256) ? png : undefined),
    };
    const statuses = async (): Promise<number[]> => Promise.all([
      `app://damocles/theme-blob/${SPRITE}`, `app://damocles/theme-blob/${WALLPAPER}`, `app://damocles/theme-cache/${VIDEO}/still.png`,
      `app://damocles/theme-blob/${VIDEO}`, `app://damocles/theme-blob/${OTHER}`, `app://damocles/theme-cache/${OTHER}/still.png`,
      `app://damocles/theme-cache/${VIDEO}/thumb-480.webp`, `app://damocles/theme-cache/${WALLPAPER}/thumb-480.webp`,
    ].map(async (url) => (await fetchRender(url, {}, jobPages)).status));
    let during: number[] = [];
    const page: RenderPage = {
      render: async () => {
        during = await statuses();
        return JSON.stringify({ drawn: true, width: 1280, height: 800 });
      },
      resize: async () => undefined,
      capture: async () => {
        const bytes = new Uint8Array(24);
        bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
        new DataView(bytes.buffer).setUint32(16, 1280);
        new DataView(bytes.buffer).setUint32(20, 800);
        return bytes;
      },
      close: async () => undefined,
    };
    const appearance = { kind: 'dark', css: '', trustedCss: '', arrangement: { grid: { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: false, terminal: false }, sideWidth: 400, bottomHeight: 200 }, sidebarWidth: 280, sectionOrder: [], sections: {} }, platform: 'linux' } as const;
    const job: Extract<ThemeRenderJob, { kind: 'window' }> = { kind: 'window', view: 'window', appearance, width: 1280, height: 800 };
    expect(await statuses()).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
    await renderer.window(job, served);
    expect(during).toEqual([200, 200, 200, 404, 404, 404, 404, 404]);
    expect(await statuses()).toEqual([404, 404, 404, 404, 404, 404, 404, 404]);
  });
});

describe('handleAppProtocol', () => {
  // Monaco's workers load by URL from dist/webview/assets, and a worker served with a non-script type fails under nosniff.
  async function fetchApp(
    url: string,
    forgeAvatar: AppPages['forgeAvatar'] = () => Promise.resolve(undefined),
    themeBlob: AppPages['themeBlob'] = () => Promise.resolve(undefined),
    themeCache: AppPages['themeCache'] = () => Promise.resolve(undefined),
    headers: Record<string, string> = {},
  ): Promise<Response> {
    vi.mocked(protocol.handle).mockClear();
    handleAppProtocol(root, {
      panel: () => undefined, shell: () => '', overlay: () => '', notifier: () => '', themeEditor: () => '', forgeAvatar, themeBlob, themeCache,
      storeThumb: (sha256) => Promise.resolve(sha256 === STORE_THUMB_SHA ? STORE_THUMB_WEBP : undefined),
      themeShot: (id) => (id === SHOT ? SHOT_PNG : undefined),
    });
    const handler = vi.mocked(protocol.handle).mock.calls[0]?.[1];
    if (!handler) throw new Error('no app:// handler registered');
    return handler(new Request(url, { headers })) as Promise<Response>;
  }

  // A blob served from memory, recording every part a response streamed.
  const served = (bytes: Uint8Array, mime: string, parts: Array<[number, number]> = []): AppPages['themeBlob'] => () => Promise.resolve({
    mime,
    size: bytes.length,
    body: (start, end) => {
      parts.push([start, end]);
      return new Blob([bytes.slice(start, end + 1)]).stream();
    },
  });

  it.each([
    ['monaco-editor.worker-Ab12.js', 'text/javascript; charset=utf-8'],
    ['monaco-codicon-Cd34.ttf', 'font/ttf'],
    ['monaco-editor-Ef56.css', 'text/css; charset=utf-8'],
  ])('serves the Monaco asset %s as %s with nosniff', async (file, mime) => {
    const response = await fetchApp(`app://damocles/webview/assets/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(mime);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(path.join(root, 'dist', 'webview', 'assets', file)));
  });

  it('serves a screenshot from memory with no caching, and nothing for one dropped; never the theme renderer\'s page', async () => {
    const shot = await fetchApp(`${THEME_SHOT_URL_PREFIX}${SHOT}`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect(shot.headers.get('cache-control')).toBe('no-store');
    expect(shot.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(new Uint8Array(await shot.arrayBuffer())).toEqual(SHOT_PNG);
    expect((await fetchApp(`${THEME_SHOT_URL_PREFIX}${'b'.repeat(32)}`)).status).toBe(404);
    expect((await fetchApp(THEME_RENDER_PAGE_URL)).status).toBe(404);
  });

  it('gives a script its own restrictive policy, which a worker does not inherit from its page', async () => {
    const script = await fetchApp('app://damocles/webview/assets/monaco-editor.worker-Ab12.js');
    expect(script.headers.get('content-security-policy')).toBe("default-src 'none'; script-src app://damocles");
    const style = await fetchApp('app://damocles/webview/assets/monaco-editor-Ef56.css');
    expect(style.headers.get('content-security-policy')).toBeNull();
  });

  const AVATAR_KEY = 'a'.repeat(64);

  it('serves a forge account picture core gave, as its sniffed type under nosniff and a no-content policy', async () => {
    const asked: string[] = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await fetchApp(`app://damocles/forge/avatar/${AVATAR_KEY}`, (key) => {
      asked.push(key);
      return Promise.resolve({ bytes: png, mime: 'image/png' });
    });
    expect(asked).toEqual([AVATAR_KEY]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it('answers 404 for an avatar key core does not list, a malformed key, and a failed fetch', async () => {
    expect((await fetchApp(`app://damocles/forge/avatar/${AVATAR_KEY}`)).status).toBe(404);
    const asked: string[] = [];
    const record: AppPages['forgeAvatar'] = (key) => {
      asked.push(key);
      return Promise.resolve(undefined);
    };
    for (const key of ['ABC', `${AVATAR_KEY}0`, `../${AVATAR_KEY}`, 'g'.repeat(64)]) expect((await fetchApp(`app://damocles/forge/avatar/${key}`, record)).status).toBe(404);
    expect(asked).toEqual([]);
    expect((await fetchApp(`app://damocles/forge/avatar/${AVATAR_KEY}`, () => Promise.reject(new Error('core could not fetch it')))).status).toBe(404);
  });

  const BLOB = 'b'.repeat(64);

  it('serves a theme blob main names, as its sniffed type, immutable, under nosniff and a no-content policy', async () => {
    const asked: string[] = [];
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
    const response = await fetchApp(`app://damocles/theme-blob/${BLOB}`, undefined, (sha256) => {
      asked.push(sha256);
      return served(woff2, 'font/woff2')(sha256);
    });
    expect(asked).toEqual([BLOB]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('font/woff2');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('max-age=31536000, immutable');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe(String(woff2.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(woff2);
  });

  it('serves an SVG sprite blob under the SVG policy, which runs no script when the file is opened as a document', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const response = await fetchApp(`app://damocles/theme-blob/${BLOB}`, undefined, served(svg, 'image/svg+xml'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  describe('byte ranges of a theme blob', () => {
    const video = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));
    const ranged = async (range: string, parts: Array<[number, number]> = []): Promise<Response> =>
      fetchApp(`app://damocles/theme-blob/${BLOB}`, undefined, served(video, 'video/mp4', parts), undefined, { range });

    it.each([
      ['bytes=0-99', 0, 99],
      ['bytes=900-', 900, 999],
      ['bytes=990-2000', 990, 999],
      ['bytes=-100', 900, 999],
      ['bytes=-5000', 0, 999],
      ['bytes=0-0', 0, 0],
      ['Bytes = 10 - 19', 10, 19],
    ])('answers %s with 206, its Content-Range and Content-Length, streaming only that part', async (range, start, end) => {
      const parts: Array<[number, number]> = [];
      const response = await ranged(range, parts);
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/1000`);
      expect(response.headers.get('content-length')).toBe(String(end - start + 1));
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(video.slice(start, end + 1));
      expect(parts).toEqual([[start, end]]);
    });

    it.each([
      ['a start past the end', 'bytes=1000-'],
      ['an end before the start', 'bytes=500-100'],
      ['an empty suffix', 'bytes=-0'],
      ['no positions', 'bytes=-'],
      ['positions that are not numbers', 'bytes=a-b'],
    ])('answers %s with 416 and the size, sending nothing', async (_name, range) => {
      const parts: Array<[number, number]> = [];
      const response = await ranged(range, parts);
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */1000');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(parts).toEqual([]);
    });

    // RFC 9110 lets a server ignore a Range header it does not serve: several ranges, or a unit other than bytes
    it.each([['several ranges', 'bytes=0-9,20-29'], ['another unit', 'items=0-9']])('answers %s with the whole body and 200', async (_name, range) => {
      const response = await ranged(range);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-range')).toBeNull();
      expect(response.headers.get('content-length')).toBe('1000');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(video);
    });
  });

  it('answers 404 for a theme blob main does not name, a malformed key, and a failed read', async () => {
    expect((await fetchApp(`app://damocles/theme-blob/${BLOB}`)).status).toBe(404);
    const asked: string[] = [];
    const record: AppPages['themeBlob'] = (sha256) => {
      asked.push(sha256);
      return Promise.resolve(undefined);
    };
    for (const key of ['ABC', `${BLOB}0`, `../${BLOB}`, 'B'.repeat(64), `${BLOB}/x`]) expect((await fetchApp(`app://damocles/theme-blob/${key}`, undefined, record)).status).toBe(404);
    expect(asked).toEqual([]);
    expect((await fetchApp(`app://damocles/theme-blob/${BLOB}`, undefined, () => Promise.reject(new Error('unreadable')))).status).toBe(404);
  });

  it('serves a wallpaper thumbnail core wrote, as WebP, immutable, under nosniff and a no-content policy', async () => {
    const asked: Array<[string, string]> = [];
    const webp = new Uint8Array([...new TextEncoder().encode('RIFF'), 4, 0, 0, 0, ...new TextEncoder().encode('WEBP')]);
    const response = await fetchApp(`app://damocles/theme-cache/${BLOB}/thumb-480.webp`, undefined, undefined, (sha256, file) => {
      asked.push([sha256, file]);
      return Promise.resolve(webp);
    });
    expect(asked).toEqual([[BLOB, 'thumb-480.webp']]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('max-age=31536000, immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webp);
  });

  it('answers 404 for a thumbnail not written, a file other than the thumbnail, a malformed key and a failed read', async () => {
    expect((await fetchApp(`app://damocles/theme-cache/${BLOB}/thumb-480.webp`)).status).toBe(404);
    const asked: string[] = [];
    const record: AppPages['themeCache'] = (sha256) => {
      asked.push(sha256);
      return Promise.resolve(new Uint8Array([1]));
    };
    for (const tail of [`${BLOB}/stats.json`, `${BLOB}/palette.json`, `${BLOB}/flash.json`, `${BLOB}/..%2fthumb-480.webp`, `${'B'.repeat(64)}/thumb-480.webp`, `${BLOB}`, `${BLOB}/thumb-480.webp/x`]) {
      expect((await fetchApp(`app://damocles/theme-cache/${tail}`, undefined, undefined, record)).status, tail).toBe(404);
    }
    expect(asked).toEqual([]);
    expect((await fetchApp(`app://damocles/theme-cache/${BLOB}/thumb-480.webp`, undefined, undefined, () => Promise.reject(new Error('unreadable')))).status).toBe(404);
  });

  it('serves a kept community store thumbnail by its lowercase sha256 only, as WebP, immutable, under nosniff', async () => {
    expect(resolveAppRequest(`app://damocles/store-thumb/${STORE_THUMB_SHA}`, root)).toEqual({ kind: 'storeThumb', sha256: STORE_THUMB_SHA });
    for (const tail of [STORE_THUMB_SHA.toUpperCase(), `${STORE_THUMB_SHA}/x`, `..%2f${STORE_THUMB_SHA}`, 'list.json', STORE_THUMB_SHA.slice(1)]) {
      expect(resolveAppRequest(`app://damocles/store-thumb/${tail}`, root), tail).toBeUndefined();
    }
    const response = await fetchApp(`app://damocles/store-thumb/${STORE_THUMB_SHA}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(STORE_THUMB_WEBP);
    expect((await fetchApp(`app://damocles/store-thumb/${'d'.repeat(64)}`)).status).toBe(404);
  });

  it('serves an SVG under a policy that runs no script if it is ever opened as a document', async () => {
    const icon = await fetchApp('app://damocles/desktop-shell/file-icons/folder.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(icon.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });

  it.each([
    'app://damocles/webview/assets/monaco-missing.worker.js',
    'app://damocles/webview/assets/%2e%2e/%2e%2e/desktop/main.js',
    'app://damocles/desktop/main.js',
    'app://damocles/webview/assets/linked/secret.js',
    'app://damocles/__proto__/x',
  ])('answers 404 for %s', async (url) => {
    expect((await fetchApp(url)).status).toBe(404);
  });
});
