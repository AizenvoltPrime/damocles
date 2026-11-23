// The desktop theme store in this computer's Damocles Core only (docs/invariants.md "Desktop themes"): a daemon's core never
// builds it, so no theme file is ever written on a target.
import { THEMES_DIR } from '../../core/paths';
import { createThemeService, type ThemeService } from '../../core/themes';
import { COUNTDOWN_RECHECK_MS } from '../../core/themes/countdown-lock';
import type { ThemeAgentHost, ThemeHostPort } from '../../core/pi-session/tools/theme-tools';
import { createThemeRelayHost, RELAYED_DRAFT_SWEEP_MS } from '../../core/pi-session/tools/theme-relay';
import { LOCAL_CLIENT_ID } from '../../shared/remote-user';
import type { ThemeShowEndReason } from '../../shared/themes/agent';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { createStoreList, type StoreFetch } from '../../core/themes/store/list';
import { createThemePathRule } from '../../core/themes/network-rule';
import { createStoreClient, THEMES_STORE_SETTING } from '../../core/themes/store/install';
import type { CorePlatform } from './platform';

export interface CoreThemes {
  readonly service: ThemeService;
  // the agent's theme tools, which every main chat of this core gets
  readonly agent: ThemeAgentHost;
  // ends the timers, so nothing new enters the write lane
  dispose(): void;
  // once the write lane is idle: core's shutdown waits for it, since a run cut short keeps the lane's lock file until it goes stale
  settled(): Promise<void>;
}

