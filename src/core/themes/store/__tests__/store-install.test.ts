// The store's install side through the real theme service: Install and Update from a signed list, the pin checked before the
// file is read, minAppVersion, the your-edits copy, and removed entries. Downloads go through the real safeFetch with undici's
// fetch mocked, so its literal check and the release-host redirect rule run on every hop; the connection's DNS guard is covered
// in safe-fetch.test.ts. The list comes from a fake fetcher.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recolor } from '../../__tests__/service-fixtures';

const { lookupMock, fetchMock, trust } = vi.hoisted(() => ({ lookupMock: vi.fn(), fetchMock: vi.fn(), trust: { pem: undefined as string | undefined } }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), fetch: fetchMock }));
// the list trusts the test key as the e2e hooks' key would be trusted
vi.mock('../../store-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store-keys')>();
  return { ...actual, trustedStoreKeys: (pem?: string) => actual.trustedStoreKeys(pem ?? trust.pem) };
});

import type { SettingsStore } from '../../../../platform/settings-store';
import { BUILTIN_THEME_ID } from '../../../../shared/themes/builtin';
import { USER_ACTOR } from '../../../../shared/themes/changes';
import { folderKey } from '../../../workspace-folders/folder-key';
import { writeThemeArchive } from '../../archive';
import { createThemeService, PREFERRED_LOOK_SETTINGS, type ThemeService } from '../../index';
import { contentHash } from '../../install';
import type { StoreView } from '../../../../shared/themes/store';
import { createStoreClient, needsNewerApp, type StoreClient, type StoreClientDeps } from '../install';
import { createStoreList, type StoreFetch, type StoreFetcher, type StoreList, type StoreListResult } from '../list';
import { verifyEnvelope, type StorePayload } from '../verify';
import { trustedStoreKeys } from '../../store-keys';
import { entry, payload, SEEDS, signed, testKey } from './store-fixtures';

const NOW = Date.UTC(2026, 10, 19, 12);
const key = testKey();
const RELEASE_URL = 'https://github.com/ada/aurora/releases/download/v1/aurora.damocles-theme';
const ASSET_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/aurora.damocles-theme';
const PROJECT = folderKey(path.resolve('/work/site'));
const HOUR = 60 * 60 * 1000;
const THUMB = new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('thumb')]));
const THUMB_SHA = createHash('sha256').update(THUMB).digest('hex');
const THUMB_URL = `https://raw.githubusercontent.com/AizenvoltPrime/damocles-themes/main/thumbs/${THUMB_SHA}.webp`;
const WITH_THUMB = { thumbnails: { dark: [{ panel: 'chat', url: THUMB_URL, sha256: THUMB_SHA }] } };

let root: string;
let themes: ThemeService;
let list: StoreList;
let client: StoreClient;
let enabled: boolean;
let listFetches: StoreFetch[];
let listBody: Record<string, unknown>;

function fakeSettings(file: string): SettingsStore {
  return {
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? file : undefined),
  } as unknown as SettingsStore;
}

const settingsFile = (): string => path.join(root, 'settings.json');
const readSettings = (): Record<string, unknown> => JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>;

const theme = (name: string, version: string): Record<string, unknown> => ({
  schemaVersion: 1,
  id: '11111111-2222-4333-8444-555555555555',
  name,
  version,
  author: 'Ada',
  license: 'CC0-1.0',
  looks: { dark: { colors: SEEDS } },
});

const archive = (name = 'Aurora', version = '1.0.0'): Promise<Uint8Array> => writeThemeArchive(JSON.stringify(theme(name, version)), new Map());
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The list's one entry for `bytes`, with the pin of those bytes unless `file` says otherwise. */
const listed = (bytes: Uint8Array, overrides: Record<string, unknown> = {}, file: Record<string, unknown> = {}): Record<string, unknown> =>
  entry({ file: { url: RELEASE_URL, sha256: sha(bytes), bytes: bytes.length, ...file }, minAppVersion: '3.8.0', thumbnails: {}, ...overrides });

const serveList = (entries: readonly Record<string, unknown>[], removed: readonly Record<string, unknown>[] = [], sequence = 5): void => {
  listBody = signed(key, payload(NOW, { entries, removed, sequence }));
};

const listFetcher: StoreFetcher = async (url) => (url === THUMB_URL ? new Response(THUMB, { status: 200 }) : new Response(JSON.stringify(listBody), { status: 200 }));

