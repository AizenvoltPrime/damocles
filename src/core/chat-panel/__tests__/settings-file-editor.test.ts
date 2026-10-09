import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { locateSettingsFile, saveSettingsFileText, SettingsFileAvailabilityFeed } from '../settings-file-editor';
import { settingsFileVersion } from '../../config/settings-file';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import type { PanelHost } from '../../../platform/window-service';
import type { ExtensionToWebviewMessage, SettingsFileScope } from '../../../shared/types/messages';

let root: string;
let project: string;
let userFile: string;
let projectFile: string;
let platform: FakePlatform;
let posted: Array<{ host: PanelHost; message: ExtensionToWebviewMessage }>;
let feed: SettingsFileAvailabilityFeed;
const hostA = { name: 'A' } as unknown as PanelHost;

function setup(opts: { trusted?: boolean; folders?: boolean } = {}): void {
  platform = createFakePlatform({
    capabilities: { settingsSources: true, monaco: true },
    trusted: opts.trusted ?? true,
    folders: opts.folders === false ? [] : [{ fsPath: project, name: 'proj' }],
    settings: {
      scopeFiles: {
        user: userFile,
        ...(opts.folders === false ? {} : { project: projectFile, local: path.join(project, '.damocles', 'settings.local.json') }),
      },
    },
  });
  posted = [];
  feed = new SettingsFileAvailabilityFeed(platform, (host, message) => posted.push({ host, message }));
}

const save = (scope: SettingsFileScope, content: string, baseVersion: string, filePath = scope === 'user' ? userFile : projectFile) =>
  saveSettingsFileText(platform, scope, filePath, content, baseVersion);
const versionOf = (file: string): string => settingsFileVersion(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-file-editor-'));
  project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.damocles'), { recursive: true });
  userFile = path.join(root, 'home', '.damocles', 'settings.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  projectFile = path.join(project, '.damocles', 'settings.json');
  setup();
});

