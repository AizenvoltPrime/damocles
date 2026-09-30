import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));

// Runs between the file landing on disk and the save resolving, where a watcher event can arrive.
const writeHooks = vi.hoisted(() => ({ afterWrite: undefined as (() => Promise<void>) | undefined }));
vi.mock('../../config/json-config-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/json-config-write')>();
  return {
    ...actual,
    writeJsonConfig: async (...args: Parameters<typeof actual.writeJsonConfig>) => {
      await actual.writeJsonConfig(...args);
      await writeHooks.afterWrite?.();
    },
  };
});

import { SettingsFileEditor } from '../settings-file-editor';
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
let editor: SettingsFileEditor;
const hostA = { name: 'A' } as unknown as PanelHost;
const hostB = { name: 'B' } as unknown as PanelHost;

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
  editor = new SettingsFileEditor(platform, (host, message) => posted.push({ host, message }));
}

const last = () => posted[posted.length - 1]?.message;

async function loaded(scope: SettingsFileScope, host = hostA, panelId = 'p1') {
  await editor.load(panelId, host, scope);
  const message = last();
  if (message?.type !== 'settingsFileContent') throw new Error(`expected settingsFileContent, got ${message?.type}`);
  return message.file;
}

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
  writeHooks.afterWrite = undefined;
  editor.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('load', () => {
  it('sends the file text and its version', async () => {
    const text = '{\n  "damocles.model": "x"\n}\n';
    fs.writeFileSync(userFile, text);

    expect(await loaded('user')).toEqual({ scope: 'user', status: 'ready', path: userFile, exists: true, content: text, version: settingsFileVersion(text) });
  });

  it('sends an absent file as empty with an empty version', async () => {
    expect(await loaded('project')).toEqual({ scope: 'project', status: 'ready', path: projectFile, exists: false, content: '', version: '' });
  });

  it('reports the parse error of a file that does not parse', async () => {
    fs.writeFileSync(projectFile, '{ "a": 1, }');

    const file = await loaded('project');
    expect(file).toMatchObject({ status: 'ready', content: '{ "a": 1, }' });
    expect(file.status === 'ready' ? file.parseError : undefined).toMatch(/JSON/);
  });

  it('reports a file holding a non-object as unparseable', async () => {
    fs.writeFileSync(userFile, '[]');

    const file = await loaded('user');
    expect(file.status === 'ready' ? file.parseError : undefined).toBe(`${userFile} does not hold a JSON object`);
  });

  it('refuses project and local files of an untrusted project', async () => {
    setup({ trusted: false });

    expect(await loaded('project')).toEqual({ scope: 'project', status: 'unavailable', reason: 'untrusted' });
    expect(await loaded('local')).toEqual({ scope: 'local', status: 'unavailable', reason: 'untrusted' });
    expect((await loaded('user')).status).toBe('ready');
  });

  it('reports no project when none is open', async () => {
    setup({ folders: false });

    expect(await loaded('project')).toEqual({ scope: 'project', status: 'unavailable', reason: 'noProject' });
  });

  it('reports a path it cannot read as unreadable and keeps nothing for it', async () => {
    fs.rmSync(userFile, { force: true });
    fs.mkdirSync(userFile);

    const file = await loaded('user');

    expect(file).toMatchObject({ scope: 'user', status: 'unavailable', reason: 'unreadable', path: userFile });
    expect(file.status === 'unavailable' && file.reason === 'unreadable' ? file.error : '').toMatch(/EISDIR/);
    expect(platform.fileWatchers.watchers).toHaveLength(0);
  });

  it('registers nothing for a panel whose watcher could not start, so a later load holds the panel again', async () => {
    const watch = vi.spyOn(platform.fileWatchers, 'watch').mockImplementationOnce(() => { throw new Error('no watcher'); });

    await expect(editor.load('p1', hostA, 'user')).rejects.toThrow('no watcher');
    watch.mockRestore();

    expect(await editor.load('p1', hostA, 'user')).toBe(true);
  });

  it('refuses on a host that keeps no settings files', async () => {
    platform = createFakePlatform();
    editor = new SettingsFileEditor(platform, () => undefined);

    await expect(editor.load('p1', hostA, 'user')).rejects.toThrow('this host keeps no Damocles settings files to edit');
  });

  it('refuses a scope outside user, project and local', async () => {
    await expect(editor.load('p1', hostA, 'workspace' as SettingsFileScope)).rejects.toThrow('unknown settings file scope "workspace"');
    await expect(editor.save('p1', hostA, '../x' as SettingsFileScope, '{}', '')).rejects.toThrow('unknown settings file scope "../x"');
    expect(posted).toEqual([]);
  });
});