/** The verified payload of a list of `entries`, as the store list would hand it on. */
function verified(entries: readonly Record<string, unknown>[], overrides: Record<string, unknown> = {}): StorePayload {
  const verdict = verifyEnvelope(signed(key, payload(NOW, { entries, ...overrides })), trustedStoreKeys(key.publicPem));
  if (!verdict.ok) throw new Error(JSON.stringify(verdict.reason));
  return verdict.payload;
}

/** A store list that answers `result()` to every read and keeps no thumbnail. */
function fakeList(result: () => StoreListResult): StoreList {
  return {
    list: async () => result(),
    kept: async () => undefined,
    fetchThumbnails: async () => false,
    keptThumbnails: async () => new Set<string>(),
    turnedOff: () => undefined,
    offSignal: () => new AbortController().signal,
    e2e: false,
  };
}

const clientOf = (deps: Partial<StoreClientDeps>): StoreClient => createStoreClient({ themes, list, enabled: () => enabled, appVersion: '3.8.0', now: () => NOW, ...deps });

/** The views a client tells its listeners, with whether each followed a read of the list. */
function viewsOf(of: StoreClient): Array<{ view: StoreView; listRead: boolean }> {
  const told: Array<{ view: StoreView; listRead: boolean }> = [];
  of.onUpdated((view, listRead) => told.push({ view, listRead }));
  return told;
}

const redirect = (location: string): Response =>
  ({ status: 302, ok: false, headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) }, body: null }) as unknown as Response;

