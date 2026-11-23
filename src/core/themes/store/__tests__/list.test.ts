// The store list on disk: reuse within a day, forced checks, a failed request, refusals that keep the last good list and are
// asked about again, the sequence mark and its key, the size caps, and thumbnails kept only when their hash matches. In the
// redirect tests the real safeFetch runs with undici mocked, so its literal check and the redirect rule run; the connection's
// DNS guard is covered in safe-fetch.test.ts.
import { createHash, createPublicKey } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock, fetchMock, trust } = vi.hoisted(() => ({ lookupMock: vi.fn(), fetchMock: vi.fn(), trust: { pem: undefined as string | undefined, also: [] as string[] } }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: fetchMock }));
// the store trusts the test key as the hooks' key would be trusted, so the fake fetch can serve lists it signs; `also` stands
// for a second shipped key
vi.mock('../../store-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store-keys')>();
  return {
    ...actual,
    trustedStoreKeys: (pem?: string) => new Map([...actual.trustedStoreKeys(pem ?? trust.pem), ...trust.also.map((other) => [actual.keyIdOf(other), createPublicKey(other)] as const)]),
  };
});

import { createWriteLane } from '../../write-lane';
import { createStoreList, MAX_LIST_BYTES, MAX_THUMB_BYTES, MAX_THUMBS_PER_CALL, STORE_LIST_URL, type StoreFetch, type StoreFetcher, type StoreListOptions } from '../list';
import type { StoreEntry, StorePayload } from '../verify';
import { entry, payload, signed, testKey } from './store-fixtures';

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 60 * 60 * 1000;
const key = testKey();
const webp = (tail: string): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(tail)]));
const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const THUMB = webp('one');
const THUMB_SHA = shaOf(THUMB);
const thumbUrl = (sha256: string): string => `https://raw.githubusercontent.com/AizenvoltPrime/damocles-themes/main/thumbs/${sha256}.webp`;
const THUMB_URL = thumbUrl(THUMB_SHA);

let root: string;
let clock: number;
let fetches: StoreFetch[];
let enabled: boolean;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-list-'));
  clock = NOW;
  fetches = [];
  enabled = true;
  trust.pem = key.publicPem;
  trust.also = [];
  fetchMock.mockReset();
  lookupMock.mockReset();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const listFile = (): string => path.join(root, 'store', 'list.json');
const keptFile = (): Record<string, unknown> => JSON.parse(fs.readFileSync(listFile(), 'utf8')) as Record<string, unknown>;
const thumbFile = (sha256: string): string => path.join(root, 'store', 'thumbs', sha256);
const thumbFetches = (): string[] => fetches.filter((fetch) => fetch.purpose === 'thumbnail').map((fetch) => fetch.url);

/** A fake safeFetch answering each URL from `answers` (a function of the call count), recording each call. */
function fakeFetch(answer: (url: string, call: number) => Response | Error | Promise<Response>): StoreFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher: StoreFetcher = async (url) => {
    calls.push(url);
    const result = answer(url, calls.length);
    if (result instanceof Error) throw result;
    return result;
  };
  return Object.assign(fetcher, { calls });
}

function store(fetch: StoreFetcher | undefined, extra: Partial<StoreListOptions> = {}) {
  return createStoreList({
    root,
    lane: createWriteLane(root),
    enabled: () => enabled,
    ...(fetch ? { fetch } : {}),
    now: () => clock,
    log: () => undefined,
    onFetch: (fetch) => fetches.push(fetch),
    ...extra,
  });
}

/** A verified payload naming `thumbs` (sha256 to URL) as one entry's dark thumbnails per 40. */
function thumbsPayload(thumbs: ReadonlyMap<string, string>, sequence = 1): StorePayload {
  const all = [...thumbs];
  const entries: StoreEntry[] = [];
  for (let i = 0; i < all.length; i += 40) {
    entries.push({ ...(entry({ id: `entry-${i}` }) as unknown as StoreEntry), thumbnails: { dark: all.slice(i, i + 40).map(([sha256, url]) => ({ panel: 'chat', url, sha256 })) } });
  }
  return { sequence, issuedAt: NOW, expiresAt: NOW + HOUR, entries, removed: [] };
}

