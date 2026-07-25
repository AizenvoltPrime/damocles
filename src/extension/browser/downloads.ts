import { promises as fsp } from 'fs';
import { join } from 'path';
import type { Download } from 'patchright';
import { log } from '../logger';
import { DAMOCLES_BROWSER_DOWNLOADS_DIR } from '../paths';
import type { DownloadEntry } from '../../shared/types/browser';

/** Keep only the most-recent N per-launch download dirs to bound cross-launch on-disk growth. */
const DOWNLOAD_DIR_RETENTION = 10;

// Ring-buffer cap for captured downloads. Bounded so a long session that downloads many files never
// grows the in-memory list unbounded; the oldest entry is dropped once the cap is exceeded.
const DOWNLOADS_MAX = 50;

/** Largest single download that may be saved. */
export const DOWNLOAD_MAX_BYTES: number = 100 * 1024 * 1024;
/** Total bytes all downloads may save in one browser launch, after which new downloads are cancelled. */
export const DOWNLOAD_LAUNCH_MAX_BYTES: number = 500 * 1024 * 1024;

/** Win32 device names, reserved as the basename before the extension. `COM0`/`LPT10`/`CONSOLE` are not. */
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/**
 * Owns everything about captured downloads: the per-launch directory, the bounded capture list, the
 * reserved-path set and the per-launch byte budget.
 *
 * INVARIANT INHERITED FROM `BrowserService`, stated so the extraction does not quietly lose it:
 * {@link DownloadManager.prepareLaunchDir} is NOT internally concurrency-safe (it awaits before
 * assigning `downloadsDir`). It is safe today only because its sole caller, `ensureUserDataDir`, runs
 * inside the serialized `openChain` via `ensureContextInternal`. Calling it from an unserialized path
 * would race two launches onto one directory assignment.
 */
export class DownloadManager {
  private downloadsDir: string | null = null;
  private downloads: DownloadEntry[] = [];
  // Saved download paths reserved this launch, so concurrent same-name downloads never collide on disk.
  private takenDownloadPaths = new Set<string>();
  // Bytes saved this launch, measured against DOWNLOAD_LAUNCH_MAX_BYTES. Reset in reset().
  private downloadedBytes = 0;

  /** A copy of the captured-downloads ring buffer (newest last). */
  list(): DownloadEntry[] {
    return [...this.downloads];
  }

  /**
   * Create this launch's downloads directory, pruning stale sibling launch dirs first (so the new one
   * is never a prune target). See the class doc: relies on its caller's serialization.
   */
  async prepareLaunchDir(): Promise<void> {
    // Deviation from the plan's <sessionId> downloads subdir (open question #8): BrowserService is a
    // panel-level singleton constructed with NO pi sessionId, so a per-launch id is used instead.
    // ensureUserDataDir already runs once per launch (userDataDir nulled in cleanup), so this isolates
    // each launch's downloads without threading pi's sessionId into the browser singleton — equivalent
    // isolation for the agent, and the ONLY id available at this layer.
    // Bound cross-launch disk growth: cleanup() only nulls the ref, so without this each launch's dir
    // would accumulate forever. Prune stale sibling launch dirs BEFORE creating this launch's (so the
    // new one is never a prune target). Best-effort — never blocks a launch.
    await this.pruneOldDownloadDirs();
    const launchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const downloadsDir = join(DAMOCLES_BROWSER_DOWNLOADS_DIR, launchId);
    await fsp.mkdir(downloadsDir, { recursive: true });
    this.downloadsDir = downloadsDir;
  }

  /**
   * Reserve `size` against this launch's budget, returning whether it fit. SYNCHRONOUS by contract:
   * the check and the deduction must not be separated by an await, or two concurrent downloads both
   * measure against the pre-claim total and the cap is enforced per-download instead of per-launch.
   */
  private claimBudget(size: number): boolean {
    if (this.downloadedBytes + size > DOWNLOAD_LAUNCH_MAX_BYTES) return false;
    this.downloadedBytes += size;
    return true;
  }

  /** Drop this launch's directory, capture list, reservations and byte budget. */
  reset(): void {
    this.downloads = [];
    this.takenDownloadPaths.clear();
    this.downloadedBytes = 0;
    this.downloadsDir = null;
  }

