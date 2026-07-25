import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import * as vscode from 'vscode';
import type { Page } from 'patchright';
import { isBlockedFaviconHost } from './net-guard';
import { log } from '../logger';

// Collects favicon candidate URLs from the page. This is a pure DOM read (no fetch): downloading
// in the page context is governed by the page's CSP connect-src, which on strict sites blocks
// script-initiated fetches of icon URLs even though the browser itself may load them, so the actual
// download happens extension side. Waits for DOMContentLoaded first because callers evaluate this
// right after navigation commit, before <head> is parsed; if the scan finds no declared links it
// retries once after the window load event, covering SPAs that inject the icon link late. Returns a
// JSON array of absolute URLs, declared icons first (largest sizes first), always ending with the
// /favicon.ico fallback.
//
// THE IN-PAGE TIMERS BOUND THE SCAN, NOT THE CALL. Both waits resolve on a timer the PAGE's event loop
// owns, so a page that blocks its main thread resolves neither. `page.evaluate` has no timeout of its
// own, so the host-side bound lives at the call site (`FAVICON_SCAN_TIMEOUT_MS`) — without it the
// promise dangles for the life of the page, once per navigation.
const GET_FAVICON_CANDIDATES_EXPR = `(async () => {
  const scan = () => Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'))
    .map((l) => {
      const sizes = (l.getAttribute('sizes') || '').split('x')[0];
      return { href: l.href, size: parseInt(sizes, 10) || 0 };
    })
    .filter((c) => c.href)
    .sort((a, b) => b.size - a.size)
    .map((c) => c.href);
  if (document.readyState === 'loading') {
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  let candidates = scan();
  if (candidates.length === 0 && document.readyState !== 'complete') {
    await new Promise((r) => {
      const timer = setTimeout(r, 8000);
      window.addEventListener('load', () => { clearTimeout(timer); r(); }, { once: true });
    });
    candidates = scan();
  }
  candidates.push(new URL('/favicon.ico', location.origin).href);
  return JSON.stringify(candidates);
})()`;

const FAVICON_MAX_BYTES = 512 * 1024;
const FAVICON_CACHE_MAX_FILES = 256;

/** Host-side bound on the in-page candidate scan. Comfortably above the script's own 8s load wait, so
 *  it only fires when the page never resolves at all. */
const FAVICON_SCAN_TIMEOUT_MS = 10_000;

/** Reject `work` if it has not settled within `ms`. A tab icon is cosmetic, so an unbounded wait on a
 *  page that never resolves is pure leak — the rejection routes into the existing keep-the-old-icon
 *  handler. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Favicon scan exceeded ${ms}ms`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}

const FAVICON_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

/**
 * The slice of a `PageEntry` favicon resolution reads. Structural rather than the full entry so this
 * module stays independent of the page registry: it needs the page to scan and the per-entry token
 * that supersedes a slow resolution.
 */
export interface FaviconTarget {
  controller: { getPage(): Page };
  faviconToken: number;
}

/**
 * Resolves a page's favicon and hands the cached file path to `applyIcon`: candidate URLs come from
 * a page-context DOM scan, the bytes are downloaded extension side (immune to the page's CSP
 * connect-src), and cached to a local file (VS Code tab icons require a file path, not a URL). A
 * per-entry token guards against a slow resolution from a superseded same-page navigation
 * overwriting a newer one.
 *
 * Applying the icon to a tab stays with the caller (this module never touches a panel), so the only
 * thing it hands back is a file path.
 */