describe('save', () => {
  async function saveResult(scope: SettingsFileScope, content: string, baseVersion: string) {
    await editor.save('p1', hostA, scope, content, baseVersion);
    const message = last();
    if (message?.type !== 'settingsFileSaveResult') throw new Error(`expected settingsFileSaveResult, got ${message?.type}`);
    return message;
  }

  it('writes the text verbatim and returns its version', async () => {
    const { version } = await loaded('project') as { version: string };
    const text = '// kept?\n{ "damocles.model": "y" }';
    const valid = '{\n    "damocles.model": "y",\n    "permissions": { "deny": ["Bash(rm:*)"] }\n}';

    expect(await saveResult('project', text, version)).toMatchObject({ ok: false });
    expect(await saveResult('project', valid, version)).toEqual({ type: 'settingsFileSaveResult', scope: 'project', ok: true, version: settingsFileVersion(valid) });
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(valid);
  });

  it('refuses text that is not JSON, with the parser message, and leaves the file alone', async () => {
    fs.writeFileSync(userFile, '{}');
    const { version } = await loaded('user') as { version: string };

    const result = await saveResult('user', '{ "a": }', version);

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toMatch(/^Not saved: the text is not valid JSON\. .+/);
    expect(result.ok ? undefined : result.conflict).toBeUndefined();
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{}');
  });

  it('never overwrites a file on disk that does not parse', async () => {
    fs.writeFileSync(userFile, '{ broken');
    const { version } = await loaded('user') as { version: string };

    const result = await saveResult('user', '{}', version);

    expect(result.ok ? '' : result.error).toMatch(/does not parse, so it was not overwritten/);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ broken');
  });

  it('refuses as a conflict when the file changed since it was loaded', async () => {
    fs.writeFileSync(userFile, '{}');
    const { version } = await loaded('user') as { version: string };
    fs.writeFileSync(userFile, '{ "damocles.model": "other" }');

    const result = await saveResult('user', '{ "damocles.model": "mine" }', version);

    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "damocles.model": "other" }');
  });

  it('refuses as a conflict when the default project moved since the file was loaded', async () => {
    const { version } = await loaded('project') as { version: string };
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    platform.workspaceFolders.setFolders([{ fsPath: other, name: 'other' }]);
    // The desktop store names the new default project's files.
    vi.spyOn(platform.settings, 'scopeFile').mockImplementation((scope) => (scope === 'user' ? userFile : path.join(other, '.damocles', 'settings.json')));

    expect(await saveResult('project', '{}', version)).toMatchObject({ ok: false, conflict: true });
  });

  it('hands back the newer file on a conflict, so the panel can compare or overwrite', async () => {
    fs.writeFileSync(userFile, '{}');
    const { version } = await loaded('user') as { version: string };
    const newer = '{ "damocles.model": "other" }';
    fs.writeFileSync(userFile, newer);

    const result = await saveResult('user', '{ "damocles.model": "mine" }', version);
    expect(result).toMatchObject({ ok: false, conflict: true, onDisk: { exists: true, content: newer, version: settingsFileVersion(newer) } });

    const overwrite = await saveResult('user', '{ "damocles.model": "mine" }', settingsFileVersion(newer));
    expect(overwrite).toMatchObject({ ok: true });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "damocles.model": "mine" }');
  });

  it('reports a file deleted since the load as absent on disk', async () => {
    fs.writeFileSync(userFile, '{}');
    const { version } = await loaded('user') as { version: string };
    fs.rmSync(userFile);

    expect(await saveResult('user', '{}', version)).toMatchObject({ ok: false, conflict: true, onDisk: { exists: false, content: '', version: '' } });
  });

  it('lets only the first of two panels saving from the same version write', async () => {
    fs.writeFileSync(userFile, '{}');
    const { version } = await loaded('user', hostA, 'p1') as { version: string };
    await loaded('user', hostB, 'p2');

    await Promise.all([
      editor.save('p1', hostA, 'user', '{ "damocles.model": "a" }', version),
      editor.save('p2', hostB, 'user', '{ "damocles.model": "b" }', version),
    ]);

    const results = posted.filter((p) => p.message.type === 'settingsFileSaveResult');
    expect(results.map((r) => [r.host, r.message])).toEqual([
      [hostA, { type: 'settingsFileSaveResult', scope: 'user', ok: true, version: settingsFileVersion('{ "damocles.model": "a" }') }],
      [hostB, expect.objectContaining({ ok: false, conflict: true, onDisk: expect.objectContaining({ content: '{ "damocles.model": "a" }' }) })],
    ]);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "damocles.model": "a" }');
  });

  it('refuses a scope this panel never opened, without calling it a conflict', async () => {
    fs.writeFileSync(userFile, '{}');

    const result = await saveResult('user', '{ "damocles.model": "x" }', settingsFileVersion('{}'));

    expect(result).toEqual({ type: 'settingsFileSaveResult', scope: 'user', ok: false, error: `${userFile} was not opened in this panel, so it was not saved. Open it again before saving.` });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{}');
  });

  it("refuses a project file that a symlink points at another tool's settings", async () => {
    const claudeFile = path.join(project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, '{}');
    fs.symlinkSync(claudeFile, projectFile, 'file');
    const { version } = await loaded('project') as { version: string };

    const result = await saveResult('project', '{ "damocles.model": "x" }', version);

    expect(result).toMatchObject({ ok: false });
    expect(fs.readFileSync(claudeFile, 'utf8')).toBe('{}');
  });

  it('refuses a project file once the project is no longer trusted', async () => {
    const { version } = await loaded('project') as { version: string };
    platform.trust.setTrusted(false);

    expect(await saveResult('project', '{}', version)).toMatchObject({ ok: false, error: 'The project is not trusted, so its settings files cannot be saved.' });
    expect(fs.existsSync(projectFile)).toBe(false);
  });
});

