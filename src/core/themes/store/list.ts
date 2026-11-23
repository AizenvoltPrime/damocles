// The community store list on this computer (docs/invariants.md "Desktop themes"): fetched from GitHub, verified, and kept in
// <themes root>/store/list.json with the highest sequence seen; thumbnails are kept in store/thumbs/<sha256> once their hash matched.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { LocalizedText } from '../../../shared/localized-text';
import { isWebp } from '../../../shared/themes/image-header';
import { FetchRefusedError, readBodyCapped, RedirectRefusedError, ResponseTooLargeError, safeFetch, type SafeFetchOptions } from '../../pi-session/web-access/safe-fetch';
import { errorTextOf, l, verbatim } from '../../l10n';
import { ArchiveRefusedError, readCappedFile } from '../archive';
import { SHA256 } from '../blobs';
import { E2E_HOST, e2eFileName, readE2eFile } from '../e2e-downloads';
import { createThemePathRule, type ThemePathRule } from '../network-rule';
import { writeFileAtomic } from '../store';
import { trustedStoreKeys } from '../store-keys';
import type { WriteLane } from '../write-lane';
import { checkFreshness, isRecord, verifyEnvelope, type StoreEnvelope, type StorePayload } from './verify';

export const STORE_LIST_URL = 'https://raw.githubusercontent.com/AizenvoltPrime/damocles-themes/main/community.signed.json';
// the list and its thumbnails, every hop of their redirects included
export const LIST_HOSTS: readonly string[] = ['raw.githubusercontent.com'];
export const MAX_LIST_BYTES: number = 2 * 1024 * 1024;
// a 320 px WebP is far smaller; one call fetches at most MAX_THUMBS_PER_CALL
export const MAX_THUMB_BYTES: number = 512 * 1024;
export const MAX_THUMBS_PER_CALL = 200;
// a list fetched within this long is reused unless the user asked to check
export const LIST_REUSE_MS: number = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const THUMB_CONCURRENCY = 4;
export const STORE_FOLDER = 'store';
const LIST_FILE = 'list.json';
const THUMBS_FOLDER = 'thumbs';
// list.json holds the envelope as it came, at most MAX_LIST_BYTES, and a few short fields
const MAX_KEPT_BYTES: number = MAX_LIST_BYTES + 4096;
const MAX_CAUSE_DEPTH = 5;

export interface StoreFetch { readonly url: string; readonly purpose: 'list' | 'thumbnail' }

export type StoreFetcher = (url: string, init: RequestInit, options: SafeFetchOptions) => Promise<Response>;

export interface StoreListOptions {
  // the theme store's root (~/.damocles/themes)
  readonly root: string;
  readonly lane: WriteLane;
  // the network rule its files are judged by; absent: the root's own, with no notice
  readonly rule?: ThemePathRule;
  // damocles.desktop.themes.store: off, the store makes no request at all
  readonly enabled: () => boolean;
  readonly fetch?: StoreFetcher;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  // hears every request the store makes, before it is made
  readonly onFetch?: (fetch: StoreFetch) => void;
  // CoreInit.e2eThemeStore with e2eThemeDownloads as `folder`; the caller passes it only with CoreInit.e2eHooks on
  readonly e2e?: { readonly listUrl: string; readonly publicKeyPem: string; readonly folder: string };
}

/**
 * `fetched`: this call made a request. `cached`: the request failed, so the last verified list shows. `unreachable`: it failed
 * and there is no list yet. `refused`: the list that came was refused; `last` is the previous verified list, which stays.
 */
export type StoreListResult =
  | { readonly state: 'off' }
  | { readonly state: 'ok'; readonly payload: StorePayload; readonly fetchedAt: number; readonly fetched: boolean }
  | { readonly state: 'cached'; readonly payload: StorePayload; readonly fetchedAt: number; readonly reason: LocalizedText; readonly fetched: true }
  | { readonly state: 'unreachable'; readonly reason: LocalizedText; readonly fetched: true }
  | { readonly state: 'refused'; readonly reason: LocalizedText; readonly last?: { readonly payload: StorePayload; readonly fetchedAt: number }; readonly fetched: true };

