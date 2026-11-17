import { promises as fs, type PathLike } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { PanelHost } from '../../../platform/window-service';
import { fileUrlPath, MAX_SERVED_FOLDERS_PER_CHAT } from '../../../shared/served-file-url';
import { servedCsp } from '../../design/serve-policy';
import { ChatServedFiles, outsideRootsRefusal, type ServedFileRoots } from '../../browser/served-files';
import { LocalServedRoots } from '../local-served-roots';
import { previewCsp } from '../serve-policy';

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

// Connects to 127.0.0.1 with the URL's host as Host, as Chrome connects a *.localhost name the OS resolver may not answer.
function get(url: string, headers: Record<string, string> = {}): Promise<Answer> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: Number(parsed.port), path: `${parsed.pathname}${parsed.search}`, headers: { host: parsed.host, ...headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
  });
}

// Opens a one-time URL as the browser does: the token for the cookie, then the redirect's file with the cookie.
async function open(oneTime: string): Promise<{ readonly page: Answer; readonly cookie: string; readonly origin: string }> {
  const exchange = await get(oneTime);
  expect(exchange.status).toBe(303);
  const cookie = String(exchange.headers['set-cookie']?.[0]).split(';')[0]!;
  const origin = new URL(oneTime).origin;
  return { page: await get(`${origin}${exchange.headers.location}`, { cookie }), cookie, origin };
}

function fakeChat(): PanelHost & { close(): void } {
  const listeners = new Set<() => void>();
  return {
    onDispose: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    close: () => {
      for (const listener of [...listeners]) listener();
    },
  } as unknown as PanelHost & { close(): void };
}

let dir: string;
let project: string;
let design: string;
let outside: string;
let trusted: boolean;
let roots: LocalServedRoots;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'local-served-roots-')));
  project = path.join(dir, 'proj');
  design = path.join(dir, 'designs', 'd1');
  outside = path.join(dir, 'outside');
  await fs.mkdir(path.join(project, 'docs'), { recursive: true });
  await fs.mkdir(path.join(design, 'screens'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(project, 'docs', 'index.html'), '<script type="module" src="app.js"></script>');
  await fs.writeFile(path.join(project, 'docs', 'app.js'), 'fetch("data.json")');
  await fs.writeFile(path.join(project, '.env'), 'SECRET=1');
  await fs.writeFile(path.join(design, 'screens', 'S1.html'), '<p>S1</p>');
  await fs.writeFile(path.join(outside, 'secret.html'), 'outside the project');
  // a folder link inside the project to a folder outside it
  await fs.symlink(outside, path.join(project, 'out'), 'junction');
  trusted = false;
  roots = new LocalServedRoots({ isTrusted: () => trusted, refusalText: () => 'Open this preview from Damocles.', log: () => undefined });
});

