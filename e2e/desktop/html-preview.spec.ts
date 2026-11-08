import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { windowViews, type ViewInfo } from './support/browser';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { recordOpenExternal } from './support/design';
import { activeTab, codeEditor, editorShows, filesRow, replaceText, saveWithKeyboard } from './support/editor';
import { chooseMenuItem } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { pressKeys, SHELL_URL, shellPage, shellState } from './support/shell';
import { addProject, answerDialogs, chatInput, clickMenu, TRUST_PROMPT } from './support/ui';

// An HTML file of a project previews in a chat-less editor tab served on main's damocles-preview scheme, and Open in browser
// serves it from main's loopback server behind a one-time token traded for a cookie. Node fetches the served URLs; no browser opens.

test.describe.configure({ timeout: 240_000 });

const PREVIEW_SCHEME = 'damocles-preview:';

// The page reports what loaded into its title once it has loaded, so main reads it with no script of its own; a page that runs
// no script keeps "static", and js/rel.js would change it if it ran. probe: a loopback port the page loads an image from.
const INDEX = (heading: string, probe?: number): string => [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>static</title>',
  '<link rel="stylesheet" href="css/rel.css"><link rel="stylesheet" href="/css/abs.css">',
  '<script src="js/rel.js"></script><script src="/js/abs.js"></script></head>',
  '<body>',
  '<a id="external" href="https://example.com/" style="position:fixed;left:0;top:0;width:120px;height:40px;display:block">external</a>',
  '<a id="blank" href="https://example.com/blank" target="_blank" style="position:fixed;left:140px;top:0;width:120px;height:40px;display:block">new tab</a>',
  ...(probe === undefined ? [] : [`<img id="img-loopback" src="http://127.0.0.1:${probe}/probe.svg" alt="">`]),
  `<h1 id="heading" style="margin-top:60px">${heading}</h1><p id="rel">relative</p><p id="abs">root-absolute</p>`,
  '<img id="img-rel" src="img/dot.svg" alt=""><img id="img-abs" src="/img/dot.svg" alt=""><img id="img-app" src="app://damocles/desktop-shell/file-icons/readme.svg" alt="">',
  '<script>',
  'addEventListener("load", async () => {',
  '  const color = (id) => getComputedStyle(document.getElementById(id)).color;',
  '  const loaded = (id) => document.getElementById(id).naturalWidth > 0;',
  '  const status = (url) => fetch(url).then((r) => r.status, () => "refused");',
  '  const ranged = (url, range) => fetch(url, { headers: { Range: range } }).then(async (r) => [r.status, r.headers.get("content-range"), r.headers.get("accept-ranges"), await r.text()], () => "refused");',
  '  const data = await fetch("/data.json").then((r) => r.json());',
  '  const report = { heading: document.getElementById("heading").textContent, rel: color("rel"), abs: color("abs"), relJs: window.relJs === true, absJs: window.absJs === true,',
  '    imgRel: loaded("img-rel"), imgAbs: loaded("img-abs"), imgApp: loaded("img-app"), data: data.value,',
  '    denied: [await status("/.env"), await status("/.git/config"), await status("/certs/server.key"), await status("/%2e%2e/secret")], file: await status("file:///" + location.pathname),',
  '    range: await ranged("/data.json", "bytes=2-8"), past: await ranged("/data.json", "bytes=1000-"), deniedRange: await ranged("/.env", "bytes=0-") };',
  '  document.title = "report:" + JSON.stringify(report);',
  '});',
  '</script>',
  '</body></html>',
  '',
].join('\n');

interface Report {
  readonly heading: string;
  readonly rel: string;
  readonly abs: string;
  readonly relJs: boolean;
  readonly absJs: boolean;
  readonly imgRel: boolean;
  readonly imgAbs: boolean;
  readonly imgApp: boolean;
  readonly data: string;
  readonly denied: readonly (number | string)[];
  readonly file: number | string;
  // status, Content-Range, Accept-Ranges and text of a ranged fetch
  readonly range: readonly unknown[];
  readonly past: readonly unknown[];
  readonly deniedRange: readonly unknown[];
}

