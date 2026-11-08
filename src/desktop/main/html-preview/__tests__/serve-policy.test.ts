import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: {} }));

import type { Project } from '../../../local-services/confine';
import { createTransferOps, type ReadRangeResult } from '../../../workspace/transfer-ops';
import { RangedReadsUnsupportedError } from '../../workspace/remote-workspace';
import { NotConnectedError } from '../../workspace/workspaces';
import { answerPreview, exactBytes, type PreviewAnswer, type PreviewFileReads } from '../preview-reader';
import { declaresCharset, isServablePreviewPath, previewContentType, previewCsp, previewHeaders, previewRequestPath, previewUrlPath, requestedRange } from '../serve-policy';
import { syntheticFile } from './synthetic-file';

describe('previewRequestPath', () => {
  it.each([
    ['/', 'index.html', true],
    ['/index.html', 'index.html', false],
    ['/docs/', 'docs/index.html', true],
    ['/css/a%20b.css', 'css/a b.css', false],
    ['/.well-known/security.txt', '.well-known/security.txt', false],
    ['/.WELL-KNOWN/x.json', '.WELL-KNOWN/x.json', false],
    // decoded once: a double-encoded dot segment is a file name
    ['/%252e%252e/x.html', '%2e%2e/x.html', false],
  ])('serves %s as %s', (pathname, relativePath, folderIndex) => {
    expect(previewRequestPath(pathname)).toEqual({ relativePath, folderIndex });
  });

  it.each([
    // dot entries, whatever their case
    '/.env', '/.env.local', '/.ENV', '/.git/config', '/.Git/HEAD', '/sub/.npmrc', '/.ssh/id_rsa', '/.aws/credentials', '/.damocles/settings.json',
    // keys and certificates by extension and name, whatever their case
    '/certs/server.key', '/certs/SERVER.KEY', '/a.pem', '/a.crt', '/a.cer', '/a.p12', '/a.pfx', '/a.jks', '/a.keystore', '/id_rsa', '/keys/ID_ED25519', '/id_dsa', '/id_ecdsa', '/a.ppk', '/keys/AuthKey_ABC123.p8', '/id_ecdsa_sk', '/keys/ID_ED25519_SK',
    // Windows: 8.3 aliases, trailing dots and spaces, streams, devices
    '/GIT~1/config', '/ENV~1', '/ID_ED2~1', '/.git./config', '/.env%20', '/index.html::$DATA', '/con', '/nul.html', '/a%3Ab.html',
    // traversal and malformed paths
    '/%2e%2e/secret', '/..%2fsecret', '/a/../../secret', '/a%5c..%5csecret', '//etc/passwd', '/%E0%A4%A', '/a%00.html', 'index.html', '/C:/x.html',
    // the loopback server's own prefix
    '/__damocles_preview/open', '/__DAMOCLES_PREVIEW/x.html',
  ])('refuses %s', (pathname) => {
    expect(previewRequestPath(pathname)).toBeUndefined();
  });

  it('answers isServablePreviewPath for a project path as the request path check does', () => {
    for (const servable of ['index.html', 'docs/a b.html', '.well-known/x.html', 'node_modules/pkg/index.html']) {
      expect(isServablePreviewPath(servable)).toBe(true);
    }
    for (const refused of ['docs/.vitepress/dist/index.html', '.git/index.html', 'GIT~1/index.html', 'con.html', 'a./index.html', '../x.html', '/x.html', 'a\\b.html', '__damocles_preview/x.html', '']) {
      expect(isServablePreviewPath(refused)).toBe(false);
    }
  });

  it('builds a URL path that never reads as another origin', () => {
    expect(previewUrlPath('docs/a b#c?.html')).toBe('/docs/a%20b%23c%3F.html');
    expect(previewUrlPath('evil.com/x.html')).toBe('/evil.com/x.html');
  });
});