afterEach(async () => {
  roots.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a VS Code chat\'s served roots', () => {
  it('serves a project file through a one-time token, its cookie and the preview policy, and its relative links on the same origin', async () => {
    const chat = fakeChat();
    const answer = await roots.url(chat, { kind: 'project', relPath: 'docs/index.html' }, project);
    if (!('url' in answer)) throw new Error(answer.refused);
    expect(answer.url.startsWith(`${answer.origin}/__damocles_preview/open?`)).toBe(true);
    const { page, cookie, origin } = await open(answer.url);
    expect(page.status).toBe(200);
    expect(page.body).toBe('<script type="module" src="app.js"></script>');
    expect(page.headers['content-security-policy']).toBe(previewCsp(false, 'browser'));
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(`${origin}/docs/app.js`, { cookie })).body).toBe('fetch("data.json")');
    // the token opens once, and nothing is served without the cookie or under another Host
    expect((await get(answer.url)).status).toBe(403);
    expect((await get(`${origin}/docs/app.js`)).status).toBe(403);
    expect((await get(`${origin}/docs/app.js`, { cookie, host: 'evil.test' })).status).toBe(421);
    // a dot file and a link out of the project are never served
    expect((await get(`${origin}/.env`, { cookie })).status).toBe(404);
    expect((await get(`${origin}/out/secret.html`, { cookie })).status).toBe(404);
    trusted = true;
    expect((await get(`${origin}/docs/app.js`, { cookie })).headers['content-security-policy']).toBe(previewCsp(true, 'browser'));
  });

  it('never follows a link at the file itself, as desktop\'s confinement does', async () => {
    await fs.symlink(path.join(project, 'docs'), path.join(project, 'docs-link'), 'junction');
    const answer = await roots.url(fakeChat(), { kind: 'project', relPath: 'docs/index.html' }, project);
    if (!('url' in answer)) throw new Error(answer.refused);
    const { cookie, origin } = await open(answer.url);
    expect((await get(`${origin}/docs-link`, { cookie })).status).toBe(404);
  });

  it.runIf(process.platform === 'win32')('refuses a file under a folder link that leads to a network path without resolving the link', async () => {
    await fs.mkdir(path.join(project, 'real-assets'));
    await fs.writeFile(path.join(project, 'real-assets', 'x.png'), 'png');
    const link = path.join(project, 'assets');
    await fs.symlink(path.join(project, 'real-assets'), link, 'junction');
    const answer = await roots.url(fakeChat(), { kind: 'project', relPath: 'docs/index.html' }, project);
    if (!('url' in answer)) throw new Error(answer.refused);
    const { cookie, origin } = await open(answer.url);
    // the link reads as a share on a documentation address, which nothing may contact
    const readlink = fs.readlink.bind(fs);
    const readlinkSpy = vi.spyOn(fs, 'readlink').mockImplementation((async (file: PathLike) => (String(file).toLowerCase() === link.toLowerCase() ? '\\\\192.0.2.1\\s' : readlink(file))) as typeof fs.readlink);
    const realpathSpy = vi.spyOn(fs, 'realpath');
    onTestFinished(() => {
      readlinkSpy.mockRestore();
      realpathSpy.mockRestore();
    });
    expect((await get(`${origin}/assets/x.png`, { cookie })).status).toBe(404);
    const resolved = realpathSpy.mock.calls.map(([file]) => String(file).toLowerCase());
    expect(resolved.filter((file) => file.startsWith(link.toLowerCase()) || file.includes('192.0.2.1'))).toEqual([]);
  });

  it('refuses a path the policy never serves before starting anything', async () => {
    expect(await roots.url(fakeChat(), { kind: 'project', relPath: '.env' }, project)).toEqual({ refused: expect.stringContaining('.env is not opened') });
    expect(await roots.url(fakeChat(), { kind: 'design', designId: 'd1', relPath: 'notes.pdf' }, design)).toEqual({ refused: expect.stringContaining('serves only pages') });
  });

  it('serves a design file with the design\'s CSP on an origin of its own', async () => {
    const chat = fakeChat();
    const projectAnswer = await roots.url(chat, { kind: 'project', relPath: 'docs/index.html' }, project);
    const answer = await roots.url(chat, { kind: 'design', designId: 'd1', relPath: 'screens/S1.html' }, design);
    if (!('url' in answer) || !('url' in projectAnswer)) throw new Error('not served');
    expect(answer.origin).not.toBe(projectAnswer.origin);
    const { page } = await open(answer.url);
    expect(page.status).toBe(200);
    expect(page.body).toBe('<p>S1</p>');
    expect(page.headers['content-security-policy']).toBe(servedCsp(null));
  });

  it('closes a root\'s server with the last chat that holds it', async () => {
    const first = fakeChat();
    const second = fakeChat();
    const a = await roots.url(first, { kind: 'project', relPath: 'docs/index.html' }, project);
    const b = await roots.url(second, { kind: 'project', relPath: 'docs/app.js' }, project);
    if (!('url' in a) || !('url' in b)) throw new Error('not served');
    expect(new URL(b.origin).port).toBe(new URL(a.origin).port);
    expect(b.origin).not.toBe(a.origin);
    const { cookie } = await open(a.url);
    first.close();
    // the closed chat's host is refused at once, and the other chat's still opens
    expect((await get(`${a.origin}/docs/index.html`, { cookie })).status).toBe(421);
    expect((await get(b.url)).status).toBe(303);
    second.close();
    await expect(get(`${a.origin}/docs/index.html`)).rejects.toThrow(/ECONNREFUSED|ECONNRESET/);
  });

  it('opens a chat\'s root on no host another chat of the shared browser profile can name, while the page\'s links work', async () => {
    const other = path.join(dir, 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'index.html'), '<p>other</p>');
    // host-only cookies by host name, sent to every port of it (RFC 6265 5.4), as the one profile every chat shares keeps them
    const jar = new Map<string, string>();
    const navigate = async (url: string, site = 'none'): Promise<Answer> => {
      let target = new URL(url);
      for (;;) {
        const cookie = jar.get(target.hostname);
        const answer = await get(target.href, { 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...(cookie ? { cookie } : {}) });
        const set = answer.headers['set-cookie']?.[0];
        if (set !== undefined) jar.set(target.hostname, [jar.get(target.hostname), set.split(';')[0]!].filter(Boolean).join('; '));
        if (answer.status !== 303) return answer;
        target = new URL(answer.headers.location!, target);
      }
    };
    const first = await roots.url(fakeChat(), { kind: 'project', relPath: 'docs/index.html' }, project);
    const second = await roots.url(fakeChat(), { kind: 'project', relPath: 'index.html' }, other);
    if (!('url' in first) || !('url' in second)) throw new Error('not served');
    expect((await navigate(first.url)).body).toBe('<script type="module" src="app.js"></script>');
    expect((await navigate(`${first.origin}/docs/app.js`, 'same-origin')).body).toBe('fetch("data.json")');
    expect((await navigate(second.url)).body).toBe('<p>other</p>');
    for (const host of ['127.0.0.1', 'localhost', new URL(second.origin).hostname]) {
      const answer = await navigate(`http://${host}:${new URL(first.origin).port}/docs/index.html`);
      expect(answer.status, host).not.toBe(200);
    }
    // a second chat of the same root gets a host of its own
    const third = await roots.url(fakeChat(), { kind: 'project', relPath: 'docs/index.html' }, project);
    if (!('url' in third)) throw new Error(third.refused);
    expect(third.origin).not.toBe(first.origin);
    expect(new URL(third.origin).hostname).toMatch(/^[0-9a-f]{32}\.localhost$/);
  });

  it('gives a chat\'s BrowserOpen of a project file its served URL, maps the answers back, and refuses a file outside the roots', async () => {
    const chat = fakeChat();
    const chatRoots: ServedFileRoots = { project, designs: [{ designId: 'd1', folder: design }] };
    const files = new ChatServedFiles({ roots: () => chatRoots, serve: (file, root) => roots.url(chat, file, root) });
    const address = `${pathToFileURL(path.join(project, 'docs', 'index.html')).href}?tab=2#top`;
    const target = await files.localTarget(address);
    if (!('url' in target)) throw new Error(target.refused);
    const { page, origin } = await open(target.url);
    expect(page.body).toBe('<script type="module" src="app.js"></script>');
    expect(files.toFile(`[URL] ${origin}/docs/index.html?tab=2#top`)).toBe(`[URL] ${address}`);
    const secret = path.join(outside, 'secret.html');
    expect(await files.localTarget(pathToFileURL(secret).href)).toEqual({ refused: outsideRootsRefusal(chatRoots, fileUrlPath(pathToFileURL(secret).href)!) });
  });
});