const SECRET = 'TOP-SECRET-7f3a';
const DATA_JSON = '{ "value": "from data.json" }\n';
const DATA_BYTES = Buffer.byteLength(DATA_JSON);

// seconds of 8 kHz, 8-bit mono PCM silence, 8000 bytes a second
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}
const TONE = wav(4);
// 52.8 MB; Chromium takes its duration from the first response's end, so a response cut short of the file shortens it
const LONG_SECONDS = 6600;

// The audio's duration and its position after a seek to a second before its end, or its error code, in the page's title.
const MEDIA = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>media</title></head><body>',
  '<audio id="long" src="/media/long.wav" preload="metadata"></audio>',
  '<script>',
  'const audio = document.getElementById("long");',
  'const done = (result) => { document.title = "media:" + JSON.stringify(result); };',
  'audio.addEventListener("error", () => done({ error: audio.error ? audio.error.code : 0 }), { once: true });',
  'const seek = () => {',
  '  audio.addEventListener("seeked", () => done({ duration: audio.duration, seeked: audio.currentTime }), { once: true });',
  '  audio.currentTime = audio.duration - 1;',
  '};',
  'if (audio.readyState >= 1) seek(); else audio.addEventListener("loadedmetadata", seek, { once: true });',
  '</script>',
  '</body></html>',
  '',
].join('\n');

function writeSite(project: string): void {
  const write = (relative: string, content: string | Buffer): void => {
    fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    fs.writeFileSync(path.join(project, relative), content);
  };
  write('index.html', INDEX('Hello'));
  write('css/rel.css', '#rel { color: rgb(1, 2, 3); }\n');
  write('css/abs.css', '#abs { color: rgb(7, 8, 9); }\n');
  write('js/rel.js', 'window.relJs = true;\ndocument.title = "scripts ran";\n');
  write('js/abs.js', 'window.absJs = true;\n');
  write('img/dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#09f"/></svg>\n');
  write('data.json', DATA_JSON);
  write('media/tone.wav', TONE);
  write('.env', `API_KEY=${SECRET}\n`);
  write('.git/config', `[core]\n\tsecret = ${SECRET}\n`);
  write('certs/server.key', `${SECRET}\n`);
  // beside the project, which no served path may reach
  fs.writeFileSync(path.join(path.dirname(project), 'secret'), `${SECRET}\n`);
}

/** The title of the preview view's page, read in main; undefined while no preview view exists. */
function previewTitle(app: ElectronApplication): Promise<string | undefined> {
  return app.evaluate(({ webContents }, scheme) => webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(scheme))?.getTitle(), PREVIEW_SCHEME);
}

async function previewViews(app: ElectronApplication): Promise<ViewInfo[]> {
  return (await windowViews(app)).filter((view) => view.url.startsWith(PREVIEW_SCHEME));
}

async function report(app: ElectronApplication): Promise<Report | string | undefined> {
  const title = await previewTitle(app);
  return title?.startsWith('report:') ? JSON.parse(title.slice('report:'.length)) as Report : title;
}

const previewTab = (shell: Page): Locator => shell.locator('[data-testid="editor-tab"][data-kind="htmlPreview"]');

async function openPreviewFromFiles(app: ElectronApplication, shell: Page, name = 'index.html'): Promise<void> {
  await filesRow(shell, name).click({ button: 'right' });
  await chooseMenuItem(app, 'openPreview');
  await expect(previewTab(shell)).toHaveAttribute('aria-selected', 'true');
  await expect(previewTab(shell).getByTestId('editor-tab-title')).toHaveText(`Preview ${name}`);
  await expect(shell.getByTestId('html-preview-tab')).toBeVisible();
}

