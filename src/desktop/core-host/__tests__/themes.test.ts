import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileSettings } from '../../../core/themes/__tests__/service-fixtures';
import { STAGED_INSTALL_TTL_MS } from '../../../core/themes/install';
import { MAX_PROJECT_KEY_CHARS } from '../../../shared/themes/project-looks';
import type { LookColors } from '../../../shared/themes/schema';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type CoreTransport, type MainEndpoint } from '../../core-protocol';
import type { CorePlatform } from '../platform';
import { ANALYZE_RETRY_DELAYS_MS, startCoreThemes, type CoreThemes } from '../themes';
import { createThemeService } from '../../../core/themes';
import { COUNTDOWN_RECHECK_MS, countdownLockPath } from '../../../core/themes/countdown-lock';
import type { ThemeDraft } from '../../../core/themes/drafts';
import { LOCK_STALE_MS } from '../../../core/themes/write-lane';

// The theme service behind the core protocol: every answer and request passes both endpoints' checks, as it does between the
// two processes, so a value core reads from disk and cannot send fails here.

const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'damocles-core-themes-'));
});
vi.mock('../../../core/paths', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../core/paths')>()), THEMES_DIR: home }));

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const THIRD = 'a1b2c3d4-0000-4000-8000-000000000000';
const FOURTH = 'b1b2c3d4-0000-4000-8000-000000000000';
const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const SHA = 'a'.repeat(64);
// this app among those that share the themes folder, and another one
const OWNER = 'a'.repeat(32);
const OTHER_APP = 'b'.repeat(32);

const themeJson = (id: string, name: unknown = 'Night', extra: Record<string, unknown> = {}): Record<string, unknown> => ({ schemaVersion: 1, id, name, looks: { dark: { colors: COLORS } }, ...extra });
const file = (...parts: string[]): string => path.join(home, ...parts);
function write(parts: readonly string[], json: unknown): void {
  fs.mkdirSync(path.dirname(file(...parts)), { recursive: true });
  fs.writeFileSync(file(...parts), typeof json === 'string' ? json : JSON.stringify(json));
}
const writeTheme = (id: string, json: unknown): void => write(['themes', id, 'theme.json'], json);
const historyEntry = (id: string, change: unknown, before: unknown = { settings: { dark: null } }, actor: unknown = { kind: 'user' }): Record<string, unknown> => ({ id, at: 1, actor, change, before });
const writeHistory = (entries: readonly unknown[]): void => write(['history', 'index.json'], { version: 1, entries });

let running: CoreThemes | undefined;

beforeEach(() => {
  for (const name of fs.readdirSync(home)) fs.rmSync(file(name), { recursive: true, force: true });
});

afterEach(async () => {
  running?.dispose();
  await running?.settled();
  running = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Started {
  readonly main: MainEndpoint;
  readonly host: CoreThemes;
  readonly violations: string[];
  readonly logs: string[];
  readonly settled: Array<{ entryId: string; outcome: string; arrangement?: unknown; atStart?: boolean }>;
  // the countdowns core's start said another running Damocles counts
  readonly elsewhere: string[];
  readonly events: string[];
}

// `seen` gets every envelope core posts, in the order it posts them, before main's endpoint handles it
function start(seen?: (envelope: { readonly kind: string; readonly method?: string }) => void): Started {
  const { main: channel, core } = createLoopback();
  const main: CoreTransport = !seen ? channel : {
    post: channel.post,
    onMessage: (listener) => channel.onMessage((raw) => {
      seen(raw as { readonly kind: string; readonly method?: string });
      listener(raw);
    }),
  };
  const violations: string[] = [];
  const logs: string[] = [];
  const mainEndpoint = createMainEndpoint(main, () => undefined, (error) => violations.push(error.message));
  const settled: Started['settled'] = [];
  const events: string[] = [];
  mainEndpoint.serve('themes.pendingSettled', (params) => {
    settled.push(params);
  });
  const elsewhere: string[] = [];
  mainEndpoint.serve('themes.pendingElsewhere', ({ entryId }) => {
    elsewhere.push(entryId);
  });
  mainEndpoint.onEvent('themes.changed', () => events.push('themes.changed'));
  mainEndpoint.onEvent('themes.install.expired', ({ installId }) => events.push(`expired:${installId}`));
  mainEndpoint.onEvent('themes.install.updated', () => undefined);
  mainEndpoint.onEvent('themes.store.updated', () => undefined);
  const platform = {
    endpoint: createCoreEndpoint(core, () => undefined, (error) => violations.push(error.message)),
    init: { paths: { resourceRoot: process.cwd() }, appInfo: { version: '1.0.0' }, e2eHooks: false, themesOwner: OWNER },
    settings: fileSettings(file('settings.json')),
    notifications: { info: async () => undefined },
  } as unknown as CorePlatform;
  const host = startCoreThemes(platform, (line) => logs.push(line));
  if (!host) throw new Error('no theme service started');
  running = host;
  return { main: mainEndpoint, host, violations, logs, settled, elsewhere, events };
}

describe('the theme list over the core protocol', () => {
  it('lists every theme folder and nothing the protocol cannot carry', async () => {
    writeTheme(ID, themeJson(ID));
    writeTheme(OTHER, '{ not json');
    writeTheme(THIRD, themeJson(THIRD, ''));
    writeTheme(FOURTH, themeJson(FOURTH, 'Later', { schemaVersion: 1e20 }));
    writeTheme('c1b2c3d4-0000-4000-8000-000000000000', themeJson('c1b2c3d4-0000-4000-8000-000000000000', 'Newer', { schemaVersion: 2 }));
    for (const stray of ['New folder', 'Backup', 'my_theme', `${ID} - Copy`, '.git', 'UPPER']) write(['themes', stray, 'theme.json'], themeJson(ID));
    const { main, violations, logs } = start();
    const { themes } = await main.request('themes.list', {});
    const byId = new Map(themes.map((entry) => [entry.id, entry]));
    expect(byId.get('damocles')).toMatchObject({ status: 'ok', builtin: true });
    expect(byId.get(ID)).toMatchObject({ status: 'ok', name: 'Night' });
    expect(byId.get(OTHER)).toMatchObject({ status: 'broken' });
    expect(byId.get(THIRD)).toMatchObject({ status: 'broken' });
    expect(byId.get(THIRD)).not.toHaveProperty('name');
    expect(byId.get(FOURTH)).toMatchObject({ status: 'broken', name: 'Later' });
    expect(byId.get('c1b2c3d4-0000-4000-8000-000000000000')).toMatchObject({ status: 'needsNewer', version: 2 });
    expect(themes.filter((entry) => !entry.id.startsWith('damocles')).map((entry) => entry.id).sort()).toEqual([ID, OTHER, THIRD, FOURTH, 'c1b2c3d4-0000-4000-8000-000000000000'].sort());
    expect(violations).toEqual([]);
    expect(logs.filter((line) => line.includes('New folder'))).toHaveLength(1);
  });

  it('lists the themes, with no update badge, beside a kept store list that is no file', async () => {
    writeTheme(ID, themeJson(ID, 'Aurora', { origin: { kind: 'store', store: { entryId: 'aurora', version: '1.0.0', sha256: SHA }, installedAt: 1 } }));
    fs.mkdirSync(file('store', 'list.json'), { recursive: true });
    const { main, violations } = start();
    const { themes } = await main.request('themes.list', {});
    expect(themes.find((entry) => entry.id === ID)).toMatchObject({ status: 'ok', name: 'Aurora' });
    expect(themes.find((entry) => entry.id === ID)).not.toHaveProperty('storeUpdate');
    expect(violations).toEqual([]);
  });

  it('reads the theme folders once for one list', async () => {
    writeTheme(ID, themeJson(ID, 'Aurora', { origin: { kind: 'store', store: { entryId: 'aurora', version: '1.0.0', sha256: SHA }, installedAt: 1 } }));
    const { main, host } = start();
    await host.settled();
    const list = vi.spyOn(host.service, 'list');
    await main.request('themes.list', {});
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('the theme history over the core protocol', () => {
  const pick = { kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' };
  const teleport = { kind: 'teleport', to: 'Mars', theme: '' };

  it('answers a hand-written history: an unreadable entry is left out and a newer Damocles change reads as other', async () => {
    writeHistory([
      historyEntry('one', pick),
      historyEntry('empty-name', { kind: 'delete', theme: '' }),
      historyEntry('long-chat', pick, { settings: { dark: null } }, { kind: 'agent', chatId: 'c'.repeat(300), title: '' }),
      historyEntry('newer', teleport),
      historyEntry('newer-restore', { kind: 'restore', before: teleport }),
      historyEntry('newer-fixed', teleport, { settings: { highContrast: 'x' } }),
    ]);
    const text = fs.readFileSync(file('history', 'index.json'), 'utf8');
    const { main, violations } = start();
    const { entries } = await main.request('themes.history', {});
    expect(entries).toEqual([
      { id: 'newer-fixed', at: 1, actor: { kind: 'user' }, change: { kind: 'other' }, cannotUndo: true },
      { id: 'newer-restore', at: 1, actor: { kind: 'user' }, change: { kind: 'other' } },
      { id: 'newer', at: 1, actor: { kind: 'user' }, change: { kind: 'other' } },
      { id: 'one', at: 1, actor: { kind: 'user' }, change: pick },
    ]);
    expect(fs.readFileSync(file('history', 'index.json'), 'utf8')).toBe(text);
    expect(violations).toEqual([]);
  });

  it('keeps a newer Damocles change in the file as it was written when a later change rewrites the history', async () => {
    writeTheme(ID, themeJson(ID));
    writeHistory([historyEntry('newer', teleport), historyEntry('newer-fixed', teleport, { settings: { highContrast: 'x' } })]);
    const { main, violations } = start();
    await main.request('themes.pick', { themeId: ID, kind: 'dark' });
    const stored = (JSON.parse(fs.readFileSync(file('history', 'index.json'), 'utf8')) as { entries: Array<Record<string, unknown>> }).entries;
    expect(stored.map((entry) => entry['id'])).toEqual(['newer', 'newer-fixed', expect.any(String)]);
    expect(stored[0]).toEqual(historyEntry('newer', teleport));
    expect(stored[1]).toEqual(historyEntry('newer-fixed', teleport, { settings: { highContrast: 'x' } }));
    // the pick is newer than both, so Undo reaches it alone
    expect((await main.request('themes.undo', {})).undone).toMatchObject({ kind: 'pick', theme: 'Night' });
    // the newest is now the entry this Damocles cannot write back: nothing is undone, and the file keeps both
    await expect(main.request('themes.undo', {})).rejects.toThrow(/newer Damocles/);
    await expect(main.request('themes.restore', { entryId: 'newer' })).rejects.toThrow(/newer Damocles/);
    expect((JSON.parse(fs.readFileSync(file('history', 'index.json'), 'utf8')) as { entries: unknown[] }).entries).toHaveLength(2);
    expect(violations).toEqual([]);
  });

  it('answers a pick, its undo and the project looks through both endpoints', async () => {
    writeTheme(ID, themeJson(ID));
    const look = { mode: 'touches', accent: '#ff00aa' };
    write(['projects.json'], { version: 1, looks: { 'c:/work/app': look, ['x'.repeat(MAX_PROJECT_KEY_CHARS + 1)]: look } });
    const { main, violations } = start();
    expect(Object.keys((await main.request('themes.projectLooks', {})).looks)).toEqual(['c:/work/app']);
    await main.request('themes.pick', { themeId: ID, kind: 'dark', arrangementBefore: { sidebarWidth: 300 } });
    const { entries } = await main.request('themes.history', {});
    expect(entries).toEqual([{ id: expect.any(String), at: expect.any(Number), actor: { kind: 'user' }, change: { kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' } }]);
    expect(await main.request('themes.undo', {})).toEqual({ undone: entries[0]!.change, arrangement: { sidebarWidth: 300 } });
    expect(violations).toEqual([]);
  });

  it('stages a theme file for the install card, and refuses one that is not a theme as an answer', async () => {
    const good = file('incoming.json');
    fs.writeFileSync(good, JSON.stringify(themeJson(ID, 'Incoming')));
    const { main, violations } = start();
    const prepared = await main.request('themes.install.prepare', { from: { kind: 'file', path: good } });
    expect(prepared).toMatchObject({ preview: { installId: expect.any(String), about: { name: 'Incoming' } } });
    const bad = file('notes.json');
    fs.writeFileSync(bad, '{ not json');
    expect(await main.request('themes.install.prepare', { from: { kind: 'file', path: bad } })).toMatchObject({ refused: { message: expect.any(String) } });
    expect(violations).toEqual([]);
  });
});

describe('the theme service at core start', () => {
  const marked = (entries: readonly unknown[], owners: readonly string[] = [OWNER]): void => {
    writeHistory(entries);
    write(['appearance.json'], { version: 1, pendingConfirm: { entryId: 'first', startedAt: 1, owners } });
    write(['drafts', 'left.json'], { id: 'left' });
  };
  const pick = { kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' };

  it('reverts the change a countdown left and tells main how it ended, with the arrangement to put back', async () => {
    marked([historyEntry('first', pick, { settings: { dark: null }, arrangement: { sidebarWidth: 300 } }), historyEntry('second', pick, { settings: { light: null } })]);
    const { host, settled, events, violations } = start();
    await host.settled();
    await vi.waitFor(() => expect(settled).toEqual([{ entryId: 'first', outcome: 'reverted', arrangement: { sidebarWidth: 300 }, atStart: true }]));
    expect(await host.service.pendingConfirm()).toBeUndefined();
    expect(await host.service.history()).toEqual([]);
    expect(events).toContain('themes.changed');
    expect(fs.existsSync(file('drafts', 'left.json'))).toBe(false);
    expect(violations).toEqual([]);
  });

  it('clears the mark, tells main the change is kept and still sweeps the drafts when the revert cannot be made', async () => {
    marked([historyEntry('first', pick), historyEntry('newer-fixed', { kind: 'teleport' }, { settings: { highContrast: 'x' } })]);
    const { host, settled, events, logs } = start();
    await host.settled();
    await vi.waitFor(() => expect(settled).toEqual([{ entryId: 'first', outcome: 'kept', atStart: true }]));
    expect(await host.service.pendingConfirm()).toBeUndefined();
    expect(await host.service.history()).toHaveLength(2);
    expect(events).toContain('themes.changed');
    expect(logs.some((line) => line.includes('could not be reverted, so it is kept'))).toBe(true);
    expect(fs.existsSync(file('drafts', 'left.json'))).toBe(false);
  });

  // Main's banner ends a revert that undid nothing as kept at once, which is right only because the settle is never behind the answer.
  it("posts its word that a countdown settled before its answer to the banner's revert of that countdown", async () => {
    const posted: string[] = [];
    const { main, host, settled } = start((envelope) => {
      if (envelope.kind === 'request' && envelope.method === 'themes.pendingSettled') posted.push('settled');
      else if (envelope.kind === 'response') posted.push('answer');
    });
    await host.settled();
    // the countdown's entry left the history under a mark that still names it
    writeHistory([]);
    write(['appearance.json'], { version: 1, pendingConfirm: { entryId: 'gone', startedAt: 1, owners: [OWNER] } });
    posted.length = 0;
    expect(await main.request('themes.undoPending', { entryId: 'gone' })).toEqual({});
    expect(posted).toEqual(['settled', 'answer']);
    expect(settled).toEqual([{ entryId: 'gone', outcome: 'kept' }]);
  });

  // the dev build and the installed app share the themes folder
  it('leaves a countdown another running Damocles counts, tells main so once, and reverts it once that one is gone', async () => {
    const other = createThemeService({ root: home, settings: fileSettings(file('settings.json')), owner: OTHER_APP });
    const draft: ThemeDraft = { id: other.drafts.newId(), owner: { authority: 'local', sessionId: 'chat-a', toolCallId: 'call-1' }, createdAt: 1, baseThemeId: null, baseHash: null, theme: themeJson(ID) as never };
    const applied = await other.applyDraft({ draft, pick: ['dark'], actor: { kind: 'agent', chatId: 'chat-a', title: '' }, onTheFly: true, currentArrangement: async () => undefined });
    if (applied.kind !== 'applied') throw new Error('not applied');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, settled, elsewhere, events, logs } = start();
    await host.settled();
    await vi.waitFor(() => expect(elsewhere).toEqual([applied.entryId]));
    expect(settled).toEqual([]);
    expect(events).toEqual([]);
    expect((await host.service.pendingConfirm())?.owners).toEqual([OTHER_APP]);
    expect(fs.existsSync(file('themes', ID, 'theme.json'))).toBe(true);
    expect(logs.some((line) => line.includes('another running Damocles counts'))).toBe(true);
    // asked again while the other one still runs: nothing more is told
    await vi.advanceTimersByTimeAsync(COUNTDOWN_RECHECK_MS);
    await host.settled();
    expect(elsewhere).toHaveLength(1);
    expect(settled).toEqual([]);
    // the other one ended without settling it: its lock is no longer refreshed
    const longAgo = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    fs.utimesSync(countdownLockPath(home, OTHER_APP), longAgo, longAgo);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_RECHECK_MS);
    await host.settled();
    await vi.waitFor(() => expect(settled).toEqual([{ entryId: applied.entryId, outcome: 'reverted' }]));
    expect(fs.existsSync(file('themes', ID, 'theme.json'))).toBe(false);
    expect(events).toContain('themes.changed');
  });

  it('reverts a countdown of another app that no longer runs, and sends no window arrangement, which was that app\'s', async () => {
    marked([historyEntry('first', pick, { settings: { dark: null }, arrangement: { sidebarWidth: 300 } })], [OTHER_APP]);
    const { host, settled } = start();
    await host.settled();
    await vi.waitFor(() => expect(settled).toEqual([{ entryId: 'first', outcome: 'reverted', atStart: true }]));
    expect(await host.service.history()).toEqual([]);
  });

  it('says nothing to main when no countdown was left', async () => {
    const { host, settled } = start();
    await host.settled();
    expect(settled).toEqual([]);
  });
});

describe('the theme service at core shutdown', () => {
  it('is settled only once the write lane is idle', async () => {
    const { host } = start();
    await host.settled();
    let release!: () => void;
    const held = host.service.lane.run(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    let settled = false;
    const waiting = host.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    release();
    await held;
    await waiting;
    expect(settled).toBe(true);
  });

  it('runs none of its timers after dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { host } = start();
    const collect = vi.spyOn(host.service, 'collectBlobs').mockResolvedValue(0);
    const analyze = vi.spyOn(host.service, 'analyzeMissing').mockResolvedValue({ analyzed: 0, failed: 0 });
    host.dispose();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(collect).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe('the start-up analysis pass', () => {
  it('runs again after each retry delay while a wallpaper or sprite stays unanalyzed, then stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { host } = start();
    vi.spyOn(host.service, 'collectBlobs').mockResolvedValue(0);
    const analyze = vi.spyOn(host.service, 'analyzeMissing').mockResolvedValue({ analyzed: 0, failed: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(analyze).toHaveBeenCalledTimes(1);
    for (const [index, delay] of ANALYZE_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(analyze).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(analyze).toHaveBeenCalledTimes(ANALYZE_RETRY_DELAYS_MS.length + 1);
  });

  it('runs once when every wallpaper and sprite was analyzed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { host } = start();
    vi.spyOn(host.service, 'collectBlobs').mockResolvedValue(0);
    const analyze = vi.spyOn(host.service, 'analyzeMissing').mockResolvedValue({ analyzed: 2, failed: 0 });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});

describe('a staged install that waits too long', () => {
  it('is dropped, and main hears that it expired', async () => {
    const incoming = file('incoming.json');
    fs.writeFileSync(incoming, JSON.stringify(themeJson(ID, 'Incoming')));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { main, host, events } = start();
    vi.spyOn(host.service, 'collectBlobs').mockResolvedValue(0);
    vi.spyOn(host.service, 'analyzeMissing').mockResolvedValue({ analyzed: 0, failed: 0 });
    const prepared = await main.request('themes.install.prepare', { from: { kind: 'file', path: incoming } });
    if (!('preview' in prepared)) throw new Error('refused');
    const { installId } = prepared.preview;
    await vi.advanceTimersByTimeAsync(STAGED_INSTALL_TTL_MS - 1);
    expect(events).not.toContain(`expired:${installId}`);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(events).toContain(`expired:${installId}`));
    expect(await main.request('themes.install.commit', { installId, useArrangement: false })).toMatchObject({ refused: { message: 'This theme install is no longer open. Start it again.' } });
  });
});
