import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: {} }));

import { servedCsp } from '../../../../core/design/serve-policy';
import { previewCsp } from '../../../../core/served-pages/serve-policy';
import { MAX_SERVED_FOLDERS_PER_CHAT, SERVED_OPEN_PATH } from '../../../../shared/served-file-url';
import type { DesignPreviewFile } from '../../../../shared/types/design';
import type { Project } from '../../../local-services/confine';
import type { ReadRangeResult } from '../../../workspace/transfer-ops';
import { PreviewHttpServer } from '../../../../core/served-pages/preview-http-server';
import { servedPathRefusal } from '../../../../core/served-pages/root-files';
import { MAX_DESIGN_ROOTS_PER_VIEW, ServedRoots, type ServedGrant } from '../served-roots';

const LOCAL: Project = { key: '/home/u/proj', fsPath: '/home/u/proj', name: 'proj' };
const REMOTE: Project = { key: 'ssh+box|/home/u/proj', fsPath: '/home/u/proj', name: 'proj' };
// another local project, whose chats share the local browser profile with LOCAL's
const OTHER: Project = { key: '/home/u/other', fsPath: '/home/u/other', name: 'other' };

const FILES: Record<string, string> = {
  'docs/index.html': '<script type="module" src="app.js"></script>',
  'docs/app.js': 'fetch("data.json")',
  'docs/data.json': '{"ok":true}',
  '.env': 'SECRET=1',
  // a folder link inside the root whose real path is a dot folder
  'link/config': '[core]',
};

interface Harness {
  readonly served: ServedRoots;
  readonly views: Map<string, Project>;
  // a chat view's authority, for a view with no project
  readonly chatViews: Map<string, string>;
  // the root key of every workspace read, so a read of the wrong authority shows
  readonly fileKeys: string[];
  // a folder's real path now, when a link replaced it
  readonly realRoots: Map<string, string>;
  readonly trusted: Set<string>;
  readonly changes: string[];
  readonly designReads: Array<[string, string, string]>;
}

let h: Harness;

function readRange(relativePath: string, offset: number, length: number): Promise<ReadRangeResult> {
  const text = FILES[relativePath];
  if (text === undefined) return Promise.resolve({ ok: false, reason: 'missing' });
  const bytes = Buffer.from(text).subarray(Math.max(0, offset), Math.max(0, offset) + length);
  const resolvedPath = relativePath === 'link/config' ? '.git/config' : relativePath;
  return Promise.resolve({ ok: true, size: Buffer.byteLength(text), offset: Math.max(0, offset), length: bytes.length, resolvedPath, chunks: (async function* () { yield bytes; })() });
}

beforeEach(() => {
  const views = new Map<string, Project>();
  const trusted = new Set<string>();
  const changes: string[] = [];
  const designReads: Array<[string, string, string]> = [];
  const chatViews = new Map<string, string>();
  const fileKeys: string[] = [];
  const realRoots = new Map<string, string>();
  const served = new ServedRoots({
    projectOfView: (authority, viewId) => {
      const project = views.get(viewId);
      return project && (project === REMOTE ? 'ssh+box' : 'local') === authority ? project : undefined;
    },
    chatView: (authority, viewId) => (chatViews.get(viewId) ?? (views.has(viewId) ? (views.get(viewId) === REMOTE ? 'ssh+box' : 'local') : undefined)) === authority,
    projects: () => [LOCAL, REMOTE, OTHER],
    files: (rootKey) => {
      fileKeys.push(rootKey);
      return {
        readFileRange: (_project: Project, relativePath: string, offset: number, length: number) => readRange(relativePath, offset, length),
        confineExisting: async (project: Project) => ({ ok: true as const, path: realRoots.get(project.fsPath) ?? project.fsPath }),
      };
    },
    isTrusted: (project) => trusted.has(project.key),
    localDesignFolder: (designId) => `/home/u/.damocles/designs/${designId}`,
    designRead: async (authority, designId, relPath): Promise<DesignPreviewFile | undefined> => {
      designReads.push([authority, designId, relPath]);
      return relPath === 'screens/S2.html' ? { bytes: Buffer.from('<p>S2</p>'), fidelity: 'interactive' } : undefined;
    },
    refusalText: () => 'Open this preview from Damocles.',
    log: () => undefined,
  });
  served.onDidChange((authority) => changes.push(authority));
  h = { served, views, chatViews, fileKeys, realRoots, trusted, changes, designReads };
});