describe('list', () => {
  it('makes no request at all while the store setting is off', async () => {
    enabled = false;
    const fetch = fakeFetch(() => json(signed(key, payload(NOW))));
    const list = store(fetch);
    expect(await list.list({ refresh: true })).toEqual({ state: 'off' });
    expect(await list.list({ refresh: false })).toEqual({ state: 'off' });
    expect(await list.fetchThumbnails(thumbsPayload(new Map([[THUMB_SHA, THUMB_URL]])))).toBe(false);
    expect(fetch.calls).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('asks the GitHub URL and refuses a list signed by the test key without the e2e hooks', async () => {
    trust.pem = undefined;
    const fetch = fakeFetch(() => json(signed(key, payload(NOW))));
    const result = await store(fetch).list({ refresh: false });
    expect(result.state === 'refused' && result.reason.message).toBe('The community store list is signed with a key Damocles does not know ({0}), so Damocles did not use it.');
    expect(fetch.calls).toEqual([STORE_LIST_URL]);
    expect(fs.existsSync(listFile())).toBe(false);
  });

  it('reuses a list fetched within the last day, fetches again after it, and fetches on every forced check', async () => {
    const fetch = fakeFetch(() => json(signed(key, payload(NOW))));
    const list = store(fetch);
    const first = await list.list({ refresh: false });
    expect(first).toMatchObject({ state: 'ok', fetched: true, fetchedAt: NOW });
    expect(keptFile()).toMatchObject({ highestSequence: 5, highestSequenceKeyId: key.keyId });
    clock = NOW + 23 * HOUR;
    expect(await list.list({ refresh: false })).toMatchObject({ state: 'ok', fetched: false, fetchedAt: NOW });
    expect(await list.list({ refresh: true })).toMatchObject({ state: 'ok', fetched: true, fetchedAt: NOW + 23 * HOUR });
    clock = NOW + 48 * HOUR;
    expect(await list.list({ refresh: false })).toMatchObject({ state: 'ok', fetched: true });
    expect(fetch.calls).toHaveLength(3);
    expect(fetches.map((f) => f.purpose)).toEqual(['list', 'list', 'list']);
  });

  it('makes one request for two calls made together, the second reusing what the first kept', async () => {
    const fetch = fakeFetch(() => json(signed(key, payload(NOW))));
    const list = store(fetch);
    const [first, second] = await Promise.all([list.list({ refresh: false }), list.list({ refresh: false })]);
    expect(first).toMatchObject({ state: 'ok', fetched: true });
    expect(second).toMatchObject({ state: 'ok', fetched: false });
    expect(fetch.calls).toHaveLength(1);
  });

  it('does not reuse a kept list whose fetchedAt is in the future', async () => {
    const fetch = fakeFetch(() => json(signed(key, payload(NOW))));
    const list = store(fetch);
    await list.list({ refresh: true });
    clock = NOW - HOUR;
    expect(await list.list({ refresh: false })).toMatchObject({ state: 'ok', fetched: true });
  });

  it('shows the kept list as cached when the request fails, and says unreachable with nothing kept', async () => {
    let online = true;
    const fetch = fakeFetch(() => (online ? json(signed(key, payload(NOW))) : new TypeError('fetch failed')));
    const list = store(fetch);
    online = false;
    const nothing = await list.list({ refresh: false });
    expect(nothing.state).toBe('unreachable');
    online = true;
    await list.list({ refresh: false });
    online = false;
    const cached = await list.list({ refresh: true });
    expect(cached).toMatchObject({ state: 'cached', fetchedAt: NOW, fetched: true });
    expect(cached.state === 'cached' && cached.payload.entries[0]!.id).toBe('aurora');
    expect(cached.state === 'cached' && cached.reason.message).toBe('Damocles could not fetch the community store list: {0}');
  });

  it.each([
    ['a cause whose message names its code', new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'), { code: 'ENOTFOUND' }) }), 'getaddrinfo ENOTFOUND raw.githubusercontent.com'],
    ['a cause whose message does not', new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }), 'socket hang up (ECONNRESET)'],
    ['a cause with a code and no message', new TypeError('fetch failed', { cause: Object.assign(new Error(''), { code: 'ETIMEDOUT' }) }), 'ETIMEDOUT'],
    ['an error with no cause', new TypeError('fetch failed'), 'fetch failed'],
  ])('says why a request failed from %s', async (_name, error, text) => {
    const result = await store(fakeFetch(() => error)).list({ refresh: true });
    expect(result.state === 'unreachable' && result.reason.args).toEqual([{ message: '{0}', args: [text] }]);
  });

  it('never shows a kept list past its expiresAt, after a failed request or a refusal', async () => {
    const bodies = [json(signed(key, payload(NOW))), new TypeError('fetch failed'), json({ unsigned: true })];
    const fetch = fakeFetch((_url, call) => bodies[call - 1]!);
    const list = store(fetch);
    await list.list({ refresh: true });
    clock = NOW + 30 * 24 * HOUR;
    const offline = await list.list({ refresh: false });
    expect(offline.state).toBe('unreachable');
    expect(offline.state === 'unreachable' && offline.reason.message).toBe('Damocles could not fetch the community store list, and the list it kept expired on {0}: {1}');
    const refused = await list.list({ refresh: true });
    expect(refused.state === 'refused' && refused.last).toBeUndefined();
    expect(await list.kept()).toBeUndefined();
  });

  it('shows the kept list as cached when GitHub answers an HTTP error, naming the status', async () => {
    const fetch = fakeFetch((_url, call) => (call === 1 ? json(signed(key, payload(NOW))) : new Response('busy', { status: 503 })));
    const list = store(fetch);
    await list.list({ refresh: true });
    const cached = await list.list({ refresh: true });
    expect(cached).toMatchObject({ state: 'cached', fetchedAt: NOW });
    expect(cached.state === 'cached' && cached.reason.args).toEqual([{ message: 'GitHub answered HTTP {0}.', args: ['503'] }]);
  });

  it('refuses a bad, rolled-back or expired list, keeps the last good one and records the refusal beside it', async () => {
    const bodies = [
      json(signed(key, payload(NOW))),
      json(signed(testKey(), payload(NOW, { sequence: 9 }), { keyId: key.keyId })),
      json(signed(key, payload(NOW, { sequence: 4 }))),
      json(signed(key, payload(NOW, { sequence: 7, issuedAt: new Date(NOW - 40 * 24 * HOUR).toISOString(), expiresAt: new Date(NOW - HOUR).toISOString() }))),
      json({ unsigned: true }),
      json(signed(key, payload(NOW, { entries: [entry({ file: { url: 'http://github.com/a', sha256: 'a'.repeat(64), bytes: 1 } })] }))),
      json(signed(key, payload(NOW))),
    ];
    const fetch = fakeFetch((_url, call) => bodies[call - 1]!);
    const list = store(fetch);
    await list.list({ refresh: true });
    const good = keptFile();
    expect(good).not.toHaveProperty('refusedAt');
    const messages: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock += HOUR;
      const result = await list.list({ refresh: true });
      expect(result.state).toBe('refused');
      if (result.state !== 'refused') continue;
      messages.push(result.reason.message);
      expect(result.last?.payload.sequence).toBe(5);
      expect(keptFile()).toEqual({ ...good, refusedAt: clock });
    }
    expect(messages).toEqual([
      'The community store list\'s signature does not match its contents, so Damocles did not use it.',
      'The community store list is older (number {0}) than one Damocles already saw (number {1}), so Damocles kept the newer list.',
      'The community store list expired on {0}, so Damocles did not use it.',
      'The community store list is not signed, so Damocles did not use it.',
      'The community store list is signed but malformed ({0}), so Damocles did not use it.',
    ]);
    expect((await list.kept())?.payload.sequence).toBe(5);
    // the same sequence again is a re-fetch of the same list, and a list that verifies ends the refusal
    expect(await list.list({ refresh: true })).toMatchObject({ state: 'ok', fetched: true });
    expect(keptFile()).not.toHaveProperty('refusedAt');
  });

  it('asks again after a refusal instead of reusing the kept list, across a restart, until a list verifies', async () => {
    const bodies = [json(signed(key, payload(NOW))), json({ unsigned: true }), json({ unsigned: true }), json(signed(key, payload(NOW)))];
    const fetch = fakeFetch((_url, call) => bodies[call - 1]!);
    await store(fetch).list({ refresh: false });
    expect((await store(fetch).list({ refresh: true })).state).toBe('refused');
    // another run of the app, inside the day the kept list would be reused for
    const restarted = store(fetch);
    expect((await restarted.list({ refresh: false })).state).toBe('refused');
    expect(fetch.calls).toHaveLength(3);
    expect(await restarted.list({ refresh: false })).toMatchObject({ state: 'ok', fetched: true });
    expect(await restarted.list({ refresh: false })).toMatchObject({ state: 'ok', fetched: false });
    expect(fetch.calls).toHaveLength(4);
  });

  it('refuses a list over 2 MB and reads one at the cap', async () => {
    const big = new Uint8Array(MAX_LIST_BYTES + 1).fill(0x20);
    const fetch = fakeFetch(() => new Response(big, { status: 200 }));
    const result = await store(fetch).list({ refresh: true });
    expect(result.state === 'refused' && result.reason.message).toBe('The answer is larger than {0} MB, the most Damocles reads for the community store.');
    const text = JSON.stringify(signed(key, payload(NOW)));
    const padded = new TextEncoder().encode(text.padEnd(MAX_LIST_BYTES, ' '));
    expect(padded.byteLength).toBe(MAX_LIST_BYTES);
    expect(await store(fakeFetch(() => new Response(padded, { status: 200 }))).list({ refresh: true })).toMatchObject({ state: 'ok' });
  });

  it.each([
    ['larger than a kept list can be', (): string => ' '.repeat(MAX_LIST_BYTES + 4097)],
    ['not JSON', (): string => '{"version":1,'],
    ['of another version', (): string => JSON.stringify({ version: 2, envelope: signed(key, payload(NOW)), fetchedAt: NOW, highestSequence: 99 })],
  ])('starts without a kept list from a list.json that is %s', async (_name, text) => {
    fs.mkdirSync(path.dirname(listFile()), { recursive: true });
    fs.writeFileSync(listFile(), text());
    const list = store(fakeFetch(() => json(signed(key, payload(NOW)))));
    expect(await list.kept()).toBeUndefined();
    expect(await list.list({ refresh: false })).toMatchObject({ state: 'ok', fetched: true });
  });

  it('reads the highest sequence again inside the lane, so a list another Damocles kept meanwhile refuses an older one', async () => {
    let release: (response: Response) => void = () => undefined;
    const slow = store(fakeFetch(() => new Promise<Response>((resolve) => (release = resolve))));
    const pending = slow.list({ refresh: true });
    await store(fakeFetch(() => json(signed(key, payload(NOW, { sequence: 9 }))))).list({ refresh: true });
    release(json(signed(key, payload(NOW, { sequence: 8 }))));
    const result = await pending;
    expect(result.state === 'refused' && result.reason.args).toEqual(['8', '9']);
    expect(keptFile()).toMatchObject({ highestSequence: 9 });
  });

  it('is refused when built with an e2e list URL outside the e2e host', () => {
    expect(() => store(undefined, { e2e: { listUrl: 'https://raw.githubusercontent.com/x.json', publicKeyPem: key.publicPem, folder: root } })).toThrow(/e2e store list/);
  });

  it('reads the e2e list from the hooks folder, signed by the test key, with a file on the e2e host', async () => {
    const body = payload(NOW, { entries: [entry({ file: { url: 'https://e2e.test/aurora.damocles-theme', sha256: 'a'.repeat(64), bytes: 1 } })] });
    fs.writeFileSync(path.join(root, 'community.signed.json'), JSON.stringify(signed(key, body)));
    const fetch = fakeFetch(() => new Error('no network in this test'));
    const list = store(fetch, { e2e: { listUrl: 'https://e2e.test/community.signed.json', publicKeyPem: key.publicPem, folder: root } });
    expect(await list.list({ refresh: true })).toMatchObject({ state: 'ok', fetched: true });
    expect(fetch.calls).toEqual([]);
    expect(fetches).toEqual([{ url: 'https://e2e.test/community.signed.json', purpose: 'list' }]);
    expect(list.e2e).toBe(true);
    // without the hooks the same list names a file off the release hosts
    const plain = await store(fakeFetch(() => json(signed(key, body)))).list({ refresh: true });
    expect(plain.state === 'refused' && plain.reason.message).toBe('The community store list is signed but malformed ({0}), so Damocles did not use it.');
  });
});