const userThemes = async () => (await themes.list()).filter((candidate) => candidate.status === 'ok' && !candidate.builtin);
const blobsStored = (): string[] => fs.readdirSync(path.join(root, 'blobs'), { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name);

async function installedTheme(id: string) {
  const found = (await themes.list()).find((candidate) => candidate.id === id);
  if (found?.status !== 'ok') throw new Error(`${id} is not installed`);
  return found;
}

/** Install from Browse and commit the card: the theme id. */
async function installFromStore(bytes: Uint8Array): Promise<string> {
  fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
  const preview = await client.install('aurora');
  const committed = await themes.installCommit({ installId: preview.installId, useArrangement: false });
  if (!('installed' in committed)) throw new Error(`not installed: ${committed.refused.message}`);
  return committed.installed.themeId;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-store-install-'));
  fs.writeFileSync(settingsFile(), '{}\n');
  themes = createThemeService({ root, settings: fakeSettings(settingsFile()), now: () => NOW });
  enabled = true;
  listFetches = [];
  trust.pem = key.publicPem;
  list = createStoreList({ root, lane: themes.lane, enabled: () => enabled, fetch: listFetcher, now: () => NOW, log: () => undefined, onFetch: (fetch) => listFetches.push(fetch) });
  client = clientOf({});
  fetchMock.mockReset();
  lookupMock.mockReset();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('store install', () => {
  it('downloads the pinned file from its release host, follows GitHub\'s redirect to its asset host, and installs with a store origin', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    fetchMock.mockResolvedValueOnce(redirect(ASSET_URL)).mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const preview = await client.install('aurora');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([RELEASE_URL, ASSET_URL]);
    // undici is mocked, so no connection is made and the connection's DNS guard never runs here
    expect(lookupMock).not.toHaveBeenCalled();
    expect(preview.source).toEqual({ kind: 'store', host: 'github.com', fileName: 'aurora.damocles-theme' });
    expect(preview.store).toEqual({ entryId: 'aurora', version: '1.0.0' });
    expect(await userThemes()).toEqual([]);
    const committed = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    if (!('installed' in committed)) throw new Error(committed.refused.message);
    const installed = await installedTheme(committed.installed.themeId);
    expect(installed.theme.origin).toEqual({
      kind: 'store',
      url: RELEASE_URL,
      store: { entryId: 'aurora', version: '1.0.0', sha256: sha(bytes) },
      installedHash: contentHash(installed.theme),
      installedAt: NOW,
    });
    const view = await client.view(false);
    expect(view.entries.map(({ id, status, installedThemeId }) => ({ id, status, installedThemeId }))).toEqual([{ id: 'aurora', status: 'installed', installedThemeId: installed.id }]);
  });

  it('refuses a download shorter than its pinned size before reading it, staging nothing', async () => {
    const bytes = await archive();
    serveList([listed(bytes, {}, { bytes: bytes.length + 1 })]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const staged = vi.spyOn(themes, 'installStage');
    await expect(client.install('aurora')).rejects.toThrow(`The downloaded theme is ${bytes.length} bytes, but the community store list pins ${bytes.length + 1} bytes`);
    expect(staged).not.toHaveBeenCalled();
  });

  it('stops a download longer than its pinned size as it streams', async () => {
    const bytes = await archive();
    serveList([listed(bytes, {}, { bytes: bytes.length - 1 })]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const staged = vi.spyOn(themes, 'installStage');
    await expect(client.install('aurora')).rejects.toThrow(`larger than the ${bytes.length - 1} bytes the store list pins`);
    expect(staged).not.toHaveBeenCalled();
  });

  it('refuses bytes whose SHA-256 differs from the pin before reading them, even bytes that are no archive at all', async () => {
    const bytes = await archive();
    const other = new Uint8Array(bytes.length).fill(7);
    serveList([listed(bytes)]);
    fetchMock.mockResolvedValueOnce(new Response(other, { status: 200 }));
    const staged = vi.spyOn(themes, 'installStage');
    // a parse would have said "not a zip archive"; the pin refuses first
    await expect(client.install('aurora')).rejects.toThrow("The downloaded theme's SHA-256 does not match the community store list's pin");
    expect(staged).not.toHaveBeenCalled();
    expect(await userThemes()).toEqual([]);
  });

  it('refuses a file URL off the GitHub release hosts without making a request, in a list the parser did not refuse', async () => {
    const bytes = await archive();
    const [onHost] = verified([listed(bytes)]).entries;
    const offHost: StorePayload = { ...verified([]), entries: [{ ...onHost!, file: { ...onHost!.file, url: 'https://themes.example/aurora.damocles-theme' } }] };
    const install = clientOf({ list: fakeList(() => ({ state: 'ok', payload: offHost, fetchedAt: NOW, fetched: false })) }).install('aurora');
    await expect(install).rejects.toThrow('not on a GitHub release host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a host that is not a release host, naming it, without contacting it', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    fetchMock.mockResolvedValueOnce(redirect('https://cdn.elsewhere.example/aurora.damocles-theme'));
    await expect(client.install('aurora')).rejects.toThrow('github.com sends the download on to cdn.elsewhere.example, which is not a GitHub release host');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an entry that needs a newer Damocles in core, and installs one whose minAppVersion is this version', async () => {
    const bytes = await archive();
    serveList([listed(bytes, { minAppVersion: '3.9.0' })]);
    expect((await client.view(false)).entries[0]?.status).toBe('needsNewerApp');
    await expect(client.install('aurora')).rejects.toThrow('Aurora needs Damocles 3.9.0 or newer.');
    expect(fetchMock).not.toHaveBeenCalled();
    serveList([listed(bytes, { minAppVersion: '3.8.0' })], [], 6);
    expect((await client.view(true)).entries[0]?.status).toBe('available');
    await installFromStore(bytes);
  });

  it('compares minAppVersion as a version, a prerelease app below its release', () => {
    expect(needsNewerApp('3.8.0', '3.8.0')).toBe(false);
    expect(needsNewerApp('3.7.9', '3.8.0')).toBe(false);
    expect(needsNewerApp('3.10.0', '3.9.0')).toBe(true);
    expect(needsNewerApp('4.0.0', '3.99.99')).toBe(true);
    expect(needsNewerApp('3.8.0', '3.8.0-beta.1')).toBe(true);
    expect(needsNewerApp('3.7.0', '3.8.0-beta.1')).toBe(false);
  });

  it('ignores build metadata in the app version, and reads a version that is none as below every entry', async () => {
    expect(needsNewerApp('3.8.0', '3.8.0+sha.5d2f')).toBe(false);
    expect(needsNewerApp('3.8.0', '3.8.0+build-7')).toBe(false);
    expect(needsNewerApp('3.8.0', '3.8.0-beta.1+5')).toBe(true);
    expect(needsNewerApp('3.9.0', '3.8.0+sha')).toBe(true);
    expect(needsNewerApp('0.0.1', 'dev')).toBe(true);
    const bytes = await archive();
    serveList([listed(bytes)]);
    const id = await installFromStore(bytes);
    serveList([listed(await archive('Aurora', '2.0.0'), { version: '2.0.0' })], [], 6);
    const lines: string[] = [];
    const nameless = clientOf({ appVersion: 'dev', log: (line) => lines.push(line) });
    expect(lines).toEqual(['[themes] the app version dev is not x.y.z, so every store theme reads as needing a newer Damocles']);
    expect((await nameless.view(true)).entries[0]).toMatchObject({ status: 'needsNewerApp', installedThemeId: id });
    expect(await nameless.updates()).toEqual(new Map());
  });

  it('refuses everything while the store setting is off, with no request', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    enabled = false;
    await expect(client.install('aurora')).rejects.toThrow('The community store is off');
    expect(await client.view(false)).toEqual({ state: 'off', entries: [] });
    expect(await client.backgroundCheck()).toEqual({ fetched: false });
    expect(listFetches).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads nothing when the setting goes off between the list read and the download', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    // install reads the installed themes after the list and before the download
    const off = clientOf({ themes: { ...themes, list: async () => {
      enabled = false;
      return themes.list();
    } } });
    await expect(off.install('aurora')).rejects.toThrow('The community store is off');
    expect(listFetches.map((fetch) => fetch.purpose)).toEqual(['list']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends a download in flight when the setting goes off, as the store\'s own refusal', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))));
    const staged = vi.spyOn(themes, 'installStage');
    const install = client.install('aurora');
    const refused = expect(install).rejects.toThrow('The community store is off');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    enabled = false;
    list.turnedOff();
    await refused;
    expect(staged).not.toHaveBeenCalled();
  });

  it('stages nothing once its caller cancelled, even after the last byte arrived', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const caller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      caller.abort(new Error('Settings closed'));
      return new Response(bytes, { status: 200 });
    });
    const staged = vi.spyOn(themes, 'installStage');
    await expect(client.install('aurora', caller.signal)).rejects.toThrow('Settings closed');
    expect(staged).not.toHaveBeenCalled();
  });

  it('makes no list request for a caller that already cancelled', async () => {
    serveList([listed(await archive())]);
    const caller = new AbortController();
    caller.abort(new Error('Settings closed'));
    await expect(client.install('aurora', caller.signal)).rejects.toThrow('Settings closed');
    expect(listFetches).toEqual([]);
  });
});

