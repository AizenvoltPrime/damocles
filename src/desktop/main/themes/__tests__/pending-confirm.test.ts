import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_HISTORY_BYTES, MAX_STATE_FILE_BYTES } from '../../../../shared/themes/limits';
import { createThemePathRule } from '../../../../core/themes/network-rule';
import { COUNTDOWN_OWNER } from '../../../../shared/themes/agent';
import { countdownOwnerOf, heldLookOf, readCountdownEnd, readPendingBefore, readStateJson } from '../pending-confirm';

// What main paints before the first paint of a launch whose last run ended during the keep-changes countdown: the look the
// pending entry's before-snapshot describes, read without writing anything.

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
// the app whose countdown the mark is
const OWNER = 'a'.repeat(32);
const COLORS = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const THEME_TEXT = JSON.stringify({ schemaVersion: 1, id: ID, name: 'Before', looks: { dark: { colors: COLORS } } });

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-pending-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));
}

describe('countdownOwnerOf', () => {
  it('names an app by its userData folder: the same at every run, another for another folder, and fit for a mark', () => {
    const installed = countdownOwnerOf(path.join(root, 'damocles'));
    expect(installed).toMatch(COUNTDOWN_OWNER);
    expect(countdownOwnerOf(path.join(root, 'damocles'))).toBe(installed);
    expect(countdownOwnerOf(path.join(root, 'elsewhere', '..', 'damocles'))).toBe(installed);
    expect(countdownOwnerOf(path.join(root, 'damocles-dev'))).not.toBe(installed);
  });
});

describe('heldLookOf', () => {
  it('reads the preferred looks (unset as the built-in) and each theme file, a missing one as none and a broken one as broken', () => {
    const look = heldLookOf({ settings: { dark: ID, light: null }, themes: { [ID]: THEME_TEXT, gone: null, bad: '{not json' } })!;
    expect(look.preferred).toEqual({ dark: ID, light: 'damocles' });
    expect(look.themes.get(ID)).toMatchObject({ status: 'ok', theme: { name: 'Before' } });
    expect(look.themes.has('gone')).toBe(true);
    expect(look.themes.get('gone')).toBeUndefined();
    expect(look.themes.get('bad')).toMatchObject({ status: 'broken' });
    expect(heldLookOf({ themes: { [ID]: `\ufeff${THEME_TEXT}` } })!.themes.get(ID)).toMatchObject({ status: 'ok' });
    expect(heldLookOf('nonsense')).toBeUndefined();
  });

  it("reads the project looks from before a project look's change, none when projects.json was missing, and leaves them out otherwise", () => {
    const touched = { mode: 'touches', accent: '#3a86ff' };
    expect(heldLookOf({ projects: JSON.stringify({ version: 1, pins: {}, looks: { '/work/site': touched } }) })!.projectLooks).toEqual({ '/work/site': touched });
    expect(heldLookOf({ projects: null })!.projectLooks).toEqual({});
    expect(heldLookOf({ settings: { dark: ID } })!.projectLooks).toBeUndefined();
  });

  it('reads the mode from before a change that set it, the default when the setting was not there, and leaves it out otherwise', () => {
    expect(heldLookOf({ mode: 'light' })!.mode).toBe('light');
    expect(heldLookOf({ mode: null })!.mode).toBe('system');
    expect(heldLookOf({ mode: 'sepia' })!.mode).toBe('system');
    expect(heldLookOf({ settings: { dark: ID } })).not.toHaveProperty('mode');
  });

  it('reads the schedule and its pick from before a change that wrote appearance.json, none when the file was missing or does not parse', () => {
    const schedule = { enabled: true, rules: [{ days: ['mon', 'tue'], minute: 480, theme: ID, look: 'dark' }] };
    const held = heldLookOf({ appearance: JSON.stringify({ version: 1, schedule, override: { themeId: ID, kind: 'dark', at: 5 }, pendingConfirm: { entryId: 'e0', startedAt: 1, owners: [OWNER] } }) })!;
    expect(held.schedule?.override).toEqual({ themeId: ID, kind: 'dark', at: 5 });
    expect(held.schedule?.schedule.enabled).toBe(true);
    // the schedule ran with no pick over it: the change's own pick is not part of the look from before
    expect(heldLookOf({ appearance: JSON.stringify({ version: 1, schedule }) })!.schedule).not.toHaveProperty('override');
    expect(heldLookOf({ appearance: null })!.schedule).toEqual({ schedule: { enabled: false, rules: [] } });
    expect(heldLookOf({ appearance: '{not json' })!.schedule).toEqual({ schedule: { enabled: false, rules: [] } });
    expect(heldLookOf({ settings: { dark: ID } })).not.toHaveProperty('schedule');
  });

  it('reads Show wallpapers from before a change that set it, on when the setting was not there', () => {
    expect(heldLookOf({ showWallpapers: false })!.showWallpapers).toBe(false);
    expect(heldLookOf({ showWallpapers: true })!.showWallpapers).toBe(true);
    expect(heldLookOf({ showWallpapers: null })!.showWallpapers).toBe(true);
    expect(heldLookOf({ settings: { dark: ID } })).not.toHaveProperty('showWallpapers');
  });
});