describe('the highest sequence and the key that set it', () => {
  const other = testKey();

  it('drops the mark with a key Damocles no longer trusts, so a later honest list with a low sequence is accepted', async () => {
    await store(fakeFetch(() => json(signed(key, payload(NOW, { sequence: Number.MAX_SAFE_INTEGER }))))).list({ refresh: true });
    expect(keptFile()).toMatchObject({ highestSequence: Number.MAX_SAFE_INTEGER, highestSequenceKeyId: key.keyId });
    // a release removed the key and promoted the next one
    trust.pem = other.publicPem;
    const list = store(fakeFetch(() => json(signed(other, payload(NOW, { sequence: 3 })))));
    expect(await list.kept()).toBeUndefined();
    expect(await list.list({ refresh: true })).toMatchObject({ state: 'ok', fetched: true });
    expect(keptFile()).toMatchObject({ highestSequence: 3, highestSequenceKeyId: other.keyId });
  });

  it('holds the mark across a change of key while both are trusted, so the older key\'s list is not replayed', async () => {
    trust.also = [other.publicPem];
    const bodies = [json(signed(key, payload(NOW, { sequence: 10 }))), json(signed(other, payload(NOW, { sequence: 11 }))), json(signed(key, payload(NOW, { sequence: 10 })))];
    const list = store(fakeFetch((_url, call) => bodies[call - 1]!));
    await list.list({ refresh: true });
    expect(await list.list({ refresh: true })).toMatchObject({ state: 'ok' });
    expect(keptFile()).toMatchObject({ highestSequence: 11, highestSequenceKeyId: other.keyId });
    const replay = await list.list({ refresh: true });
    expect(replay.state === 'refused' && replay.reason.args).toEqual(['10', '11']);
    // the first key leaves; the mark is the second key's and stays
    trust.pem = other.publicPem;
    trust.also = [];
    const later = await store(fakeFetch(() => json(signed(other, payload(NOW, { sequence: 10 }))))).list({ refresh: true });
    expect(later.state === 'refused' && later.reason.args).toEqual(['10', '11']);
  });

  it('reads a mark written without its key as the kept list\'s key', async () => {
    fs.mkdirSync(path.dirname(listFile()), { recursive: true });
    fs.writeFileSync(listFile(), JSON.stringify({ version: 1, envelope: signed(key, payload(NOW)), fetchedAt: NOW, highestSequence: 9 }));
    const held = await store(fakeFetch(() => json(signed(key, payload(NOW, { sequence: 7 }))))).list({ refresh: true });
    expect(held.state === 'refused' && held.reason.args).toEqual(['7', '9']);
    trust.pem = other.publicPem;
    expect(await store(fakeFetch(() => json(signed(other, payload(NOW, { sequence: 1 }))))).list({ refresh: true })).toMatchObject({ state: 'ok' });
  });
});