afterEach(() => {
  h.served.dispose();
});

interface Answer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: Number(parsed.port), path: `${parsed.pathname}${parsed.search}`, method, headers: { host: parsed.host, ...headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

// The browser's exchange of the one-time URL: the cookie its redirect sets.
async function cookieOf(grant: ServedGrant, relPath: string): Promise<string> {
  const answer = await get(grant.open(relPath));
  expect(answer.status).toBe(303);
  expect(answer.headers['set-cookie']![0]).toMatch(/; HttpOnly; SameSite=Strict; Path=\//);
  return answer.headers['set-cookie']![0]!.split(';')[0]!;
}

async function granted(viewId: string, project: Project, authority = project === REMOTE ? 'ssh+box' : 'local'): Promise<ServedGrant> {
  h.views.set(viewId, project);
  const grant = await h.served.grant({ authority, root: { kind: 'project' }, viewId });
  if ('refused' in grant) throw new Error(grant.refused);
  return grant;
}

describe('a project root served to a chat view', () => {
  it('opens a file once through its token, then serves its module script and data over the cookie', async () => {
    const grant = await granted('v1', REMOTE);
    const open = new URL(grant.open('docs/index.html'));
    expect(open.pathname).toBe(SERVED_OPEN_PATH);
    expect(open.origin).toBe(grant.origin);
    const exchanged = await get(open.href);
    expect(exchanged.headers.location).toBe('/docs/index.html');
    const cookie = exchanged.headers['set-cookie']![0]!.split(';')[0]!;
    // the token is spent
    expect((await get(open.href)).status).toBe(403);
    for (const [path, text] of [['/docs/index.html', FILES['docs/index.html']], ['/docs/app.js', FILES['docs/app.js']], ['/docs/data.json', FILES['docs/data.json']]] as const) {
      const answer = await get(`${grant.origin}${path}`, { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
      expect(answer.status, path).toBe(200);
      expect(answer.body).toBe(text);
    }
    expect((await get(`${grant.origin}/docs/app.js`, { cookie })).headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('serves an untrusted project with no scripts and a trusted one with them', async () => {
    const grant = await granted('v1', LOCAL);
    const cookie = await cookieOf(grant, 'docs/index.html');
    expect((await get(`${grant.origin}/docs/index.html`, { cookie })).headers['content-security-policy']).toContain("script-src 'none'");
    h.trusted.add(LOCAL.key);
    expect((await get(`${grant.origin}/docs/index.html`, { cookie })).headers['content-security-policy']).not.toContain("script-src 'none'");
  });

  it('refuses a request without the cookie, another server\'s cookie, another Host, a cross-site fetch and a write', async () => {
    const grant = await granted('v1', REMOTE);
    const other = await granted('v2', LOCAL);
    const cookie = await cookieOf(grant, 'docs/index.html');
    const otherCookie = await cookieOf(other, 'docs/index.html');
    const file = `${grant.origin}/docs/index.html`;
    // another browser context (another authority's, or the local one) holds no cookie of this server
    expect((await get(file)).status).toBe(403);
    expect((await get(file, { cookie: otherCookie.replace(/^damocles_preview_\d+/, `damocles_preview_${new URL(grant.origin).port}`) })).status).toBe(403);
    expect((await get(file, { cookie, host: `evil.example:${new URL(grant.origin).port}` })).status).toBe(421);
    expect((await get(file, { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(403);
    // a page on another loopback port (another server, a target's forward) is same-site and could have planted the cookie
    expect((await get(file, { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(403);
    expect((await get(file, { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(403);
    expect((await get(file, { cookie, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status).toBe(200);
    expect((await get(file, { cookie }, 'POST')).status).toBe(405);
    expect((await get(file, { cookie })).status).toBe(200);
  });

  it('refuses a dot file, a key and an 8.3 alias by name, and a link into a dot folder by its real path', async () => {
    for (const relPath of ['.env', 'id_rsa', 'certs/server.key', 'GIT~1/config', 'docs/.git/HEAD']) expect(servedPathRefusal({ kind: 'project' }, relPath), relPath).toMatch(/is not opened/);
    expect(servedPathRefusal({ kind: 'project' }, 'docs/index.html')).toBeUndefined();
    const grant = await granted('v1', REMOTE);
    expect(() => grant.open('.env')).toThrow();
    const cookie = await cookieOf(grant, 'docs/index.html');
    expect((await get(`${grant.origin}/.env`, { cookie })).status).toBe(404);
    expect((await get(`${grant.origin}/link/config`, { cookie })).status).toBe(404);
  });

  it('takes the project from the view, never one of another authority, and answers a view with none as unavailable', async () => {
    expect(await h.served.grant({ authority: 'local', root: { kind: 'project' }, viewId: 'unknown' })).toEqual({ refused: expect.stringContaining('not open') });
    h.views.set('v1', REMOTE);
    expect(await h.served.grant({ authority: 'local', root: { kind: 'project' }, viewId: 'v1' })).toEqual({ refused: expect.stringContaining('not open') });
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: '../x' }, viewId: 'v1' })).not.toHaveProperty('unavailable');
  });
});

// The one browser profile every local chat shares: host-only cookies kept by host name and sent to every port of it (RFC 6265
// 5.4), as Chrome keeps them; a navigation follows the one-time URL's redirect.
class SharedProfile {
  private readonly jar = new Map<string, Map<string, string>>();

  async navigate(url: string, site = 'none'): Promise<Answer> {
    let target = new URL(url);
    for (;;) {
      const cookies = this.jar.get(target.hostname);
      const answer = await get(target.href, { 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...(cookies ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}) });
      for (const set of answer.headers['set-cookie'] ?? []) {
        const pair = set.split(';')[0]!;
        const kept = this.jar.get(target.hostname) ?? new Map<string, string>();
        kept.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
        this.jar.set(target.hostname, kept);
      }
      if (answer.status !== 303) return answer;
      target = new URL(answer.headers.location!, target);
    }
  }
}

describe('grants of chat views that share one browser profile', () => {
  it('opens a view\'s root on no host another view can name, while the page\'s own links work', async () => {
    const profile = new SharedProfile();
    const first = await granted('v1', LOCAL);
    const second = await granted('v2', OTHER);
    expect((await profile.navigate(first.open('docs/index.html'))).body).toBe(FILES['docs/index.html']);
    // the page's root-absolute and relative links stay on its own origin
    expect((await profile.navigate(`${first.origin}/docs/data.json`, 'same-origin')).status).toBe(200);
    expect((await profile.navigate(new URL('app.js', `${first.origin}/docs/index.html`).href, 'same-origin')).status).toBe(200);
    expect((await profile.navigate(second.open('docs/index.html'))).status).toBe(200);
    // the second view's agent navigates to the first view's server on every host it can name
    const port = new URL(first.origin).port;
    for (const host of ['127.0.0.1', 'localhost', new URL(second.origin).hostname]) {
      const answer = await profile.navigate(`http://${host}:${port}/docs/index.html`);
      expect(answer.status, host).not.toBe(200);
      expect(answer.body, host).not.toBe(FILES['docs/index.html']);
    }
  });

  it('gives each view of one root a host of its own, closed with that view', async () => {
    const profile = new SharedProfile();
    const first = await granted('v1', LOCAL);
    const again = await granted('v1', LOCAL);
    const second = await granted('v2', LOCAL);
    expect(again.origin).toBe(first.origin);
    expect(new URL(second.origin).port).toBe(new URL(first.origin).port);
    expect(second.origin).not.toBe(first.origin);
    expect(new URL(first.origin).hostname).toMatch(/^[0-9a-f]{32}\.localhost$/);
    expect(h.served.viewOrigins('local', 'v1')).toEqual([first.origin]);
    expect(h.served.viewOrigins('ssh+box', 'v1')).toEqual([]);
    expect(h.served.mappings('local', 'v1')).toEqual([{ origin: first.origin, displayRoot: LOCAL.fsPath }]);
    expect(h.served.mappings('local', 'v2')).toEqual([{ origin: second.origin, displayRoot: LOCAL.fsPath }]);
    expect((await profile.navigate(first.open('docs/index.html'))).status).toBe(200);
    expect((await profile.navigate(second.open('docs/index.html'))).status).toBe(200);
    h.served.release('v1');
    expect(h.served.viewOrigins('local', 'v1')).toEqual([]);
    expect(h.served.mappings('local', 'v1')).toEqual([]);
    expect(h.served.mappings('local', 'v2')).toEqual([{ origin: second.origin, displayRoot: LOCAL.fsPath }]);
    expect((await profile.navigate(`${first.origin}/docs/index.html`)).status).toBe(421);
    expect((await profile.navigate(`${second.origin}/docs/index.html`)).status).toBe(200);
  });

  it('keeps an Open in Browser grant on 127.0.0.1 with a cookie of its own, which no view grant\'s cookie opens', async () => {
    const view = await granted('v1', LOCAL);
    const preview = await h.served.grantPreview(LOCAL);
    expect(preview.origin).toBe(`http://127.0.0.1:${new URL(view.origin).port}`);
    const viewCookie = await cookieOf(view, 'docs/index.html');
    const previewCookie = await cookieOf(preview, 'docs/index.html');
    expect(viewCookie.split('=')[0]).toBe(previewCookie.split('=')[0]);
    expect((await get(`${preview.origin}/docs/index.html`, { cookie: previewCookie })).status).toBe(200);
    expect((await get(`${preview.origin}/docs/index.html`, { cookie: viewCookie })).status).toBe(403);
    expect((await get(`${view.origin}/docs/index.html`, { cookie: previewCookie })).status).toBe(403);
    expect((await get(`${view.origin}/docs/index.html`, { cookie: viewCookie })).status).toBe(200);
  });

  it('refuses a service worker\'s script on a view\'s grant host, local or remote, and serves Open in Browser\'s as before', async () => {
    h.trusted.add(LOCAL.key);
    const script = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'serviceworker', 'service-worker': 'script' };
    for (const view of [await granted('v1', LOCAL), await granted('v2', REMOTE)]) {
      const cookie = await cookieOf(view, 'docs/index.html');
      expect((await get(`${view.origin}/docs/app.js`, { cookie, ...script })).status, view.origin).toBe(403);
      expect((await get(`${view.origin}/docs/app.js`, { cookie, 'sec-fetch-site': 'same-origin' })).status, view.origin).toBe(200);
    }
    const preview = await h.served.grantPreview(LOCAL);
    const previewCookie = await cookieOf(preview, 'docs/index.html');
    expect((await get(`${preview.origin}/docs/app.js`, { cookie: previewCookie, ...script })).status).toBe(200);
  });
});

describe('a design root', () => {
  it('reads through the authority\'s core and serves with the design\'s fidelity CSP', async () => {
    const grant = await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: 'd1' }, viewId: 'v1', displayRoot: '/home/u/.damocles/designs/d1' });
    if ('refused' in grant) throw new Error(grant.refused);
    const cookie = await cookieOf(grant, 'screens/S2.html');
    const answer = await get(`${grant.origin}/screens/S2.html`, { cookie });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('<p>S2</p>');
    expect(answer.headers['content-security-policy']).toBe(servedCsp('interactive'));
    expect(h.designReads).toEqual([['ssh+box', 'd1', 'screens/S2.html']]);
    expect((await get(`${grant.origin}/screens/S3.html`, { cookie })).status).toBe(404);
    expect((await get(`${grant.origin}/manual.pdf`, { cookie })).status).toBe(404);
    for (const path of ['/.state/x.json', '/id_rsa', '/SCREEN~1/S2.html', '/__damocles_preview/x.css']) {
      expect((await get(`${grant.origin}${path}`, { cookie })).status, path).toBe(404);
      expect(servedPathRefusal({ kind: 'design', designId: 'd1' }, path.slice(1)), path).toBeDefined();
    }
    expect(h.designReads).toEqual([['ssh+box', 'd1', 'screens/S2.html'], ['ssh+box', 'd1', 'screens/S3.html']]);
    const head = await get(`${grant.origin}/screens/S2.html`, { cookie }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(servedPathRefusal({ kind: 'design', designId: 'd1' }, 'manual.pdf')).toMatch(/serves only/);
    expect(h.served.mappings('ssh+box', 'v1')).toEqual([{ origin: grant.origin, displayRoot: '/home/u/.damocles/designs/d1' }]);
  });
});

describe('file:// mappings', () => {
  it('maps a local view grant to main\'s own path of its root, and a remote one only to the path its core named', async () => {
    const project = await granted('v1', LOCAL);
    const design = await h.served.grant({ authority: 'local', root: { kind: 'design', designId: 'd1' }, viewId: 'v1' });
    if ('refused' in design) throw new Error(design.refused);
    const local = [{ origin: project.origin, displayRoot: '/home/u/proj' }, { origin: design.origin, displayRoot: '/home/u/.damocles/designs/d1' }];
    expect(h.served.mappings('local', 'v1')).toEqual(local);
    // an Open in Browser grant serves no chat page
    await h.served.grantPreview({ key: '/home/u/other', fsPath: '/home/u/other', name: 'other' });
    expect(h.served.mappings('local', 'v1')).toEqual(local);
    // another view's grant of the same roots maps none of v1's origins
    const other = await granted('v3', LOCAL);
    expect(h.served.mappings('local', 'v3')).toEqual([{ origin: other.origin, displayRoot: '/home/u/proj' }]);
    expect(h.served.mappings('local', 'v1')).toEqual(local);
    await granted('v2', REMOTE);
    expect(h.served.mappings('ssh+box', 'v2')).toEqual([]);
    h.served.release('v1');
    expect(h.served.mappings('local', 'v1')).toEqual([]);
  });
});

describe('design roots a core names', () => {
  it('refuses a malformed design id and more design roots per view than a chat can see, starting no server', async () => {
    for (const designId of ['../x', '.state', 'a/b', '']) {
      expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId }, viewId: 'v1' }), designId).toEqual({ refused: expect.stringContaining('not a design') });
    }
    expect(h.served.servedPorts('ssh+box')).toEqual([]);
    for (let index = 0; index < MAX_DESIGN_ROOTS_PER_VIEW; index++) {
      expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: `d${index}` }, viewId: 'v1' })).not.toHaveProperty('refused');
    }
    const ports = h.served.servedPorts('ssh+box');
    expect(ports).toHaveLength(MAX_DESIGN_ROOTS_PER_VIEW);
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: 'd-more' }, viewId: 'v1' })).toEqual({ refused: expect.stringContaining('the most one chat may open') });
    expect(h.served.servedPorts('ssh+box')).toEqual(ports);
    // a design it already holds stays open to it, and another view has its own room
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: 'd0' }, viewId: 'v1' })).not.toHaveProperty('refused');
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: 'd-more' }, viewId: 'v2' })).not.toHaveProperty('refused');
  });
});