describe('store install from the kept list', () => {
  it('installs from the kept list when the list request fails, and the view says why it failed', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    await client.view(true);
    let fails = true;
    const failing = createStoreList({ root, lane: themes.lane, enabled: () => enabled, fetch: async (url, init, options) => (fails ? new Response('busy', { status: 503 }) : listFetcher(url, init, options)), now: () => NOW + 25 * HOUR, log: () => undefined });
    const later = clientOf({ list: failing, now: () => NOW + 25 * HOUR });
    const view = await later.view(false);
    expect(view).toMatchObject({ state: 'cached', fetchedAt: NOW, refusedReason: { message: 'Damocles could not fetch the community store list: {0}', args: [{ message: 'GitHub answered HTTP {0}.', args: ['503'] }] } });
    expect(view.entries.map((shown) => shown.status)).toEqual(['available']);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    expect((await later.install('aurora')).store).toEqual({ entryId: 'aurora', version: '1.0.0' });
    fails = false;
  });

  it('refuses to install from a list that expired since it was read, or that no longer lists the entry', async () => {
    const bytes = await archive();
    const kept = verified([listed(bytes)]);
    let at = NOW;
    let result: StoreListResult = { state: 'ok', payload: kept, fetchedAt: NOW, fetched: false };
    const stale = clientOf({ list: fakeList(() => result), now: () => at });
    at = kept.expiresAt;
    await expect(stale.install('aurora')).rejects.toThrow('The saved community store list has expired');
    at = NOW;
    result = { state: 'ok', payload: verified([]), fetchedAt: NOW, fetched: true };
    await expect(stale.install('aurora')).rejects.toThrow('This theme is no longer in the community store list.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows nothing of, and badges nothing from, a list that expired since this run read it', async () => {
    const one = await archive();
    serveList([listed(one)]);
    const id = await installFromStore(one);
    const kept = verified([listed(await archive('Aurora', '2.0.0'), { version: '2.0.0' })]);
    let at = NOW;
    const aging = clientOf({ list: fakeList(() => ({ state: 'ok', payload: kept, fetchedAt: NOW, fetched: true })), now: () => at });
    const told = viewsOf(aging);
    expect((await aging.view(false)).entries.map((shown) => shown.status)).toEqual(['update']);
    expect(await aging.updates()).toEqual(new Map([[id, '2.0.0']]));
    at = kept.expiresAt;
    expect(await aging.updates()).toEqual(new Map());
    await aging.repeatView();
    expect(told.at(-1)).toEqual({ view: { state: 'unreachable', refusedReason: { message: 'The community store list Damocles kept expired on {0}, so Damocles does not show it.', args: ['2026-12-18'] }, entries: [] }, listRead: false });
  });
});

describe('the views the store tells', () => {
  it('tells the view again with its thumbnails once they are kept, whatever read the list meanwhile', async () => {
    const bytes = await archive();
    serveList([listed(bytes, WITH_THUMB)]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slowThumbs: StoreFetcher = async (url, init, options) => {
      if (url === THUMB_URL) await held;
      return listFetcher(url, init, options);
    };
    const slow = clientOf({ list: createStoreList({ root, lane: themes.lane, enabled: () => enabled, fetch: slowThumbs, now: () => NOW, log: () => undefined }) });
    const told = viewsOf(slow);
    expect((await slow.view(false)).entries[0]?.thumbnails).toEqual({ dark: [] });
    // an install reads the list again while the thumbnail is still on its way
    fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    await slow.install('aurora');
    release();
    await vi.waitFor(() => expect(told).toHaveLength(2));
    expect(told.map((each) => each.listRead)).toEqual([true, false]);
    expect(told[1]!.view.entries[0]?.thumbnails).toEqual({ dark: [{ panel: 'chat', sha256: THUMB_SHA }] });
  });

  it('tells no second view when no thumbnail was kept or dropped', async () => {
    serveList([listed(await archive())]);
    const told = viewsOf(client);
    await client.view(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(told.map((each) => each.listRead)).toEqual([true]);
  });

  it('asks for no thumbnail of a list whose request just failed', async () => {
    serveList([listed(await archive(), WITH_THUMB)]);
    await list.list({ refresh: true });
    const failing = createStoreList({ root, lane: themes.lane, enabled: () => enabled, fetch: async () => new Response('busy', { status: 503 }), now: () => NOW, log: () => undefined, onFetch: (fetch) => listFetches.push(fetch) });
    listFetches = [];
    expect((await clientOf({ list: failing }).view(true)).state).toBe('cached');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listFetches.map((fetch) => fetch.purpose)).toEqual(['list']);
  });

  it('never tells a view built from an older read after a newer one', async () => {
    const first = verified([listed(await archive())]);
    const second = verified([]);
    let result: StoreListResult = { state: 'ok', payload: first, fetchedAt: NOW, fetched: true };
    let releaseFirst: () => void = () => undefined;
    let calls = 0;
    // the first view's read of the installed themes answers after the second view's
    const slowThemes = { ...themes, list: async () => {
      if (++calls === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      return themes.list();
    } };
    const ordered = clientOf({ themes: slowThemes, list: fakeList(() => result) });
    const told = viewsOf(ordered);
    const older = ordered.view(false);
    await vi.waitFor(() => expect(calls).toBe(1));
    result = { state: 'ok', payload: second, fetchedAt: NOW + 1, fetched: true };
    expect((await ordered.view(true)).state).toBe('empty');
    releaseFirst();
    // the caller still gets the view it asked for
    expect((await older).state).toBe('ok');
    expect(told.map((each) => each.view.state)).toEqual(['empty']);
  });

  it('tells the off view in its turn, so a view that was being built when the store went off never follows it', async () => {
    let result: StoreListResult = { state: 'ok', payload: verified([listed(await archive())]), fetchedAt: NOW, fetched: true };
    let release: () => void = () => undefined;
    let calls = 0;
    const slowThemes = { ...themes, list: async () => {
      if (++calls === 1) await new Promise<void>((resolve) => (release = resolve));
      return themes.list();
    } };
    const ordered = clientOf({ themes: slowThemes, list: fakeList(() => result) });
    const told = viewsOf(ordered);
    const building = ordered.view(false);
    await vi.waitFor(() => expect(calls).toBe(1));
    result = { state: 'off' };
    await ordered.turnedOff();
    release();
    expect((await building).state).toBe('ok');
    expect(told).toEqual([{ view: { state: 'off', entries: [] }, listRead: false }]);
  });

  it('tells the last view again after a theme change without a request, as off once the setting is off', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const told = viewsOf(client);
    await client.repeatView();
    expect(told).toEqual([]);
    await client.view(false);
    await installFromStore(bytes);
    listFetches = [];
    await client.repeatView();
    expect(told.at(-1)).toMatchObject({ view: { state: 'ok', entries: [{ status: 'installed' }] }, listRead: false });
    expect(listFetches).toEqual([]);
    enabled = false;
    await client.repeatView();
    expect(told.at(-1)).toEqual({ view: { state: 'off', entries: [] }, listRead: false });
  });

  it('tells the view again after a theme change only when a status differs from the one last told', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const told = viewsOf(client);
    await client.view(false);
    const heard = told.length;
    await client.repeatView();
    await client.repeatView();
    expect(told).toHaveLength(heard);
    await installFromStore(bytes);
    await client.repeatView();
    expect(told).toHaveLength(heard + 1);
    await client.repeatView();
    expect(told).toHaveLength(heard + 1);
  });

  it('answers no update, and says why in the log, when the kept list cannot be read', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    await installFromStore(bytes);
    const logged: string[] = [];
    const unreadable = clientOf({
      list: { ...fakeList(() => ({ state: 'off' })), kept: async () => Promise.reject(new Error('EISDIR: illegal operation on a directory, read')) },
      log: (line) => logged.push(line),
    });
    expect(await unreadable.updates()).toEqual(new Map());
    expect(logged).toEqual(['[themes] the store updates could not be read, so no theme shows an update: EISDIR: illegal operation on a directory, read']);
  });

  it('reads the update badges from the theme list its caller already read', async () => {
    const one = await archive('Aurora', '1.0.0');
    serveList([listed(one)]);
    const id = await installFromStore(one);
    serveList([listed(await archive('Aurora', '2.0.0'), { version: '2.0.0' })], [], 6);
    await client.view(true);
    const entries = await themes.list();
    const list = vi.spyOn(themes, 'list');
    expect(await client.updates(entries)).toEqual(new Map([[id, '2.0.0']]));
    expect(list).not.toHaveBeenCalled();
  });
});