describe('MIME types', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['a.HTM', 'text/html; charset=utf-8'],
    ['a.css', 'text/css; charset=utf-8'],
    ['a.js', 'text/javascript; charset=utf-8'],
    ['a.mjs', 'text/javascript; charset=utf-8'],
    ['a.json', 'application/json; charset=utf-8'],
    ['a.js.map', 'application/json; charset=utf-8'],
    ['a.wasm', 'application/wasm'],
    ['a.svg', 'image/svg+xml'],
    ['a.png', 'image/png'],
    ['a.jpeg', 'image/jpeg'],
    ['a.webp', 'image/webp'],
    ['a.ico', 'image/x-icon'],
    ['a.woff2', 'font/woff2'],
    ['a.ttf', 'font/ttf'],
    ['a.txt', 'text/plain; charset=utf-8'],
    ['a.xml', 'application/xml'],
    ['a.csv', 'text/csv; charset=utf-8'],
    ['a.mp4', 'video/mp4'],
    ['a.webm', 'video/webm'],
    ['a.mp3', 'audio/mpeg'],
    ['a.wav', 'audio/wav'],
    ['a.ogg', 'audio/ogg'],
    ['a.vtt', 'text/vtt; charset=utf-8'],
    ['a.m4a', 'audio/mp4'],
    ['a.MOV', 'video/quicktime'],
    ['a.flac', 'audio/flac'],
    ['a.aac', 'audio/aac'],
    ['a.opus', 'audio/ogg'],
    ['a.exe', 'application/octet-stream'],
    ['Makefile', 'application/octet-stream'],
    ['a.constructor', 'application/octet-stream'],
  ])('%s is %s', (name, type) => {
    expect(previewContentType(`dir/${name}`)).toBe(type);
  });
});

