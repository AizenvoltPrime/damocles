import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * RSS 2.0 + Atom feed reading (`FeedRead`): correct title/link/date/summary extraction, `limit` bounds,
 * charset handling (a supported non-UTF-8 charset is re-decoded correctly; an unsupported one falls back
 * to UTF-8 with a note), malformed XML (fail-soft), and an SSRF-blocked URL (fail-soft `Blocked`).
 * `safeFetch` is mocked so no network is touched; parsing runs for real on linkedom.
 */

const { safeFetchMock, readBodyCappedMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  readBodyCappedMock: vi.fn(),
}));
vi.mock('../safe-fetch', () => ({
  safeFetch: safeFetchMock,
  readBodyCapped: readBodyCappedMock,
}));

import { fetchFeed } from '../feed';

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com</link>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <pubDate>Mon, 06 Jan 2025 10:00:00 GMT</pubDate>
      <description>The &lt;b&gt;first&lt;/b&gt; post summary.</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <dc:date>2025-01-05</dc:date>
      <content:encoded>&lt;p&gt;Full second content&lt;/p&gt;</content:encoded>
    </item>
    <item>
      <title>Third Post</title>
      <link>https://example.com/third</link>
      <pubDate>Fri, 03 Jan 2025 10:00:00 GMT</pubDate>
      <description>Third summary.</description>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry>
    <title>Atom Entry One</title>
    <link href="https://example.com/atom/self" rel="self"/>
    <link href="https://example.com/atom/one" rel="alternate"/>
    <updated>2025-01-06T12:00:00Z</updated>
    <summary>Atom entry one summary.</summary>
  </entry>
  <entry>
    <title>Atom Entry Two</title>
    <link href="https://example.com/atom/two"/>
    <published>2025-01-05T12:00:00Z</published>
    <content>Atom entry two content body.</content>
  </entry>
</feed>`;

function feedResponse(): Response {
  return { ok: true, status: 200, statusText: 'OK' } as unknown as Response;
}

function encode(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}

beforeEach(() => {
  safeFetchMock.mockReset();
  readBodyCappedMock.mockReset();
  safeFetchMock.mockResolvedValue(feedResponse());
});

describe('fetchFeed — RSS 2.0', () => {
  it('parses title, link, normalized date, and HTML-stripped summary', async () => {
    readBodyCappedMock.mockResolvedValue(encode(RSS_XML));
    const result = await fetchFeed('https://example.com/feed.xml');
    expect(result.error).toBeUndefined();
    expect(result.title).toBe('Example Blog');
    expect(result.items).toHaveLength(3);

    expect(result.items[0]).toMatchObject({
      title: 'First Post',
      link: 'https://example.com/first',
      published: new Date('Mon, 06 Jan 2025 10:00:00 GMT').toISOString(),
    });
    expect(result.items[0]!.summary).toBe('The first post summary.');

    // Namespaced dc:date + content:encoded resolve via local-name fallback.
    expect(result.items[1]!.published).toBe(new Date('2025-01-05').toISOString());
    expect(result.items[1]!.summary).toContain('Full second content');
  });

  it('respects the limit', async () => {
    readBodyCappedMock.mockResolvedValue(encode(RSS_XML));
    const result = await fetchFeed('https://example.com/feed.xml', undefined, 2);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.title)).toEqual(['First Post', 'Second Post']);
  });
});

describe('fetchFeed — Atom', () => {
  it('parses entries with the alternate link, published/updated date, and summary/content', async () => {
    readBodyCappedMock.mockResolvedValue(encode(ATOM_XML));
    const result = await fetchFeed('https://example.com/atom.xml');
    expect(result.error).toBeUndefined();
    expect(result.title).toBe('Atom Example');
    expect(result.items).toHaveLength(2);

    // rel="alternate" is preferred over rel="self".
    expect(result.items[0]).toMatchObject({
      title: 'Atom Entry One',
      link: 'https://example.com/atom/one',
      summary: 'Atom entry one summary.',
    });
    expect(result.items[0]!.published).toBe(new Date('2025-01-06T12:00:00Z').toISOString());

    expect(result.items[1]).toMatchObject({
      title: 'Atom Entry Two',
      link: 'https://example.com/atom/two',
      summary: 'Atom entry two content body.',
    });
  });
});

describe('fetchFeed — charset + robustness', () => {
  it('re-decodes a supported non-UTF-8 charset (windows-1252) correctly, no note', async () => {
    // 0x92 is a right single quote in windows-1252 but invalid as UTF-8 (would become U+FFFD).
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<rss version="2.0"><channel><title>Caf\u00e9</title>' +
      '<item><title>It\x92s here</title><link>https://example.com/x</link></item></channel></rss>';
    const bytes = Uint8Array.from([...xml].map((c) => c.charCodeAt(0))); // latin1/cp1252 byte per char
    readBodyCappedMock.mockResolvedValue(bytes);
    const result = await fetchFeed('https://example.com/feed.xml');
    expect(result.error).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(result.items[0]!.title).toBe('It\u2019s here'); // 0x92 → U+2019, not U+FFFD
  });

  it('notes an unsupported declared charset and falls back to UTF-8', async () => {
    const xml = RSS_XML.replace('encoding="UTF-8"', 'encoding="x-mac-bogus-42"');
    readBodyCappedMock.mockResolvedValue(encode(xml));
    const result = await fetchFeed('https://example.com/feed.xml');
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(result.note).toMatch(/x-mac-bogus-42/i);
  });

  it('clamps limit to the 1–100 range', async () => {
    readBodyCappedMock.mockResolvedValue(encode(RSS_XML));
    const over = await fetchFeed('https://example.com/feed.xml', undefined, 9999);
    expect(over.items).toHaveLength(3); // only 3 items exist; clamp doesn't invent more
    const under = await fetchFeed('https://example.com/feed.xml', undefined, 0);
    expect(under.items).toHaveLength(1); // 0 clamps up to a floor of 1
  });

  it('fails soft on malformed XML that is neither RSS nor Atom', async () => {
    readBodyCappedMock.mockResolvedValue(encode('<html><body>not a feed</body></html>'));
    const result = await fetchFeed('https://example.com/notafeed');
    expect(result.items).toHaveLength(0);
    expect(result.error).toBeTruthy();
  });

  it('fails soft (Blocked) on a private-address feed URL without throwing', async () => {
    safeFetchMock.mockRejectedValue(new Error('Blocked private address: metadata.internal → 169.254.169.254'));
    const result = await fetchFeed('http://metadata.internal/feed');
    expect(result.error).toMatch(/Blocked/);
    expect(result.items).toHaveLength(0);
  });

  it('fails soft on a non-ok HTTP status', async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' } as unknown as Response);
    const result = await fetchFeed('https://example.com/missing.xml');
    expect(result.error).toMatch(/404/);
  });
});