describe('readPendingBefore', () => {
  it('finds the mark and its entry, and nothing without either', async () => {
    expect(await readPendingBefore(root, () => undefined)).toBeUndefined();
    write('appearance.json', { version: 1, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
    expect(await readPendingBefore(root, () => undefined)).toBeUndefined();
    write('history/index.json', { version: 1, entries: [{ id: 'e1', at: 5, actor: { kind: 'agent', chatId: 'c', title: '' }, change: { kind: 'save', theme: 'X' }, before: { themes: { [ID]: THEME_TEXT } } }] });
    const pending = await readPendingBefore(root, () => undefined);
    expect(pending?.mark).toEqual({ entryId: 'e1', startedAt: 5, owners: [OWNER] });
    expect(pending?.look.themes.get(ID)).toMatchObject({ status: 'ok' });
    write('appearance.json', { version: 2, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
    expect(await readPendingBefore(root, () => undefined)).toBeUndefined();
  });

  // core lists no entry of a history a newer Damocles wrote, so main names no look from it either
  it('reads a history of another version as holding no entries', async () => {
    write('appearance.json', { version: 1, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
    write('history/index.json', { version: 2, entries: [{ id: 'e1', before: { settings: { dark: ID } } }] });
    expect(await readPendingBefore(root, () => undefined)).toBeUndefined();
  });

  // Main parses on its own thread, so it reads neither file past the size its writer keeps to.
  it('reads no history file past the size core keeps it to, and says so once', async () => {
    write('appearance.json', { version: 1, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
    fs.mkdirSync(path.join(root, 'history'));
    const file = path.join(root, 'history', 'index.json');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_HISTORY_BYTES + 1);
    const lines: string[] = [];
    expect(await readPendingBefore(root, (line) => lines.push(line))).toBeUndefined();
    expect(await readPendingBefore(root, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([`[themes] ${file} is ${MAX_HISTORY_BYTES + 1} bytes, more than the ${MAX_HISTORY_BYTES} its writer keeps to, so it was not read`]);
  });

  // core reads its state files past a byte order mark, so main must name the same countdown from the same bytes
  it('reads an appearance.json and a history that start with a byte order mark', async () => {
    const bom = (value: unknown): string => `\ufeff${JSON.stringify(value)}`;
    fs.writeFileSync(path.join(root, 'appearance.json'), bom({ version: 1, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } }));
    fs.mkdirSync(path.join(root, 'history'));
    fs.writeFileSync(path.join(root, 'history', 'index.json'), bom({ version: 1, entries: [{ id: 'e1', before: { settings: { dark: ID } } }] }));
    const pending = await readPendingBefore(root, () => undefined);
    expect(pending?.mark).toMatchObject({ entryId: 'e1' });
    expect(pending?.look.preferred).toEqual({ dark: ID });
    expect(await readStateJson(createThemePathRule(root), path.join(root, 'appearance.json'), MAX_STATE_FILE_BYTES, () => undefined)).toMatchObject({ version: 1 });
  });

  describe('readCountdownEnd', () => {
    const end = (): Promise<string> => readCountdownEnd(root, 'e1', () => undefined);
    const entry = { id: 'e1', before: {} };

    it('answers marked while the mark names the entry, kept while only the history holds it, and reverted once neither does', async () => {
      write('appearance.json', { version: 1, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
      write('history/index.json', { version: 1, entries: [entry] });
      expect(await end()).toBe('marked');
      write('appearance.json', { version: 1 });
      expect(await end()).toBe('kept');
      write('history/index.json', { version: 1, entries: [] });
      expect(await end()).toBe('reverted');
      fs.rmSync(path.join(root, 'appearance.json'));
      fs.rmSync(path.join(root, 'history'), { recursive: true });
      expect(await end()).toBe('reverted');
    });

    // a file main cannot read says nothing of the countdown, so main names no end from it
    it('answers unknown when a file it needs is there and cannot be read, or is of another version', async () => {
      fs.writeFileSync(path.join(root, 'appearance.json'), '{ "version": 1, "pend');
      write('history/index.json', { version: 1, entries: [] });
      expect(await end()).toBe('unknown');
      write('appearance.json', { version: 2, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
      expect(await end()).toBe('unknown');
      write('appearance.json', { version: 1 });
      fs.writeFileSync(path.join(root, 'history', 'index.json'), '{ "version": 1, "entr');
      expect(await end()).toBe('unknown');
      write('history/index.json', { version: 2, entries: [entry] });
      expect(await end()).toBe('unknown');
      // the mark answers by itself, whatever the history is
      write('appearance.json', { version: 1, pendingConfirm: { entryId: 'e1', startedAt: 5, owners: [OWNER] } });
      expect(await end()).toBe('marked');
    });
  });

  it('reads no appearance.json past its size either', async () => {
    const file = path.join(root, 'appearance.json');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, MAX_STATE_FILE_BYTES + 1);
    const lines: string[] = [];
    expect(await readPendingBefore(root, (line) => lines.push(line))).toBeUndefined();
    expect(await readPendingBefore(root, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('so it was not read');
  });
});
