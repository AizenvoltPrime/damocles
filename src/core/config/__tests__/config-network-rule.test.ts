import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakeFileWatcherFactory, type FakeNotificationService } from '../../../__mocks__/fake-platform';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import type { TrustChange, TrustService } from '../../../platform/trust-service';
import { parseContributedConfiguration } from '../contributed-configuration';
import { ConfigWriteRefused } from '../local-config-path';
import { writeJsonConfig } from '../json-config-write';
import { DesktopSettingsStore } from '../../../desktop/local-services/settings-store';
import { DesktopFileWatcherFactory } from '../../../desktop/local-services/file-watcher-factory';
import { createInProcessTreeHost } from '../../../desktop/watch-worker/fs-watch-tree';
import { readLanguageSetting } from '../../../desktop/local-services/localization-service';
import { findPermissionRuleRenames, loadPermissionsByPriority, PermissionRulesUnreadable, rewritePermissionRuleToolNames, RuleFileUnreadable } from '../../permission-handler/permission-settings';
import { syncPermissionRulesToSettings } from '../../chat-panel/settings-manager/utils';
import { saveSettingsFileText } from '../../chat-panel/settings-file-editor';
import { HooksConfigService, parseHooksFile } from '../../pi-session/hooks/config';
import { resolveGlobalContextFile } from '../../pi-session/context-files';
import { DAMOCLES_MCP_CONFIG_PATH, readMcpConfigFile } from '../../chat-panel/settings-manager/managers/mcp-config-import';
import { addDamoclesMcpServer, migrateOwnedMcpFile } from '../../chat-panel/settings-manager/managers/mcp-config-write';
import { McpManager } from '../../chat-panel/settings-manager/managers/mcp-manager';
import { isLocalMcpFileUnignored } from '../../chat-panel/settings-manager/managers/mcp-local-gitignore';
import { EvaluatorManager } from '../../permission-handler/managers/evaluator-manager';
import { PermissionState } from '../../permission-handler/state';
import { readSetupCommands } from '../../worktrees/create';
import { FolderIdentityStore } from '../../project-relocation/identity-store';
import { FOLDER_IDENTITIES_PATH } from '../../paths';
import { folderKey } from '../../workspace-folders/folder-key';
import { UserRelays, type LocalUserScope } from '../../../desktop/main/remote/user-relays';
import { FEATURES } from '../../../remote/protocol-version';