describe('external changes', () => {
  it('tells only the panels that loaded the scope, once per new version', async () => {
    fs.writeFileSync(userFile, '{}');
    await loaded('user', hostA, 'p1');
    await loaded('project', hostB, 'p2');
    posted = [];

    fs.writeFileSync(userFile, '{ "damocles.model": "z" }');
    platform.fileWatchers.watcher(path.dirname(userFile), path.basename(userFile)).fireChange(userFile);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    platform.fileWatchers.watcher(path.dirname(userFile), path.basename(userFile)).fireChange(userFile);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted).toEqual([{ host: hostA, message: { type: 'settingsFileChanged', scope: 'user', version: settingsFileVersion('{ "damocles.model": "z" }') } }]);
  });

  it('does not report the panel its own save', async () => {
    const { version } = await loaded('user') as { version: string };
    await editor.save('p1', hostA, 'user', '{}', version);
    posted = [];

    platform.fileWatchers.watcher(path.dirname(userFile), path.basename(userFile)).fireCreate(userFile);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted).toEqual([]);
  });

  it('does not report the panel its own save when the watcher fires before the save returns', async () => {
    const { version } = await loaded('user') as { version: string };
    const watcher = platform.fileWatchers.watcher(path.dirname(userFile), path.basename(userFile));
    writeHooks.afterWrite = async () => {
      watcher.fireCreate(userFile);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    posted = [];

    await editor.save('p1', hostA, 'user', '{}', version);

    expect(posted.map((p) => p.message.type)).toEqual(['settingsFileSaveResult']);
  });

  it('ignores an event for the other project file', async () => {
    await loaded('project');
    fs.writeFileSync(projectFile, '{ "damocles.model": "z" }');
    posted = [];

    platform.fileWatchers.watchers[0]!.fireChange(path.join(project, '.damocles', 'settings.local.json'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted).toEqual([]);
  });

  it('stops watching when the panel is released', async () => {
    await loaded('user');
    await loaded('project');
    const watchers = platform.fileWatchers.watchers.filter((w) => !w.disposed);
    expect(watchers).toHaveLength(2);

    editor.releasePanel('p1');

    expect(watchers.every((w) => w.disposed)).toBe(true);
  });
});

describe('availability', () => {
  const availableAll = { user: { available: true }, project: { available: true }, local: { available: true } };

  it('names the files that apply, without reading them', async () => {
    setup({ trusted: false });

    editor.availability('p1', hostA);

    expect(last()).toEqual({ type: 'settingsFileAvailability', files: { user: { available: true }, project: { available: false, reason: 'untrusted' }, local: { available: false, reason: 'untrusted' } } });
    expect(platform.fileWatchers.watchers).toHaveLength(0);
  });

  it('tells each panel that asked when trust is granted or the projects change, until it is released', () => {
    setup({ trusted: false });
    expect(editor.availability('p1', hostA)).toBe(true);
    expect(editor.availability('p1', hostA)).toBe(false);
    posted = [];

    platform.trust.grantTrust();
    expect(posted).toEqual([{ host: hostA, message: { type: 'settingsFileAvailability', files: availableAll } }]);

    platform.workspaceFolders.setFolders([]);
    expect(posted[1]).toEqual({ host: hostA, message: { type: 'settingsFileAvailability', files: { ...availableAll, project: { available: false, reason: 'noProject' }, local: { available: false, reason: 'noProject' } } } });

    editor.releasePanel('p1');
    platform.trust.grantTrust();
    expect(posted).toHaveLength(2);
  });

  it('tells no panel that only loaded a file', async () => {
    await loaded('user');
    posted = [];

    platform.trust.grantTrust();

    expect(posted).toEqual([]);
  });
});

describe('reveal', () => {
  it('reveals the file of an applicable scope and nothing for an untrusted project', async () => {
    await editor.reveal('user');
    expect(platform.shell.revealedPaths).toEqual([userFile]);

    setup({ trusted: false });
    await editor.reveal('project');
    expect(platform.shell.revealedPaths).toEqual([]);
  });
});
