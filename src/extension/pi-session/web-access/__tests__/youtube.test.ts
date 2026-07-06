import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Best-effort YouTube transcript retrieval (`YouTubeTranscript`): id parsing across URL forms, the happy
 * path via the ANDROID InnerTube client + `fmt=json3`, the srv3 (`<p>/<s>`) and legacy (`<text>`) XML
 * fallbacks, and each distinct fail-soft mode. `safeFetch`/`readBodyCapped` are mocked and routed by URL,
 * so the multi-hop flow (watch page → InnerTube player → caption track) is exercised deterministically.
 * SSRF validation itself is covered by safe-fetch.test.ts.
 */

const { safeFetchMock, readBodyCappedMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  readBodyCappedMock: vi.fn(),
}));
vi.mock('../safe-fetch', () => ({
  safeFetch: safeFetchMock,
  readBodyCapped: readBodyCappedMock,
}));

import { parseVideoId, fetchTranscript } from '../youtube';

const VIDEO_ID = 'dQw4w9WgXcQ';
const API_KEY = 'AIzaSyTESTKEY';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const INNERTUBE_PREFIX = 'https://www.youtube.com/youtubei/v1/player';

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  __body: string;
}

function resp(body: string, ok = true, status = 200): FakeResponse {
  return { ok, status, statusText: ok ? 'OK' : 'ERR', __body: body };
}

function watchHtml(player: unknown, withApiKey = true): string {
  const key = withApiKey ? `ytcfg.set({"INNERTUBE_API_KEY":"${API_KEY}","other":1});` : '';
  return `<!doctype html><html><head><title>YT</title></head><body>
<script>${key} var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>
</body></html>`;
}

function playerWith(tracks: unknown[], title = 'Rick Astley - Never Gonna Give You Up'): unknown {
  return {
    videoDetails: { title },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  };
}

const JSON3_BODY = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "We're no " }, { utf8: 'strangers to love' }] },
    { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'You know the rules' }] },
    { tStartMs: 4000, wWinId: 1 }, // style/timing event with no segs — must be skipped
  ],
});

const SRV3_XML =
  '<?xml version="1.0" encoding="utf-8"?><timedtext format="3"><body>' +
  '<p t="0" d="2000"><s>We&amp;#39;re</s><s> no strangers</s></p>' +
  '<p t="2000" d="2000">You know the rules</p>' +
  '</body></timedtext>';

const LEGACY_XML =
  '<?xml version="1.0" encoding="utf-8"?><transcript>' +
  '<text start="0" dur="2">We&amp;#39;re no strangers to love</text>' +
  '<text start="2" dur="2">You know the &amp;lt;rules&amp;gt;</text>' +
  '</transcript>';

/**
 * Route mock responses by URL. `handlers` maps a URL-substring test to the FakeResponse to return; the
 * matching response's `__body` is what `readBodyCapped` yields for that call.
 */
function route(handlers: Array<{ match: (url: string) => boolean; res: FakeResponse | (() => FakeResponse) }>): void {
  safeFetchMock.mockImplementation((url: string) => {
    const h = handlers.find((x) => x.match(url));
    if (!h) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(typeof h.res === 'function' ? h.res() : h.res);
  });
  readBodyCappedMock.mockImplementation((res: FakeResponse) => Promise.resolve(new TextEncoder().encode(res.__body)));
}

beforeEach(() => {
  safeFetchMock.mockReset();
  readBodyCappedMock.mockReset();
});