describe('lifecycle', () => {
  it('keeps one server per authority and root, and lists only view grants\' ports for their authority', async () => {
    const a = await granted('v1', REMOTE);
    const b = await granted('v2', REMOTE);
    expect(new URL(b.origin).port).toBe(new URL(a.origin).port);
    const local = await granted('v3', LOCAL);
    expect(new URL(local.origin).port).not.toBe(new URL(a.origin).port);
    const port = Number(new URL(a.origin).port);
    expect(h.served.servedPorts('ssh+box')).toEqual([port]);
    expect(h.served.servedPorts('local')).toEqual([Number(new URL(local.origin).port)]);
    const preview = await h.served.grantPreview({ ...REMOTE, key: 'ssh+box|/home/u/other' });
    expect(h.served.servedPorts('ssh+box')).toEqual([port]);
    expect(preview.origin).not.toBe(a.origin);
  });

  it('publishes a new port before the grant resolves', async () => {
    h.views.set('v1', REMOTE);
    const order: string[] = [];
    h.served.onDidChange(() => order.push('changed'));
    const pending = h.served.grant({ authority: 'ssh+box', root: { kind: 'project' }, viewId: 'v1' });
    void pending.then(() => order.push('resolved'));
    const grant = await pending;
    if ('refused' in grant) throw new Error(grant.refused);
    expect(order).toEqual(['changed', 'resolved']);
  });

  it('keeps no grant of a server that failed to start, so failed starts use up no design room', async () => {
    const start = vi.spyOn(PreviewHttpServer, 'start').mockRejectedValue(new Error('listen EMFILE'));
    for (let index = 0; index < MAX_DESIGN_ROOTS_PER_VIEW; index++) {
      await expect(h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: `d${index}` }, viewId: 'v1' })).rejects.toThrow('EMFILE');
    }
    start.mockRestore();
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: 'd-next' }, viewId: 'v1' })).not.toHaveProperty('refused');
    expect(h.served.servedPorts('ssh+box')).toHaveLength(1);
  });

  it('closes the server with its last grant, and its port leaves the policy', async () => {
    const first = await granted('v1', REMOTE);
    const grant = await granted('v2', REMOTE);
    const firstCookie = await cookieOf(first, 'docs/index.html');
    const cookie = await cookieOf(grant, 'docs/index.html');
    h.served.release('v1');
    expect(h.served.servedPorts('ssh+box')).toHaveLength(1);
    expect((await get(`${first.origin}/docs/index.html`, { cookie: firstCookie })).status).toBe(421);
    expect((await get(`${grant.origin}/docs/index.html`, { cookie })).status).toBe(200);
    h.changes.length = 0;
    h.served.release('v2');
    expect(h.served.servedPorts('ssh+box')).toEqual([]);
    expect(h.changes).toEqual(['ssh+box']);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(get(`${grant.origin}/docs/index.html`, { cookie })).rejects.toThrow();
  });

  it('closes a project\'s server once it is no longer trusted, and the next grant starts another', async () => {
    h.trusted.add(REMOTE.key);
    const grant = await granted('v1', REMOTE);
    h.trusted.delete(REMOTE.key);
    h.served.trustChanged();
    expect(h.served.servedPorts('ssh+box')).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(get(`${grant.origin}/`)).rejects.toThrow();
    const again = await granted('v1', REMOTE);
    expect(again.origin).not.toBe(grant.origin);
  });
});