describe('a VS Code chat\'s granted folder', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(outside, 'sub'), { recursive: true });
    await fs.mkdir(path.join(outside, '.git'), { recursive: true });
    await fs.writeFile(path.join(outside, 'sub', 'index.html'), '<script src="app.js"></script>');
    await fs.writeFile(path.join(outside, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(outside, '.git', 'config'), '[core]');
    await fs.writeFile(path.join(outside, 'id_ed25519'), 'key');
    await fs.writeFile(path.join(outside, 'a.pem'), 'pem');
    // a link out of the granted folder, to the project beside it
    await fs.symlink(project, path.join(outside, 'proj-link'), 'junction');
  });

  it('serves the folder the gate granted with the deny list, confinement and the untrusted CSP, to the granting chat only', async () => {
    trusted = true;
    const chat = fakeChat();
    const files = new ChatServedFiles({ roots: () => ({ project, designs: [] }), serve: (file, root) => roots.url(chat, file, root) });
    files.grant(outside);
    const target = await files.localTarget(pathToFileURL(path.join(outside, 'sub', 'index.html')).href);
    if (!('url' in target)) throw new Error(target.refused);
    const { page, cookie, origin } = await open(target.url);
    expect(page.status).toBe(200);
    expect(page.body).toBe('<script src="app.js"></script>');
    // a folder outside every project has no trust of its own, so its pages run no script whatever the project's trust
    expect(page.headers['content-security-policy']).toBe(previewCsp(false, 'browser'));
    expect(files.toFile(`[URL] ${origin}/sub/index.html`)).toBe(`[URL] ${pathToFileURL(path.join(outside, 'sub', 'index.html')).href}`);
    for (const denied of ['.env', '.git/config', 'GIT~1/config', 'id_ed25519', 'a.pem', 'proj-link/docs/index.html', '../proj/docs/index.html', '%2e%2e/proj/docs/index.html']) {
      expect((await get(`${origin}/${denied}`, { cookie })).status, denied).toBe(404);
    }
    // another chat holds no grant: its own open of the folder is refused, and the first chat's cookie opens nothing on its host
    const other = fakeChat();
    const second = await roots.url(other, { kind: 'folder', folder: outside, relPath: 'sub/index.html' }, outside);
    if (!('url' in second)) throw new Error(second.refused);
    expect(second.origin).not.toBe(origin);
    expect((await get(`${second.origin}/sub/index.html`, { cookie })).status).toBe(403);
    // the grant goes with the chat
    chat.close();
    expect((await get(`${origin}/sub/index.html`, { cookie })).status).toBe(421);
  });

  it('stops serving a granted folder that was swapped for a link to another folder', async () => {
    const chat = fakeChat();
    const answer = await roots.url(chat, { kind: 'folder', folder: outside, relPath: 'sub/index.html' }, outside);
    if (!('url' in answer)) throw new Error(answer.refused);
    const { cookie, origin } = await open(answer.url);
    const hidden = path.join(dir, '.secret');
    await fs.mkdir(hidden);
    await fs.writeFile(path.join(hidden, 'config'), 'token');
    await fs.rm(outside, { recursive: true, force: true });
    await fs.symlink(hidden, outside, 'junction');
    expect((await get(`${origin}/config`, { cookie })).status).toBe(404);
  });

  it('serves at most a bounded number of folders to one chat', async () => {
    const chat = fakeChat();
    for (let index = 0; index < MAX_SERVED_FOLDERS_PER_CHAT; index++) {
      const folder = path.join(dir, `f${index}`);
      await fs.mkdir(folder);
      expect(await roots.url(chat, { kind: 'folder', folder, relPath: 'a.html' }, folder)).toHaveProperty('url');
    }
    const more = path.join(dir, 'more');
    await fs.mkdir(more);
    expect(await roots.url(chat, { kind: 'folder', folder: more, relPath: 'a.html' }, more)).toEqual({ refused: expect.stringContaining(`${MAX_SERVED_FOLDERS_PER_CHAT} folders`) });
  });
});
