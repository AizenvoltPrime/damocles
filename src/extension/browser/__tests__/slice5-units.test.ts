import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserService } from '../index';
import { buildBrowserPiTools } from '../../pi-session/tools/browser-tools';

/**
 * Pure unit tests for Slice-5 isolable logic that needs NO real browser: the downloads ring-buffer
 * bound, the tabs-list formatting, download-filename sanitization, and BrowserUpload's fail-soft
 * path-exists validation. Each drives the REAL production code (real BrowserService methods, the real
 * download handler installed by registerPage, the real tool) via lightweight fakes — no speculative
 * helpers were extracted.
 */

type Handler = (...args: unknown[]) => unknown;

/** A fake Playwright Page that records the event handlers registerPage installs. */
function fakePage(url = 'about:blank'): { obj: Record<string, unknown>; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const obj: Record<string, unknown> = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    url: () => url,
    opener: async () => null,
  };
  return { obj, handlers };
}

/** A fake CDPSession — registerPage only calls `.on(...)` on it. */
const fakeSession = { on: () => {} };

describe('Slice 5 — downloads ring buffer', () => {
  let downloadsDir = '';

  beforeAll(async () => {
    downloadsDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
  });
  afterAll(async () => {
    if (downloadsDir) await fsp.rm(downloadsDir, { recursive: true, force: true }).catch(() => {});
  });

  it('caps at DOWNLOADS_MAX (50), dropping the oldest, and reports absolute saved paths', async () => {
    const service = new BrowserService();
    (service as unknown as { context: unknown }).context = { newCDPSession: async () => fakeSession };
    (service as unknown as { downloadsDir: string }).downloadsDir = downloadsDir;

    const { obj: page, handlers } = fakePage();
    await (service as unknown as { registerPage: (p: unknown) => Promise<unknown> }).registerPage(page);
    const onDownload = handlers.get('download');
    expect(onDownload).toBeTypeOf('function');

    // Drive 60 downloads through the REAL handler; saveAs is a no-op resolve (we assert bookkeeping,
    // not disk IO — a separate IT covers the real saveAs path).
    for (let i = 0; i < 60; i++) {
      const name = `f${i}.txt`;
      await onDownload!({
        suggestedFilename: () => name,
        url: () => `http://x/${name}`,
        saveAs: async () => {},
      });
    }

    const downloads = service.getDownloads();
    expect(downloads.length).toBe(50);
    // 60 pushed, first 10 shifted → f10..f59 remain.
    expect(downloads[0]!.filename).toBe('f10.txt');
    expect(downloads[49]!.filename).toBe('f59.txt');
    expect(downloads[0]!.savedPath).toBe(join(downloadsDir, 'f10.txt'));
    expect(downloads[0]!.state).toBe('completed');
  });

  it('marks state "failed" when saveAs rejects (fail-soft, still recorded)', async () => {
    const service = new BrowserService();
    (service as unknown as { context: unknown }).context = { newCDPSession: async () => fakeSession };
    (service as unknown as { downloadsDir: string }).downloadsDir = downloadsDir;

    const { obj: page, handlers } = fakePage();
    await (service as unknown as { registerPage: (p: unknown) => Promise<unknown> }).registerPage(page);
    const onDownload = handlers.get('download')!;

    await onDownload({
      suggestedFilename: () => 'boom.bin',
      url: () => 'http://x/boom.bin',
      saveAs: async () => { throw new Error('disk full'); },
    });

    const downloads = service.getDownloads();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.state).toBe('failed');
    expect(downloads[0]!.filename).toBe('boom.bin');
  });

  it('getDownloads returns a copy (external mutation cannot corrupt the buffer)', async () => {
    const service = new BrowserService();
    (service as unknown as { context: unknown }).context = { newCDPSession: async () => fakeSession };
    (service as unknown as { downloadsDir: string }).downloadsDir = downloadsDir;
    const { obj: page, handlers } = fakePage();
    await (service as unknown as { registerPage: (p: unknown) => Promise<unknown> }).registerPage(page);
    await handlers.get('download')!({ suggestedFilename: () => 'a.txt', url: () => 'http://x/a.txt', saveAs: async () => {} });

    const copy = service.getDownloads();
    copy.push({ filename: 'evil', savedPath: '/tmp/evil', url: 'http://evil', state: 'completed' });
    expect(service.getDownloads()).toHaveLength(1);
  });
});

describe('Slice 5 — sanitizeDownloadFilename', () => {
  const service = new BrowserService();
  const sanitize = (s: string): string =>
    (service as unknown as { sanitizeDownloadFilename: (v: string) => string }).sanitizeDownloadFilename(s);

  it('keeps a normal filename', () => {
    expect(sanitize('report.pdf')).toBe('report.pdf');
  });
  it('strips path separators so a download cannot escape the downloads dir', () => {
    expect(sanitize('a/b\\c.txt')).toBe('a_b_c.txt');
    expect(sanitize('../../etc/passwd')).not.toContain('/');
    expect(sanitize('../../etc/passwd')).not.toContain('\\');
  });
  it('strips control characters', () => {
    expect(sanitize('na\x00me\x1f.txt')).toBe('name.txt');
  });
  it('falls back to "download" when nothing usable remains', () => {
    expect(sanitize('')).toBe('download');
    expect(sanitize('\x00\x01')).toBe('download');
    expect(sanitize('///')).toBe('___'); // separators become underscores (non-empty), not the fallback
  });
  it('neutralizes a bare dot / dot-dot that would resolve to a directory under join()', () => {
    expect(sanitize('.')).toBe('download');
    expect(sanitize('..')).toBe('download');
    expect(sanitize('...')).toBe('download');
    expect(sanitize('..foo.txt')).toBe('..foo.txt'); // leading dots on a real name are kept
  });
  it('neutralizes the Windows drive / NTFS ADS colon', () => {
    expect(sanitize('C:evil.txt')).toBe('C_evil.txt');
    expect(sanitize('name.txt:$DATA')).toBe('name.txt_$DATA');
  });
});

