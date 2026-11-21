import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { parseContributedConfiguration } from '../../../core/config/contributed-configuration';
import { DesktopSettingsStore } from '../../local-services/settings-store';
import { migrateRenamedSearchSettings } from '../search-settings-migration';

let dir: string;
let userFile: string;
const stores: DesktopSettingsStore[] = [];

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-search-migration-')));
  userFile = path.join(dir, 'settings.json');
});

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.flush();
    store.dispose();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The desktop user settings store over userFile, holding settings. */
function store(settings: Record<string, unknown>): DesktopSettingsStore {
  fs.writeFileSync(userFile, `${JSON.stringify(settings, null, 2)}\n`);
  const fake = createFakePlatform();
  const none = { dispose: () => undefined };
  const created = new DesktopSettingsStore({
    userFile,
    contributed: parseContributedConfiguration({ contributes: { configuration: { properties: {} } } }),
    fileWatchers: fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust: fake.trust,
    defaultProject: { folder: () => undefined, onDidChange: () => none },
    chatFolders: { folders: () => [], onDidChange: () => none },
    notifications: fake.notifications,
    log: () => undefined,
  });
  stores.push(created);
  return created;
}

const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(userFile, 'utf8')) as Record<string, unknown>;

describe('migrateRenamedSearchSettings', () => {
  it('moves each old search.use*IgnoreFiles value to its unset damocles.desktop.search key and removes the old key', async () => {
    const settings = store({ 'search.useIgnoreFiles': false, 'search.useGlobalIgnoreFiles': false, 'search.useParentIgnoreFiles': true, 'damocles.model': 'm' });
    await migrateRenamedSearchSettings(settings, () => undefined);
    expect(onDisk()).toEqual({
      'damocles.model': 'm',
      'damocles.desktop.search.useIgnoreFiles': false,
      'damocles.desktop.search.useGlobalIgnoreFiles': false,
      'damocles.desktop.search.useParentIgnoreFiles': true,
    });
  });

  it('never overwrites a new key the user set, and still removes the old one', async () => {
    const settings = store({ 'search.useIgnoreFiles': false, 'damocles.desktop.search.useIgnoreFiles': true });
    await migrateRenamedSearchSettings(settings, () => undefined);
    expect(onDisk()).toEqual({ 'damocles.desktop.search.useIgnoreFiles': true });
  });

  it('changes nothing on a later start, and nothing in a file without an old key', async () => {
    const settings = store({ 'search.useParentIgnoreFiles': false });
    await migrateRenamedSearchSettings(settings, () => undefined);
    const after = fs.readFileSync(userFile, 'utf8');
    const lines: string[] = [];
    await migrateRenamedSearchSettings(settings, (line) => lines.push(line));
    expect(fs.readFileSync(userFile, 'utf8')).toBe(after);
    expect(lines).toEqual([]);
    expect(onDisk()).toEqual({ 'damocles.desktop.search.useParentIgnoreFiles': false });
  });

  it('keeps the old key, and its value, when the new key cannot be written', async () => {
    const settings = store({ 'search.useIgnoreFiles': false });
    const failing = { inspect: settings.inspect.bind(settings), update: async (key: string, value: unknown, scope: 'user') => {
      if (key === 'damocles.desktop.search.useIgnoreFiles') throw new Error('EACCES: permission denied');
      await settings.update(key, value, scope);
    } };
    await expect(migrateRenamedSearchSettings(failing, () => undefined)).rejects.toThrow('EACCES');
    expect(onDisk()).toEqual({ 'search.useIgnoreFiles': false });
  });
});
