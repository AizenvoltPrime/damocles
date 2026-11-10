import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: {} }));

import { servedCsp } from '../../../../core/design/serve-policy';
import { SERVED_OPEN_PATH } from '../../../../shared/served-file-url';
import type { DesignPreviewFile } from '../../../../shared/types/design';
import type { Project } from '../../../local-services/confine';
import type { ReadRangeResult } from '../../../workspace/transfer-ops';
import { PreviewHttpServer } from '../preview-http-server';
import { MAX_DESIGN_ROOTS_PER_VIEW, servedPathRefusal, ServedRoots, type ServedGrant } from '../served-roots';

const LOCAL: Project = { key: '/home/u/proj', fsPath: '/home/u/proj', name: 'proj' };
const REMOTE: Project = { key: 'ssh+box|/home/u/proj', fsPath: '/home/u/proj', name: 'proj' };

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
  const served = new ServedRoots({
    projectOfView: (authority, viewId) => {
      const project = views.get(viewId);
      return project && (project === LOCAL ? 'local' : 'ssh+box') === authority ? project : undefined;
    },
    projects: () => [LOCAL, REMOTE],
    files: () => ({ readFileRange: (_project: Project, relativePath: string, offset: number, length: number) => readRange(relativePath, offset, length) }),
    isTrusted: (project) => trusted.has(project.key),
    designRead: async (authority, designId, relPath): Promise<DesignPreviewFile | undefined> => {
      designReads.push([authority, designId, relPath]);
      return relPath === 'screens/S2.html' ? { bytes: Buffer.from('<p>S2</p>'), fidelity: 'interactive' } : undefined;
    },
    refusalText: () => 'Open this preview from Damocles.',
    log: () => undefined,
  });
  served.onDidChange((authority) => changes.push(authority));
  h = { served, views, trusted, changes, designReads };
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

async function granted(viewId: string, project: Project, authority = project === LOCAL ? 'local' : 'ssh+box'): Promise<ServedGrant> {
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
    expect(await h.served.grant({ authority: 'local', root: { kind: 'project' }, viewId: 'unknown' })).toEqual({ refused: expect.stringContaining('not open'), unavailable: true });
    h.views.set('v1', REMOTE);
    expect(await h.served.grant({ authority: 'local', root: { kind: 'project' }, viewId: 'v1' })).toEqual({ refused: expect.stringContaining('not open'), unavailable: true });
    expect(await h.served.grant({ authority: 'ssh+box', root: { kind: 'design', designId: '../x' }, viewId: 'v1' })).not.toHaveProperty('unavailable');
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
    expect(h.served.mappings('ssh+box')).toEqual([{ origin: grant.origin, displayRoot: '/home/u/.damocles/designs/d1' }]);
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
    expect(b.origin).toBe(a.origin);
    const local = await granted('v3', LOCAL);
    expect(local.origin).not.toBe(a.origin);
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
    const grant = await granted('v1', REMOTE);
    await granted('v2', REMOTE);
    const cookie = await cookieOf(grant, 'docs/index.html');
    h.served.release('v1');
    expect(h.served.servedPorts('ssh+box')).toHaveLength(1);
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
