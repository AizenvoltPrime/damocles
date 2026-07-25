import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrowserService, DOWNLOAD_MAX_BYTES, DOWNLOAD_LAUNCH_MAX_BYTES } from '../index';
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

/**
 * Create a REAL file of `bytes` via `truncate`, so `fsp.stat(await download.path()).size` in the
 * production handler measures a real size. `truncate` makes a sparse file: a 105 MB fixture costs
 * ~1 ms and (on NTFS) no allocated blocks, which is what makes the 100 MB cap testable at all.
 */
async function sparseFile(dir: string, name: string, bytes: number): Promise<string> {
  const path = join(dir, name);
  const fh = await fsp.open(path, 'w');
  await fh.truncate(bytes);
  await fh.close();
  return path;
}

/**
 * A fake Playwright `Download` covering the whole surface the production handler touches:
 * `suggestedFilename`/`url`/`failure`/`path`/`delete`/`cancel`/`saveAs`. `saveAs` performs a REAL
 * copy so tests can assert the downloads directory's on-disk contents rather than only the in-memory
 * ring-buffer entry — an entry claiming `completed` with nothing on disk must not pass.
 */
function fakeDownload(opts: { filename: string; url?: string; tempPath?: string; failure?: string | null }) {
  const calls = { cancel: 0, delete: 0, path: 0, failure: 0, saveAs: [] as string[] };
  const download = {
    suggestedFilename: () => opts.filename,
    url: () => opts.url ?? `http://x/${opts.filename}`,
    failure: async () => { calls.failure++; return opts.failure ?? null; },
    path: async () => { calls.path++; return opts.tempPath!; },
    delete: async () => { calls.delete++; },
    cancel: async () => { calls.cancel++; },
    saveAs: async (dest: string) => { calls.saveAs.push(dest); await fsp.copyFile(opts.tempPath!, dest); },
  };
  return { download, calls };
}

/** The download state moved onto DownloadManager in Slice 6; reach it through the service's manager
 *  so these tests keep driving the REAL production state rather than a copy. */
function downloadsPriv(service: BrowserService): { downloadsDir: string; downloadedBytes: number } {
  return (service as unknown as { downloadManager: { downloadsDir: string; downloadedBytes: number } }).downloadManager;
}

/** A service wired with a fake context + downloads dir, and the REAL `download` handler off registerPage. */
async function serviceWithDownloads(downloadsDir: string): Promise<{
  service: BrowserService;
  onDownload: Handler;
  budget: (bytes: number) => void;
  spent: () => number;
}> {
  const service = new BrowserService();
  (service as unknown as { context: unknown }).context = { newCDPSession: async () => fakeSession };
  downloadsPriv(service).downloadsDir = downloadsDir;
  const { obj: page, handlers } = fakePage();
  await (service as unknown as { registerPage: (p: unknown) => Promise<unknown> }).registerPage(page);
  const priv = downloadsPriv(service);
  return {
    service,
    onDownload: handlers.get('download')!,
    // Seed bytes "already saved this launch". The positive control that this mirrors real accumulation
    // is the test below asserting real saveAs calls move the same counter.
    budget: (bytes: number) => { priv.downloadedBytes = bytes; },
    spent: () => priv.downloadedBytes,
  };
}

const MB = 1024 * 1024;