  /**
   * Keep only the most-recent {@link DOWNLOAD_DIR_RETENTION} per-launch download dirs, deleting older
   * ones by modification time. Fully fail-soft: a missing parent (first launch) or any I/O error is
   * logged and swallowed so pruning never blocks or fails a launch.
   */
  private async pruneOldDownloadDirs(): Promise<void> {
    try {
      const entries = await fsp.readdir(DAMOCLES_BROWSER_DOWNLOADS_DIR, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length <= DOWNLOAD_DIR_RETENTION) return;
      const withMtime = await Promise.all(
        dirs.map(async (d) => {
          const full = join(DAMOCLES_BROWSER_DOWNLOADS_DIR, d.name);
          try {
            return { full, mtime: (await fsp.stat(full)).mtimeMs };
          } catch {
            return { full, mtime: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const stale = withMtime.slice(DOWNLOAD_DIR_RETENTION);
      await Promise.all(stale.map((s) => fsp.rm(s.full, { recursive: true, force: true }).catch(() => {})));
    } catch (err) {
      log(`[Browser] Download-dir prune skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Reduce an untrusted suggested filename to a bare, path-safe basename: strip any directory
  // separators (so a download cannot escape the downloads dir) and control characters, and fall back
  // to 'download' when nothing usable remains.
  //
  // NORMALIZED TO WHAT THE FILESYSTEM WILL ACTUALLY STORE, not merely to something safe to pass to
  // join(). Two names that differ here but name the SAME file on disk break the no-silent-overwrite
  // guarantee at its root: the reservation set and the existence probe both treat them as distinct, so
  // the second download overwrites the first and is still reported as a success. Win32 strips trailing
  // dots and spaces, so `report.txt.` IS `report.txt` — hence the trailing-dot strip below.
  private sanitizeDownloadFilename(suggested: string): string {
    const cleaned = (suggested || '')
      .replace(/[/\\]/g, '_') // path separators (traversal)
      .replace(/:/g, '_') // Windows drive / NTFS alternate-data-stream colon
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '') // control chars
      // Bidi overrides and other invisible formatting: `\u202Egnp.exe` RENDERS as `exe.png` in the
      // downloads list while an executable lands on disk. A filename the user cannot read correctly is
      // a filename they cannot judge, so the characters that cause it are removed rather than escaped.
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
      .trim()
      // Trailing dots and spaces: Win32 silently strips them when opening, so keeping them would let
      // two reservations name one file. Stripped AFTER trim so `"a. . ."` collapses fully.
      .replace(/[. ]+$/, '');
    // A name that is only dots resolves to the current/parent directory under join() — never a file.
    if (cleaned === '' || /^\.+$/.test(cleaned)) return 'download';
    // A Windows reserved device name resolves to the DEVICE, not a file, so join(dir, 'CON') opens the
    // console and the save fails. Matched on the basename before the extension, per Win32 rules.
    if (WINDOWS_RESERVED_DEVICE_NAME.test(cleaned)) return `_${cleaned}`;
    return cleaned;
  }

  // Reserve a collision-free path under `dir` for a sanitized filename. A second download with the same
  // name gets `name (1).ext`, `name (2).ext`, ... — never a silent overwrite. The claim is made BEFORE
  // the disk probe: with per-agent tabs two scopes really can download the same name at once, and a
  // check-then-await-then-claim would let both pass the Set check and reserve the same path. A candidate
  // that turns out to exist on disk stays claimed (it is taken either way) and the loop moves on.
  private async reserveDownloadPath(dir: string, filename: string): Promise<{ path: string; filename: string }> {
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 0; ; i++) {
      const name = i === 0 ? filename : `${base} (${i})${ext}`;
      const full = join(dir, name);
      if (this.takenDownloadPaths.has(full)) continue;
      this.takenDownloadPaths.add(full);
      try {
        await fsp.access(full);
        continue; // exists on disk — keep it claimed and try the next suffix
      } catch {
        return { path: full, filename: name };
      }
    }
  }

  // Download capture. acceptDownloads is set on the context (launcher), so every download resolves
  // to a Playwright Download we can persist. Save under the per-launch downloads dir with a sanitized
  // filename, then record a bounded ring-buffer entry. NEVER log file contents — only the metadata.
  // HONEST LIMITATION of the size caps below: page.on('download') fires at download START, by which
  // point Playwright has already begun streaming the bytes into its OWN temp file. Download exposes
  // only cancel/failure/path/delete/saveAs, so the caps are enforced by stat-ing that temp file and
  // delete()ing it instead of copying. That bounds OUR downloads directory absolutely and evicts a
  // hostile temp file promptly, but it CANNOT prevent Chromium writing one over-cap temp file first.
  async handleDownload(download: Download): Promise<void> {
    const dir = this.downloadsDir;
    if (!dir) return;
    const url = download.url();
    const record = (entry: DownloadEntry): void => {
      this.downloads.push(entry);
      if (this.downloads.length > DOWNLOADS_MAX) this.downloads.shift();
    };
    const filename = this.sanitizeDownloadFilename(download.suggestedFilename());
    let attemptedPath = '';
    try {
      if (this.downloadedBytes >= DOWNLOAD_LAUNCH_MAX_BYTES) {
        await download.cancel();
        record({ filename, savedPath: '', url, state: 'rejected' });
        return;
      }
      const failure = await download.failure();
      if (failure !== null) {
        log(`[Browser] Download failed — ${failure}`);
        record({ filename, savedPath: '', url, state: 'failed' });
        return;
      }
      const size = (await fsp.stat(await download.path())).size;
      if (size > DOWNLOAD_MAX_BYTES) {
        await download.delete();
        record({ filename, savedPath: '', url, state: 'rejected', sizeBytes: size });
        return;
      }
      // CLAIM THE BUDGET SYNCHRONOUSLY, then release it if the save fails — the same claim-then-probe
      // shape reserveDownloadPath uses, and for the same reason. Comparing against `downloadedBytes`
      // and adding to it after `saveAs` is a read-modify-write straddling two awaits: with per-agent
      // tabs, concurrent downloads really do overlap, and three 200 MB downloads each read 0 and each
      // passed a 500 MB cap. Claiming first means the second one sees the first one's bytes.
      if (!this.claimBudget(size)) {
        await download.delete();
        record({ filename, savedPath: '', url, state: 'rejected', sizeBytes: size });
        return;
      }
      try {
        // Two downloads with the same suggested name must not silently overwrite each other; reserve a
        // unique path (`name (1).ext`, `name (2).ext`, ...) before saving.
        const reserved = await this.reserveDownloadPath(dir, filename);
        attemptedPath = reserved.path;
        await download.saveAs(reserved.path);
        record({ filename: reserved.filename, savedPath: reserved.path, url, state: 'completed', sizeBytes: size });
      } catch (err) {
        this.downloadedBytes -= size;
        throw err;
      }
    } catch (err) {
      log(`[Browser] Download save failed — ${err instanceof Error ? err.message : String(err)}`);
      record({ filename, savedPath: attemptedPath, url, state: 'failed' });
    }
  }
}