describe('Slice 5 — download filename collisions', () => {
  const reserve = (service: unknown, dir: string, name: string) =>
    (service as { reserveDownloadPath: (d: string, n: string) => Promise<{ path: string; filename: string }> }).reserveDownloadPath(dir, name);

  it('suffixes same-name reservations instead of overwriting (in-memory, no write needed)', async () => {
    const service = new BrowserService();
    const dir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
    const a = await reserve(service, dir, 'file.txt');
    const b = await reserve(service, dir, 'file.txt');
    const c = await reserve(service, dir, 'file.txt');
    expect([a.filename, b.filename, c.filename]).toEqual(['file.txt', 'file (1).txt', 'file (2).txt']);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('skips a name that already exists on disk', async () => {
    const service = new BrowserService();
    const dir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
    await fsp.writeFile(join(dir, 'x.txt'), '');
    const r = await reserve(service, dir, 'x.txt');
    expect(r.filename).toBe('x (1).txt');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('suffixes an extensionless name after the whole name', async () => {
    const service = new BrowserService();
    const dir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
    const a = await reserve(service, dir, 'archive');
    const b = await reserve(service, dir, 'archive');
    expect([a.filename, b.filename]).toEqual(['archive', 'archive (1)']);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('Slice 5 — listTabs formatting (scope-scoped)', () => {
  it('enumerates a scope\'s own tabs in order with 0-based index, tracked title/url, and the active flag', () => {
    const PRIMARY = BrowserService.PRIMARY_SCOPE_ID;
    const service = new BrowserService();
    const p1 = { url: () => 'http://a/live' };
    const p2 = { url: () => 'http://b/live' };
    const pages = new Map<unknown, unknown>();
    pages.set(p1, { page: p1, ownerScopeId: PRIMARY, lastTitle: 'Alpha', lastUrl: 'http://a/tracked' });
    pages.set(p2, { page: p2, ownerScopeId: PRIMARY, lastTitle: null, lastUrl: null });
    (service as unknown as { pages: unknown }).pages = pages;
    // The scope's CURRENT tab (p2) is the active one — independent of the human `activePage`.
    (service as unknown as { scopes: Map<string, { currentPage: unknown }> }).scopes = new Map([
      [PRIMARY, { currentPage: p2 }],
    ]);

    expect(service.listTabs(PRIMARY)).toEqual([
      { index: 0, title: 'Alpha', url: 'http://a/tracked', active: false },
      // lastTitle null → '', lastUrl null → falls back to page.url().
      { index: 1, title: '', url: 'http://b/live', active: true },
    ]);
  });
});

describe('Slice 5 — BrowserUpload path validation (fail-soft, no browser)', () => {
  let existing = '';

  beforeAll(async () => {
    existing = join(await fsp.mkdtemp(join(tmpdir(), 'damocles-up-')), 'real.txt');
    await fsp.writeFile(existing, 'hello');
  });
  afterAll(async () => {
    await fsp.rm(existing, { force: true }).catch(() => {});
  });

  type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };
  // Tools now bind to a per-agent SCOPE handle (not the bare service). The upload path reads the scope's
  // current page + stages onto it, so a minimal fake scope suffices.
  function build(getCurrentPage: () => unknown): Map<string, ToolLike> {
    const scope = { getCurrentPage, stageUpload: () => {}, getController: () => null };
    const tools = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    return new Map(tools.map((t) => [t.name, t]));
  }

  it('errors when the browser is not connected', async () => {
    const res = await build(() => null).get('BrowserUpload')!.execute('u', { selector: '#f', paths: [existing] });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Browser is not connected');
  });

  it('reports which files are missing without throwing, and names only the missing ones', async () => {
    const missing = join(tmpdir(), 'damocles-does-not-exist-xyz.txt');
    const res = await build(() => ({})).get('BrowserUpload')!.execute('u', { selector: '#f', paths: [existing, missing] });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('file(s) not found');
    expect(res.content[0]!.text).toContain(missing);
    expect(res.content[0]!.text).not.toContain(existing);
  });

  it('rejects a relative path before touching the filesystem, naming only the relative one', async () => {
    const relative = 'relative/only.txt';
    const res = await build(() => ({})).get('BrowserUpload')!.execute('u', { selector: '#f', paths: [existing, relative] });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('must be absolute');
    expect(res.content[0]!.text).toContain(relative);
    expect(res.content[0]!.text).not.toContain(existing);
  });

  it('reports a completed upload as SUCCESS even when the follow-up screenshot fails', async () => {
    // setInputFiles succeeds, but the confirmation screenshot path throws (getCdp() null, e.g. the
    // upload navigated the page). The files WERE set, so the tool must report success — never mislabel a
    // completed upload as a "not connected" error, and never reject raw.
    const page = { locator: () => ({ first: () => ({ setInputFiles: async () => {} }) }) };
    const scope = { getCurrentPage: () => page, stageUpload: () => {}, getController: () => null };
    const tools = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    const upload = new Map(tools.map((t) => [t.name, t])).get('BrowserUpload')!;
    const res = await upload.execute('u', { selector: '#f', paths: [existing] });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain('Uploaded 1 file(s)');
    expect(res.content[0]!.text).toMatch(/Screenshot unavailable|navigated/i);
  });
});