interface Served {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A GET of `target`, sent verbatim so encoded segments reach the server as written. */
function get(port: number, target: string, headers: Record<string, string> = {}): Promise<Served> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: target, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

test('Open preview on index.html shows the page in a chat-less tab, with its files, data and links, and reloads on save', async ({ foreground: _foreground, home, launch }) => {
  writeSite(home.project);
  const { app } = await launch();
  const opened = await recordOpenExternal(app);
  const chat = await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  // A click on the file opens its code; Open preview in its menu opens the preview tab.
  await filesRow(shell, 'index.html').click();
  await expect(shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'index.html' })).toHaveAttribute('aria-selected', 'true');
  await expect(previewTab(shell)).toHaveCount(0);
  await openPreviewFromFiles(app, shell);
  expect(await activeTab(app)).toMatchObject({ kind: 'htmlPreview', relativePath: 'index.html', htmlPreview: { trusted: true } });
  await expect(shell.getByTestId('html-preview-untrusted')).toHaveCount(0);

  // Relative and root-absolute CSS, scripts and images load, and so does fetch('/data.json'); dot files, keys and a path out of
  // the project answer 404, and file: and app: are refused. A ranged fetch answers 206, or 416 past the end, and a denied path
  // 404 whatever its Range.
  await expect.poll(() => report(app), { timeout: 60_000 }).toMatchObject({
    heading: 'Hello', rel: 'rgb(1, 2, 3)', abs: 'rgb(7, 8, 9)', relJs: true, absJs: true, imgRel: true, imgAbs: true, imgApp: false, data: 'from data.json', denied: [404, 404, 404, 404], file: 'refused',
    range: [206, `bytes 2-8/${DATA_BYTES}`, 'bytes', '"value"'], past: [416, `bytes */${DATA_BYTES}`, 'bytes', ''], deniedRange: [404, null, null, ''],
  });
  await expect.poll(async () => (await activeTab(app))?.htmlPreview?.status).toBe('ready');

  // The view covers exactly the tab's page card, and hides while another tab shows.
  const stage = await shell.getByTestId('html-preview-stage').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.right) - Math.round(rect.left), height: Math.round(rect.bottom) - Math.round(rect.top) };
  });
  await expect.poll(async () => (await previewViews(app)).map((view) => ({ visible: view.visible, ...view.bounds }))).toEqual([{ visible: true, ...stage }]);
  await shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'index.html' }).click();
  await expect.poll(async () => (await previewViews(app)).map((view) => view.visible)).toEqual([false]);
  await previewTab(shell).click();
  await expect.poll(async () => (await previewViews(app)).map((view) => view.visible)).toEqual([true]);

  // An external link opens in the system browser after a click the view received, and the view stays on the page.
  await app.evaluate(({ webContents }, scheme) => {
    const view = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(scheme))!;
    view.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
    view.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    view.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
  }, PREVIEW_SCHEME);
  await expect.poll(opened).toContain('https://example.com/');
  expect(await previewTitle(app)).toMatch(/^report:/);

  // A target=_blank link's click reaches main's window-open handler, which opens it in the system browser and no window.
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await app.evaluate(({ webContents }, scheme) => {
    const view = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(scheme))!;
    view.sendInputEvent({ type: 'mouseMove', x: 160, y: 20 });
    view.sendInputEvent({ type: 'mouseDown', x: 160, y: 20, button: 'left', clickCount: 1 });
    view.sendInputEvent({ type: 'mouseUp', x: 160, y: 20, button: 'left', clickCount: 1 });
  }, PREVIEW_SCHEME);
  await expect.poll(opened).toContain('https://example.com/blank');
  expect(await previewTitle(app)).toMatch(/^report:/);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows);

  // No chat holds the tab: a new chat leaves it open and shown.
  await clickMenu(app, 'damocles.newChat');
  await expect.poll(async () => (await activeChat(app)).url()).not.toBe(chat.url());
  await expect(previewTab(shell)).toHaveCount(1);
  await expect(previewTab(shell)).toHaveAttribute('aria-selected', 'true');

  // Saving the page in the editor reloads the preview.
  await shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'index.html' }).click();
  await editorShows(shell, '<title>static</title>');
  await replaceText(codeEditor(shell), INDEX('Saved in the editor'));
  await saveWithKeyboard(app);
  await previewTab(shell).click();
  await expect.poll(() => report(app), { timeout: 30_000 }).toMatchObject({ heading: 'Saved in the editor' });

  // A stylesheet it loaded changing on disk reloads it too.
  fs.writeFileSync(path.join(home.project, 'css', 'rel.css'), '#rel { color: rgb(4, 5, 6); }\n');
  await expect.poll(() => report(app), { timeout: 30_000 }).toMatchObject({ heading: 'Saved in the editor', rel: 'rgb(4, 5, 6)' });

  // The editor tab's menu of the HTML file offers Open preview too, which activates the one preview tab.
  await shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'index.html' }).click({ button: 'right' });
  await chooseMenuItem(app, 'openPreview');
  await expect(previewTab(shell)).toHaveCount(1);
  await expect(previewTab(shell)).toHaveAttribute('aria-selected', 'true');
});