afterEach(() => {
  feed.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('locateSettingsFile', () => {
  it('names project and local files only for a trusted default project', () => {
    expect(locateSettingsFile(platform, 'user')).toBe(userFile);
    expect(locateSettingsFile(platform, 'project')).toBe(projectFile);
    setup({ trusted: false });
    expect(locateSettingsFile(platform, 'project')).toEqual({ reason: 'untrusted' });
    expect(locateSettingsFile(platform, 'user')).toBe(userFile);
    setup({ folders: false });
    expect(locateSettingsFile(platform, 'local')).toEqual({ reason: 'noProject' });
  });

  it('refuses a scope outside user, project and local', () => {
    expect(() => locateSettingsFile(platform, '../x' as SettingsFileScope)).toThrow('unknown settings file scope "../x"');
  });
});

describe('saveSettingsFileText', () => {
  it('writes the text verbatim and returns its version', async () => {
    const valid = '{\n    "damocles.model": "y",\n    "permissions": { "deny": ["Bash(rm:*)"] }\n}';
    expect(await save('project', '// kept?\n{ "damocles.model": "y" }', '')).toMatchObject({ ok: false });
    expect(await save('project', valid, '')).toEqual({ ok: true, path: projectFile, version: settingsFileVersion(valid) });
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(valid);
  });

  it('refuses text that is not JSON, with the parser message, and leaves the file alone', async () => {
    fs.writeFileSync(userFile, '{}');
    const result = await save('user', '{ "a": }', versionOf(userFile));
    expect(result).toMatchObject({ ok: false, conflict: false });
    expect(result.ok ? '' : result.error).toMatch(/^Not saved: the text is not valid JSON\. .+/);
    expect(result).not.toHaveProperty('cause');
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{}');
  });

  it('hands back the error of a write that failed, for a host that words it itself', async () => {
    fs.mkdirSync(userFile);
    const result = await save('user', '{}', settingsFileVersion(undefined));
    expect(result).toMatchObject({ ok: false, conflict: false, cause: expect.objectContaining({ code: expect.any(String) }) });
  });

  it('never overwrites a file on disk that does not parse', async () => {
    fs.writeFileSync(userFile, '{ broken');
    const result = await save('user', '{}', versionOf(userFile));
    expect(result.ok ? '' : result.error).toMatch(/does not parse, so it was not overwritten/);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ broken');
  });

  it('refuses as a conflict when the file changed since its version was read, and saves against the newer version', async () => {
    fs.writeFileSync(userFile, '{}');
    const loaded = versionOf(userFile);
    fs.writeFileSync(userFile, '{ "damocles.model": "other" }');

    expect(await save('user', '{ "damocles.model": "mine" }', loaded)).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "damocles.model": "other" }');

    expect(await save('user', '{ "damocles.model": "mine" }', versionOf(userFile))).toMatchObject({ ok: true });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "damocles.model": "mine" }');
  });

  it('treats a file deleted since its version was read as a conflict', async () => {
    fs.writeFileSync(userFile, '{}');
    const loaded = versionOf(userFile);
    fs.rmSync(userFile);
    expect(await save('user', '{}', loaded)).toMatchObject({ ok: false, conflict: true });
  });

  it('lets only the first of two saves from the same version write', async () => {
    fs.writeFileSync(userFile, '{}');
    const version = versionOf(userFile);
    const [first, second] = await Promise.all([save('user', '{ "damocles.model": "a" }', version), save('user', '{ "damocles.model": "b" }', version)]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "damocles.model": "a" }');
  });

  it("refuses a project file that a symlink points at another tool's settings", async () => {
    const claudeFile = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, '{}');
    fs.symlinkSync(claudeFile, projectFile, 'file');

    expect(await save('project', '{ "damocles.model": "x" }', versionOf(projectFile))).toMatchObject({ ok: false });
    expect(fs.readFileSync(claudeFile, 'utf8')).toBe('{}');
  });

  it('refuses to save into another project\'s file once the default project moved, even when both files are missing', async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, '.damocles'), { recursive: true });
    platform.workspaceFolders.setFolders([{ fsPath: other, name: 'other' }]);
    const otherFile = path.join(other, '.damocles', 'settings.json');
    platform.settings.scopeFile = (scope) => (scope === 'user' ? userFile : otherFile);

    expect(await save('project', '{ "permissions": { "allow": ["Bash"] } }', '', projectFile)).toMatchObject({ ok: false, conflict: false, error: 'The default project changed since this file was opened. Reload it before saving.' });
    expect(fs.existsSync(otherFile)).toBe(false);
    expect(fs.existsSync(projectFile)).toBe(false);
  });

  it('refuses a project file of an untrusted project', async () => {
    platform.trust.setTrusted(false);
    expect(await save('project', '{}', '')).toMatchObject({ ok: false, error: 'The project is not trusted, so its settings files cannot be saved.' });
    expect(fs.existsSync(projectFile)).toBe(false);
  });

  it('refuses on a host that keeps no settings files', async () => {
    platform = createFakePlatform();
    await expect(save('user', '{}', '')).rejects.toThrow('this host keeps no Damocles settings files to edit');
  });
});

describe('availability', () => {
  const availableAll = { user: { available: true }, project: { available: true }, local: { available: true } };

  it('names the files that apply, without reading them', () => {
    setup({ trusted: false });
    feed.availability('p1', hostA);
    expect(posted.at(-1)?.message).toEqual({ type: 'settingsFileAvailability', files: { user: { available: true }, project: { available: false, reason: 'untrusted' }, local: { available: false, reason: 'untrusted' } } });
    expect(platform.fileWatchers.watchers).toHaveLength(0);
  });

  it('tells each panel that asked when trust is granted or the projects change, until it is released', () => {
    setup({ trusted: false });
    expect(feed.availability('p1', hostA)).toBe(true);
    expect(feed.availability('p1', hostA)).toBe(false);
    posted = [];

    platform.trust.grantTrust();
    expect(posted).toEqual([{ host: hostA, message: { type: 'settingsFileAvailability', files: availableAll } }]);

    platform.workspaceFolders.setFolders([]);
    expect(posted[1]).toEqual({ host: hostA, message: { type: 'settingsFileAvailability', files: { ...availableAll, project: { available: false, reason: 'noProject' }, local: { available: false, reason: 'noProject' } } } });

    feed.releasePanel('p1');
    platform.trust.grantTrust();
    expect(posted).toHaveLength(2);
  });
});