// links: each faked link's path, lowercased, and what readlink answers for it (a share); the link really leads to a local
// folder. touched: every file system call that named a UNC path, or a path through a faked link (lstat and readlink of the
// link itself excepted), which the rule forbids a refused read or write to make.
const H = vi.hoisted(() => ({
  home: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}${process.platform === 'win32' ? '\\' : '/'}dm-config-rule-home-${process.pid}`,
  links: new Map<string, string>(),
  touched: [] as string[],
  // whether op on file is one the rule forbids; a UNC path is never really reached
  forbidden(op: string, file: string): 'unc' | 'through' | undefined {
    const spelled = file.toLowerCase();
    if (/^[\\/]{2}/.test(spelled)) return 'unc';
    for (const link of this.links.keys()) {
      if (spelled === link && op !== 'lstat' && op !== 'readlink') return 'through';
      if (spelled.startsWith(`${link}\\`) || spelled.startsWith(`${link}/`)) return 'through';
    }
    return undefined;
  },
}));

const fsMock = vi.hoisted(() => (actual: typeof import('node:fs')) => {
  const guard = <F extends (...args: never[]) => unknown>(op: string, fn: F): F => ((...args: Parameters<F>) => {
    const file = String(args[0]);
    const verdict = H.forbidden(op, file);
    if (verdict !== undefined) H.touched.push(`${op} ${file}`);
    if (verdict === 'unc') throw new Error(`reached ${file}`);
    return fn(...args);
  }) as F;
  const readlinkSync = ((file: fs.PathLike, ...rest: unknown[]) => H.links.get(String(file).toLowerCase()) ?? (actual.readlinkSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof actual.readlinkSync;
  const realpathSync = Object.assign(guard('realpath', actual.realpathSync), { native: guard('realpath', actual.realpathSync.native) });
  const overrides = {
    lstatSync: guard('lstat', actual.lstatSync),
    statSync: guard('stat', actual.statSync),
    existsSync: guard('exists', actual.existsSync),
    readFileSync: guard('readFile', actual.readFileSync),
    openSync: guard('open', actual.openSync),
    readdirSync: guard('readdir', actual.readdirSync),
    readlinkSync,
    realpathSync,
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock('node:fs', async (importOriginal) => fsMock(await importOriginal<typeof import('node:fs')>()));
vi.mock('fs', async (importOriginal) => fsMock(await importOriginal<typeof import('node:fs')>()));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => H.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => H.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const contributed = parseContributedConfiguration({ contributes: { configuration: { properties: { 'damocles.model': { default: 'default-model' } } } } });

let root: string;
// the local folder every faked link really leads to
let marker: string;
let project: string;

class Trust implements TrustService {
  readonly trusted = new Set<string>();
  isTrusted(folder: string): boolean {
    return this.trusted.has(folder);
  }
  onDidChangeTrust(_cb: (change: TrustChange) => void): Disposable {
    return { dispose: () => undefined };
  }
  requestTrust(): Promise<boolean> {
    throw new Error('unused');
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A link at `at` the walk reads as one to \\host\share\..., which really leads to marker.
function linkToShare(at: string, share = '\\\\host\\share\\x'): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(marker, at, 'junction');
  H.links.set(at.toLowerCase(), share);
}

const promiseOps = ['readlink', 'lstat', 'stat', 'realpath', 'open', 'readdir', 'readFile', 'mkdir', 'rename', 'rm', 'access'] as const;

beforeAll(() => {
  fs.mkdirSync(H.home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(H.home, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(H.home, 'case-')));
  marker = path.join(root, 'marker');
  // what a reader would find if it followed a faked link
  write(path.join(marker, 'settings.json'), JSON.stringify({ 'damocles.model': 'from-share', permissions: { deny: ['Bash(rm:*)'] } }));
  write(path.join(marker, 'settings.local.json'), JSON.stringify({ 'damocles.model': 'from-share' }));
  write(path.join(marker, 'hooks.json'), JSON.stringify({ hooks: { tool_call: [{ command: 'echo shared' }] } }));
  write(path.join(marker, 'mcp.local.json'), JSON.stringify({ mcpServers: { shared: { command: 'node' } } }));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  H.links.clear();
  H.touched.length = 0;
  for (const op of promiseOps) {
    const original = fs.promises[op].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, op).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (op === 'readlink') {
        const fake = H.links.get(String(file).toLowerCase());
        if (fake !== undefined) return fake;
      }
      const verdict = H.forbidden(op, String(file));
      if (verdict !== undefined) H.touched.push(`${op} ${String(file)}`);
      if (verdict === 'unc') throw new Error(`reached ${String(file)}`);
      return original(file, ...rest);
    }) as never);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  H.links.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

// The notices' file arguments, in order.
const noticed = (notifications: FakeNotificationService): unknown[] =>
  notifications.calls.map((call) => (call.text.message === '{0} links to a network share or WSL path, so Damocles does not read it.' ? call.text.args?.[0] : call.text));

function store(userFile: string, trusted: readonly string[] = [], fileWatchers?: FileWatcherFactory): { store: DesktopSettingsStore; notifications: FakeNotificationService; watchers: FakeFileWatcherFactory; lines: string[] } {
  const fake = createFakePlatform({ folders: [{ fsPath: project, name: 'project' }] });
  const trust = new Trust();
  for (const folder of trusted) trust.trusted.add(folder);
  const lines: string[] = [];
  const settings = new DesktopSettingsStore({
    userFile,
    contributed,
    fileWatchers: fileWatchers ?? fake.fileWatchers,
    projects: fake.workspaceFolders,
    trust,
    defaultProject: { folder: () => project, onDidChange: () => ({ dispose: () => undefined }) },
    chatFolders: { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    notifications: fake.notifications,
    log: (line) => lines.push(line),
  });
  return { store: settings, notifications: fake.notifications, watchers: fake.fileWatchers, lines };
}

describe.runIf(process.platform === 'win32')('config reads and writes under the network rule (win32)', () => {
  describe('the desktop settings store', () => {
    it('keeps the user layer it last read when the file becomes a link onto a share, tells the user once, and writes nothing', async () => {
      const userFile = path.join(root, 'home', '.damocles', 'settings.json');
      write(userFile, JSON.stringify({ 'damocles.model': 'kept' }));
      const { store: settings, notifications, watchers } = store(userFile);
      expect(settings.get('damocles.model')).toBe('kept');
      fs.rmSync(userFile);
      linkToShare(userFile);
      const watcher = watchers.watcher(path.dirname(userFile), 'settings.json');
      watcher.fireChange(userFile);
      watcher.fireChange(userFile);
      expect(settings.get('damocles.model')).toBe('kept');
      expect(noticed(notifications)).toEqual([userFile]);
      await expect(settings.update('damocles.model', 'new', 'user')).rejects.toBeInstanceOf(ConfigWriteRefused);
      expect(fs.readdirSync(marker).sort()).toEqual(['hooks.json', 'mcp.local.json', 'settings.json', 'settings.local.json']);
      expect(H.touched).toEqual([]);
      settings.dispose();
    });

    it('leaves the project and local layers empty when the project\'s .damocles links onto a share, and the link to the watcher factory', () => {
      const userFile = path.join(root, 'home', '.damocles', 'settings.json');
      linkToShare(path.join(project, '.damocles'));
      const { store: settings, notifications, watchers } = store(userFile, [project]);
      expect(settings.inspect('damocles.model', { path: project })).toEqual({ defaultValue: 'default-model' });
      expect(noticed(notifications)).toEqual([path.join(project, '.damocles', 'settings.json'), path.join(project, '.damocles', 'settings.local.json')]);
      expect(watchers.watchers.filter((watcher) => watcher.base === project).map((watcher) => watcher.glob)).toEqual(['.damocles/{settings.json,settings.local.json}']);
      expect(H.touched).toEqual([]);
      settings.dispose();
    });

    it('applies the project file once a .damocles that links onto a share is replaced by a folder, watched by the desktop factory', async () => {
      const userFile = path.join(root, 'home', '.damocles', 'settings.json');
      const link = path.join(project, '.damocles');
      linkToShare(link);
      const log = (): undefined => undefined;
      const watchers = new DesktopFileWatcherFactory({ folders: () => [], onDidChange: () => ({ dispose: () => undefined }) }, log, createInProcessTreeHost(log));
      const { store: settings } = store(userFile, [project], watchers);
      try {
        expect(settings.get('damocles.model', undefined, { path: project })).toBe('default-model');
        fs.rmdirSync(link);
        H.links.delete(link.toLowerCase());
        fs.mkdirSync(link);
        await vi.waitFor(() => {
          fs.writeFileSync(path.join(link, 'settings.json'), JSON.stringify({ 'damocles.model': 'from-project' }));
          expect(settings.get('damocles.model', undefined, { path: project })).toBe('from-project');
        }, { timeout: 15_000 });
        expect(H.touched).toEqual([]);
      } finally {
        settings.dispose();
        await watchers.close();
      }
    }, 30_000);

    it('reads a project whose .damocles is a local link, as today', () => {
      const userFile = path.join(root, 'home', '.damocles', 'settings.json');
      fs.symlinkSync(marker, path.join(project, '.damocles'), 'junction');
      const { store: settings, notifications } = store(userFile, [project]);
      expect(settings.get('damocles.model', undefined, { path: project })).toBe('from-share');
      expect(notifications.calls).toEqual([]);
      settings.dispose();
    });
  });

  it('readLanguageSetting follows the system language for a settings file linked onto a share', () => {
    const userFile = path.join(root, 'home', '.damocles', 'settings.json');
    linkToShare(userFile);
    const lines: string[] = [];
    expect(readLanguageSetting(userFile, (line) => lines.push(line))).toBe('system');
    expect(lines).toEqual([`[l10n] ${userFile} links to a network share or WSL path, so the language follows the system`]);
    expect(H.touched).toEqual([]);
  });

  describe('permission settings', () => {
    // The permission reader's notice names the file it could not read and says what happens to its rules.
    const ruleNotices = (notifications: FakeNotificationService): unknown[] => notifications.calls.map((call) => call.text.args?.[0]).sort();

    it('cannot tell the rules of a never-read project file linked onto a share, and tells the user once', async () => {
      linkToShare(path.join(project, '.damocles'));
      const notifications = createFakePlatform().notifications;
      const records = new Map();
      const file = path.join(project, '.damocles', 'settings.json');
      const unreadable = { unreadable: { file, reason: { message: 'it links to a network share or WSL path' } } };
      expect(await loadPermissionsByPriority({ path: project, personalFiles: false }, records, undefined, notifications)).toEqual(unreadable);
      expect(await loadPermissionsByPriority({ path: project, personalFiles: false }, records, undefined, notifications)).toEqual(unreadable);
      expect(ruleNotices(notifications)).toEqual([file]);
      expect(H.touched).toEqual([]);
    });

    it('tells the user what happens to the rules of a file the settings store also refuses', async () => {
      linkToShare(path.join(project, '.damocles'));
      const { store: settings, notifications } = store(path.join(root, 'home', '.damocles', 'settings.json'), [project]);
      const permissionNotices = createFakePlatform().notifications;
      expect(await loadPermissionsByPriority({ path: project, personalFiles: true }, new Map(), undefined, permissionNotices)).toHaveProperty('unreadable');
      const files = [path.join(project, '.damocles', 'settings.json'), path.join(project, '.damocles', 'settings.local.json')];
      expect(noticed(notifications)).toEqual(files);
      expect(ruleNotices(permissionNotices)).toEqual([...files].sort());
      settings.dispose();
    });

    it('tells the user through the permission evaluator itself, which cannot decide while the file was never read', async () => {
      linkToShare(path.join(project, '.claude'));
      const platform = createFakePlatform({ trusted: true });
      const state = new PermissionState();
      state.cwd = project;
      const evaluator = new EvaluatorManager(state, platform);
      try {
        await expect(evaluator.matchRule('Bash', { command: 'rm -rf x' }, project)).rejects.toThrow(PermissionRulesUnreadable);
        expect(ruleNotices(platform.notifications)).toEqual([path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')].sort());
        expect(H.touched).toEqual([]);
      } finally {
        evaluator.dispose();
      }
    });

    it('neither finds nor rewrites renamed tool rules in such a file, and says it could not read it', async () => {
      linkToShare(path.join(project, '.damocles'));
      const file = path.join(project, '.damocles', 'settings.json');
      const renames = new Map([['Bash', 'Shell']]);
      await expect(findPermissionRuleRenames(file, project, renames)).rejects.toBeInstanceOf(RuleFileUnreadable);
      await expect(rewritePermissionRuleToolNames(file, renames, { baseFolder: project, confineTo: path.dirname(file) })).rejects.toMatchObject({ file, reason: { message: 'it links to a network share or WSL path' } });
      expect(H.touched).toEqual([]);
    });

    it('saves no rule to a settings file linked onto a share, and says why', async () => {
      linkToShare(path.join(project, '.damocles'));
      const failures = await syncPermissionRulesToSettings([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }], project);
      const file = path.join(project, '.damocles', 'settings.local.json');
      expect(failures).toEqual([{ message: 'The permission rule was not saved. {0}', args: [{ message: 'Could not save {0}: {1}', args: [file, { message: '{0} links to a network share or WSL path, so Damocles does not write it.', args: [file] }] }] }]);
      expect(H.touched).toEqual([]);
    });
  });

  it('the settings file editor saves nothing to a file linked onto a share and says why', async () => {
    const userFile = path.join(root, 'home', '.damocles', 'settings.json');
    linkToShare(userFile);
    const platform = createFakePlatform({ capabilities: { settingsSources: true, monaco: true }, settings: { scopeFiles: { user: userFile } } });
    const outcome = await saveSettingsFileText(platform, 'user', userFile, '{}', '');
    // no cause, so the desktop renders this text rather than an errno reason
    expect(outcome).toEqual({ ok: false, conflict: false, error: { message: 'Could not save {0}: {1}', args: [userFile, { message: '{0} links to a network share or WSL path, so Damocles does not write it.', args: [userFile] }] } });
    expect(H.touched).toEqual([]);
  });

  describe('a write the check cannot decide', () => {
    // file as two junctions naming each other, which the check rejects ELOOP with its own text
    function loopAt(file: string): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(`${file}.other`, file, 'junction');
      fs.symlinkSync(file, `${file}.other`, 'junction');
    }
    const loopText = (base: string) => ({ message: 'The path under {0} goes through too many links.', args: [base] });

    it('the settings file editor shows the check\'s own text', async () => {
      const userFile = path.join(root, 'home', '.damocles', 'settings.json');
      loopAt(userFile);
      const platform = createFakePlatform({ capabilities: { settingsSources: true, monaco: true }, settings: { scopeFiles: { user: userFile } } });
      const outcome = await saveSettingsFileText(platform, 'user', userFile, '{}', '');
      expect(outcome).toMatchObject({ ok: false, conflict: false, error: { message: 'Could not save {0}: {1}', args: [userFile, loopText(path.dirname(userFile))] } });
    });

    it('a permission rule save shows the check\'s own text', async () => {
      const file = path.join(project, '.damocles', 'settings.local.json');
      loopAt(file);
      const failures = await syncPermissionRulesToSettings([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }], project);
      expect(failures).toEqual([{ message: 'The permission rule was not saved. {0}', args: [{ message: 'Could not save {0}: {1}', args: [file, loopText(project)] }] }]);
    });

    it('the MCP form reports the file as unreadable, by its code', async () => {
      loopAt(DAMOCLES_MCP_CONFIG_PATH);
      try {
        await expect(addDamoclesMcpServer('probe', { command: 'node' }, new Map())).rejects.toMatchObject({ info: { code: 'fileUnreadable' }, message: expect.stringContaining('ELOOP') });
      } finally {
        fs.rmSync(DAMOCLES_MCP_CONFIG_PATH, { force: true });
        fs.rmSync(`${DAMOCLES_MCP_CONFIG_PATH}.other`, { force: true });
      }
    });
  });

  describe('hooks.json', () => {
    it('loads no hooks from a project hooks.json linked onto a share, leaves its watch to the watcher factory, and tells the user once', () => {
      linkToShare(path.join(project, '.damocles'));
      const notifications = createFakePlatform().notifications;
      expect(parseHooksFile(path.join(project, '.damocles', 'hooks.json'), project, notifications)).toEqual({});
      const trust = new Trust();
      trust.trusted.add(project);
      const fake = createFakePlatform();
      const hooks = new HooksConfigService(project, trust, fake.fileWatchers, notifications);
      expect(hooks.getEntries('tool_call')).toEqual([]);
      expect(fake.fileWatchers.watchers.filter((watcher) => watcher.base === project).map((watcher) => watcher.glob)).toEqual(['.damocles/hooks.json']);
      expect(noticed(notifications)).toEqual([path.join(project, '.damocles', 'hooks.json')]);
      expect(H.touched).toEqual([]);
      hooks.dispose();
    });

    it('loads hooks through a local link, as today', () => {
      fs.symlinkSync(marker, path.join(project, '.damocles'), 'junction');
      expect(parseHooksFile(path.join(project, '.damocles', 'hooks.json'), project)['tool_call']).toEqual([{ command: 'echo shared' }]);
    });
  });

  it('the global instruction file is skipped when it links onto a share, with one notice', () => {
    const home = path.join(root, 'home');
    linkToShare(path.join(home, '.damocles', 'AGENTS.md'), '\\\\host\\share\\AGENTS.md');
    const notifications = createFakePlatform().notifications;
    expect(resolveGlobalContextFile(home, notifications)).toBeUndefined();
    expect(noticed(notifications)).toEqual([path.join(home, '.damocles', 'AGENTS.md')]);
    expect(H.touched).toEqual([]);
  });

  describe('MCP config', () => {
    it('reads a .mcp.json linked onto a share as unreadable and tells the user once', async () => {
      linkToShare(path.join(project, '.mcp.json'));
      const notifications = createFakePlatform().notifications;
      const read = await readMcpConfigFile(path.join(project, '.mcp.json'), project, notifications);
      expect(read).toMatchObject({ servers: {}, error: { path: path.join(project, '.mcp.json'), kind: 'unreadable' } });
      expect(noticed(notifications)).toEqual([path.join(project, '.mcp.json')]);
      expect(H.touched).toEqual([]);
    });

    it('leaves the watch of a project\'s MCP folder that links onto a share to the watcher factory, beside the others', () => {
      linkToShare(path.join(project, '.damocles'));
      const platform = createFakePlatform();
      const manager = new McpManager(platform, () => [{ key: folderKey(project), fsPath: project, name: 'project', label: 'project', projectScope: true }]);
      manager.syncFolderWatchers();
      expect(platform.fileWatchers.watchers.map((watcher) => [watcher.base, watcher.glob])).toEqual([[project, '.mcp.json'], [project, '.damocles/mcp.local.json'], [project, '.pi/mcp.json'], [project, '.gitignore']]);
      expect(H.touched).toEqual([]);
      manager.dispose();
    });

    it('asks nothing about a local MCP file whose folder links onto a share when checking it is git-ignored', async () => {
      linkToShare(path.join(project, '.damocles'));
      expect(await isLocalMcpFileUnignored(project)).toBe(false);
      expect(H.touched).toEqual([]);
    });

    it('migrates nothing in a local MCP file whose folder links onto a share', async () => {
      linkToShare(path.join(project, '.damocles'));
      expect(await migrateOwnedMcpFile(path.join(project, '.damocles', 'mcp.local.json'))).toBe(false);
      expect(H.touched).toEqual([]);
    });

    it('refuses a server write to ~/.damocles/mcp.json linked onto a share with its own code', async () => {
      fs.rmSync(DAMOCLES_MCP_CONFIG_PATH, { force: true });
      linkToShare(DAMOCLES_MCP_CONFIG_PATH);
      try {
        await expect(addDamoclesMcpServer('notes', { command: 'node' }, new Map())).rejects.toMatchObject({ info: { code: 'fileLinksToShare' } });
        expect(H.touched).toEqual([]);
      } finally {
        fs.rmSync(DAMOCLES_MCP_CONFIG_PATH, { recursive: true, force: true });
      }
    });
  });

  it('this computer\'s user files relayed to remote chats mark a file linked onto a share, never read, as unreadable', async () => {
    const home = path.join(root, 'home');
    linkToShare(path.join(home, '.claude'));
    const lines: string[] = [];
    const notifications = createFakePlatform().notifications;
    const relays = new UserRelays({
      notifications,
      resolveCredential: async () => ({ type: 'api_key', key: 'k' }),
      forges: async () => [],
      clientAuth: async () => ({ providers: {} }),
      voice: false,
      homedir: home,
      userSettingKeys: () => [],
      userValue: () => undefined,
      hostPolicy: () => ({ allowBypass: false }),
      savedHost: () => true,
      engineHalted: () => false,
      local: { mcpServers: async () => [] } as unknown as LocalUserScope,
      log: (line) => lines.push(line),
    });
    await relays.userChanged();
    const mirrors = await relays.attach(() => undefined, 'ssh+h1', false, FEATURES).mirrors;
    const file = path.join(home, '.claude', 'settings.local.json');
    expect(mirrors.clientUser).toMatchObject({ permissionRules: [], unreadable: { file, reason: { message: 'it links to a network share or WSL path' } } });
    expect(lines).toContain(`[remote] ${file} could not be read (it links to a network share or WSL path); it was never read, so remote chats cannot know its rules`);
    expect(notifications.calls.map((call) => call.text.args?.[0]).sort()).toEqual([file, path.join(home, '.claude', 'settings.json')].sort());
    expect(H.touched).toEqual([]);
    relays.dispose();
  });

  it('a worktree setup file linked onto a share is refused with its reason, unread', async () => {
    linkToShare(path.join(project, '.damocles'));
    const file = path.join(project, '.damocles', 'worktree.json');
    await expect(readSetupCommands(project)).rejects.toMatchObject({ text: { message: '{0} links to a network share or WSL path, so Damocles does not read it.', args: [file] } });
    expect(H.touched).toEqual([]);
  });

  it('a store in a ~/.damocles that links onto a share writes there, and a link from inside it onto another share is refused', async () => {
    const data = path.join(H.home, '.damocles');
    const onShare = path.join(root, 'on-share');
    fs.mkdirSync(path.join(onShare, 'elsewhere'), { recursive: true });
    fs.rmSync(data, { recursive: true, force: true });
    fs.symlinkSync(onShare, data, 'junction');
    // the walk reads ~/.damocles as a link onto \\corp\data; the write itself lands in its real local target
    H.links.set(data.toLowerCase(), '\\\\corp\\data\\dm');
    try {
      await new FolderIdentityStore({ file: FOLDER_IDENTITIES_PATH, log: () => undefined }).record([{ folder: project, identity: undefined }], 1);
      expect(JSON.parse(fs.readFileSync(path.join(onShare, 'folder-identities.json'), 'utf8'))).toMatchObject({ folders: {} });
      // judged from the drive root, as before the store named its base, the same write is refused
      await expect(writeJsonConfig(FOLDER_IDENTITIES_PATH, () => '{}')).rejects.toBeInstanceOf(ConfigWriteRefused);
      linkToShare(path.join(data, 'elsewhere', 'out'), '\\\\other\\share\\x');
      H.links.set(path.join(onShare, 'elsewhere', 'out').toLowerCase(), '\\\\other\\share\\x');
      await expect(writeJsonConfig(path.join(data, 'elsewhere', 'out', 'state.json'), () => '{}', { baseFolder: data })).rejects.toBeInstanceOf(ConfigWriteRefused);
      expect(H.touched.filter((call) => /^\w+ [\\/]{2}/.test(call))).toEqual([]);
    } finally {
      fs.rmSync(data, { force: true, recursive: true });
    }
  });

  describe('the JSON config writer', () => {
    it('writes nothing to a file below its base folder that links onto a share, nor to one judged from its own root', async () => {
      const file = path.join(project, '.damocles', 'settings.json');
      linkToShare(path.join(project, '.damocles'));
      await expect(writeJsonConfig(file, () => '{}', { baseFolder: project })).rejects.toBeInstanceOf(ConfigWriteRefused);
      await expect(writeJsonConfig(file, () => '{}')).rejects.toBeInstanceOf(ConfigWriteRefused);
      expect(H.touched).toEqual([]);
    });

    it('writes through a local link to its target, as today', async () => {
      fs.symlinkSync(marker, path.join(project, '.damocles'), 'junction');
      await writeJsonConfig(path.join(project, '.damocles', 'new.json'), () => '{"a":1}\n', { baseFolder: project });
      expect(fs.readFileSync(path.join(marker, 'new.json'), 'utf8')).toBe('{"a":1}\n');
    });
  });
});

describe('config reads off Windows', () => {
  it('read a file whose link the walk would place on a share, since the rule applies on Windows only', async () => {
    fs.symlinkSync(marker, path.join(project, '.damocles'), process.platform === 'win32' ? 'junction' : 'dir');
    H.links.set(path.join(project, '.damocles').toLowerCase(), '\\\\host\\share\\x');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(parseHooksFile(path.join(project, '.damocles', 'hooks.json'), project)['tool_call']).toEqual([{ command: 'echo shared' }]);
      const read = await readMcpConfigFile(path.join(project, '.damocles', 'mcp.local.json'), project);
      expect(Object.keys(read.servers)).toEqual(['shared']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