const BLOB_COLLECT_DELAY_MS = 60_000;
// after the window and its theme renderer are up
const ANALYZE_DELAY_MS = 5_000;
// a pass that left a wallpaper or sprite unanalyzed runs again after each of these, then no more in this run
export const ANALYZE_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** Serves the themes.* requests and emits themes.changed after each theme file write; undefined in a daemon's core. */
export function startCoreThemes(platform: CorePlatform, log?: (line: string) => void): CoreThemes | undefined {
  if (platform.init.remote !== undefined) return undefined;
  // the install download's stand-in folder is honored only with the e2e hooks on, as e2eForgeServers is
  const e2eThemeDownloads = platform.init.e2eHooks ? platform.init.e2eThemeDownloads : undefined;
  const themes = createThemeService({
    root: THEMES_DIR,
    settings: platform.settings,
    resourceRoot: platform.init.paths.resourceRoot,
    notifications: platform.notifications,
    ...(log ? { log } : {}),
    ...(e2eThemeDownloads !== undefined ? { e2eThemeDownloads } : {}),
    ...(platform.init.themesOwner !== undefined ? { owner: platform.init.themesOwner } : {}),
  });
  const { endpoint } = platform;
  const failed = (what: string) => (err: unknown): void => log?.(`[themes] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  // a refusal is the card's or the dialog's to show, so it is an answer rather than a failed call
  const refusalOf = (err: unknown): { readonly refused: LocalizedText } => {
    if (err instanceof LocalizedError) return { refused: err.text };
    throw err;
  };
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // never the reason core stays alive, and never run once core shuts down
  const later = (ms: number, run: () => void): void => {
    if (disposed) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timer.unref();
    timers.add(timer);
  };
  // A crash, a force-quit or an engine restart during the keep-changes countdown left its mark: the change is reverted before
  // anything else runs, and main, which owns the banner and the window arrangement, hears how it ended. A countdown another
  // running Damocles counts is left to it, and asked about again in case that one ends without settling it.
  const settlePending = (atStart: boolean): void => {
    (atStart ? themes.settlePendingAtStart() : themes.settlePendingLeft())
      .then((settled) => {
        if (!settled) return undefined;
        if (settled.outcome === 'counted') {
          later(COUNTDOWN_RECHECK_MS, () => settlePending(false));
          if (!atStart) return undefined;
          log?.('[themes] another running Damocles counts the change the keep-changes banner had not settled, so it was left as it is');
          return endpoint.request('themes.pendingElsewhere', { entryId: settled.entryId });
        }
        log?.(`[themes] the change the keep-changes banner had not settled was ${settled.outcome}`);
        return endpoint.request('themes.pendingSettled', { ...settled, ...(atStart ? { atStart: true } : {}) });
      })
      .catch(failed('the change the keep-changes banner had not settled could not be settled'));
  };
  settlePending(true);
  // no chat survives a core start, so no draft does either, whatever became of the mark
  themes.sweepDrafts().catch(failed('the drafts of the last run could not be removed'));
  // unused blobs go once the start has settled, never on its path
  later(BLOB_COLLECT_DELAY_MS, () => {
    themes.collectBlobs().catch(failed('the unused blobs could not be removed'));
  });
  // wallpapers decode only in main's sandboxed theme renderer; core writes what it derives
  themes.setAnalyzer((sha256, image, signal) => endpoint.request('themes.analyze', { sha256, ...image }, signal));
  themes.setSpriteAnalyzer((sha256, sprite, signal) => endpoint.request('themes.analyzeSprite', { sha256, ...sprite }, signal));
  const analyzePass = (attempt: number): void => {
    themes.analyzeMissing().then((pass) => {
      const retry = ANALYZE_RETRY_DELAYS_MS[attempt];
      if (pass.failed > 0 && retry !== undefined) later(retry, () => analyzePass(attempt + 1));
    }, failed('the wallpapers and sprites could not be analyzed'));
  };
  later(ANALYZE_DELAY_MS, () => analyzePass(0));
  themes.onDidChange(() => endpoint.emit('themes.changed', {}));
  themes.onPendingSettled(({ entryId, outcome }) => {
    endpoint.request('themes.pendingSettled', { entryId, outcome }).catch(failed('the keep-changes banner was not told its change settled'));
  });
  themes.onPendingExtended(({ entryId, change, actor }) => {
    const chat = actor.kind === 'agent' ? { chatId: actor.chatId, ...(actor.title !== '' ? { chatTitle: actor.title } : {}) } : {};
    endpoint.request('themes.pendingExtended', { entryId, change, ...chat }).catch(failed('the keep-changes banner was not told a change joined it'));
  });
  // the community store list, fetched only while damocles.desktop.themes.store is on
  const e2eStore = platform.init.e2eHooks && platform.init.e2eThemeStore !== undefined && e2eThemeDownloads !== undefined
    ? { ...platform.init.e2eThemeStore, folder: e2eThemeDownloads }
    : undefined;
  const storeFetches: StoreFetch[] = [];
  const storeEnabled = (): boolean => platform.settings.get<unknown>(THEMES_STORE_SETTING, true) !== false;
  const storeList = createStoreList({
    root: THEMES_DIR,
    lane: themes.lane,
    rule: createThemePathRule(THEMES_DIR, platform.notifications),
    enabled: storeEnabled,
    ...(log ? { log } : {}),
    ...(e2eStore ? { e2e: e2eStore, onFetch: (fetch: StoreFetch) => storeFetches.push(fetch) } : {}),
  });
  const store = createStoreClient({
    themes,
    list: storeList,
    enabled: storeEnabled,
    appVersion: platform.init.appInfo.version,
    ...(e2eThemeDownloads !== undefined ? { e2eFolder: e2eThemeDownloads } : {}),
    ...(log ? { log } : {}),
  });
  store.onUpdated((view, listRead) => endpoint.emit('themes.store.updated', { view, listRead }));
  // an install, update or delete changes the entries' statuses, which the view this run showed repeats without a request
  themes.onDidChange(() => {
    store.repeatView().catch(failed('the store view could not be read again'));
  });
  // however the setting went off (Settings' switch, an edit of the settings file), the requests in flight end with it
  platform.settings.onDidChange(THEMES_STORE_SETTING, () => {
    if (!storeEnabled()) storeList.turnedOff();
  });
  endpoint.serve('themes.list', async () => {
    const entries = await themes.list();
    const updates = await store.updates(entries);
    return { themes: entries.map((entry) => (entry.status === 'ok' && updates.has(entry.id) ? { ...entry, storeUpdate: { version: updates.get(entry.id)! } } : entry)) };
  });
  endpoint.serve('themes.store.list', ({ refresh }) => store.view(refresh));
  endpoint.serve('themes.store.install', ({ entryId }, signal) => store.install(entryId, signal).then((preview) => ({ preview }), refusalOf));
  endpoint.serve('themes.store.backgroundCheck', () => store.backgroundCheck());
  endpoint.serve('themes.store.setEnabled', async ({ enabled }) => {
    await platform.settings.update(THEMES_STORE_SETTING, enabled, 'user');
    // turned on, Browse lists again once this answers; core fetches nothing on its own
    if (!enabled) await store.turnedOff();
  });
  if (platform.init.e2eHooks) endpoint.serve('e2e.themeStoreFetches', () => ({ fetches: storeFetches.splice(0) }));
  endpoint.serve('themes.saveTheme', ({ themeId, theme, pins, baseHash }) => themes.saveTheme(themeId, theme, undefined, pins, baseHash));
  endpoint.serve('themes.baseHash', async ({ themeId }) => {
    const base = await themes.editBase(themeId);
    return base ? { hash: base.hash } : {};
  });
  endpoint.serve('themes.duplicate', async ({ themeId, name }) => ({ themeId: await themes.duplicate(themeId, name) }));
  endpoint.serve('themes.delete', ({ themeId }) => themes.remove(themeId));
  endpoint.serve('themes.rename', ({ themeId, name }) => themes.rename(themeId, name));
  endpoint.serve('themes.pick', async ({ themeId, kind, arrangementBefore, at }) => ({
    recorded: await themes.pick(themeId, kind, { ...(arrangementBefore !== undefined ? { arrangementBefore } : {}), ...(at !== undefined ? { at } : {}) }),
  }));
  endpoint.serve('themes.setMode', ({ mode }) => themes.setMode(mode));
  endpoint.serve('themes.setScheduleMode', ({ choice, showing }) => themes.setScheduleMode(choice, showing));
  endpoint.serve('themes.setScheduleRules', ({ rules }) => themes.setScheduleRules(rules));
  endpoint.serve('themes.resumeSchedule', () => themes.resumeSchedule());
  endpoint.serve('themes.hold', ({ themeId, kind, at }) => themes.hold(themeId, kind, at));
  endpoint.serve('themes.reset', ({ projectKey }) => themes.reset(undefined, projectKey));
  endpoint.serve('themes.projectLooks', async () => ({ looks: await themes.projectLooks.shownLooks() }));
  endpoint.serve('themes.setProjectLook', async ({ projectKey, look, name }) => {
    await themes.setProjectLook(projectKey, look, { name });
  });
  endpoint.serve('themes.relocateProject', ({ fromKey, toKey }) => themes.projectLooks.relocateProject(fromKey, toKey));
  endpoint.serve('themes.forgetProject', ({ projectKey }) => themes.projectLooks.forgetProject(projectKey));
  endpoint.serve('themes.history', async () => ({ entries: await themes.history() }));
  endpoint.serve('themes.undo', ({ expected }) => themes.undo(undefined, expected));
  endpoint.serve('themes.undoPending', ({ entryId }) => themes.undo(entryId));
  endpoint.serve('themes.restore', ({ entryId, arrangementNow }) => themes.restore(entryId, arrangementNow));
  endpoint.serve('themes.importFont', ({ bytes }) => themes.importFont(bytes));
  endpoint.serve('themes.importImage', ({ file }) => themes.importImage({ file }));
  endpoint.serve('themes.importSprite', ({ file, strip }) => themes.importSprite({ file }, strip));
  endpoint.serve('themes.allowFlash', ({ sha256 }) => themes.allowFlash(sha256));
  endpoint.serve('themes.keep', ({ entryId }) => themes.keep(entryId));
  endpoint.serve('themes.install.prepare', ({ from }, signal) => themes.installPrepare(from, { signal }).then((preview) => ({ preview }), refusalOf));
  endpoint.serve('themes.install.commit', (commit) => themes.installCommit(commit).catch(refusalOf));
  endpoint.serve('themes.install.cancel', ({ installId }) => themes.installCancel(installId));
  endpoint.serve('themes.install.allowFlash', ({ installId, sha256 }) => themes.installAllowFlash(installId, sha256));
  endpoint.serve('themes.analyzeProgress', ({ sha256, fraction }) => themes.analyzeProgress(sha256, fraction));
  themes.onInstallProgress((progress) => endpoint.emit('themes.install.progress', progress));
  endpoint.serve('themes.export.plan', ({ themeId, installedFonts }) => themes.exportPlan(themeId, installedFonts ?? []).then((plan) => ({ plan }), refusalOf));
  endpoint.serve('themes.export.write', ({ themeId, path, installedFonts }) => themes.exportWrite(themeId, path, installedFonts).then((bytes) => ({ written: { bytes } }), refusalOf));
  themes.onInstallUpdated((preview) => endpoint.emit('themes.install.updated', { preview }));
  themes.onInstallExpired((installId) => endpoint.emit('themes.install.expired', { installId }));

  const showEnded = new Set<(promptId: string, reason: ThemeShowEndReason) => void>();
  endpoint.serve('themes.showEnded', ({ promptId, reason }) => {
    for (const listener of [...showEnded]) listener(promptId, reason);
  });
  const screenshotGone = new Set<(shotId: string) => void>();
  endpoint.serve('themes.screenshotGone', ({ shotId }) => {
    for (const listener of [...screenshotGone]) listener(shotId);
  });
  const host: ThemeHostPort = {
    render: async (theme, mode, signal) => (await endpoint.request('themes.render', { theme, mode }, signal)).png,
    screenshotTake: (signal) => endpoint.request('themes.screenshotTake', {}, signal),
    screenshotRead: async (shotId, signal) => (await endpoint.request('themes.screenshotRead', { shotId }, signal)).png,
    screenshotDrop: (shotId) => endpoint.request('themes.screenshotDrop', { shotId }),
    applied: async (ask, signal) => (await endpoint.request('themes.applied', ask, signal)).outcome,
    showInWindow: async (promptId, chatTitle, theme) => (await endpoint.request('themes.showInWindow', { promptId, ...(chatTitle !== undefined ? { chatTitle } : {}), theme })).refused,
    stopShowing: (promptId) => endpoint.request('themes.stopShowing', { promptId }),
    state: (signal) => endpoint.request('themes.state', {}, signal),
    currentArrangement: async (signal) => (await endpoint.request('themes.currentArrangement', {}, signal)).arrangement,
    applyArrangement: (arrangement, density) => endpoint.request('themes.applyArrangement', { arrangement, ...(density !== undefined ? { density } : {}) }),
    onShowEnded(listener) {
      showEnded.add(listener);
      return { dispose: () => showEnded.delete(listener) };
    },
    onScreenshotGone(listener) {
      screenshotGone.add(listener);
      return { dispose: () => screenshotGone.delete(listener) };
    },
  };
  const agent: ThemeAgentHost = { themes, host, settings: platform.settings, authority: LOCAL_CLIENT_ID };
  // a remote chat's theme tools, which main forwards after its own checks; this core stays the only writer
  const relay = createThemeRelayHost(agent);
  endpoint.serve('themes.forgetHost', async ({ authorityKey }) => {
    await themes.projectLooks.forgetHost(authorityKey);
    await relay.forgetAuthority(authorityKey);
  });
  endpoint.serve('themes.keepHosts', async ({ authorityKeys }) => {
    const kept = new Set(authorityKeys);
    const dropped = await themes.projectLooks.keepHosts(kept);
    if (dropped.length > 0) log?.(`[themes] dropped the project looks and pins of forgotten hosts: ${dropped.join(', ')}`);
    await relay.keepAuthorities(kept);
  });
  endpoint.serve('themes.relay.read', ({ authority, request, project }, signal) => relay.read(authority, request, project, signal));
  endpoint.serve('themes.relay.uploadStart', ({ authority, ...start }) => relay.uploadStart(authority, start));
  endpoint.serve('themes.relay.uploadChunk', ({ authority, ...chunk }) => relay.uploadChunk(authority, chunk));
  endpoint.serve('themes.relay.stage', ({ authority, request, project }, signal) => relay.stage(authority, request, project, signal));
  endpoint.serve('themes.relay.commit', ({ authority, stageId, pressed }, signal) => relay.commit(authority, stageId, pressed === true, signal));
  endpoint.serve('themes.relay.discard', ({ authority, stageId, keepDraft }) => relay.discard(authority, stageId, keepDraft));
  endpoint.serve('themes.relay.preview', ({ authority, ...params }) => relay.preview(authority, params));
  endpoint.serve('themes.relay.installPrepare', ({ authority, url }, signal) => relay.installPrepare(authority, url, signal));
  endpoint.serve('themes.relay.installCommit', ({ authority, ...commit }) => relay.installCommit(authority, commit));
  endpoint.serve('themes.relay.installCancel', ({ authority, installId }) => relay.installCancel(authority, installId));
  endpoint.serve('themes.relay.allowFlash', ({ authority, installId, sha256 }) => relay.allowFlash(authority, installId, sha256));
  const expiring = setInterval(() => {
    relay.expireDrafts().catch(failed('the relayed drafts could not be expired'));
  }, RELAYED_DRAFT_SWEEP_MS);
  expiring.unref();
  return {
    service: themes,
    agent,
    dispose() {
      disposed = true;
      clearInterval(expiring);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    settled: () => themes.lane.run(async () => undefined).catch(failed('the theme write lane did not settle')),
  };
}