test('long audio loads with its whole duration and seeks to its end in the preview tab, read in byte ranges', async ({ home, launch }) => {
  writeSite(home.project);
  fs.writeFileSync(path.join(home.project, 'media', 'long.wav'), wav(LONG_SECONDS));
  fs.writeFileSync(path.join(home.project, 'media.html'), MEDIA);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await openPreviewFromFiles(app, shell, 'media.html');

  await expect.poll(async () => (await previewTitle(app))?.startsWith('media:'), { timeout: 60_000 }).toBe(true);
  const media = JSON.parse((await previewTitle(app))!.slice('media:'.length)) as { duration?: number; seeked?: number; error?: number };
  expect(media.error).toBeUndefined();
  expect(media.duration).toBeCloseTo(LONG_SECONDS, 0);
  expect(media.seeked).toBeCloseTo(LONG_SECONDS - 1, 0);
});

test('an untrusted project\'s preview runs no script, reaches no loopback address and says so, and Trust Folder... reloads it with both', async ({ home, launch }) => {
  writeSite(home.project);
  // a local service the page names; an untrusted preview never reaches it
  const probes: string[] = [];
  const service = http.createServer((request, response) => {
    probes.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const probe = (service.address() as { port: number }).port;
  fs.writeFileSync(path.join(home.project, 'index.html'), INDEX('Hello', probe));
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await addProject(app, home.project, false);
  const shell = await shellPage(app);
  await openPreviewFromFiles(app, shell);

  const banner = shell.getByTestId('html-preview-untrusted');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Scripts are off because this folder is not trusted.');
  // Loaded, with its styles, and still the title the markup gives: neither its inline script nor js/rel.js ran.
  await expect.poll(async () => (await activeTab(app))?.htmlPreview?.status, { timeout: 60_000 }).toBe('ready');
  await expect.poll(() => previewTitle(app)).toBe('static');
  expect(probes).toEqual([]);

  await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
  await shell.getByTestId('html-preview-trust').click();
  await expect(banner).toHaveCount(0);
  await expect.poll(() => report(app), { timeout: 60_000 }).toMatchObject({ heading: 'Hello', relJs: true, absJs: true, data: 'from data.json' });
  // a trusted project's preview reaches local services, a dev server's included
  expect(probes).toContain('/probe.svg');
  await new Promise<void>((resolve) => service.close(() => resolve()));
});

test('Open in browser trades a one-time token for a per-port cookie and serves the project root behind it', async ({ home, launch }) => {
  writeSite(home.project);
  const { app } = await launch();
  const opened = await recordOpenExternal(app);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await openPreviewFromFiles(app, shell);

  await shell.getByTestId('html-preview-open-in-browser').click();
  await expect.poll(opened).toHaveLength(1);
  const url = new URL((await opened())[0]!);
  expect(url.protocol).toBe('http:');
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.pathname).toBe('/__damocles_preview/open');
  expect(url.searchParams.get('p')).toBe('index.html');
  const port = Number(url.port);
  const opening = `${url.pathname}${url.search}`;

  // Before the exchange: no cookie, no page; a Host that is no loopback name is refused before anything else.
  expect((await get(port, '/index.html')).status).toBe(403);
  expect((await get(port, opening, { host: `attacker.example:${port}` })).status).toBe(421);

  const exchange = await get(port, opening);
  expect(exchange.status).toBe(303);
  expect(exchange.headers.location).toBe('/index.html');
  const setCookie = exchange.headers['set-cookie']?.[0] ?? '';
  expect(setCookie).toMatch(new RegExp(`^damocles_preview_${port}=[A-Za-z0-9_-]{43,};`));
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  expect(setCookie).toContain('Path=/');
  const cookie = setCookie.split(';')[0]!;
  // the token works once
  expect((await get(port, opening)).status).toBe(403);

  // With the cookie: the page and its root-absolute files, with the served headers and no CORS headers.
  const page = await get(port, '/index.html', { cookie });
  expect(page.status).toBe(200);
  expect(page.body).toBe(INDEX('Hello'));
  expect(page.headers['content-type']).toMatch(/^text\/html/);
  expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts allow-same-origin');
  expect(page.headers['x-content-type-options']).toBe('nosniff');
  expect(page.headers['referrer-policy']).toBe('no-referrer');
  expect(page.headers['cache-control']).toBe('no-store');
  expect(Object.keys(page.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  for (const target of ['/css/abs.css', '/js/abs.js', '/img/dot.svg', '/data.json']) expect((await get(port, target, { cookie })).status, target).toBe(200);
  expect((await get(port, '/', { cookie })).body).toBe(INDEX('Hello'));
  for (const target of ['/.env', '/.git/config', '/certs/server.key', '/%2e%2e/secret', '/..%2fsecret']) {
    const refused = await get(port, target, { cookie });
    expect(refused.status, target).toBe(404);
    expect(refused.body, target).not.toContain(SECRET);
  }
  // One byte range answers 206 with the served headers, a range past the end 416, several ranges the whole file, and a denied
  // path 404 whatever its Range.
  const part = await get(port, '/data.json', { cookie, range: 'bytes=2-8' });
  expect(part.status).toBe(206);
  expect(part.body).toBe('"value"');
  expect(part.headers['content-range']).toBe(`bytes 2-8/${DATA_BYTES}`);
  expect(part.headers['content-length']).toBe('7');
  expect(part.headers['accept-ranges']).toBe('bytes');
  expect(part.headers['content-security-policy']).toContain('sandbox allow-scripts allow-same-origin');
  expect(part.headers['x-content-type-options']).toBe('nosniff');
  expect(part.headers['cache-control']).toBe('no-store');
  expect(Object.keys(part.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  const past = await get(port, '/data.json', { cookie, range: 'bytes=1000-' });
  expect(past.status).toBe(416);
  expect(past.headers['content-range']).toBe(`bytes */${DATA_BYTES}`);
  expect((await get(port, '/data.json', { cookie, range: 'bytes=0-1,3-4' })).body).toBe(DATA_JSON);
  const tone = await get(port, '/media/tone.wav', { cookie, range: 'bytes=44-' });
  expect(tone.status).toBe(206);
  expect(tone.headers['content-type']).toBe('audio/wav');
  expect(tone.headers['content-range']).toBe(`bytes 44-${TONE.length - 1}/${TONE.length}`);
  for (const target of ['/.env', '/certs/server.key']) {
    const refused = await get(port, target, { cookie, range: 'bytes=0-' });
    expect(refused.status, target).toBe(404);
    expect(refused.body, target).not.toContain(SECRET);
  }

  // A cross-site subresource request is refused even with the cookie; a cross-site navigation is not.
  expect((await get(port, '/data.json', { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' })).status).toBe(403);
  expect((await get(port, '/index.html', { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(200);
  expect((await get(port, '/index.html', { host: `localhost:${port}`, cookie })).status).toBe(200);

  // Closing the project's last preview closes its port.
  const tabId = await previewTab(shell).getAttribute('data-tab-id');
  await shell.evaluate((id) => window.damoclesShell!.editorTab({ action: 'close', tabId: id! }), tabId);
  await expect(previewTab(shell)).toHaveCount(0);
  await expect.poll(async () => {
    try {
      return (await get(port, '/index.html', { cookie })).status;
    } catch {
      return 'closed';
    }
  }).toBe('closed');
});

// The page names the last key it saw in its title.
const KEYS = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>keys</title></head><body><h1>Keys</h1><script>addEventListener("keydown", (event) => { document.title = "key:" + event.key; });</script></body></html>\n';

/** The URL of the page that holds keyboard focus; undefined while none does. */
function focusedUrl(app: ElectronApplication): Promise<string | undefined> {
  return app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL());
}

/** Presses a key in the page that holds keyboard focus, through Electron's native input path, without focusing any page first. */
async function pressInFocused(app: ElectronApplication, keyCode: string, modifiers: Array<'shift'> = []): Promise<void> {
  await app.evaluate(({ webContents }, [key, mods]) => {
    const target = webContents.getFocusedWebContents();
    if (!target) throw new Error('no page holds keyboard focus');
    target.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
    target.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
  }, [keyCode, modifiers] as const);
}

test('Tab from the preview\'s toolbar and F6 onto the editor reach the page, its keys reach it, and F6 and Shift+F6 leave it in part order', async ({ foreground: _foreground, home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'keys.html'), KEYS);
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  const chatUrl = `/panel/${panelIdOf(chat)}/`;
  const shell = await shellPage(app);
  await openPreviewFromFiles(app, shell, 'keys.html');
  await expect.poll(async () => (await activeTab(app))?.htmlPreview?.status, { timeout: 60_000 }).toBe('ready');
  await expect.poll(async () => (await previewViews(app)).map((view) => view.visible)).toEqual([true]);

  // Tab past the toolbar reaches the page's stop in the stage, which hands focus to the page; a key reaches it.
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.focus(), SHELL_URL);
  await shell.getByTestId('html-preview-open-in-browser').focus();
  await pressInFocused(app, 'Tab');
  await expect.poll(() => focusedUrl(app)).toMatch(/^damocles-preview:/);
  await pressInFocused(app, 'Enter');
  await expect.poll(() => previewTitle(app)).toBe('key:Enter');

  // F6 in the page leaves it for the next part after the editor, the chat; the page never sees the key.
  await pressInFocused(app, 'F6');
  await expect.poll(() => focusedUrl(app)).toContain(chatUrl);
  expect(await previewTitle(app)).toBe('key:Enter');

  // Shift+F6 from the chat lands on the editor part, which enters the page again.
  await pressKeys(app, chatUrl, 'F6', ['shift']);
  await expect.poll(() => focusedUrl(app)).toMatch(/^damocles-preview:/);
  await pressInFocused(app, 'Escape');
  await expect.poll(() => previewTitle(app)).toBe('key:Escape');
  expect(await focusedUrl(app)).toMatch(/^damocles-preview:/);

  // Shift+F6 in the page leaves it for the part before the editor, the sidebar.
  await pressInFocused(app, 'F6', ['shift']);
  await expect.poll(() => focusedUrl(app)).toBe(SHELL_URL);
  await expect.poll(() => shell.evaluate(() => document.activeElement?.closest('[data-testid="sidebar"]') !== null)).toBe(true);
  expect(await previewTitle(app)).toBe('key:Escape');
});

test('Remove Project closes its preview tab, which cannot load without its root, and adding the project again lets Open preview bring it back', async ({ home, launch }) => {
  writeSite(home.project);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await openPreviewFromFiles(app, shell);
  await expect.poll(async () => (await activeTab(app))?.htmlPreview?.status, { timeout: 60_000 }).toBe('ready');

  const projectKey = (await shellState(app)).projects.find((project) => project.fsPath === home.project)!.key;
  expect(await shell.evaluate((key) => window.damoclesShell!.removeProject(key), projectKey)).toEqual({ ok: true });
  await expect(previewTab(shell)).toHaveCount(0);
  await expect.poll(async () => (await previewViews(app)).length).toBe(0);

  await addProject(app, home.project, true);
  await openPreviewFromFiles(app, shell);
  await expect.poll(() => report(app), { timeout: 60_000 }).toMatchObject({ heading: 'Hello' });
});
