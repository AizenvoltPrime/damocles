/**
 * Best-effort, dependency-free YouTube transcript retrieval for the `YouTubeTranscript` tool. No
 * `yt-dlp`, `ffmpeg`, audio download, or API key: everything is one of two fixed `youtube.com` endpoints
 * (SSRF-guarded via `safeFetch`).
 *
 * Flow (all youtube.com):
 *  1. Fetch the public watch page; extract `INNERTUBE_API_KEY` (from `ytcfg`) and `ytInitialPlayerResponse`.
 *  2. Get caption tracks via the ANDROID InnerTube `player` endpoint. YouTube's WEB caption `baseUrl`s now
 *     require a Proof-of-Origin token and return an EMPTY body to a plain server-side fetch; the ANDROID
 *     client is exempt, so its `baseUrl`s work without executing YouTube's obfuscated JS. The watch-page
 *     `ytInitialPlayerResponse` tracks are a fallback when the InnerTube call fails.
 *  3. Fetch the chosen track with `&fmt=json3` (structured JSON) and parse `events[].segs[].utf8`; if that
 *     is empty, retry the raw `baseUrl` and parse the timed-text XML (legacy `<text>` or srv3 `<p>/<s>`).
 *
 * Inherently brittle — an undocumented internal API that YouTube can block or change — so every failure is
 * fail-soft with a DISTINCT diagnostic, letting the agent fall back to `WebFetch`/`WebSearch`. Never throws.
 */

import { safeFetch, readBodyCapped } from './safe-fetch';
import { withTimeout, errorMessage } from './util';

const YT_TIMEOUT_MS = 30_000;
const WATCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const TIMEDTEXT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const INNERTUBE_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** A recent ANDROID YouTube app client — the InnerTube identity that is exempt from the POT requirement. */
const ANDROID_CLIENT_NAME = 'ANDROID';
const ANDROID_CLIENT_VERSION = '20.10.38';

/** Browser-like headers for the watch page — a bare fetch is more likely to be served a blocking interstitial. */
const YT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** Headers identifying the request as the ANDROID YouTube app, required for the POT-exempt InnerTube path. */
const ANDROID_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14) gzip`,
  'X-YouTube-Client-Name': '3',
  'X-YouTube-Client-Version': ANDROID_CLIENT_VERSION,
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface TranscriptResult {
  videoId: string;
  title?: string;
  lang?: string;
  text: string;
  error?: string;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

/**
 * Extract an 11-character YouTube video id from a watch URL, a `youtu.be/<id>`, `/shorts/<id>`,
 * `/embed/<id>`, or `/v/<id>` URL, or a bare id. Accepts the `youtube-nocookie.com` privacy-embed host.
 * Returns null when no id can be parsed.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  const idPattern = /^[A-Za-z0-9_-]{11}$/;
  if (idPattern.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && idPattern.test(id) ? id : null;
  }
  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    const v = url.searchParams.get('v');
    if (v && idPattern.test(v)) return v;
    const segments = url.pathname.split('/').filter(Boolean);
    // /shorts/<id>, /embed/<id>, /v/<id>, /live/<id>
    if (segments.length >= 2 && ['shorts', 'embed', 'v', 'live'].includes(segments[0]!.toLowerCase())) {
      const id = segments[1]!;
      return idPattern.test(id) ? id : null;
    }
  }
  return null;
}

/**
 * Slice `ytInitialPlayerResponse` from the watch-page HTML and JSON-parse it. The assignment is followed
 * by a balanced JSON object; we scan for the matching close brace (respecting strings/escapes) rather
 * than a greedy regex, so nested braces in the payload don't truncate it. Returns null when absent.
 */
function extractPlayerResponse(html: string): Record<string, unknown> | null {
  const marker = 'ytInitialPlayerResponse';
  const assignIdx = html.indexOf(marker);
  if (assignIdx < 0) return null;
  const braceStart = html.indexOf('{', assignIdx);
  if (braceStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const json = html.slice(braceStart, i + 1);
        try {
          return JSON.parse(json) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function getCaptionTracks(player: Record<string, unknown>): CaptionTrack[] {
  const captions = player['captions'] as Record<string, unknown> | undefined;
  const renderer = captions?.['playerCaptionsTracklistRenderer'] as Record<string, unknown> | undefined;
  const tracks = renderer?.['captionTracks'];
  return Array.isArray(tracks) ? (tracks as CaptionTrack[]) : [];
}

function getVideoTitle(player: Record<string, unknown>): string | undefined {
  const details = player['videoDetails'] as Record<string, unknown> | undefined;
  const title = details?.['title'];
  return typeof title === 'string' ? title : undefined;
}

/**
 * Choose a caption track: an exact requested-`lang` match wins; otherwise prefer a human-authored track
 * (`kind !== 'asr'`) over the auto-generated ASR track for best transcript quality; else the first track.
 */
function chooseTrack(tracks: CaptionTrack[], lang?: string): CaptionTrack | null {
  if (tracks.length === 0) return null;
  if (lang) {
    const exact = tracks.find((t) => t.languageCode?.toLowerCase() === lang.toLowerCase());
    if (exact) return exact;
  }
  const human = tracks.find((t) => t.kind !== 'asr');
  if (human) return human;
  return tracks[0]!;
}

/** A Unicode scalar value (`String.fromCodePoint` throws RangeError outside this range). */
function codePointToChar(n: number, rawEntity: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : rawEntity;
}

/** Decode the XML/HTML entities that appear in timedtext node bodies. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, code: string) => codePointToChar(Number(code), m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, code: string) => codePointToChar(parseInt(code, 16), m));
}

interface Json3Seg {
  utf8?: string;
}
interface Json3Event {
  segs?: Json3Seg[];
}

/**
 * Parse the `fmt=json3` caption payload: each `events[]` with a `segs[]` is one cue; concatenate its
 * `utf8` segments. Events without `segs` (timing/style markers) are skipped. Returns '' on any shape miss.
 */
function parseJson3(body: string): string {
  let data: { events?: Json3Event[] };
  try {
    data = JSON.parse(body) as { events?: Json3Event[] };
  } catch {
    return '';
  }
  if (!Array.isArray(data.events)) return '';
  const lines: string[] = [];
  for (const event of data.events) {
    if (!Array.isArray(event.segs)) continue;
    const line = event.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Parse timed-text XML into plain text. Handles both the legacy transcript format (`<text …>body</text>`)
 * and the srv3/TTML format (`<p …>…<s>seg</s>…</p>`, where segment text may sit in `<s>` children or as
 * `<p>` inner text). Cue bodies are entity-decoded (twice — timedtext double-encodes, e.g. `&amp;#39;`).
 */