describe('a folder a chat\'s permission gate granted, served to that chat view', () => {
  async function folderGrant(viewId: string, authority: string, folder: string): Promise<ServedGrant> {
    h.chatViews.set(viewId, authority);
    const grant = await h.served.grant({ authority, root: { kind: 'folder', folder }, viewId });
    if ('refused' in grant) throw new Error(grant.refused);
    return grant;
  }

  it('reads a remote core\'s folder through that authority\'s workspace only, never this computer\'s, with the deny list and no project trust', async () => {
    h.trusted.add(REMOTE.key);
    const grant = await folderGrant('v1', 'ssh+box', 'C:\\Users\\me\\reports');
    const cookie = await cookieOf(grant, 'docs/index.html');
    const page = await get(`${grant.origin}/docs/index.html`, { cookie });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(previewCsp(false, 'browser'));
    expect((await get(`${grant.origin}/.env`, { cookie })).status).toBe(404);
    expect((await get(`${grant.origin}/link/config`, { cookie })).status).toBe(404);
    expect(h.fileKeys.length).toBeGreaterThan(0);
    expect(h.fileKeys.every((key) => key === 'ssh+box|c:\\users\\me\\reports')).toBe(true);
    expect(h.served.mappings('ssh+box', 'v1')).toEqual([{ origin: grant.origin, displayRoot: 'C:\\Users\\me\\reports' }]);
  });

  it('serves a folder only to a live chat view of the asking authority, on that view\'s own host', async () => {
    h.chatViews.set('local-view', 'local');
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'folder', folder: '/home/u/reports' }, viewId: 'local-view' })).toEqual({ refused: expect.stringContaining('not one this chat may be served') });
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'folder', folder: '/home/u/reports' }, viewId: 'unknown' })).toHaveProperty('refused');
    const first = await folderGrant('v1', 'ssh+box', '/home/u/reports');
    const second = await folderGrant('v2', 'ssh+box', '/home/u/reports');
    expect(second.origin).not.toBe(first.origin);
    const cookie = await cookieOf(first, 'docs/index.html');
    // the first view's cookie opens nothing on the second's host, and its host goes with its view
    expect((await get(`${second.origin}/docs/index.html`, { cookie })).status).toBe(403);
    h.served.release('v1');
    expect((await get(`${first.origin}/docs/index.html`, { cookie })).status).toBe(421);
  });

  it('refuses a folder that is no absolute path below a root in its host\'s form', async () => {
    h.chatViews.set('v1', 'ssh+box');
    for (const folder of ['reports', 'C:', 'C:\\', '/', '\\\\host\\share', '//host/share/', '\\\\?\\C:\\x', '/home/u/../root', 'C:\\a\\.\\b', '/home/u/a\0b', `/${'a'.repeat(5000)}`]) {
      expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'folder', folder }, viewId: 'v1' }), JSON.stringify(folder)).toHaveProperty('refused');
    }
    expect(h.served.servedPorts('ssh+box')).toEqual([]);
  });

  it('serves at most a bounded number of folders to one view, starting no server past it', async () => {
    for (let index = 0; index < MAX_SERVED_FOLDERS_PER_CHAT; index++) await folderGrant('v1', 'ssh+box', `/home/u/f${index}`);
    const ports = h.served.servedPorts('ssh+box');
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'folder', folder: '/home/u/more' }, viewId: 'v1' })).toEqual({ refused: expect.stringContaining(`${MAX_SERVED_FOLDERS_PER_CHAT} folders`) });
    expect(h.served.servedPorts('ssh+box')).toEqual(ports);
  });

  it('serves a network folder granted as its real share path, and nothing once that path changes', async () => {
    const share = '\\\\192.0.2.7\\data\\team\\week';
    const grant = await folderGrant('v1', 'local', share);
    const cookie = await cookieOf(grant, 'docs/index.html');
    expect((await get(`${grant.origin}/docs/index.html`, { cookie })).status).toBe(200);
    h.realRoots.set(share, '\\\\192.0.2.8\\other\\week');
    expect((await get(`${grant.origin}/docs/data.json`, { cookie })).status).toBe(404);
  });

  it('serves nothing once the folder\'s real path is another, as when a link replaced it', async () => {
    const grant = await folderGrant('v1', 'local', '/home/u/reports');
    const cookie = await cookieOf(grant, 'docs/index.html');
    expect((await get(`${grant.origin}/docs/index.html`, { cookie })).status).toBe(200);
    h.realRoots.set('/home/u/reports', '/home/u/.ssh');
    expect((await get(`${grant.origin}/docs/data.json`, { cookie })).status).toBe(404);
  });
});