describe('requests end with the setting and the caller', () => {
  const untilAborted: StoreFetcher = (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)));

  it('ends a list request in flight when the setting goes off, answering off', async () => {
    const list = store(untilAborted);
    const pending = list.list({ refresh: true });
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    enabled = false;
    list.turnedOff();
    expect(await pending).toEqual({ state: 'off' });
  });

  it('makes no request when the setting goes off between the read of the kept list and the request', async () => {
    let reads = 0;
    const fetch = fakeFetch(() => json(signed(key, payload(NOW))));
    // on when the call starts, off by the time the request would go out
    expect(await store(fetch, { enabled: () => reads++ === 0 }).list({ refresh: true })).toEqual({ state: 'off' });
    expect(fetch.calls).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('rejects a list request its caller aborts', async () => {
    const caller = new AbortController();
    const pending = store(untilAborted).list({ refresh: true, signal: caller.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled by its caller');
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    caller.abort(new Error('cancelled by its caller'));
    await rejected;
  });

  it('asks for no thumbnail after the setting went off part-way', async () => {
    const thumbs = new Map(Array.from({ length: 8 }, (_, i) => [shaOf(webp(`t${i}`)), thumbUrl(shaOf(webp(`t${i}`)))] as const));
    const fetch = fakeFetch((_url, call) => {
      if (call === 4) enabled = false;
      return new Response(THUMB, { status: 200 });
    });
    await store(fetch).fetchThumbnails(thumbsPayload(thumbs));
    // the setting went off during the first four, so the next four were never asked for
    expect(thumbFetches()).toHaveLength(4);
  });
});

describe('redirects, through the real safeFetch', () => {
  it('follows a redirect within raw.githubusercontent.com and refuses one to another host without requesting it', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === STORE_LIST_URL) return new Response(null, { status: 302, headers: { location: 'https://raw.githubusercontent.com/moved/community.signed.json' } });
      if (url === 'https://raw.githubusercontent.com/moved/community.signed.json') return new Response(null, { status: 302, headers: { location: 'https://evil.example/community.signed.json' } });
      throw new Error(`unexpected request to ${url}`);
    });
    const result = await store(undefined).list({ refresh: true });
    expect(result.state === 'refused' && result.reason.message).toBe('GitHub sent the request on to {0}, a host the community store does not use, so Damocles did not follow it.');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([STORE_LIST_URL, 'https://raw.githubusercontent.com/moved/community.signed.json']);
    // undici is mocked, so no connection is made and the connection's DNS guard never runs here
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect to http on the allowed host', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === STORE_LIST_URL) return new Response(null, { status: 301, headers: { location: 'http://raw.githubusercontent.com/x' } });
      throw new Error(`unexpected request to ${url}`);
    });
    expect((await store(undefined).list({ refresh: true })).state).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('thumbnails', () => {
  it('keeps a thumbnail whose SHA-256 matches and writes nothing for one that does not', async () => {
    const wrongSha = 'c'.repeat(64);
    const body = thumbsPayload(new Map([[THUMB_SHA, THUMB_URL], [wrongSha, thumbUrl(wrongSha)]]));
    const list = store(fakeFetch(() => new Response(THUMB, { status: 200 })));
    expect(await list.fetchThumbnails(body)).toBe(true);
    expect(fs.readFileSync(thumbFile(THUMB_SHA))).toEqual(Buffer.from(THUMB));
    expect(fs.existsSync(thumbFile(wrongSha))).toBe(false);
    expect([...(await list.keptThumbnails())]).toEqual([THUMB_SHA]);
    expect(thumbFetches().sort()).toEqual([THUMB_URL, thumbUrl(wrongSha)].sort());
    // a kept thumbnail is not fetched again, and a run that keeps and drops nothing says so
    expect(await list.fetchThumbnails(body)).toBe(false);
    expect(thumbFetches().filter((url) => url === THUMB_URL)).toHaveLength(1);
  });

  it('keeps no thumbnail that is not a WebP though its hash matches, and does not ask for it again', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
    const body = thumbsPayload(new Map([[shaOf(png), thumbUrl(shaOf(png))]]));
    const list = store(fakeFetch(() => new Response(png, { status: 200 })));
    expect(await list.fetchThumbnails(body)).toBe(false);
    expect(fs.existsSync(thumbFile(shaOf(png)))).toBe(false);
    expect((await list.keptThumbnails()).size).toBe(0);
    await list.fetchThumbnails(body);
    expect(thumbFetches()).toHaveLength(1);
  });

  it('keeps no thumbnail larger than its cap', async () => {
    const big = new Uint8Array(MAX_THUMB_BYTES + 1);
    big.set(THUMB);
    const list = store(fakeFetch(() => new Response(big, { status: 200 })));
    expect(await list.fetchThumbnails(thumbsPayload(new Map([[shaOf(big), thumbUrl(shaOf(big))]])))).toBe(false);
    expect((await list.keptThumbnails()).size).toBe(0);
  });

  it('never requests a thumbnail off the allowed hosts and drops kept thumbnails the list no longer names', async () => {
    const fetch = fakeFetch(() => new Response(THUMB, { status: 200 }));
    const list = store(fetch);
    const stale = 'd'.repeat(64);
    fs.mkdirSync(path.join(root, 'store', 'thumbs'), { recursive: true });
    fs.writeFileSync(thumbFile(stale), 'old');
    expect(await list.fetchThumbnails(thumbsPayload(new Map([[THUMB_SHA, `https://evil.example/${THUMB_SHA}.webp`]])))).toBe(true);
    expect(fetch.calls).toEqual([]);
    expect(fs.existsSync(thumbFile(stale))).toBe(false);
  });

  it('fetches at most MAX_THUMBS_PER_CALL thumbnails in one run', async () => {
    const thumbs = new Map(Array.from({ length: MAX_THUMBS_PER_CALL + 40 }, (_, i) => [String(i).padStart(64, '0'), thumbUrl(String(i).padStart(64, '0'))] as const));
    await store(fakeFetch(() => new Response(THUMB, { status: 200 }))).fetchThumbnails(thumbsPayload(thumbs));
    expect(thumbFetches()).toHaveLength(200);
    expect(MAX_THUMBS_PER_CALL).toBe(200);
  });

  it('stops after a batch in which no request got through', async () => {
    const thumbs = new Map(Array.from({ length: 12 }, (_, i) => [String(i).padStart(64, '0'), thumbUrl(String(i).padStart(64, '0'))] as const));
    await store(fakeFetch(() => new TypeError('fetch failed'))).fetchThumbnails(thumbsPayload(thumbs));
    expect(thumbFetches()).toHaveLength(4);
  });

  it('runs once for the same list asked for twice, and runs another list after it', async () => {
    const second = webp('two');
    const answers = new Map([[THUMB_URL, THUMB], [thumbUrl(shaOf(second)), second]]);
    const list = store(fakeFetch((url) => new Response(answers.get(url)!, { status: 200 })));
    const one = thumbsPayload(new Map([[THUMB_SHA, THUMB_URL]]), 1);
    const two = thumbsPayload(new Map([[THUMB_SHA, THUMB_URL], [shaOf(second), thumbUrl(shaOf(second))]]), 2);
    const runs = [list.fetchThumbnails(one), list.fetchThumbnails(one), list.fetchThumbnails(two)];
    expect(runs[1]).toBe(runs[0]);
    expect(await Promise.all(runs)).toEqual([true, true, true]);
    expect(thumbFetches()).toEqual([THUMB_URL, thumbUrl(shaOf(second))]);
    expect([...(await list.keptThumbnails())].sort()).toEqual([THUMB_SHA, shaOf(second)].sort());
  });
});
