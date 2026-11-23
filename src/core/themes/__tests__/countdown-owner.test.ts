// A keep-changes countdown belongs to the apps that count it: a start reverts it only once none of them runs.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEMES_DARK_SETTING } from '../../../desktop/local-services/desktop-configuration';
import { countdownLockPath } from '../countdown-lock';
import { createThemeService, type ThemeService } from '../index';
import { LOCK_STALE_MS } from '../write-lane';
import { AGENT, draftOf, failWrites, fileSettings, ID, named, OTHER, readJson, writeTheme } from './service-fixtures';

const INSTALLED = 'a'.repeat(32);
const DEV = 'b'.repeat(32);
const THIRD = 'c'.repeat(32);

let root: string;
let settingsFile: string;

const service = (owner: string): ThemeService => createThemeService({ root, settings: fileSettings(settingsFile), owner });
const appearanceFile = (): string => path.join(root, 'appearance.json');
const themeFile = (id: string): string => path.join(root, 'themes', id, 'theme.json');
const mark = (): unknown => readJson(appearanceFile())['pendingConfirm'];
const applyOnTheFly = async (themes: ThemeService): Promise<string> => {
  const draft = draftOf(themes.drafts.newId(), OTHER);
  const applied = await themes.applyDraft({ draft, pick: ['dark'], actor: AGENT, onTheFly: true, currentArrangement: async () => undefined });
  if (applied.kind !== 'applied') throw new Error('not applied');
  return applied.entryId;
};
// A process that ended without letting go leaves its lock as it last refreshed it, which goes stale.
const ended = (owner: string): void => {
  const longAgo = new Date(Date.now() - LOCK_STALE_MS - 5_000);
  fs.utimesSync(countdownLockPath(root, owner), longAgo, longAgo);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-countdown-owner-'));
  settingsFile = path.join(root, 'settings.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the owner of a keep-changes countdown', () => {
  it('is named by the mark and holds its lock for as long as it counts', async () => {
    const installed = service(INSTALLED);
    const entryId = await applyOnTheFly(installed);
    expect(mark()).toEqual({ entryId, startedAt: expect.any(Number), owners: [INSTALLED] });
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(true);
    await installed.keep(entryId);
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(false);
  });

  it('lets go of its lock when the banner reverts, and when the change is not made', async () => {
    const installed = service(INSTALLED);
    const entryId = await applyOnTheFly(installed);
    await installed.undo(entryId);
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(false);
    const failing = failWrites(named('theme.json'));
    await expect(applyOnTheFly(installed)).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(mark()).toBeUndefined();
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(false);
  });

  it('is left counting by the start of another app, which reverts nothing', async () => {
    const installed = service(INSTALLED);
    const entryId = await applyOnTheFly(installed);
    const dev = service(DEV);
    let changed = 0;
    dev.onDidChange(() => changed++);
    expect(await dev.settlePendingAtStart()).toEqual({ entryId, outcome: 'counted' });
    expect(mark()).toEqual({ entryId, startedAt: expect.any(Number), owners: [INSTALLED] });
    expect(fs.existsSync(themeFile(OTHER))).toBe(true);
    expect(readJson(settingsFile)[THEMES_DARK_SETTING]).toBe(OTHER);
    expect(await installed.history()).toHaveLength(1);
    // asked again while the owner still runs, the answer is the same and nothing is told changed
    changed = 0;
    expect(await dev.settlePendingLeft()).toEqual({ entryId, outcome: 'counted' });
    expect(changed).toBe(0);
    // the owner's own banner still ends it
    expect(await installed.undo(entryId)).toMatchObject({ undone: { kind: 'create' } });
    expect(fs.existsSync(themeFile(OTHER))).toBe(false);
    expect(await dev.settlePendingLeft()).toBeUndefined();
  });

  it('is reverted by the start of another app once its owner is gone', async () => {
    const entryId = await applyOnTheFly(service(INSTALLED));
    ended(INSTALLED);
    expect(await service(DEV).settlePendingAtStart()).toEqual({ entryId, outcome: 'reverted' });
    expect(mark()).toBeUndefined();
    expect(fs.existsSync(themeFile(OTHER))).toBe(false);
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(false);
  });

  it('is reverted at once by the next start of the same app, whose core that ended left a lock still fresh', async () => {
    const crashed = service(INSTALLED);
    const entryId = await applyOnTheFly(crashed);
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(true);
    const restarted = service(INSTALLED);
    expect(await restarted.settlePendingAtStart()).toEqual({ entryId, outcome: 'reverted' });
    expect(mark()).toBeUndefined();
    expect(fs.existsSync(themeFile(OTHER))).toBe(false);
  });

  it('is joined by an app that changes a theme while it stands, and then waits for every app that counts it', async () => {
    writeTheme(root, ID);
    const installed = service(INSTALLED);
    const entryId = await applyOnTheFly(installed);
    const dev = service(DEV);
    await dev.rename(ID, 'Dusk');
    expect(mark()).toEqual({ entryId, startedAt: expect.any(Number), owners: [INSTALLED, DEV] });
    expect(fs.existsSync(countdownLockPath(root, DEV))).toBe(true);
    // this app counts it now, so it asks nothing more of it
    expect(await dev.settlePendingLeft()).toBeUndefined();
    ended(INSTALLED);
    const third = service(THIRD);
    expect(await third.settlePendingAtStart()).toEqual({ entryId, outcome: 'counted' });
    ended(DEV);
    expect(await third.settlePendingLeft()).toEqual({ entryId, outcome: 'reverted' });
    expect(fs.existsSync(themeFile(OTHER))).toBe(false);
    expect((readJson(themeFile(ID)) as { name: string }).name).toBe('Night');
  });

  it('keeps the same app counting with the other app after its engine restarted, under its own lock again', async () => {
    writeTheme(root, ID);
    const installed = service(INSTALLED);
    const entryId = await applyOnTheFly(installed);
    await service(DEV).rename(ID, 'Dusk');
    const restarted = service(INSTALLED);
    expect(await restarted.settlePendingAtStart()).toEqual({ entryId, outcome: 'counted' });
    ended(DEV);
    // a start elsewhere still finds this app counting
    expect(await service(THIRD).settlePendingAtStart()).toEqual({ entryId, outcome: 'counted' });
    expect(await restarted.undo(entryId)).toMatchObject({ undone: { kind: 'create' } });
    expect(fs.existsSync(countdownLockPath(root, INSTALLED))).toBe(false);
  });

  it('lets go of its lock once another app ended the countdown it had joined', async () => {
    writeTheme(root, ID);
    const installed = service(INSTALLED);
    const entryId = await applyOnTheFly(installed);
    const dev = service(DEV);
    await dev.rename(ID, 'Dusk');
    await installed.keep(entryId);
    // the joined app's banner then asks for an end that is no longer its to make
    expect(await dev.undo(entryId)).toEqual({});
    expect(fs.existsSync(countdownLockPath(root, DEV))).toBe(false);
  });

  it('reads a mark that names no owner, or one that is no owner id, as no mark', async () => {
    for (const owners of [undefined, [], ['../../elsewhere'], [INSTALLED, 7]]) {
      fs.writeFileSync(appearanceFile(), JSON.stringify({ version: 1, pendingConfirm: { entryId: 'e1', startedAt: 1, ...(owners ? { owners } : {}) } }));
      const themes = service(DEV);
      expect(await themes.pendingConfirm()).toBeUndefined();
      expect(await themes.settlePendingAtStart()).toBeUndefined();
    }
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.countdown'))).toEqual([]);
    expect(fs.existsSync(path.join(root, '..', '..', 'elsewhere'))).toBe(false);
  });
});
