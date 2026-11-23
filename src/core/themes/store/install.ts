// The community store's install side (docs/themes.md "Community store"): Browse's view of the verified list, Install and Update through the
// install card, the list's removed entries, update badges, and the background check beside the app's own update check.
import type { Disposable } from '../../../platform/disposable';
import { LocalizedError } from '../../../shared/localized-text';
import type { ThemeInstallPreview } from '../../../shared/themes/install';
import type { Origin } from '../../../shared/themes/schema';
import type { StoreEntryView, StoreThumb, StoreView } from '../../../shared/themes/store';
import { LOOK_KINDS } from '../../../shared/themes/tokens';
import { l, verbatim } from '../../l10n';
import { downloadTheme, type StageInput } from '../install';
import type { ThemeListEntry } from '../store';
import type { StoreList, StoreListResult } from './list';
import { assertPinned, releaseDownloadAllowed, type StoreEntry, type StorePayload, type StoreRemoved } from './verify';

// Must match THEMES_STORE_SETTING in src/desktop/local-services/desktop-configuration.ts.
export const THEMES_STORE_SETTING = 'damocles.desktop.themes.store';

type StoreOrigin = Origin & { readonly store: NonNullable<Origin['store']> };
type InstalledStoreTheme = Extract<ThemeListEntry, { status: 'ok' }> & { readonly theme: { readonly origin: StoreOrigin } };

export interface StoreClientDeps {
  readonly themes: {
    list(): Promise<ThemeListEntry[]>;
    installStage(input: StageInput): Promise<ThemeInstallPreview>;
    markRemovedFromStore(marks: readonly { readonly themeId: string; readonly reason: string }[]): Promise<readonly string[]>;
  };
  readonly list: StoreList;
  // damocles.desktop.themes.store
  readonly enabled: () => boolean;
  // the running app's version, which an entry's minAppVersion must not be newer than
  readonly appVersion: string;
  // CoreInit.e2eThemeDownloads, passed only with the e2e hooks on
  readonly e2eFolder?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface StoreClient {
  // Browse: refresh false when it opens (a list under a day old is reused), true for Check for updates
  view(refresh: boolean): Promise<StoreView>;
  // tells the listeners the view this run last showed again, its statuses read from the installed themes, when a status
  // differs from the view they heard last; no request
  repeatView(): Promise<void>;
  // the setting went off: the listeners hear the off view in its turn, so a view still being built never follows it
  turnedOff(): Promise<void>;
  // an entry's file downloaded, pin-checked and staged for the install card; throws a LocalizedError naming a refusal
  install(entryId: string, signal?: AbortSignal): Promise<ThemeInstallPreview>;
  // beside the app's update check: the list, without thumbnails, only while the setting is on and a store theme is installed
  backgroundCheck(): Promise<{ readonly fetched: boolean }>;
  // installed store theme id -> the list's entry version it can update to, from the list this run last read or the kept one; no
  // request. `themes` is the theme list the caller already read. A badge is optional: a failure is logged and answers none
  updates(themes?: readonly ThemeListEntry[]): Promise<ReadonlyMap<string, string>>;
  // listRead: the view follows a read of the list, so the installed themes' update badges may have changed
  onUpdated(listener: (view: StoreView, listRead: boolean) => void): Disposable;
}

// x.y.z with an optional prerelease; build metadata never counts in a comparison (Semantic Versioning 2.0.0, item 10)
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `required` (x.y.z) is newer than the app's `version`; a prerelease app sits below its release, and an app version that is no version is below everything. */
export function needsNewerApp(required: string, version: string): boolean {
  const want = VERSION.exec(required);
  const have = VERSION.exec(version);
  // the list's parser admits only x.y.z, so anything else is newer than this app understands
  if (!want || !have) return true;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(want[i]) - Number(have[i]);
    if (diff !== 0) return diff > 0;
  }
  return have[4] !== undefined;
}

/** A removed entry names an installed store theme by its entry id, and by its pinned sha256 and version when it gives them. */
export function removedMatches(removed: StoreRemoved, origin: StoreOrigin): boolean {
  return origin.store.entryId === removed.id
    && (removed.sha256 === undefined || removed.sha256 === origin.store.sha256)
    && (removed.version === undefined || removed.version === origin.store.version);
}