export function resolveFavicon(
  cacheDir: string,
  entry: FaviconTarget,
  applyIcon: (icon: vscode.Uri | undefined) => void,
): void {
  const token = ++entry.faviconToken;
  // DOM-only read → Patchright's ISOLATED world via page.evaluate; the value comes back DIRECTLY.
  withTimeout(entry.controller.getPage().evaluate(GET_FAVICON_CANDIDATES_EXPR), FAVICON_SCAN_TIMEOUT_MS)
    .then(async (result) => {
      if (token !== entry.faviconToken) return;
      const raw = typeof result === 'string' ? result : '[]';
      let candidates: string[];
      try {
        const parsed = JSON.parse(raw) as unknown;
        candidates = Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
      } catch {
        candidates = [];
      }
      for (const href of candidates) {
        if (token !== entry.faviconToken) return;
        const icon = await downloadFavicon(href);
        if (!icon) continue;
        const name = createHash('sha1').update(icon.bytes).digest('hex').slice(0, 16);
        const filePath = join(cacheDir, `${name}.${icon.ext}`);
        try {
          await fsp.writeFile(filePath, icon.bytes);
        } catch (err) {
          log(`[Browser] Favicon cache write failed — ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        pruneIconCache(cacheDir);
        if (token !== entry.faviconToken) return;
        applyIcon(vscode.Uri.file(filePath));
        return;
      }
      if (token === entry.faviconToken) applyIcon(undefined);
    })
    .catch(() => { /* page closed or eval blocked; keep the previous icon */ });
}

// Downloads one favicon candidate from the extension host. Returns null on any failure so the
// caller can try the next candidate. Sniffs ICO/PNG signatures when the server omits or mislabels
// the content type (common for /favicon.ico served as application/octet-stream or text/plain).
//
// The chosen extension follows the SERVER's content type (falling back to a signature sniff), so a
// server can name the cached file's extension. Harmless today — the path is only ever handed to VS
// Code as a tab icon, which does not execute SVG script — but it is server-controlled input.
async function downloadFavicon(href: string): Promise<{ bytes: Buffer; ext: string } | null> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // SSRF guard: the candidate URLs come from an untrusted page's DOM, so refuse hosts that resolve
  // to loopback/link-local/private ranges before issuing the extension-host GET. `redirect: 'error'`
  // closes the redirect bypass — only the validated host is ever contacted, so a 3xx to
  // 169.254.169.254/localhost can't slip past the guard. A favicon served via redirect just won't show.
  if (await isBlockedFaviconHost(url.hostname)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) return null;
    const declaredType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    // `Object.hasOwn` before the lookup: `declaredType` is server-controlled, so a content type of
    // `__proto__` or `constructor` otherwise resolves to an inherited Object.prototype member and
    // becomes the file extension — a junk filename built from a prototype property.
    let ext = Object.hasOwn(FAVICON_EXTENSIONS, declaredType) ? FAVICON_EXTENSIONS[declaredType] : undefined;
    if (!ext) {
      if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) ext = 'png';
      else if (bytes.length >= 4 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1) ext = 'ico';
      else if (bytes.length >= 5 && bytes.toString('ascii', 0, 5).toLowerCase() === '<svg ') ext = 'svg';
      else return null;
    }
    return { bytes, ext };
  } catch {
    return null;
  }
}

// Content-addressed favicon files accumulate one per distinct icon across every site visited. Cap
// the directory at a bounded size, deleting the oldest files by mtime. Best-effort: cache-only data,
// so any IO error is swallowed.
//
// Prunes from concurrent tabs are not coordinated, so a prune can delete a file another resolution
// has just written and is about to apply. The result is a missing tab icon until the next
// navigation, never a wrong one — the paths are content-addressed.
function pruneIconCache(dir: string): void {
  void (async () => {
    try {
      const names = await fsp.readdir(dir);
      if (names.length <= FAVICON_CACHE_MAX_FILES) return;
      const stats = await Promise.all(
        names.map(async (name) => {
          const full = join(dir, name);
          const st = await fsp.stat(full);
          return { full, mtime: st.mtimeMs };
        }),
      );
      stats.sort((a, b) => a.mtime - b.mtime);
      const toDelete = stats.slice(0, stats.length - FAVICON_CACHE_MAX_FILES);
      await Promise.all(toDelete.map((f) => fsp.rm(f.full, { force: true })));
    } catch (err) {
      log(`[Browser] Favicon cache prune failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