describe('store update', () => {
  it('replaces an unedited store theme under its id with no copy, and badges it while the list has another version', async () => {
    const one = await archive('Aurora', '1.0.0');
    serveList([listed(one)]);
    const id = await installFromStore(one);
    const two = await archive('Aurora', '2.0.0');
    serveList([listed(two, { version: '2.0.0' })], [], 6);
    expect((await client.view(true)).entries[0]).toEqual(expect.objectContaining({ status: 'update', installedThemeId: id, installedVersion: '1.0.0' }));
    expect(await client.updates()).toEqual(new Map([[id, '2.0.0']]));
    fetchMock.mockResolvedValueOnce(new Response(two, { status: 200 }));
    const preview = await client.install('aurora');
    expect(preview.store).toEqual({ entryId: 'aurora', version: '2.0.0', update: { themeId: id, fromVersion: '1.0.0' } });
    expect(preview.clash).toBeUndefined();
    const history = (await themes.history()).length;
    const committed = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    expect(committed).toEqual({ installed: { themeId: id, name: 'Aurora', replaced: true } });
    expect((await themes.history()).length).toBe(history + 1);
    expect((await installedTheme(id)).theme.origin?.store).toEqual({ entryId: 'aurora', version: '2.0.0', sha256: sha(two) });
    expect(await userThemes()).toHaveLength(1);
    expect(await client.updates()).toEqual(new Map());
  });

  it('saves an edited store theme as "<name> (your edits)" before replacing it, in the same history entry', async () => {
    const one = await archive('Aurora', '1.0.0');
    serveList([listed(one)]);
    const id = await installFromStore(one);
    await recolor(themes, id, 'dark', { ...SEEDS, accent: '#ff00aa' });
    const two = await archive('Aurora', '2.0.0');
    serveList([listed(two, { version: '2.0.0' })], [], 6);
    await client.view(true);
    fetchMock.mockResolvedValueOnce(new Response(two, { status: 200 }));
    const preview = await client.install('aurora');
    expect(preview.store?.update).toEqual({ themeId: id, fromVersion: '1.0.0', yourEditsName: 'Aurora (your edits)' });
    const history = (await themes.history()).length;
    const committed = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    if (!('installed' in committed)) throw new Error(committed.refused.message);
    expect(committed.installed).toEqual({ themeId: id, name: 'Aurora', replaced: true, keptCopy: { themeId: expect.any(String), name: 'Aurora (your edits)' } });
    expect((await themes.history()).length).toBe(history + 1);
    const copy = await installedTheme(committed.installed.keptCopy!.themeId);
    expect(copy.theme.looks.dark?.colors.accent).toBe('#ff00aa');
    // a copy of a store theme the user did not opt into keeps its arrangement off (copiedLayoutOptIn)
    expect(copy.theme.origin).toEqual({ kind: 'duplicate', from: id, installedAt: NOW, layoutOptIn: false });
    const updated = await installedTheme(id);
    expect(updated.theme.looks.dark?.colors.accent).toBe(SEEDS.accent);
    expect(updated.theme.origin?.store?.version).toBe('2.0.0');
  });

  it('asks again when the theme was edited after the card opened, then keeps the edits', async () => {
    const one = await archive('Aurora', '1.0.0');
    serveList([listed(one)]);
    const id = await installFromStore(one);
    const two = await archive('Aurora', '2.0.0');
    serveList([listed(two, { version: '2.0.0' })], [], 6);
    await client.view(true);
    fetchMock.mockResolvedValueOnce(new Response(two, { status: 200 }));
    const preview = await client.install('aurora');
    expect(preview.store?.update?.yourEditsName).toBeUndefined();
    await recolor(themes, id, 'dark', { ...SEEDS, accent: '#ff00aa' });
    const asked = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    expect(asked).toEqual({ refused: expect.objectContaining({ message: 'The theme {0} changed while this card was open. Check the card, then Install again.' }), preview: expect.objectContaining({ store: expect.objectContaining({ update: { themeId: id, fromVersion: '1.0.0', yourEditsName: 'Aurora (your edits)' } }) }) });
    const committed = await themes.installCommit({ installId: preview.installId, useArrangement: false });
    expect(committed).toEqual({ installed: expect.objectContaining({ themeId: id, keptCopy: expect.objectContaining({ name: 'Aurora (your edits)' }) }) });
  });

  it('refuses to install the version already installed', async () => {
    const one = await archive();
    serveList([listed(one)]);
    await installFromStore(one);
    await expect(client.install('aurora')).rejects.toThrow('Aurora 1.0.0 is already installed.');
  });

  it('offers Update for a file published again under the same version, and installs it', async () => {
    const one = await archive('Aurora', '1.0.0');
    serveList([listed(one)]);
    const id = await installFromStore(one);
    const again = await archive('Aurora again', '1.0.0');
    serveList([listed(again)], [], 6);
    expect((await client.view(true)).entries[0]).toMatchObject({ status: 'update', installedThemeId: id, installedVersion: '1.0.0' });
    expect(await client.updates()).toEqual(new Map([[id, '1.0.0']]));
    expect(await installFromStore(again)).toBe(id);
    expect((await installedTheme(id)).theme.origin?.store?.sha256).toBe(sha(again));
    expect((await client.view(false)).entries[0]?.status).toBe('installed');
    expect(await client.updates()).toEqual(new Map());
  });
});

