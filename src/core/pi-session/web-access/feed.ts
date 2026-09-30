/**
 * RSS 2.0 + Atom feed reading for the `FeedRead` tool. SSRF-guarded fetch (`safeFetch`) → decode to text
 * (honoring a declared charset) → parse with linkedom's XML `DOMParser` → return the latest items
 * (title, link, date, summary).
 *
 * We use linkedom's `DOMParser` (`text/xml`), NOT `parseHTML`: HTML parsing treats `<link>` as a void
 * element and drops the RSS link text (`<link>https://…</link>`), so an HTML parse loses every RSS item
 * link. The XML parser preserves element text and namespaced tags (`content:encoded`, `dc:date`). This
 * is the same `linkedom` dependency `extract.ts` already uses — no new package.
 *
 * Fail-soft: every error becomes a `FeedResult.error`; the tool layer turns it into a text result and
 * never throws a turn.
 */

import { DOMParser } from 'linkedom';
import { safeFetch, readBodyCapped } from './safe-fetch';
import { withTimeout, errorMessage } from './util';

const FEED_TIMEOUT_MS = 30_000;
const FEED_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Max characters kept from an item summary — enough to be useful, small enough to keep results tidy. */
const SUMMARY_CAP = 600;

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

export interface FeedItem {
  title: string;
  link: string;
  /** ISO-normalized publish/updated date, or the raw string when unparseable, or '' when absent. */
  published: string;
  summary: string;
}

export interface FeedResult {
  title: string;
  items: FeedItem[];
  /** Set when a declared charset couldn't be decoded (fell back to UTF-8) or another soft caveat applies. */
  note?: string;
  error?: string;
}

/** Minimal structural view of the linkedom element surface we use (keeps this module strict-typed). */
interface FeedEl {
  nodeName: string;
  textContent: string | null;
  children: Iterable<FeedEl>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FeedEl | null;
  querySelectorAll(selector: string): Iterable<FeedEl>;
}

/** The local (post-colon) part of a possibly namespaced tag name, lowercased. */
function localName(nodeName: string): string {
  const lower = nodeName.toLowerCase();
  const colon = lower.indexOf(':');
  return colon >= 0 ? lower.slice(colon + 1) : lower;
}

/**
 * First DIRECT child of `parent` matching any of `names` (matched against both the full tag name and its
 * local name, so `content:encoded` matches `['content:encoded','encoded']`). Direct-child scanning
 * avoids picking a same-named element nested inside another item/entry.
 */
function childByNames(parent: FeedEl, names: readonly string[]): FeedEl | null {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const child of parent.children) {
    const nn = child.nodeName.toLowerCase();
    if (wanted.has(nn) || wanted.has(localName(nn))) return child;
  }
  return null;
}

/** All direct children of `parent` whose (full or local) name matches any of `names`. */
function childrenByNames(parent: FeedEl, names: readonly string[]): FeedEl[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out: FeedEl[] = [];
  for (const child of parent.children) {
    const nn = child.nodeName.toLowerCase();
    if (wanted.has(nn) || wanted.has(localName(nn))) out.push(child);
  }
  return out;
}

function textOf(parent: FeedEl, names: readonly string[]): string {
  return childByNames(parent, names)?.textContent?.trim() ?? '';
}

/** Strip tags/entities from an HTML-bearing summary and collapse whitespace, capped to `SUMMARY_CAP`. */
function stripHtml(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SUMMARY_CAP ? `${text.slice(0, SUMMARY_CAP).trimEnd()}…` : text;
}