describe('headers and CSP', () => {
  it('runs no script in an untrusted project, in the view and in the browser alike, and fetches only its own origin or https in the browser', () => {
    expect(previewCsp(false, 'view')).toBe("sandbox allow-same-origin allow-popups; script-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'self'");
    expect(previewCsp(false, 'browser')).toBe("sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; default-src 'self' https: data:; style-src 'self' https: data: 'unsafe-inline'; script-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'self'");
  });

  it('gives a trusted page popups but no modals in the view (D85), and modals and popups that leave the sandbox in the browser', () => {
    expect(previewCsp(true, 'view')).toBe("sandbox allow-scripts allow-same-origin allow-forms allow-popups; object-src 'none'; base-uri 'self'");
    expect(previewCsp(true, 'browser')).toBe("sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox; object-src 'none'; base-uri 'self'");
  });

  it('sends the isolation headers on every response and never a CORS header', () => {
    const headers = previewHeaders(true, 'view');
    expect(headers).toEqual({
      'Content-Security-Policy': previewCsp(true, 'view'),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    expect(Object.keys(headers).some((name) => name.toLowerCase().startsWith('access-control-'))).toBe(false);
  });
});

function file(size = 1): { result: ReadRangeResult; returned: () => boolean } {
  let returned = false;
  const iterator: AsyncIterator<Uint8Array> = {
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  return { result: { ok: true, size, offset: 0, length: size, resolvedPath: 'index.html', chunks: { [Symbol.asyncIterator]: () => iterator } }, returned: () => returned };
}

describe('answerPreview', () => {
  const ask = (pathname: string, read: (relativePath: string) => Promise<ReadRangeResult>, method = 'GET') => answerPreview({ method, pathname, trusted: false, target: 'view', range: undefined, ifRange: undefined }, { range: (relativePath) => read(relativePath) }, () => undefined);

  it('refuses another method with Allow, and a denied path with no read and no bytes', async () => {
    const read = vi.fn(async (): Promise<ReadRangeResult> => ({ ok: false, reason: 'missing' }));
    const post = await ask('/index.html', read, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers['Allow']).toBe('GET, HEAD');
    const denied = await ask('/.env', read);
    expect(denied).toEqual({ status: 404, headers: previewHeaders(false, 'view') });
    expect(read).not.toHaveBeenCalled();
  });

  it('releases the read of a HEAD, which sends no bytes', async () => {
    const head = file();
    const answer = await ask('/index.html', async () => head.result, 'HEAD');
    expect(answer.status).toBe(200);
    expect(answer.body).toBeUndefined();
    expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(head.returned()).toBe(true);
  });

  it('moves a folder named without its slash to its own path, and serves its index.html once it has one', async () => {
    const read = vi.fn(async (relativePath: string): Promise<ReadRangeResult> => (relativePath === 'docs' ? { ok: false, reason: 'notAFile', folder: true } : file().result));
    const moved = await ask('/docs', read);
    expect(moved.status).toBe(308);
    expect(moved.headers['Location']).toBe('/docs/');
    expect((await ask('/docs/', read)).status).toBe(200);
    expect(read).toHaveBeenLastCalledWith('docs/index.html');
  });

  it('answers 404, never a move, for an entry that is neither a file nor a folder (a link, a FIFO)', async () => {
    const answer = await ask('/page.html', async () => ({ ok: false, reason: 'notAFile', folder: false }));
    expect(answer).toEqual({ status: 404, headers: previewHeaders(false, 'view') });
  });

  it.each([
    // a folder link to a dot folder: docs/x -> ../.git
    ['/docs/x/config', '.git/config'],
    ['/site/env.txt', '.config/env.txt'],
    ['/pkg/secret.html', 'node_modules/.cache/secret.html'],
    ['/linked/key.html', 'GIT~1/key.html'],
    // only a .pnpm folder directly in a node_modules folder passes
    ['/lib/a.js', 'lib/.pnpm/a.js'],
    ['/tools/b.js', 'node_modules/.bin/b.js'],
    ['/store/c.js', '.pnpm/c.js'],
  ])('refuses %s, whose real path is %s, and releases its read', async (pathname, resolvedPath) => {
    const read = file();
    const answer = await ask(pathname, async () => ({ ...read.result, resolvedPath }) as ReadRangeResult);
    expect(answer).toEqual({ status: 404, headers: previewHeaders(false, 'view') });
    expect(read.returned()).toBe(true);
  });

  it.each([
    // pnpm: node_modules/<name> links into node_modules/.pnpm
    ['/node_modules/lib/index.js', 'node_modules/.pnpm/lib@1.0.0/node_modules/lib/index.js'],
    ['/vendor/lib.js', 'packages/a/node_modules/.pnpm/lib@2.1.0/node_modules/lib/lib.js'],
    ['/.well-known/x.json', '.well-known/x.json'],
    ['/docs/x/page.html', 'pages/page.html'],
  ])('serves %s, whose real path is %s', async (pathname, resolvedPath) => {
    const read = file();
    const answer = await ask(pathname, async () => ({ ...read.result, resolvedPath }) as ReadRangeResult);
    expect(answer.status).toBe(200);
  });

  it('answers 503 with the host\'s text while it is not connected, and 404 for a file confinement refuses', async () => {
    const offline = await ask('/index.html', async () => {
      throw new NotConnectedError('build-box is not connected.');
    });
    expect(offline.status).toBe(503);
    expect(offline.body).toBe('build-box is not connected.');
    expect(offline.headers['Content-Security-Policy']).toBe(previewCsp(false, 'view'));
    expect((await ask('/link/out.html', async () => ({ ok: false, reason: 'outside' }))).status).toBe(404);
    expect((await ask('/index.html', async () => ({ ok: false, reason: 'failed', code: 'EIO' }))).status).toBe(500);
  });
});

describe('requestedRange', () => {
  it.each([
    ['bytes=0-99', { first: 0, last: 99 }],
    ['bytes=5-', { first: 5 }],
    ['bytes=-10', { suffix: 10 }],
    ['bytes=-0', { suffix: 0 }],
    ['bytes=7-7', { first: 7, last: 7 }],
    ['BYTES=1-2', { first: 1, last: 2 }],
    ['bytes= 1-2 ', { first: 1, last: 2 }],
    ['bytes=0012-0013', { first: 12, last: 13 }],
    ['bytes=99999999999999999999-', { first: Number.MAX_SAFE_INTEGER }],
    ['bytes=-99999999999999999999', { suffix: Number.MAX_SAFE_INTEGER }],
  ])('reads %s as one range', (header, range) => {
    expect(requestedRange(header, undefined)).toEqual(range);
  });

  it.each([
    // several ranges, which are served whole rather than as multipart/byteranges
    'bytes=0-1,4-5', 'bytes=0-1, 4-5', 'bytes=0-1,', 'bytes=,0-1',
    // invalid: last before first, no position, another unit or syntax
    'bytes=5-1', 'bytes=9007199254740993-9007199254740992', 'bytes=-', 'bytes=', 'bytes=a-b', 'bytes=1.5-2', 'bytes=+1-2', 'bytes 0-1', 'bytes =0-1', 'items=0-1', '',
  ])('serves the whole file for %s', (header) => {
    expect(requestedRange(header, undefined)).toBeUndefined();
  });

  it('serves the whole file with no Range, and for any If-Range, since no response carries a validator it could match', () => {
    expect(requestedRange(undefined, undefined)).toBeUndefined();
    expect(requestedRange('bytes=0-1', '"abc"')).toBeUndefined();
    expect(requestedRange('bytes=0-1', 'Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
    expect(requestedRange(undefined, '"abc"')).toBeUndefined();
  });
});

async function bodyOf(answer: PreviewAnswer): Promise<Buffer> {
  if (answer.body === undefined || typeof answer.body === 'string') return Buffer.from(answer.body ?? '');
  const parts: Buffer[] = [];
  for await (const chunk of answer.body) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

describe('answerPreview byte ranges, read through the workspace\'s own ranged read', () => {
  const MEDIA = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  let root: string;
  let reads: PreviewFileReads;
  let calls: Array<[string, number, number]>;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-preview-range-'));
    fs.writeFileSync(path.join(root, 'clip.mp4'), MEDIA);
    fs.writeFileSync(path.join(root, 'empty.mp4'), '');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    const project: Project = { key: root, fsPath: root, name: 'site' };
    const ops = createTransferOps({ platform: process.platform, log: () => undefined });
    calls = [];
    reads = {
      range: (relativePath, offset, length) => {
        calls.push([relativePath, offset, length]);
        return ops.readFileRange(project, relativePath, offset, length);
      },
    };
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ask = (pathname: string, range: string | undefined, ifRange?: string, method = 'GET') => answerPreview({ method, pathname, trusted: false, target: 'view', range, ifRange }, reads, () => undefined);

  it.each([
    ['bytes=0-9', 206, 'bytes 0-9/100', 0, 10],
    ['bytes=90-', 206, 'bytes 90-99/100', 90, 100],
    ['bytes=95-200', 206, 'bytes 95-99/100', 95, 100],
    ['bytes=99-99', 206, 'bytes 99-99/100', 99, 100],
    ['bytes=-5', 206, 'bytes 95-99/100', 95, 100],
    ['bytes=-500', 206, 'bytes 0-99/100', 0, 100],
    ['bytes=0-1,5-6', 200, undefined, 0, 100],
    ['bytes=5-1', 200, undefined, 0, 100],
    ['bytes=x', 200, undefined, 0, 100],
    ['items=0-9', 200, undefined, 0, 100],
    [undefined, 200, undefined, 0, 100],
  ])('Range %s answers %i with Content-Range %s', async (range, status, contentRange, from, to) => {
    const answer = await ask('/clip.mp4', range);
    expect(answer.status).toBe(status);
    expect(answer.headers['Content-Range']).toBe(contentRange);
    expect(answer.headers['Content-Length']).toBe(String(to - from));
    expect(answer.headers['Accept-Ranges']).toBe('bytes');
    expect(answer.headers['Content-Type']).toBe('video/mp4');
    expect(answer.headers).toMatchObject(previewHeaders(false, 'view'));
    expect((await bodyOf(answer)).equals(MEDIA.subarray(from, to))).toBe(true);
  });

  it.each([['bytes=100-'], ['bytes=100-200'], ['bytes=-0']])('Range %s past the end answers 416 with the size and no bytes', async (range) => {
    const answer = await ask('/clip.mp4', range);
    expect(answer).toEqual({ status: 416, headers: { ...previewHeaders(false, 'view'), 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */100' } });
  });

  it('answers an empty file\'s position range 416, and its suffix range with the whole empty file, which no Content-Range can name', async () => {
    expect((await ask('/empty.mp4', 'bytes=0-')).headers['Content-Range']).toBe('bytes */0');
    const suffix = await ask('/empty.mp4', 'bytes=-5');
    expect(suffix.status).toBe(200);
    expect(suffix.headers['Content-Length']).toBe('0');
    expect((await bodyOf(suffix)).length).toBe(0);
    const whole = await ask('/empty.mp4', undefined);
    expect(whole.headers['Content-Length']).toBe('0');
    expect((await bodyOf(whole)).length).toBe(0);
  });

  it('sends the whole file for a range with an If-Range, which no validator of a preview matches', async () => {
    const answer = await ask('/clip.mp4', 'bytes=0-9', '"etag"');
    expect(answer.status).toBe(200);
    expect(answer.headers['Content-Length']).toBe('100');
    expect((await bodyOf(answer)).equals(MEDIA)).toBe(true);
  });

  it('answers HEAD with the whole file\'s headers and reads no byte, whatever its Range', async () => {
    calls.length = 0;
    const answer = await ask('/clip.mp4', 'bytes=0-9', undefined, 'HEAD');
    expect(answer.status).toBe(200);
    expect(answer.body).toBeUndefined();
    expect(answer.headers).toMatchObject({ 'Content-Length': '100', 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' });
    expect(calls).toEqual([['clip.mp4', 0, 0]]);
  });

  it('refuses a denied path with 404 and no read, whatever its Range', async () => {
    calls.length = 0;
    for (const range of ['bytes=0-', 'bytes=-1', 'bytes=0-1,2-3', undefined]) {
      expect(await ask('/.env', range)).toEqual({ status: 404, headers: previewHeaders(false, 'view') });
    }
    expect(calls).toEqual([]);
  });
});

describe('declaresCharset', () => {
  const bytes = (text: string): Uint8Array => Buffer.from(text, 'latin1');
  it.each([
    ['a UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x3c])],
    ['a UTF-16LE BOM', Buffer.from([0xff, 0xfe, 0x3c, 0x00])],
    ['a UTF-16BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x3c])],
    ['<meta charset="windows-1253">', bytes('<!doctype html><html><head><meta charset="windows-1253"><title>x</title>')],
    ["<meta charset='iso-8859-7'>", bytes("<head><meta charset='iso-8859-7'>")],
    ['<meta charset=shift_jis>', bytes('<head><meta charset=shift_jis>')],
    ['<META CHARSET = "GBK" />', bytes('<HEAD><META CHARSET = "GBK" /></HEAD>')],
    ['<meta charset> after other attributes', bytes('<meta name="x" charset="koi8-r">')],
    ['http-equiv content-type', bytes('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">')],
    ['http-equiv, reordered and bare', bytes('<meta content=\'text/html;charset=euc-kr\' HTTP-EQUIV=content-type>')],
  ])('holds for %s', (_name, head) => {
    expect(declaresCharset(head)).toBe(true);
  });

  it.each([
    ['no declaration', bytes('<!doctype html><html><head><title>x</title></head><body>é</body></html>')],
    ['a declaration after the first 1024 bytes', bytes(`<!doctype html><!--${'x'.repeat(1100)}--><meta charset="windows-1253">`)],
    ['a declaration that starts at byte 1024', bytes(`${' '.repeat(1024)}<meta charset="windows-1253">`)],
    ['a declaration in a comment', bytes('<!-- <meta charset="windows-1253"> --><title>x</title>')],
    ['a content charset with no http-equiv', bytes('<meta name="description" content="charset=koi8-r">')],
    ['a BOM-like byte later on', bytes('<p>\u00ef\u00bb\u00bf</p>')],
    ['an empty file', new Uint8Array(0)],
  ])('does not hold for %s', (_name, head) => {
    expect(declaresCharset(head)).toBe(false);
  });
});

describe('answerPreview of an HTML file\'s charset and real path, read through the workspace\'s own ranged read', () => {
  let root: string;
  let reads: PreviewFileReads;
  let calls: Array<[string, number, number]>;
  const LEGACY = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1253"><title>x</title></head><body>'), Buffer.alloc(3000, 0xe1), Buffer.from('</body></html>')]);
  const PLAIN = Buffer.from(`<html><head><title>x</title></head><body>${'é'.repeat(1500)}</body></html>`);

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-preview-charset-'));
    fs.writeFileSync(path.join(root, 'legacy.html'), LEGACY);
    fs.writeFileSync(path.join(root, 'plain.html'), PLAIN);
    fs.writeFileSync(path.join(root, 'bom.html'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>x</p>', 'utf16le')]));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), 'SECRET=1');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.symlinkSync(path.join(root, '.git'), path.join(root, 'docs', 'x'), 'junction');
    const project: Project = { key: root, fsPath: root, name: 'site' };
    const ops = createTransferOps({ platform: process.platform, log: () => undefined });
    calls = [];
    reads = {
      range: (relativePath, offset, length) => {
        calls.push([relativePath, offset, length]);
        return ops.readFileRange(project, relativePath, offset, length);
      },
    };
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ask = (pathname: string, range?: string, method = 'GET') => answerPreview({ method, pathname, trusted: false, target: 'view', range, ifRange: undefined }, reads, () => undefined);

  it('sends a page that declares its encoding as text/html with no charset, whole and unchanged, from one read', async () => {
    calls.length = 0;
    const answer = await ask('/legacy.html');
    expect(answer.headers['Content-Type']).toBe('text/html');
    expect((await bodyOf(answer)).equals(LEGACY)).toBe(true);
    expect(calls).toEqual([['legacy.html', 0, Number.MAX_SAFE_INTEGER]]);
    const bom = await ask('/bom.html');
    expect(bom.headers['Content-Type']).toBe('text/html');
    await bodyOf(bom);
  });

  it('sends a page that declares nothing as UTF-8', async () => {
    const answer = await ask('/plain.html');
    expect(answer.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect((await bodyOf(answer)).equals(PLAIN)).toBe(true);
  });

  it('reads at most the prescan for a HEAD, and the prescan again for a range that does not start the file', async () => {
    calls.length = 0;
    const head = await ask('/legacy.html', undefined, 'HEAD');
    expect(head.headers).toMatchObject({ 'Content-Type': 'text/html', 'Content-Length': String(LEGACY.length) });
    expect(head.body).toBeUndefined();
    expect(calls).toEqual([['legacy.html', 0, 1024]]);
    calls.length = 0;
    const part = await ask('/legacy.html', 'bytes=2000-2009');
    expect(part.status).toBe(206);
    expect(part.headers['Content-Type']).toBe('text/html');
    expect((await bodyOf(part)).equals(LEGACY.subarray(2000, 2010))).toBe(true);
    expect(calls).toEqual([['legacy.html', 2000, 10], ['legacy.html', 0, 1024]]);
  });

  it('refuses a file a folder link leads into a dot folder by, docs/x -> .git', async () => {
    expect(await ask('/docs/x/config')).toEqual({ status: 404, headers: previewHeaders(false, 'view') });
  });
});

describe('answerPreview of a file of any size', () => {
  const BIG = 200 * 1024 * 1024;
  const MAX = Number.MAX_SAFE_INTEGER;
  const ask = (reads: PreviewFileReads, range: string | undefined, method = 'GET') => answerPreview({ method, pathname: '/big.mp4', trusted: false, target: 'view', range, ifRange: undefined }, reads, () => undefined);

  // each answer's body is returned unread, so no byte of the file is produced
  it('serves the whole file and each range\'s full span, reading no byte before the body is pulled', async () => {
    const big = syntheticFile(BIG);
    const answers: PreviewAnswer[] = [];
    const answered = async (range: string | undefined, method = 'GET'): Promise<PreviewAnswer> => {
      const answer = await ask(big.reads, range, method);
      answers.push(answer);
      return answer;
    };
    const whole = await answered(undefined);
    expect(whole.status).toBe(200);
    expect(whole.headers['Content-Length']).toBe(String(BIG));
    expect(whole.headers['Content-Range']).toBeUndefined();
    const head = await answered(undefined, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
    expect(head.headers['Content-Length']).toBe(String(BIG));
    const open = await answered('bytes=0-');
    expect(open.status).toBe(206);
    expect(open.headers['Content-Range']).toBe(`bytes 0-${BIG - 1}/${BIG}`);
    expect(open.headers['Content-Length']).toBe(String(BIG));
    const from = await answered('bytes=1000-');
    expect(from.headers['Content-Range']).toBe(`bytes 1000-${BIG - 1}/${BIG}`);
    expect(from.headers['Content-Length']).toBe(String(BIG - 1000));
    const tail = await answered(`bytes=-${BIG}`);
    expect(tail.headers['Content-Range']).toBe(`bytes 0-${BIG - 1}/${BIG}`);
    const last = await answered('bytes=-10');
    expect(last.headers['Content-Range']).toBe(`bytes ${BIG - 10}-${BIG - 1}/${BIG}`);
    const end = await answered(`bytes=${BIG - 10}-${BIG + 10}`);
    expect(end.headers['Content-Range']).toBe(`bytes ${BIG - 10}-${BIG - 1}/${BIG}`);
    // positions past MAX_SAFE_INTEGER clamp, so the span asked for stays a safe integer
    const huge = await answered('bytes=0-99999999999999999999');
    expect(huge.headers['Content-Range']).toBe(`bytes 0-${BIG - 1}/${BIG}`);
    expect(big.calls).toEqual([[0, MAX], [0, 0], [0, MAX], [1000, MAX], [-BIG, BIG], [-10, 10], [BIG - 10, 21], [0, MAX]]);
    for (const answer of answers) if (answer.body !== undefined && typeof answer.body !== 'string') await answer.body[Symbol.asyncIterator]().return?.();
    expect(big.stats).toMatchObject({ produced: 0, returned: 8 });
  });

  it('serves nothing from a host that reads no range with a resolved path, and logs why', async () => {
    const logged: string[] = [];
    const answer = await answerPreview({ method: 'GET', pathname: '/clip.mp4', trusted: false, target: 'view', range: undefined, ifRange: undefined }, { range: () => Promise.reject(new RangedReadsUnsupportedError('ssh+box')) }, (line) => logged.push(line));
    expect(answer).toEqual({ status: 500, headers: previewHeaders(false, 'view') });
    expect(logged).toEqual(['[html-preview] reading "clip.mp4" failed: The Damocles server on ssh+box does not read byte ranges']);
  });
});

describe('answerPreview sends exactly the bytes its Content-Length declares', () => {
  // a 10-byte file whose read yields `yielded` instead, in two chunks, as a file cut after its stat or a faulty host's would
  function misread(yielded: number): { chunks: AsyncIterable<Uint8Array>; returned: () => boolean } {
    const parts = [Buffer.alloc(Math.min(4, yielded), 7), Buffer.alloc(Math.max(0, yielded - 4), 7)];
    let returned = false;
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        const part = parts.shift();
        return part === undefined ? { done: true, value: undefined } : { done: false, value: part };
      },
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    };
    return { chunks: { [Symbol.asyncIterator]: () => iterator }, returned: () => returned };
  }
  const ranged = (chunks: AsyncIterable<Uint8Array>): PreviewFileReads => ({
    range: async (_relativePath, offset, length) => {
      const start = offset < 0 ? Math.max(0, 10 + offset) : Math.min(offset, 10);
      return { ok: true, size: 10, offset: start, length: Math.min(length, 10 - start), resolvedPath: 'clip.mp4', chunks };
    },
  });
  const ask = (reads: PreviewFileReads, range: string | undefined) => answerPreview({ method: 'GET', pathname: '/clip.mp4', trusted: false, target: 'view', range, ifRange: undefined }, reads, () => undefined);

  it('fails the body of a read that ends short of it, whole or ranged', async () => {
    for (const range of [undefined, 'bytes=2-9']) {
      const answer = await ask(ranged(misread(4).chunks), range);
      expect(answer.headers['Content-Length'], range).toBe(range === undefined ? '10' : '8');
      await expect(bodyOf(answer), range).rejects.toThrow('short of the');
    }
  });

  it('cuts a read that yields more at it and releases the read, whole or ranged', async () => {
    for (const [range, length] of [[undefined, 10], ['bytes=0-4', 5], ['bytes=-3', 3]] as const) {
      const long = misread(30);
      const answer = await ask(ranged(long.chunks), range);
      expect(answer.headers['Content-Length'], range).toBe(String(length));
      expect((await bodyOf(answer)).length, range).toBe(length);
      expect(long.returned(), range).toBe(true);
    }
  });

  it('releases the read when the body is returned before it was read', async () => {
    const unread = misread(10);
    await exactBytes(unread.chunks, 10)[Symbol.asyncIterator]().return?.();
    expect(unread.returned()).toBe(true);
  });
});