describe('parseVideoId', () => {
  it('accepts every supported id form', () => {
    expect(parseVideoId(`https://www.youtube.com/watch?v=${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(parseVideoId(`https://youtu.be/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(parseVideoId(`https://www.youtube.com/shorts/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(parseVideoId(`https://www.youtube.com/embed/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(parseVideoId(`https://m.youtube.com/watch?v=${VIDEO_ID}&t=30s`)).toBe(VIDEO_ID);
    expect(parseVideoId(`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(parseVideoId(VIDEO_ID)).toBe(VIDEO_ID);
  });

  it('rejects non-YouTube URLs and malformed ids', () => {
    expect(parseVideoId('https://example.com/watch?v=abc')).toBeNull();
    expect(parseVideoId('not a url')).toBeNull();
    expect(parseVideoId('shortid')).toBeNull();
  });
});

describe('fetchTranscript — ANDROID InnerTube + json3 happy path', () => {
  it('uses the InnerTube tracks, requests fmt=json3, decodes segments, and picks the human track', async () => {
    const androidPlayer = playerWith([
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=asr&fmt=srv3', languageCode: 'en', kind: 'asr' },
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=human&fmt=srv3', languageCode: 'en' },
    ]);
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(playerWith([]))) },
      { match: (u) => u.startsWith(INNERTUBE_PREFIX), res: resp(JSON.stringify(androidPlayer)) },
      { match: (u) => u.includes('fmt=json3'), res: resp(JSON3_BODY) },
    ]);

    const result = await fetchTranscript(VIDEO_ID);
    expect(result.error).toBeUndefined();
    expect(result.title).toContain('Never Gonna Give You Up');
    expect(result.lang).toBe('en');
    expect(result.text).toContain("We're no strangers to love");
    expect(result.text).toContain('You know the rules');

    // The InnerTube POST was made with the ANDROID client key, and the human (non-asr) track was chosen.
    const innertubeCall = safeFetchMock.mock.calls.find((c) => String(c[0]).startsWith(INNERTUBE_PREFIX))!;
    expect(String(innertubeCall[0])).toContain(`key=${API_KEY}`);
    expect((innertubeCall[1] as { method?: string }).method).toBe('POST');
    const trackCall = safeFetchMock.mock.calls.find((c) => String(c[0]).includes('fmt=json3'))!;
    expect(String(trackCall[0])).toContain('v=human');
  });

  it('honors a requested lang over the human-track preference', async () => {
    const androidPlayer = playerWith([
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=en&fmt=srv3', languageCode: 'en' },
      { baseUrl: 'https://www.youtube.com/api/timedtext?v=fr&fmt=srv3', languageCode: 'fr' },
    ]);
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(playerWith([]))) },
      { match: (u) => u.startsWith(INNERTUBE_PREFIX), res: resp(JSON.stringify(androidPlayer)) },
      { match: (u) => u.includes('fmt=json3'), res: resp(JSON3_BODY) },
    ]);
    const result = await fetchTranscript(VIDEO_ID, undefined, { lang: 'fr' });
    expect(result.lang).toBe('fr');
    const trackCall = safeFetchMock.mock.calls.find((c) => String(c[0]).includes('fmt=json3'))!;
    expect(String(trackCall[0])).toContain('v=fr');
  });
});

describe('fetchTranscript — XML fallbacks', () => {
  it('parses srv3 <p>/<s> XML when json3 comes back empty', async () => {
    const player = playerWith([{ baseUrl: 'https://www.youtube.com/api/timedtext?v=en&fmt=srv3', languageCode: 'en' }]);
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(player, false)) }, // no api key → watch-page tracks
      { match: (u) => u.includes('fmt=json3'), res: resp('') }, // empty json3 body
      { match: (u) => u.includes('timedtext'), res: resp(SRV3_XML) }, // raw baseUrl → srv3 XML
    ]);
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("We're no strangers");
    expect(result.text).toContain('You know the rules');
  });

  it('parses legacy <text> XML returned directly from the json3 URL', async () => {
    const player = playerWith([{ baseUrl: 'https://www.youtube.com/api/timedtext?v=en', languageCode: 'en' }]);
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(player, false)) },
      { match: (u) => u.includes('fmt=json3'), res: resp(LEGACY_XML) }, // server ignored fmt, returned XML
      { match: (u) => u.includes('timedtext'), res: resp(LEGACY_XML) },
    ]);
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("We're no strangers to love");
    expect(result.text).toContain('You know the <rules>');
  });

  it('does not throw on an out-of-range numeric entity; leaves it raw and keeps the transcript', async () => {
    // &#9999999; exceeds U+10FFFF — String.fromCodePoint would throw RangeError if unguarded.
    const badXml =
      '<?xml version="1.0"?><transcript>' +
      '<text start="0">bad ref &amp;#9999999; here</text>' +
      '<text start="1">valid line</text></transcript>';
    const player = playerWith([{ baseUrl: 'https://www.youtube.com/api/timedtext?v=en', languageCode: 'en' }]);
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(player, false)) },
      { match: (u) => u.includes('fmt=json3'), res: resp(badXml) },
      { match: (u) => u.includes('timedtext'), res: resp(badXml) },
    ]);
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.error).toBeUndefined();
    expect(result.text).toContain('valid line');
    expect(result.text).toContain('&#9999999;'); // overflow entity left verbatim, not crashed
  });
});

describe('fetchTranscript — fail-soft modes', () => {
  it('reports no captions when neither InnerTube nor the watch page yields tracks', async () => {
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(playerWith([]))) },
      { match: (u) => u.startsWith(INNERTUBE_PREFIX), res: resp(JSON.stringify(playerWith([]))) },
    ]);
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/no captions available/i);
  });

  it('reports a distinct diagnostic when both track fetches return empty (POT block)', async () => {
    const player = playerWith([{ baseUrl: 'https://www.youtube.com/api/timedtext?v=en&fmt=srv3', languageCode: 'en' }]);
    route([
      { match: (u) => u === WATCH_URL, res: resp(watchHtml(player, false)) },
      { match: (u) => u.includes('timedtext'), res: resp('') }, // both json3 and raw come back empty
    ]);
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/returned no text/i);
  });

  it('reports missing player data when the watch page has no ytInitialPlayerResponse', async () => {
    route([{ match: (u) => u === WATCH_URL, res: resp('<!doctype html><html><body>no player</body></html>') }]);
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/could not locate player data/i);
  });

  it('never throws when safeFetch rejects (fail-soft)', async () => {
    safeFetchMock.mockRejectedValue(new Error('network down'));
    const result = await fetchTranscript(VIDEO_ID);
    expect(result.text).toBe('');
    expect(result.error).toBeTruthy();
  });
});