export interface StoreList {
  /**
   * The list: refresh false reuses one fetched within LIST_REUSE_MS (Browse opening, the background check, an install) unless a
   * refusal was met since, true always asks GitHub. Rejects with the signal's reason when `signal` aborts the request.
   */
  list(options: { readonly refresh: boolean; readonly signal?: AbortSignal }): Promise<StoreListResult>;
  /** The kept verified list while it has not expired, read from disk with no request. */
  kept(): Promise<{ readonly payload: StorePayload; readonly fetchedAt: number } | undefined>;
  /**
   * Fetches up to MAX_THUMBS_PER_CALL of the payload's thumbnails not yet kept, keeps each only when its SHA-256 matches and it
   * is a WebP, and drops kept ones it no longer names; whether a file was kept or dropped. One run at a time: a call for the
   * list a run is fetching for joins it, and another list's waits for it.
   */
  fetchThumbnails(payload: StorePayload): Promise<boolean>;
  /** The SHA-256s of the kept thumbnails, each of which matched its hash when written; one folder read. */
  keptThumbnails(): Promise<ReadonlySet<string>>;
  /** The store setting went off: every request in flight ends. */
  turnedOff(): void;
  /** Aborts when the store setting next goes off. */
  offSignal(): AbortSignal;
  // whether the e2e hooks' host and test key are accepted, for releaseDownloadAllowed
  readonly e2e: boolean;
}

interface SequenceMark { readonly sequence: number; readonly keyId: string }

interface Kept {
  readonly envelope?: StoreEnvelope;
  readonly payload?: StorePayload;
  readonly fetchedAt?: number;
  // the highest sequence seen and the key whose list set it
  readonly high?: SequenceMark;
  // a list that came after the kept one was refused then, and no list has verified since
  readonly refusedAt?: number;
}

type Download = { readonly bytes: Uint8Array } | { readonly refused: LocalizedText } | { readonly unreachable: LocalizedText } | { readonly off: true };

// an expired list is never shown, so a blocked host cannot hold the app on an old one
function shown(kept: Kept, at: number): { readonly payload: StorePayload; readonly fetchedAt: number } | undefined {
  return kept.payload !== undefined && kept.fetchedAt !== undefined && kept.payload.expiresAt > at ? { payload: kept.payload, fetchedAt: kept.fetchedAt } : undefined;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const onHosts = (url: string, hosts: readonly string[]): boolean => {
  if (!URL.canParse(url)) return false;
  const target = new URL(url);
  return target.protocol === 'https:' && target.port === '' && target.username === '' && target.password === '' && hosts.includes(target.hostname);
};

// undici reports a failed connection as "fetch failed" and keeps why in `cause`
function causeChain(err: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = err; current instanceof Error && chain.length < MAX_CAUSE_DEPTH; current = current.cause) chain.push(current);
  return chain;
}

function causeText(err: unknown): string {
  const named = causeChain(err).reverse().find((cause) => cause.message !== '' || typeof (cause as NodeJS.ErrnoException).code === 'string');
  if (!named) return String(err);
  const { code } = named as NodeJS.ErrnoException;
  if (typeof code !== 'string' || named.message.includes(code)) return named.message;
  return named.message === '' ? code : `${named.message} (${code})`;
}