describe('Slice 5 — downloads ring buffer', () => {
  let downloadsDir = '';
  let sourceFile = '';

  beforeAll(async () => {
    downloadsDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
    // Slice 5 gave the handler a size budget, so it now stats Playwright's temp file before saving.
    // A real (tiny) source file is what makes that measurement meaningful.
    sourceFile = await sparseFile(await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-src-')), 'src.bin', 16);
  });
  afterAll(async () => {
    if (downloadsDir) await fsp.rm(downloadsDir, { recursive: true, force: true }).catch(() => {});
    if (sourceFile) await fsp.rm(sourceFile, { force: true }).catch(() => {});
  });

  it('caps at DOWNLOADS_MAX (50), dropping the oldest, and reports absolute saved paths', async () => {
    const { service, onDownload } = await serviceWithDownloads(downloadsDir);

    // Drive 60 downloads through the REAL handler.
    for (let i = 0; i < 60; i++) {
      const name = `f${i}.txt`;
      await onDownload(fakeDownload({ filename: name, tempPath: sourceFile }).download);
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
    const dir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
    const { service, onDownload } = await serviceWithDownloads(dir);

    const { download } = fakeDownload({ filename: 'boom.bin', tempPath: sourceFile });
    download.saveAs = async () => { throw new Error('disk full'); };
    await onDownload(download);

    const downloads = service.getDownloads();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.state).toBe('failed');
    expect(downloads[0]!.filename).toBe('boom.bin');
    // A failed save must not charge the launch budget.
    expect(downloadsPriv(service).downloadedBytes).toBe(0);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('getDownloads returns a copy (external mutation cannot corrupt the buffer)', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-'));
    const { service, onDownload } = await serviceWithDownloads(dir);
    await onDownload(fakeDownload({ filename: 'a.txt', tempPath: sourceFile }).download);

    const copy = service.getDownloads();
    copy.push({ filename: 'evil', savedPath: '/tmp/evil', url: 'http://evil', state: 'completed' });
    expect(service.getDownloads()).toHaveLength(1);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

/**
 * Slice 5 / S3 — the download size budget, driven through the REAL `page.on('download')` handler that
 * `registerPage` installs. Every test asserts the DOWNLOADS DIRECTORY's actual contents, not just the
 * in-memory entry: an implementation that records `rejected` while still copying the file to disk
 * must fail, and one that records `completed` with nothing on disk must fail too.
 */
describe('Slice 5 — download size budget (S3)', () => {
  let downloadsDir = '';
  let tempDir = '';

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-temp-'));
  });
  afterAll(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
  beforeEach(async () => {
    downloadsDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-budget-'));
  });

  const dirEntries = (): Promise<string[]> => fsp.readdir(downloadsDir);

  it('constants are the values the brief mandates (100 MB per file, 500 MB per launch)', () => {
    expect(DOWNLOAD_MAX_BYTES).toBe(100 * MB);
    expect(DOWNLOAD_LAUNCH_MAX_BYTES).toBe(500 * MB);
  });

  it('(f) POSITIVE CONTROL — a normal small download still lands on disk as completed with its size', async () => {
    const { service, onDownload, spent } = await serviceWithDownloads(downloadsDir);
    const temp = await sparseFile(tempDir, 'ok-small.bin', 5 * MB);
    const { download, calls } = fakeDownload({ filename: 'ok-small.bin', tempPath: temp });

    await onDownload(download);

    const entry = service.getDownloads()[0]!;
    expect(entry.state).toBe('completed');
    expect(entry.sizeBytes).toBe(5 * MB);
    expect(entry.savedPath).toBe(join(downloadsDir, 'ok-small.bin'));
    // The file REALLY exists at the reported path with the reported size.
    expect((await fsp.stat(entry.savedPath)).size).toBe(5 * MB);
    expect(await dirEntries()).toEqual(['ok-small.bin']);
    expect(calls.saveAs).toEqual([entry.savedPath]);
    expect(calls.delete).toBe(0);
    expect(calls.cancel).toBe(0);
    // The saved bytes really are charged to the launch budget (proves `budget()` seeding below mirrors
    // production accumulation rather than poking an unrelated field).
    expect(spent()).toBe(5 * MB);
  });

  it('(a) a file over the 100 MB per-file cap is deleted, never saved, and recorded rejected WITH its size', async () => {
    const { service, onDownload, spent } = await serviceWithDownloads(downloadsDir);
    const oversized = DOWNLOAD_MAX_BYTES + 1;
    const temp = await sparseFile(tempDir, 'huge.bin', oversized);
    const { download, calls } = fakeDownload({ filename: 'huge.bin', tempPath: temp });

    await onDownload(download);

    const entry = service.getDownloads()[0]!;
    expect(entry.state).toBe('rejected');
    expect(entry.sizeBytes).toBe(oversized);
    expect(entry.savedPath).toBe('');
    expect(calls.delete).toBe(1);
    expect(calls.saveAs).toEqual([]);
    // NOTHING was written to the downloads directory.
    expect(await dirEntries()).toEqual([]);
    // A refused download must not consume the launch budget.
    expect(spent()).toBe(0);
  });

  it('(a) boundary — exactly 100 MB is SAVED, one byte more is REJECTED', async () => {
    // Positive control pinning the comparison to `>` rather than `>=`: without the at-cap case, an
    // off-by-one that refused every 100 MB file would pass the rejection test above.
    const atCap = await serviceWithDownloads(downloadsDir);
    const atCapTemp = await sparseFile(tempDir, 'at-cap.bin', DOWNLOAD_MAX_BYTES);
    await atCap.onDownload(fakeDownload({ filename: 'at-cap.bin', tempPath: atCapTemp }).download);
    expect(atCap.service.getDownloads()[0]!.state).toBe('completed');
    expect(await dirEntries()).toEqual(['at-cap.bin']);

    const overDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-budget-'));
    const over = await serviceWithDownloads(overDir);
    const overTemp = await sparseFile(tempDir, 'over-cap.bin', DOWNLOAD_MAX_BYTES + 1);
    await over.onDownload(fakeDownload({ filename: 'over-cap.bin', tempPath: overTemp }).download);
    expect(over.service.getDownloads()[0]!.state).toBe('rejected');
    expect(await fsp.readdir(overDir)).toEqual([]);
    await fsp.rm(overDir, { recursive: true, force: true });
  });

  it('(b) a download that would cross the remaining launch budget is rejected even though it is under the per-file cap', async () => {
    const { service, onDownload, budget } = await serviceWithDownloads(downloadsDir);
    // 460 MB already saved this launch → only 40 MB remains. A 50 MB file is well under the 100 MB
    // per-file cap, so ONLY the launch-budget arm of the check can refuse it.
    budget(460 * MB);
    const temp = await sparseFile(tempDir, 'crosses.bin', 50 * MB);
    const { download, calls } = fakeDownload({ filename: 'crosses.bin', tempPath: temp });

    await onDownload(download);

    const entry = service.getDownloads()[0]!;
    expect(entry.state).toBe('rejected');
    expect(entry.sizeBytes).toBe(50 * MB);
    expect(entry.savedPath).toBe('');
    expect(calls.delete).toBe(1);
    expect(calls.saveAs).toEqual([]);
    expect(await dirEntries()).toEqual([]);
  });

  it('(b) POSITIVE CONTROL — the same 50 MB file IS saved when the remaining budget covers it', async () => {
    // Proves the previous test discriminates on the budget, not on the file itself.
    const { service, onDownload } = await serviceWithDownloads(downloadsDir);
    downloadsPriv(service).downloadedBytes = 400 * MB; // 100 MB remains
    const temp = await sparseFile(tempDir, 'fits.bin', 50 * MB);
    await onDownload(fakeDownload({ filename: 'fits.bin', tempPath: temp }).download);

    expect(service.getDownloads()[0]!.state).toBe('completed');
    expect(await dirEntries()).toEqual(['fits.bin']);
  });

  it('(c) once the launch budget is exhausted a subsequent download is CANCELLED and recorded rejected', async () => {
    const { service, onDownload } = await serviceWithDownloads(downloadsDir);
    downloadsPriv(service).downloadedBytes = DOWNLOAD_LAUNCH_MAX_BYTES;
    const temp = await sparseFile(tempDir, 'after-exhausted.bin', 1 * MB);
    const { download, calls } = fakeDownload({ filename: 'after-exhausted.bin', tempPath: temp });

    await onDownload(download);

    const entry = service.getDownloads()[0]!;
    expect(entry.state).toBe('rejected');
    // Cancelled before measurement, so there is no size to report — the renderer uses this to pick
    // the "budget exhausted" reason instead of a size-based one.
    expect(entry.sizeBytes).toBeUndefined();
    expect(entry.savedPath).toBe('');
    expect(calls.cancel).toBe(1);
    expect(calls.saveAs).toEqual([]);
    // Exhaustion short-circuits BEFORE the temp file is even measured.
    expect(calls.path).toBe(0);
    expect(calls.failure).toBe(0);
    expect(await dirEntries()).toEqual([]);
  });

  it('(d) download.failure() non-null is recorded as failed (not rejected, not completed)', async () => {
    const { service, onDownload } = await serviceWithDownloads(downloadsDir);
    const temp = await sparseFile(tempDir, 'net-fail.bin', 1 * MB);
    const { download, calls } = fakeDownload({ filename: 'net-fail.bin', tempPath: temp, failure: 'net::ERR_ABORTED' });

    await onDownload(download);

    const entry = service.getDownloads()[0]!;
    expect(entry.state).toBe('failed');
    expect(calls.saveAs).toEqual([]);
    expect(await dirEntries()).toEqual([]);
  });

  it('(e) the teardown state reset clears the launch budget so a fresh launch downloads again', async () => {
    const { service, onDownload, spent } = await serviceWithDownloads(downloadsDir);
    downloadsPriv(service).downloadedBytes = DOWNLOAD_LAUNCH_MAX_BYTES;

    // Slice 6 folded the four teardown paths into one; cleanup() is now resetState().
    (service as unknown as { resetState: () => void }).resetState();
    expect(spent()).toBe(0);

    // POSITIVE CONTROL: the reset is real — a download that the exhausted budget would have cancelled
    // now completes. The reset also clears downloadsDir (a new launch assigns a new one), so restore it
    // exactly as launchAndAdopt would.
    downloadsPriv(service).downloadsDir = downloadsDir;
    const temp = await sparseFile(tempDir, 'fresh-launch.bin', 2 * MB);
    const { download, calls } = fakeDownload({ filename: 'fresh-launch.bin', tempPath: temp });
    await onDownload(download);

    expect(calls.cancel).toBe(0);
    expect(service.getDownloads()[0]!.state).toBe('completed');
    expect(await dirEntries()).toEqual(['fresh-launch.bin']);
  });

  it('holds the launch cap under CONCURRENT downloads, not just sequential ones', async () => {
    // The budget was read, then awaited across `reserveDownloadPath` and `saveAs`, then written. With
    // per-agent tabs, downloads really do overlap: three 200 MB files each read `downloadedBytes === 0`,
    // each passed the 500 MB check, and 600 MB landed on disk. `reserveDownloadPath` already used
    // claim-then-probe for exactly this reason; the budget did not.
    const { service, onDownload, spent } = await serviceWithDownloads(downloadsDir);
    const temps = await Promise.all([
      sparseFile(tempDir, 'race-a.bin', 90 * MB),
      sparseFile(tempDir, 'race-b.bin', 90 * MB),
      sparseFile(tempDir, 'race-c.bin', 90 * MB),
    ]);
    // 360 MB already spent, so exactly ONE more 90 MB file fits under the 500 MB cap.
    downloadsPriv(service).downloadedBytes = 360 * MB;

    await Promise.all(temps.map((tempPath, i) =>
      onDownload(fakeDownload({ filename: `race-${'abc'[i]}.bin`, tempPath }).download),
    ));

    const states = service.getDownloads().map((d) => d.state);
    expect(states.filter((s) => s === 'completed')).toHaveLength(1);
    expect(states.filter((s) => s === 'rejected')).toHaveLength(2);
    expect(spent()).toBe(450 * MB);
    expect(spent()).toBeLessThanOrEqual(DOWNLOAD_LAUNCH_MAX_BYTES);
    expect(await dirEntries()).toHaveLength(1);
  });

  it('releases the claimed budget when the save itself fails', async () => {
    // Claim-then-release: a claim that is never given back leaks the budget, so a launch that hit a
    // few disk errors would start refusing downloads that fit.
    const { service, onDownload, spent } = await serviceWithDownloads(downloadsDir);
    const temp = await sparseFile(tempDir, 'save-fails.bin', 10 * MB);
    const { download } = fakeDownload({ filename: 'save-fails.bin', tempPath: temp });
    download.saveAs = async () => { throw new Error('EACCES'); };

    await onDownload(download);

    expect(service.getDownloads()[0]!.state).toBe('failed');
    expect(spent()).toBe(0);
  });

  it('rejected entries still flow through the ring buffer and never carry a saved path', async () => {
    const { service, onDownload } = await serviceWithDownloads(downloadsDir);
    const small = await sparseFile(tempDir, 'mix-small.bin', 1 * MB);
    const big = await sparseFile(tempDir, 'mix-big.bin', DOWNLOAD_MAX_BYTES + 1);
    await onDownload(fakeDownload({ filename: 'mix-small.bin', tempPath: small }).download);
    await onDownload(fakeDownload({ filename: 'mix-big.bin', tempPath: big }).download);

    const [ok, refused] = service.getDownloads();
    expect(ok!.state).toBe('completed');
    expect(refused!.state).toBe('rejected');
    expect(refused!.savedPath).toBe('');
    // Only the accepted file is on disk.
    expect(await dirEntries()).toEqual(['mix-small.bin']);
  });
});

describe('Slice 5 — sanitizeDownloadFilename', () => {
  const service = new BrowserService();
  const sanitize = (s: string): string =>
    (service as unknown as { downloadManager: { sanitizeDownloadFilename: (v: string) => string } })
      .downloadManager.sanitizeDownloadFilename(s);

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

  /**
   * Sanitising to something SAFE is not the same as sanitising to what the filesystem will STORE. Two
   * names that differ here but name one file on disk break the no-silent-overwrite guarantee at its
   * root: the reservation set and the `fsp.access` probe both treat them as distinct, so the second
   * download overwrites the first and is still reported as a success.
   */
  it('normalizes trailing dots and spaces, which Win32 strips when opening', () => {
    // `report.txt.` and `report.txt` are the SAME file on Win32.
    expect(sanitize('report.txt.')).toBe('report.txt');
    expect(sanitize('report.txt...')).toBe('report.txt');
    expect(sanitize('report.txt ')).toBe('report.txt');
    expect(sanitize('report.txt . . ')).toBe('report.txt');
    // POSITIVE CONTROL: interior dots and spaces are untouched — this normalizes the tail only.
    expect(sanitize('my report.v1.2.txt')).toBe('my report.v1.2.txt');
  });

  it('strips bidi overrides, so the rendered name matches the name on disk', () => {
    // `\u202Egnp.exe` RENDERS as `exe.png` in BrowserDownloads while an executable lands on disk. A
    // name the user cannot read correctly is a name they cannot judge.
    const disguised = 'invoice\u202Egnp.exe';
    const out = sanitize(disguised);
    expect(out).toBe('invoicegnp.exe');
    for (const ch of ['\u202e', '\u202a', '\u200e', '\u2066', '\ufeff']) expect(out).not.toContain(ch);
  });

  /**
   * Slice 5 — Windows reserved device names. `join(dir, 'CON')` addresses the console DEVICE, not a
   * file, so `saveAs` fails and the download is lost. Neutralised by an underscore prefix (contract §3).
   */
  describe('Windows reserved device names', () => {
    for (const name of ['CON', 'NUL', 'con.txt', 'COM1', 'LPT9', 'aux', 'PRN', 'nul.tar.gz']) {
      it(`neutralizes "${name}" so it addresses a file, not a device`, () => {
        expect(sanitize(name)).toBe(`_${name}`);
      });
    }

    // NEGATIVE CONTROLS. These are NOT Win32 device names, and mangling them would corrupt ordinary
    // downloads — they prove the guard is anchored and digit-exact rather than a loose substring match.
    for (const name of ['COM0', 'LPT10', 'CONSOLE', 'CONS.txt', 'COM10', 'NULL.txt', 'AUXILIARY.zip', 'my-con.txt', 'report.pdf']) {
      it(`leaves "${name}" untouched (not a reserved device name)`, () => {
        expect(sanitize(name)).toBe(name);
      });
    }

    it('the neutralized name is actually writable on disk (the point of the fix)', async () => {
      const dir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-con-'));
      const target = join(dir, sanitize('CON'));
      await fsp.writeFile(target, 'saved');
      expect(await fsp.readFile(target, 'utf8')).toBe('saved');
      expect(await fsp.readdir(dir)).toEqual(['_CON']);
      await fsp.rm(dir, { recursive: true, force: true });
    });

    it('a download suggesting "CON" completes through the REAL handler instead of failing', async () => {
      // End-to-end positive control for the criterion, not just the pure sanitizer.
      const downloadsDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-con-'));
      const tempDir = await fsp.mkdtemp(join(tmpdir(), 'damocles-dl-con-src-'));
      const { service, onDownload } = await serviceWithDownloads(downloadsDir);
      const temp = await sparseFile(tempDir, 'source.bin', 1024);
      await onDownload(fakeDownload({ filename: 'CON', tempPath: temp }).download);

      const entry = service.getDownloads()[0]!;
      expect(entry.state).toBe('completed');
      expect(entry.filename).toBe('_CON');
      expect(await fsp.readdir(downloadsDir)).toEqual(['_CON']);
      await fsp.rm(downloadsDir, { recursive: true, force: true });
      await fsp.rm(tempDir, { recursive: true, force: true });
    });
  });
});

/**
 * Slice 5 — `BrowserDownloads` rendering. A rejected download has nothing on disk, so the renderer
 * must never print a path for it and must explain WHY it was refused (derived at render time from
 * state + size, per the mission decision that no `reason` field is added to `DownloadEntry`).
 */
describe('Slice 5 — BrowserDownloads rendering of rejected entries', () => {
  type ToolLike = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> };

  function downloadsToolFor(entries: unknown[]): ToolLike {
    const scope = { getDownloads: () => entries };
    const tools = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
    return new Map(tools.map((t) => [t.name, t])).get('BrowserDownloads')!;
  }
  const render = async (entries: unknown[]): Promise<string> =>
    (await downloadsToolFor(entries).execute('d', {})).content[0]!.text!;

  it('renders an over-cap rejection with its size and the per-file limit — never a path', async () => {
    const text = await render([
      { filename: 'report.zip', savedPath: '', url: 'http://x/report.zip', state: 'rejected', sizeBytes: 312 * 1024 * 1024 },
    ]);
    expect(text).toContain('report.zip');
    expect(text).toContain('rejected');
    expect(text).toContain('312.0 MB');
    expect(text).toContain('100.0 MB');
    expect(text).toMatch(/per-file/i);
    // No fabricated success and no path — an empty savedPath must not surface as a bare dash-path either.
    expect(text).not.toContain('completed');
    expect(text).not.toMatch(/ — {2}—/);
  });

  it('renders a budget-exhausted rejection (no size) with the launch-budget reason', async () => {
    const text = await render([
      { filename: 'late.bin', savedPath: '', url: 'http://x/late.bin', state: 'rejected' },
    ]);
    expect(text).toContain('late.bin');
    expect(text).toMatch(/budget/i);
    expect(text).toContain('500.0 MB');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
  });

  it('renders a rejection that fits the per-file cap but exceeded the remaining budget distinctly', async () => {
    const text = await render([
      { filename: 'mid.bin', savedPath: '', url: 'http://x/mid.bin', state: 'rejected', sizeBytes: 50 * 1024 * 1024 },
    ]);
    expect(text).toContain('50.0 MB');
    expect(text).toMatch(/remains of the/i);
    expect(text).not.toMatch(/per-file/i);
  });

  it('POSITIVE CONTROL — a completed entry still renders its absolute saved path', async () => {
    const saved = join(tmpdir(), 'dl', 'ok.txt');
    const text = await render([
      { filename: 'ok.txt', savedPath: saved, url: 'http://x/ok.txt', state: 'completed', sizeBytes: 10 },
    ]);
    expect(text).toContain(saved);
    expect(text).toContain('[completed]');
    expect(text).not.toContain('REJECTED');
  });

  it('renders a mixed list without leaking the rejected entry as a success', async () => {
    const saved = join(tmpdir(), 'dl', 'good.txt');
    const text = await render([
      { filename: 'good.txt', savedPath: saved, url: 'http://x/good.txt', state: 'completed', sizeBytes: 10 },
      { filename: 'bad.zip', savedPath: '', url: 'http://x/bad.zip', state: 'rejected', sizeBytes: 200 * 1024 * 1024 },
    ]);
    expect(text).toContain('Recent downloads (2)');
    const badLine = text.split('\n').find((l) => l.includes('bad.zip'))!;
    expect(badLine).toContain('REJECTED');
    expect(badLine).not.toContain('completed');
    // The rejected line carries no filesystem path at all.
    expect(badLine).not.toContain(tmpdir());
  });

  it('a FAILED entry keeps the path it attempted and is labelled failed, not rejected', async () => {
    // Contract §11: a failed save keeps its attempted path (honest — the write was really tried
    // there), but must never be dressed up as a success or confused with a refusal. This is the third
    // state, completing the completed/rejected/failed triangle.
    const attempted = join(tmpdir(), 'dl', 'half-written.bin');
    const text = await render([
      { filename: 'half-written.bin', savedPath: attempted, url: 'http://x/half.bin', state: 'failed' },
    ]);
    expect(text).toContain('[failed]');
    expect(text).toContain(attempted);
    expect(text).not.toContain('REJECTED');
    expect(text).not.toContain('[completed]');
  });

  it('the tool description states that oversized downloads are refused, not saved', async () => {
    const tool = downloadsToolFor([]) as unknown as { description: string };
    expect(tool.description).toMatch(/refused|rejected/i);
    expect(tool.description).toContain('100 MB');
    expect(tool.description).toContain('500 MB');
  });
});

describe('Slice 5 — download filename collisions', () => {
  const reserve = (service: unknown, dir: string, name: string) =>
    (service as { downloadManager: { reserveDownloadPath: (d: string, n: string) => Promise<{ path: string; filename: string }> } })
      .downloadManager.reserveDownloadPath(dir, name);

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