/** Normalize a feed date string to ISO; return the raw string when it isn't a parseable date. */
function normalizeDate(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

/** Pick an Atom entry's alternate link: prefer `rel="alternate"`, then a link with no `rel`, else first. */
function atomLink(entry: FeedEl): string {
  const links = childrenByNames(entry, ['link']);
  if (links.length === 0) return '';
  const alternate = links.find((l) => l.getAttribute('rel') === 'alternate');
  if (alternate) return alternate.getAttribute('href')?.trim() ?? '';
  const noRel = links.find((l) => !l.getAttribute('rel'));
  if (noRel) return noRel.getAttribute('href')?.trim() ?? '';
  return links[0]!.getAttribute('href')?.trim() ?? '';
}

function parseRssItem(item: FeedEl): FeedItem {
  return {
    title: textOf(item, ['title']),
    link: textOf(item, ['link']) || childByNames(item, ['guid'])?.textContent?.trim() || '',
    published: normalizeDate(textOf(item, ['pubdate', 'date', 'dc:date', 'published', 'updated'])),
    summary: stripHtml(textOf(item, ['description', 'content:encoded', 'summary', 'content'])),
  };
}

function parseAtomEntry(entry: FeedEl): FeedItem {
  return {
    title: textOf(entry, ['title']),
    link: atomLink(entry),
    published: normalizeDate(textOf(entry, ['published', 'updated', 'dc:date', 'date'])),
    summary: stripHtml(textOf(entry, ['summary', 'content'])),
  };
}

/** A declared charset that is already UTF-8/ASCII — decoding as UTF-8 is exact, no re-decode needed. */
function isUtf8Alias(charset: string): boolean {
  return charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii';
}

/**
 * Decode feed bytes honoring the charset declared in the XML prolog. The prolog is ASCII, so it is
 * always recoverable from a provisional UTF-8 decode regardless of the body's real encoding. When a
 * non-UTF-8 charset is declared (e.g. `windows-1252`, `iso-8859-1`), we re-decode with a `TextDecoder`
 * for that label — natively supported for the WHATWG legacy encodings — instead of returning mojibake.
 * Returns the decoded text plus an optional soft note when a declared charset couldn't be honored.
 */
function decodeFeed(bytes: Uint8Array): { xml: string; note?: string } {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const declared = utf8.slice(0, 200).match(/<\?xml[^>]*\bencoding=["']([^"']+)["']/i)?.[1]?.toLowerCase();
  if (!declared || isUtf8Alias(declared)) return { xml: utf8 };
  try {
    // `fatal:false` (default) never throws; an unknown label makes the TextDecoder ctor throw instead.
    return { xml: new TextDecoder(declared).decode(bytes) };
  } catch {
    return {
      xml: utf8,
      note: `Feed declared charset "${declared}", which isn't supported here; decoded as UTF-8, so non-ASCII characters may be garbled.`,
    };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Fetch and parse an RSS 2.0 or Atom feed, returning up to `limit` latest items. SSRF-guarded; decodes
 * UTF-8 (noting any declared non-UTF-8 charset). Never throws — failures come back as `FeedResult.error`.
 */
export async function fetchFeed(url: string, signal?: AbortSignal, limit?: number): Promise<FeedResult> {
  const max = clampLimit(limit);
  const empty = (error: string): FeedResult => ({ title: '', items: [], error });

  if (signal?.aborted) return empty('Aborted');
  try {
    new URL(url);
  } catch {
    return empty('Invalid URL');
  }

  try {
    return await withTimeout(FEED_TIMEOUT_MS, signal, async (fetchSignal) => {
      const response = await safeFetch(url, {
        signal: fetchSignal,
        headers: { Accept: FEED_ACCEPT, 'User-Agent': 'Mozilla/5.0 (compatible; DamoclesFeedReader/1.0)' },
      });
      if (!response.ok) return empty(`HTTP ${response.status}: ${response.statusText}`);

      const bytes = await readBodyCapped(response, FEED_MAX_RESPONSE_BYTES);
      const { xml, note } = decodeFeed(bytes);

      let doc: FeedEl;
      try {
        doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as FeedEl;
      } catch (err) {
        return empty(`Feed parse failed: ${errorMessage(err)}`);
      }

      const rss = doc.querySelector('rss');
      const atom = doc.querySelector('feed');

      if (rss) {
        const channel = rss.querySelector('channel') ?? rss;
        const feedTitle = textOf(channel as FeedEl, ['title']);
        const items = [...doc.querySelectorAll('item')].slice(0, max).map((i) => parseRssItem(i as FeedEl));
        if (items.length === 0) return { title: feedTitle, items: [], ...(note ? { note } : {}), error: 'No items found in feed' };
        return { title: feedTitle, items, ...(note ? { note } : {}) };
      }

      if (atom) {
        const feedTitle = textOf(atom as FeedEl, ['title']);
        const items = [...doc.querySelectorAll('entry')].slice(0, max).map((e) => parseAtomEntry(e as FeedEl));
        if (items.length === 0) return { title: feedTitle, items: [], ...(note ? { note } : {}), error: 'No entries found in feed' };
        return { title: feedTitle, items, ...(note ? { note } : {}) };
      }

      return empty('Not a recognized RSS 2.0 or Atom feed');
    });
  } catch (err) {
    const message = errorMessage(err);
    return empty(message.toLowerCase().includes('abort') ? 'Aborted' : message);
  }
}