describe('store removed entries', () => {
  async function installReferenced(bytes: Uint8Array): Promise<string> {
    const id = await installFromStore(bytes);
    fs.writeFileSync(settingsFile(), `${JSON.stringify({ [PREFERRED_LOOK_SETTINGS.dark]: id, [PREFERRED_LOOK_SETTINGS.light]: BUILTIN_THEME_ID })}\n`);
    await themes.setSchedule({ enabled: true, rules: [{ days: ['mon'], minute: 0, theme: id, look: 'dark' }] }, USER_ACTOR, false);
    await themes.setProjectLook(PROJECT, { mode: 'full', themeId: id, look: 'dark' }, { name: 'site' });
    return id;
  }

  it('switches every reference to the built-in theme, marks the theme with the reason and deletes nothing, once', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const id = await installReferenced(bytes);
    const blobsBefore = fs.existsSync(path.join(root, 'blobs')) ? blobsStored() : [];
    serveList([], [{ id: 'aurora', reason: 'Takedown request: unlicensed art' }], 6);
    const history = (await themes.history()).length;
    await client.view(true);
    const marked = await installedTheme(id);
    expect(marked.theme.origin?.removedFromStore).toEqual({ reason: 'Takedown request: unlicensed art', at: NOW });
    expect(readSettings()[PREFERRED_LOOK_SETTINGS.dark]).toBe(BUILTIN_THEME_ID);
    expect((await themes.schedule()).schedule.rules.map((rule) => rule.theme)).toEqual([BUILTIN_THEME_ID]);
    expect(await themes.projectLooks.projectLookOf(PROJECT)).toEqual({ mode: 'full', themeId: BUILTIN_THEME_ID, look: 'dark' });
    const entries = await themes.history();
    expect(entries.length).toBe(history + 1);
    expect(entries[0]?.change).toEqual({ kind: 'storeRemoved', themes: ['Aurora'] });
    expect(fs.existsSync(path.join(root, 'blobs')) ? blobsStored() : []).toEqual(blobsBefore);
    // a pick the user makes afterwards holds across later checks of the same list
    await themes.pick(id, 'dark');
    fs.writeFileSync(settingsFile(), `${JSON.stringify({ [PREFERRED_LOOK_SETTINGS.dark]: id })}\n`);
    const afterPick = (await themes.history()).length;
    await client.view(true);
    expect((await themes.history()).length).toBe(afterPick);
    expect(readSettings()[PREFERRED_LOOK_SETTINGS.dark]).toBe(id);
  });

  it('matches by id alone, and by sha256 and version only when the removed entry names them', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const id = await installReferenced(bytes);
    serveList([listed(bytes)], [{ id: 'aurora', sha256: 'c'.repeat(64), reason: 'another file' }, { id: 'aurora', version: '0.9.0', reason: 'another version' }, { id: 'borealis', reason: 'another entry' }], 6);
    await client.view(true);
    expect((await installedTheme(id)).theme.origin?.removedFromStore).toBeUndefined();
    expect(readSettings()[PREFERRED_LOOK_SETTINGS.dark]).toBe(id);
    serveList([], [{ id: 'aurora', sha256: sha(bytes), version: '1.0.0', reason: 'exact match' }], 7);
    await client.view(true);
    expect((await installedTheme(id)).theme.origin?.removedFromStore?.reason).toBe('exact match');
  });

  it('offers a removed theme again once the list lists its entry again, and installing it takes the mark off', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const id = await installFromStore(bytes);
    serveList([], [{ id: 'aurora', reason: 'Withdrawn by its author' }], 6);
    await client.view(true);
    expect((await installedTheme(id)).theme.origin?.removedFromStore?.reason).toBe('Withdrawn by its author');
    expect(await client.updates()).toEqual(new Map());
    // the same version and file come back
    serveList([listed(bytes)], [], 7);
    expect((await client.view(true)).entries[0]).toMatchObject({ status: 'update', installedThemeId: id });
    expect(await client.updates()).toEqual(new Map([[id, '1.0.0']]));
    expect(await installFromStore(bytes)).toBe(id);
    expect((await installedTheme(id)).theme.origin?.removedFromStore).toBeUndefined();
    expect((await client.view(false)).entries[0]?.status).toBe('installed');
  });

  it('the background check applies a removed entry without Browse, and fetches no thumbnail', async () => {
    const bytes = await archive();
    serveList([listed(bytes)]);
    const id = await installReferenced(bytes);
    // past the day the list is reused for, so the background check fetches; the list still names a thumbnail it could fetch
    serveList([entry({ id: 'borealis', ...WITH_THUMB })], [{ id: 'aurora', reason: 'Withdrawn by its author' }], 6);
    const later = createStoreClient({
      themes,
      list: createStoreList({ root, lane: themes.lane, enabled: () => enabled, fetch: listFetcher, now: () => NOW + 25 * 60 * 60 * 1000, log: () => undefined, onFetch: (fetch) => listFetches.push(fetch) }),
      enabled: () => enabled,
      appVersion: '3.8.0',
      now: () => NOW + 25 * 60 * 60 * 1000,
    });
    listFetches = [];
    expect(await later.backgroundCheck()).toEqual({ fetched: true });
    expect(listFetches.map((fetch) => fetch.purpose)).toEqual(['list']);
    expect((await installedTheme(id)).theme.origin?.removedFromStore?.reason).toBe('Withdrawn by its author');
    expect(readSettings()[PREFERRED_LOOK_SETTINGS.dark]).toBe(BUILTIN_THEME_ID);
  });

  it('the background check makes no request while no store theme is installed', async () => {
    serveList([]);
    expect(await client.backgroundCheck()).toEqual({ fetched: false });
    expect(listFetches).toEqual([]);
  });
});