function parseTimedText(xml: string): string {
  const lines: string[] = [];

  const textRegex = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const decoded = decodeEntities(decodeEntities(match[1] ?? '')).replace(/\s+/g, ' ').trim();
    if (decoded) lines.push(decoded);
  }
  if (lines.length > 0) return lines.join('\n');

  // srv3/TTML: <p> cues, each with optional <s> segments. Strip inner tags, then decode.
  const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
  while ((match = pRegex.exec(xml)) !== null) {
    const inner = (match[1] ?? '').replace(/<[^>]+>/g, '');
    const decoded = decodeEntities(decodeEntities(inner)).replace(/\s+/g, ' ').trim();
    if (decoded) lines.push(decoded);
  }
  return lines.join('\n');
}

/** Extract the InnerTube API key embedded in the watch page (`"INNERTUBE_API_KEY":"AIza…"`). */
function extractInnertubeApiKey(html: string): string | null {
  return html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
}
/** Set a query param on a timedtext URL, replacing any existing value (used to force `fmt=json3`). */
function withParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Fetch caption tracks via the POST-based ANDROID InnerTube `player` endpoint. YouTube's WEB caption
 * `baseUrl`s now return an empty body without a Proof-of-Origin token; the ANDROID client is exempt, so
 * its `baseUrl`s are fetchable server-side. Returns [] on any failure so the caller falls back to the
 * watch-page tracks. Only youtube.com is contacted (SSRF-guarded).
 */