/** Whether the installed theme is the entry's release as the list has it now: the same version and file, and not marked removed. */
export function sameRelease(origin: StoreOrigin, entry: StoreEntry): boolean {
  return origin.removedFromStore === undefined && origin.store.version === entry.version && origin.store.sha256 === entry.file.sha256;
}

function installedStoreThemes(entries: readonly ThemeListEntry[]): InstalledStoreTheme[] {
  return entries.filter((entry): entry is InstalledStoreTheme => entry.status === 'ok' && !entry.builtin && entry.theme.origin?.kind === 'store' && entry.theme.origin.store !== undefined);
}

// The payload a result carries for removed handling; a refused list's `last` keeps applying, but is never shown.
function payloadOf(result: StoreListResult): StorePayload | undefined {
  if (result.state === 'ok' || result.state === 'cached') return result.payload;
  if (result.state === 'refused') return result.last?.payload;
  return undefined;
}

// A result this run keeps outlives its list's expiresAt, so every later use of its payload asks here.
function livePayloadOf(result: StoreListResult, at: number): StorePayload | undefined {
  const payload = payloadOf(result);
  return payload !== undefined && payload.expiresAt > at ? payload : undefined;
}

const expiredOn = (payload: StorePayload): string => new Date(payload.expiresAt).toISOString().slice(0, 10);
const storeOff = (): LocalizedError => new LocalizedError(l('The community store is off, so nothing was installed from it. Turn it on in Settings › Appearance.'));