export function createStoreList(options: StoreListOptions): StoreList {
  const fetcher = options.fetch ?? safeFetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => undefined);
  const { e2e } = options;
  if (e2e && !(onHosts(e2e.listUrl, [E2E_HOST]) && e2eFileName(new URL(e2e.listUrl)) !== undefined)) {
    throw new Error(`The e2e store list must be https://${E2E_HOST}/<name>, not ${e2e.listUrl}`);
  }
  const keys = trustedStoreKeys(e2e?.publicKeyPem);
  const hosts = e2e ? [...LIST_HOSTS, E2E_HOST] : LIST_HOSTS;
  const folder = path.join(options.root, STORE_FOLDER);
  const listFile = path.join(folder, LIST_FILE);
  const thumbsFolder = path.join(folder, THUMBS_FOLDER);
  const rule = options.rule ?? createThemePathRule(options.root);
  let off = new AbortController();
  // the kept list as last parsed, for the file state it was parsed from
  let parsed: { readonly mtimeMs: number; readonly size: number; readonly kept: Kept } | undefined;
  // thumbnails this run fetched and found unusable whatever is fetched again: off the store's hosts, or not a WebP
  const unusableThumbs = new Set<string>();

  async function readKept(): Promise<Kept> {
    await rule.readable(listFile);
    let stat: { readonly mtimeMs: number; readonly size: number };
    try {
      stat = await fs.stat(listFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    if (parsed?.mtimeMs === stat.mtimeMs && parsed.size === stat.size) return parsed.kept;
    const kept = await parseKept();
    parsed = { mtimeMs: stat.mtimeMs, size: stat.size, kept };
    return kept;
  }

  async function parseKept(): Promise<Kept> {
    let text: string;
    try {
      text = new TextDecoder().decode(await readCappedFile(listFile, MAX_KEPT_BYTES));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (!(err instanceof ArchiveRefusedError)) throw err;
      log(`[themes] ${listFile} could not be read, so the store starts without a kept list: ${JSON.stringify(err.text)}`);
      return {};
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      log(`[themes] ${listFile} does not parse, so the store starts without a kept list: ${err.message}`);
      return {};
    }
    if (!isRecord(json) || json['version'] !== 1) {
      log(`[themes] ${listFile} is not a store list file, so the store starts without a kept list`);
      return {};
    }
    const envelope = json['envelope'];
    const fetchedAt = isCount(json['fetchedAt']) ? json['fetchedAt'] : undefined;
    const refusedAt = isCount(json['refusedAt']) ? json['refusedAt'] : undefined;
    // a file written before the mark named its key: the kept list's key set it
    const markKeyId = typeof json['highestSequenceKeyId'] === 'string' ? json['highestSequenceKeyId'] : isRecord(envelope) && typeof envelope['keyId'] === 'string' ? envelope['keyId'] : undefined;
    // the mark goes with its key: a key a release removed may have signed any sequence, which would refuse every later list
    const mark = isCount(json['highestSequence']) && markKeyId !== undefined && keys.has(markKeyId) ? { sequence: json['highestSequence'], keyId: markKeyId } : undefined;
    // read back with the keys this app trusts now, so a list signed by a key a release removed is dropped
    const verdict = verifyEnvelope(envelope, keys, e2e !== undefined);
    if (!verdict.ok || fetchedAt === undefined) {
      if (!verdict.ok) log(`[themes] the kept store list no longer verifies: ${JSON.stringify(verdict.reason)}`);
      return mark ? { high: mark } : {};
    }
    const own = { sequence: verdict.payload.sequence, keyId: verdict.envelope.keyId };
    return { envelope: verdict.envelope, payload: verdict.payload, fetchedAt, high: mark && mark.sequence > own.sequence ? mark : own, ...(refusedAt !== undefined ? { refusedAt } : {}) };
  }

  // Call inside the write lane.
  async function writeKept(kept: { readonly envelope: StoreEnvelope; readonly fetchedAt: number; readonly high: SequenceMark; readonly refusedAt?: number }): Promise<void> {
    await rule.writable(listFile);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const file = {
      version: 1,
      envelope: kept.envelope,
      fetchedAt: kept.fetchedAt,
      highestSequence: kept.high.sequence,
      highestSequenceKeyId: kept.high.keyId,
      ...(kept.refusedAt !== undefined ? { refusedAt: kept.refusedAt } : {}),
    };
    await writeFileAtomic(listFile, `${JSON.stringify(file)}\n`, { held: options.lane.held });
    parsed = undefined;
  }

  async function download(url: string, purpose: StoreFetch['purpose'], max: number, signal?: AbortSignal): Promise<Download> {
    // every list and thumbnail request passes here, so none is made once the setting is off
    if (!options.enabled()) return { off: true };
    options.onFetch?.({ url, purpose });
    const target = new URL(url);
    if (e2e && target.hostname === E2E_HOST) {
      const name = e2eFileName(target);
      if (name === undefined) return { refused: l('{0} is not a link Damocles can open.', verbatim(url.slice(0, 200))) };
      try {
        return { bytes: await readE2eFile(e2e.folder, name, max) };
      } catch (err) {
        return { unreachable: errorTextOf(err) };
      }
    }
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const turnedOff = off.signal;
    try {
      const response = await fetcher(url, { signal: AbortSignal.any([timeout, turnedOff, ...(signal ? [signal] : [])]) }, { httpsOnly: true, redirectRefused: (next) => !onHosts(next, hosts) });
      if (!response.ok) {
        await response.body?.cancel();
        return { unreachable: l('GitHub answered HTTP {0}.', String(response.status)) };
      }
      return { bytes: await readBodyCapped(response, max) };
    } catch (err) {
      signal?.throwIfAborted();
      if (turnedOff.aborted) return { off: true };
      if (timeout.aborted) return { unreachable: l('GitHub did not answer within {0} seconds.', String(FETCH_TIMEOUT_MS / 1000)) };
      if (err instanceof RedirectRefusedError) {
        const next = URL.canParse(err.location) ? new URL(err.location).host : err.location.slice(0, 200);
        return { refused: l('GitHub sent the request on to {0}, a host the community store does not use, so Damocles did not follow it.', verbatim(next)) };
      }
      if (err instanceof ResponseTooLargeError) {
        return { refused: l('The answer is larger than {0} MB, the most Damocles reads for the community store.', String(max / 1024 / 1024)) };
      }
      if (err instanceof FetchRefusedError) return { refused: l('Damocles did not make the request: {0}', verbatim(err.message)) };
      log(`[themes] a store request to ${target.host} failed: ${causeChain(err).map((cause) => cause.message).join(' <- ') || String(err)}`);
      return { unreachable: verbatim(causeText(err)) };
    }
  }

  async function fetchList(signal: AbortSignal | undefined): Promise<StoreListResult> {
    const got = await download(e2e ? e2e.listUrl : STORE_LIST_URL, 'list', MAX_LIST_BYTES, signal);
    if ('off' in got) return { state: 'off' };
    if ('unreachable' in got) {
      log(`[themes] the store list could not be fetched: ${JSON.stringify(got.unreachable)}`);
      const kept = await readKept();
      const last = shown(kept, now());
      if (last) return { state: 'cached', ...last, reason: l('Damocles could not fetch the community store list: {0}', got.unreachable), fetched: true };
      const reason = kept.payload !== undefined
        ? l('Damocles could not fetch the community store list, and the list it kept expired on {0}: {1}', new Date(kept.payload.expiresAt).toISOString().slice(0, 10), got.unreachable)
        : l('Damocles could not fetch the community store list: {0}', got.unreachable);
      return { state: 'unreachable', reason, fetched: true };
    }
    // The kept list stays as it is; only the attempt is recorded, so the list is asked for again until one verifies. Call inside the lane.
    const refusedIn = async (current: Kept, reason: LocalizedText, at: number): Promise<StoreListResult> => {
      log(`[themes] the store list was refused: ${JSON.stringify(reason)}`);
      if (current.envelope !== undefined && current.fetchedAt !== undefined && current.high !== undefined) {
        await writeKept({ envelope: current.envelope, fetchedAt: current.fetchedAt, high: current.high, refusedAt: at });
      }
      const last = shown(current, at);
      return { state: 'refused', reason, ...(last ? { last } : {}), fetched: true };
    };
    const refuse = (reason: LocalizedText): Promise<StoreListResult> => options.lane.run(async () => refusedIn(await readKept(), reason, now()));
    if ('refused' in got) return refuse(got.refused);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(got.bytes)) as unknown;
    } catch (err) {
      if (!(err instanceof SyntaxError) && !(err instanceof TypeError)) throw err;
      return refuse(l('The community store list is not signed, so Damocles did not use it.'));
    }
    const verdict = verifyEnvelope(json, keys, e2e !== undefined);
    if (!verdict.ok) return refuse(verdict.reason);
    // the highest sequence is read again under the lane, since another Damocles on this computer may have kept a newer list
    return options.lane.run(async () => {
      const current = await readKept();
      const fetchedAt = now();
      const stale = checkFreshness(verdict.payload, { highestSequence: current.high?.sequence, now: fetchedAt });
      if (stale) return refusedIn(current, stale, fetchedAt);
      // a list that passed is at or above the mark, so its own key now holds it
      await writeKept({ envelope: verdict.envelope, fetchedAt, high: { sequence: verdict.payload.sequence, keyId: verdict.envelope.keyId } });
      return { state: 'ok', payload: verdict.payload, fetchedAt, fetched: true } as const;
    });
  }

  // one list call at a time, so a check right after another reuses what the first kept
  let queue: Promise<unknown> = Promise.resolve();
  function list(request: { readonly refresh: boolean; readonly signal?: AbortSignal }): Promise<StoreListResult> {
    const next = queue.then(() => listNow(request));
    queue = next.catch(() => undefined);
    return next;
  }

  async function listNow(request: { readonly refresh: boolean; readonly signal?: AbortSignal }): Promise<StoreListResult> {
    if (!options.enabled()) return { state: 'off' };
    request.signal?.throwIfAborted();
    const kept = await readKept();
    const at = now();
    const reusable = kept.refusedAt === undefined && kept.payload !== undefined && kept.fetchedAt !== undefined && kept.fetchedAt <= at && at - kept.fetchedAt < LIST_REUSE_MS && kept.payload.expiresAt > at;
    if (!request.refresh && reusable) return { state: 'ok', payload: kept.payload, fetchedAt: kept.fetchedAt, fetched: false };
    return fetchList(request.signal);
  }

  // The thumbnail's bytes once its hash matched and it is a WebP; 'unreachable' when the request itself failed.
  async function fetchThumbnail(url: string, sha256: string): Promise<Uint8Array | 'unreachable' | undefined> {
    if (!onHosts(url, hosts)) {
      log(`[themes] a store thumbnail is not on a host the store uses, so it was not fetched: ${url.slice(0, 200)}`);
      unusableThumbs.add(sha256);
      return undefined;
    }
    const got = await download(url, 'thumbnail', MAX_THUMB_BYTES);
    if ('off' in got) return undefined;
    if (!('bytes' in got)) {
      log(`[themes] a store thumbnail could not be fetched from ${url.slice(0, 200)}: ${JSON.stringify('refused' in got ? got.refused : got.unreachable)}`);
      return 'unreachable' in got ? 'unreachable' : undefined;
    }
    if (createHash('sha256').update(got.bytes).digest('hex') !== sha256) {
      log(`[themes] a store thumbnail does not match its SHA-256, so it was not kept: ${url.slice(0, 200)}`);
      return undefined;
    }
    // main serves only a WebP, so any other file would be listed and never shown
    if (!isWebp(got.bytes)) {
      log(`[themes] a store thumbnail is not a WebP, so it was not kept: ${url.slice(0, 200)}`);
      unusableThumbs.add(sha256);
      return undefined;
    }
    return got.bytes;
  }

  async function keptThumbnails(): Promise<Set<string>> {
    await rule.readable(thumbsFolder);
    try {
      return new Set((await fs.readdir(thumbsFolder)).filter((name) => SHA256.test(name)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw err;
    }
  }

  async function runThumbnails(payload: StorePayload): Promise<boolean> {
    if (!options.enabled()) return false;
    const wanted = new Map<string, string>();
    for (const entry of payload.entries) {
      for (const thumb of [...(entry.thumbnails.dark ?? []), ...(entry.thumbnails.light ?? [])]) wanted.set(thumb.sha256, thumb.url);
    }
    const kept = await keptThumbnails();
    const missing = [...wanted].filter(([sha256]) => !kept.has(sha256) && !unusableThumbs.has(sha256)).slice(0, MAX_THUMBS_PER_CALL);
    let changed = false;
    for (let i = 0; i < missing.length && options.enabled(); i += THUMB_CONCURRENCY) {
      const batch = await Promise.all(missing.slice(i, i + THUMB_CONCURRENCY).map(async ([sha256, url]) => ({ sha256, got: await fetchThumbnail(url, sha256) })));
      const verified = batch.flatMap(({ sha256, got }) => (got instanceof Uint8Array ? [{ sha256, bytes: got }] : []));
      if (verified.length > 0) {
        await options.lane.run(async () => {
          for (const { sha256, bytes } of verified) {
            await rule.writable(path.join(thumbsFolder, sha256));
            await fs.mkdir(thumbsFolder, { recursive: true, mode: 0o700 });
            await writeFileAtomic(path.join(thumbsFolder, sha256), bytes, { held: options.lane.held });
          }
        });
        changed = true;
      }
      // a network that answers nothing is not asked for every thumbnail in turn
      if (batch.every(({ got }) => got === 'unreachable')) break;
    }
    const unnamed = [...kept].filter((sha256) => !wanted.has(sha256));
    if (unnamed.length > 0) {
      await options.lane.run(async () => {
        for (const sha256 of unnamed) {
          await rule.writable(path.join(thumbsFolder, sha256));
          await fs.rm(path.join(thumbsFolder, sha256), { force: true });
        }
      });
      changed = true;
    }
    return changed;
  }

  let running: { readonly sequence: number; readonly done: Promise<boolean> } | undefined;
  let waiting: { payload: StorePayload; readonly done: Promise<boolean> } | undefined;
  function startThumbnails(payload: StorePayload): Promise<boolean> {
    const run = { sequence: payload.sequence, done: runThumbnails(payload) };
    running = run;
    const ended = (): void => {
      if (running === run) running = undefined;
    };
    run.done.then(ended, ended);
    return run.done;
  }
  function fetchThumbnails(payload: StorePayload): Promise<boolean> {
    if (!running) return startThumbnails(payload);
    // an equal sequence is the same list
    if (running.sequence === payload.sequence) return running.done;
    if (waiting) {
      waiting.payload = payload;
      return waiting.done;
    }
    const next: { payload: StorePayload; done: Promise<boolean> } = {
      payload,
      done: running.done.then(() => undefined, () => undefined).then(() => {
        waiting = undefined;
        return fetchThumbnails(next.payload);
      }),
    };
    waiting = next;
    return next.done;
  }

  return {
    list,
    async kept() {
      return shown(await readKept(), now());
    },
    fetchThumbnails,
    keptThumbnails,
    turnedOff() {
      off.abort();
      off = new AbortController();
    },
    offSignal: () => off.signal,
    e2e: e2e !== undefined,
  };
}