async function fetchAndroidCaptionTracks(
  videoId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<CaptionTrack[]> {
  const url = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
  const bodyJson = JSON.stringify({
    context: { client: { clientName: ANDROID_CLIENT_NAME, clientVersion: ANDROID_CLIENT_VERSION, hl: 'en', gl: 'US' } },
    videoId,
  });
  try {
    const res = await safeFetch(url, { method: 'POST', signal, headers: ANDROID_HEADERS, body: bodyJson });
    if (!res.ok) return [];
    const text = new TextDecoder().decode(await readBodyCapped(res, INNERTUBE_MAX_RESPONSE_BYTES));
    const player = JSON.parse(text) as Record<string, unknown>;
    return getCaptionTracks(player);
  } catch {
    return [];
  }
}

/**
 * Fetch a caption track and parse it to plain text. Tries `fmt=json3` (structured, most reliable) first,
 * then falls back to the raw `baseUrl` (legacy `<text>` or srv3 `<p>/<s>` XML). Returns '' when the track
 * is genuinely empty/blocked (server returns 200 with an empty body when a POT is required). Throws only
 * on a transport error the caller turns into a distinct diagnostic.
 */
async function fetchTrackText(baseUrl: string, signal: AbortSignal): Promise<string> {
  const jsonUrl = withParam(baseUrl, 'fmt', 'json3');
  const jsonRes = await safeFetch(jsonUrl, { signal, headers: YT_HEADERS });
  if (jsonRes.ok) {
    const body = new TextDecoder().decode(await readBodyCapped(jsonRes, TIMEDTEXT_MAX_RESPONSE_BYTES));
    const fromJson = parseJson3(body);
    if (fromJson) return fromJson;
    // A non-empty non-JSON body here is the XML/TTML format — parse it directly.
    if (body.trim()) {
      const fromXml = parseTimedText(body);
      if (fromXml) return fromXml;
    }
  }

  const xmlRes = await safeFetch(baseUrl, { signal, headers: YT_HEADERS });
  if (!xmlRes.ok) return '';
  const xml = new TextDecoder().decode(await readBodyCapped(xmlRes, TIMEDTEXT_MAX_RESPONSE_BYTES));
  return parseTimedText(xml);
}

export interface TranscriptOptions {
  lang?: string;
}

/**
 * Best-effort fetch of a video transcript. SSRF-guarded (only youtube.com is reachable). Returns a
 * distinct fail-soft message for each failure mode so the agent can react appropriately:
 * - no captions: the video has no caption tracks.
 * - track fetch failed: captions exist but the transcript track couldn't be fetched (server-side block).
 * - no player data: the watch page had no `ytInitialPlayerResponse` (page format changed or blocked).
 */
export async function fetchTranscript(
  videoId: string,
  signal?: AbortSignal,
  opts?: TranscriptOptions,
): Promise<TranscriptResult> {
  const fail = (error: string): TranscriptResult => ({ videoId, text: '', error });
  if (signal?.aborted) return fail('Aborted');

  try {
    return await withTimeout(YT_TIMEOUT_MS, signal, async (fetchSignal) => {
      const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      const response = await safeFetch(watchUrl, { signal: fetchSignal, headers: YT_HEADERS });
      if (!response.ok) return fail(`could not fetch the YouTube watch page (HTTP ${response.status})`);

      const html = new TextDecoder().decode(await readBodyCapped(response, WATCH_MAX_RESPONSE_BYTES));
      const player = extractPlayerResponse(html);
      if (!player) {
        return fail('could not locate player data (YouTube page format changed or request was blocked)');
      }

      // Prefer POT-exempt ANDROID InnerTube tracks; fall back to the watch-page tracks if that call fails.
      const apiKey = extractInnertubeApiKey(html);
      const androidTracks = apiKey ? await fetchAndroidCaptionTracks(videoId, apiKey, fetchSignal) : [];
      const tracks = androidTracks.length > 0 ? androidTracks : getCaptionTracks(player);
      if (tracks.length === 0) {
        return fail('no captions available for this video');
      }

      const track = chooseTrack(tracks, opts?.lang);
      const baseUrl = track?.baseUrl;
      if (!baseUrl) {
        return fail('no captions available for this video');
      }

      const title = getVideoTitle(player);
      const lang = track?.languageCode;
      const withMeta = (extra: Partial<TranscriptResult>): TranscriptResult => ({
        videoId,
        ...(title ? { title } : {}),
        ...(lang ? { lang } : {}),
        text: '',
        ...extra,
      });

      let text: string;
      try {
        text = await fetchTrackText(baseUrl, fetchSignal);
      } catch (err) {
        return withMeta({ error: `captions found but the transcript track could not be fetched (${errorMessage(err)})` });
      }
      if (!text) {
        return withMeta({
          error: 'captions found but the transcript track returned no text (YouTube may be blocking server-side access)',
        });
      }

      return withMeta({ text });
    });
  } catch (err) {
    const message = errorMessage(err);
    return fail(message.toLowerCase().includes('abort') ? 'Aborted' : message);
  }
}