export function createStoreClient(deps: StoreClientDeps): StoreClient {
  const now = deps.now ?? Date.now;
  const listeners = new Set<(view: StoreView, listRead: boolean) => void>();
  // the list result this run last read, which the view told again after a theme write repeats without a request
  let last: StoreListResult | undefined;
  if (!VERSION.test(deps.appVersion)) deps.log?.(`[themes] the app version ${deps.appVersion} is not x.y.z, so every store theme reads as needing a newer Damocles`);

  const statusOf = (entry: StoreEntry, installed: readonly InstalledStoreTheme[]): Pick<StoreEntryView, 'status' | 'installedThemeId' | 'installedVersion'> => {
    const newer = needsNewerApp(entry.minAppVersion, deps.appVersion);
    const theme = installed.find((candidate) => candidate.theme.origin.store.entryId === entry.id);
    if (!theme) return { status: newer ? 'needsNewerApp' : 'available' };
    if (sameRelease(theme.theme.origin, entry)) return { status: 'installed', installedThemeId: theme.id };
    return { status: newer ? 'needsNewerApp' : 'update', installedThemeId: theme.id, installedVersion: theme.theme.origin.store.version };
  };

  const thumbsOf = (entry: StoreEntry, kept: ReadonlySet<string>): StoreEntryView['thumbnails'] => {
    const looks = LOOK_KINDS.flatMap((kind) => {
      const thumbs = entry.thumbnails[kind];
      return thumbs ? [[kind, thumbs.filter((thumb) => kept.has(thumb.sha256)).map((thumb): StoreThumb => ({ panel: thumb.panel, sha256: thumb.sha256 }))] as const] : [];
    });
    return Object.fromEntries(looks);
  };

  const entryView = (entry: StoreEntry, installed: readonly InstalledStoreTheme[], keptThumbs: ReadonlySet<string>): StoreEntryView => ({
    id: entry.id,
    name: entry.name,
    author: entry.author,
    description: entry.description,
    kinds: [...entry.kinds],
    version: entry.version,
    colors: entry.colors,
    fonts: entry.fonts.map((font) => ({ family: font.family, license: font.license })),
    licenses: [...entry.licenses],
    hasCss: entry.hasCss,
    hasLayout: entry.hasLayout,
    hasCharacters: entry.hasCharacters,
    hasMoving: entry.hasMoving,
    minAppVersion: entry.minAppVersion,
    thumbnails: thumbsOf(entry, keptThumbs),
    ...statusOf(entry, installed),
  });

  const viewOf = async (result: StoreListResult): Promise<StoreView> => {
    switch (result.state) {
      case 'off': return { state: 'off', entries: [] };
      case 'unreachable': return { state: 'unreachable', refusedReason: result.reason, entries: [] };
      // a refused list shows nothing, not even the kept one, whose removed entries still apply
      case 'refused': return { state: 'refused', refusedReason: result.reason, entries: [] };
      case 'ok':
      case 'cached': {
        if (result.payload.expiresAt <= now()) {
          return { state: 'unreachable', refusedReason: l('The community store list Damocles kept expired on {0}, so Damocles does not show it.', expiredOn(result.payload)), entries: [] };
        }
        const [themes, keptThumbs] = await Promise.all([deps.themes.list(), deps.list.keptThumbnails()]);
        const installed = installedStoreThemes(themes);
        const entries = result.payload.entries.map((entry) => entryView(entry, installed, keptThumbs));
        if (result.state === 'cached') return { state: 'cached', fetchedAt: result.fetchedAt, refusedReason: result.reason, entries };
        return { state: entries.length === 0 ? 'empty' : 'ok', fetchedAt: result.fetchedAt, entries };
      }
    }
  };

  let asked = 0;
  let told = 0;
  let toldStatuses: string | undefined;
  const statusesOf = (view: StoreView): string => JSON.stringify([view.state, view.entries.map((entry) => [entry.id, entry.status, entry.installedThemeId, entry.installedVersion])]);
  // Every view the listeners hear passes here, so one built from an older read never follows a newer one. `onlyChanged`
  // leaves out a view whose state and statuses are the ones they heard last.
  const publish = async (result: StoreListResult, listRead: boolean, onlyChanged = false): Promise<StoreView> => {
    const turn = ++asked;
    const view = await viewOf(result);
    if (turn > told) {
      told = turn;
      const statuses = statusesOf(view);
      if (!onlyChanged || statuses !== toldStatuses) {
        toldStatuses = statuses;
        for (const listener of [...listeners]) listener(view, listRead);
      }
    }
    return view;
  };

  // The removed entries that name an installed store theme, marked once each; a repeat of the same list changes nothing.
  const applyRemoved = async (payload: StorePayload): Promise<void> => {
    if (payload.removed.length === 0) return;
    const installed = installedStoreThemes(await deps.themes.list());
    const marks = installed.flatMap((theme) => {
      const removed = payload.removed.find((candidate) => removedMatches(candidate, theme.theme.origin));
      return removed ? [{ themeId: theme.id, reason: removed.reason }] : [];
    });
    if (marks.length === 0) return;
    const marked = await deps.themes.markRemovedFromStore(marks);
    if (marked.length > 0) deps.log?.(`[themes] the community store removed ${marked.join(', ')}; their references moved to the built-in theme`);
  };

  const read = async (refresh: boolean, signal?: AbortSignal): Promise<StoreListResult> => {
    const result = await deps.list.list({ refresh, ...(signal ? { signal } : {}) });
    last = result;
    const payload = payloadOf(result);
    if (payload) await applyRemoved(payload);
    return result;
  };

  const keptPayload = async (): Promise<StorePayload | undefined> => {
    const fromLast = last ? livePayloadOf(last, now()) : undefined;
    if (fromLast) return fromLast;
    return (await deps.list.kept())?.payload;
  };

  async function install(entryId: string, signal: AbortSignal): Promise<ThemeInstallPreview> {
    const result = await read(false, signal);
    if (result.state === 'off') throw storeOff();
    if (result.state === 'refused' || result.state === 'unreachable') throw new LocalizedError(result.reason);
    signal.throwIfAborted();
    const payload = livePayloadOf(result, now());
    if (!payload) throw new LocalizedError(l('The saved community store list has expired, so nothing was installed. Check for updates when you are online.'));
    const entry = payload.entries.find((candidate) => candidate.id === entryId);
    if (!entry) throw new LocalizedError(l('This theme is no longer in the community store list.'));
    if (needsNewerApp(entry.minAppVersion, deps.appVersion)) throw new LocalizedError(l('{0} needs Damocles {1} or newer.', verbatim(entry.name), verbatim(entry.minAppVersion)));
    const installed = installedStoreThemes(await deps.themes.list()).find((theme) => theme.theme.origin.store.entryId === entry.id);
    if (installed && sameRelease(installed.theme.origin, entry)) throw new LocalizedError(l('{0} {1} is already installed.', verbatim(entry.name), verbatim(entry.version)));
    // the parser refused such a list already; this holds for a list kept by a Damocles that did not
    if (!releaseDownloadAllowed(entry.file.url, deps.list.e2e)) throw new LocalizedError(l('The community store list names a download that is not on a GitHub release host, so nothing was downloaded.'));
    if (!deps.enabled()) throw storeOff();
    const downloaded = await downloadTheme(entry.file.url, {
      signal,
      ...(deps.e2eFolder !== undefined ? { e2eFolder: deps.e2eFolder } : {}),
      redirect: {
        allowed: (target) => releaseDownloadAllowed(target.href, deps.list.e2e),
        refusal: (host, target) => l('{0} sends the download on to {1}, which is not a GitHub release host, so nothing was downloaded.', host, verbatim(target)),
      },
      maxBytes: entry.file.bytes,
    });
    // the pin decides before anything parses the bytes
    assertPinned({ bytes: downloaded.bytes.byteLength, sha256: downloaded.sha256 }, entry.file);
    signal.throwIfAborted();
    if (!deps.enabled()) throw storeOff();
    return deps.themes.installStage({
      bytes: downloaded.bytes,
      fileName: downloaded.fileName,
      source: { kind: 'store', host: downloaded.host, ...(downloaded.fileName !== '' ? { fileName: downloaded.fileName } : {}) },
      url: new URL(entry.file.url).href,
      store: {
        entryId: entry.id,
        version: entry.version,
        sha256: entry.file.sha256,
        ...(installed ? { update: { themeId: installed.id, fromVersion: installed.theme.origin.store.version } } : {}),
      },
    });
  }

  return {
    async view(refresh) {
      const result = await read(refresh);
      const view = await publish(result, true);
      // a cached result means the list request just failed, so its thumbnails are not asked for either
      if (result.state === 'ok') {
        deps.list.fetchThumbnails(result.payload)
          .then(async (changed) => {
            // thumbnails are kept by SHA-256, so whichever list shows by now gains the ones just kept
            if (changed && last && (last.state === 'ok' || last.state === 'cached')) await publish(last, false);
          })
          .catch((err: unknown) => deps.log?.(`[themes] the store thumbnails could not be read: ${err instanceof Error ? err.message : String(err)}`));
      }
      return view;
    },
    async repeatView() {
      if (last) await publish(deps.enabled() ? last : { state: 'off' }, false, true);
    },
    async turnedOff() {
      await publish({ state: 'off' }, false);
    },
    async install(entryId, signal = new AbortController().signal) {
      if (!deps.enabled()) throw storeOff();
      try {
        return await install(entryId, AbortSignal.any([signal, deps.list.offSignal()]));
      } catch (err) {
        // the setting going off ends the download; that is the store's refusal, not the caller's cancel
        if (!signal.aborted && !deps.enabled()) throw storeOff();
        throw err;
      }
    },
    async backgroundCheck() {
      if (!deps.enabled()) return { fetched: false };
      if (installedStoreThemes(await deps.themes.list()).length === 0) return { fetched: false };
      const result = await read(false);
      await publish(result, true);
      return { fetched: result.state !== 'off' && result.fetched };
    },
    async updates(themes) {
      if (!deps.enabled()) return new Map();
      try {
        // every theme list asks, so the kept list is read only when a store theme could take a badge
        const installed = installedStoreThemes(themes ?? await deps.themes.list());
        if (installed.length === 0) return new Map();
        const payload = await keptPayload();
        if (!payload) return new Map();
        const byId = new Map(payload.entries.map((entry) => [entry.id, entry]));
        const updates = new Map<string, string>();
        for (const theme of installed) {
          const entry = byId.get(theme.theme.origin.store.entryId);
          if (entry && !sameRelease(theme.theme.origin, entry) && !needsNewerApp(entry.minAppVersion, deps.appVersion)) updates.set(theme.id, entry.version);
        }
        return updates;
      } catch (err) {
        deps.log?.(`[themes] the store updates could not be read, so no theme shows an update: ${err instanceof Error ? err.message : String(err)}`);
        return new Map();
      }
    },
    onUpdated(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
