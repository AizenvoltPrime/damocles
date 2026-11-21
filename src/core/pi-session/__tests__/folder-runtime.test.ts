import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncBuiltinESMExports } from 'node:module';
import type { AgentSession, AgentSessionServices, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import * as piMcp from '@earendil-works/pi-mcp';

const H = vi.hoisted(() => ({ home: '' }));

// The global context file and user asset dirs resolve through `os.homedir()`; a temp home keeps the
// developer's own `~/.damocles` out of every assertion about which instructions a folder loads.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// readlinkSync answers for these links (lowercased paths) as Windows would for a link onto a share; pi's own fs is real.
const fakeLinks = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) =>
    fakeLinks.get(String(args[0]).toLowerCase()) ?? actual.readlinkSync(...args)) as typeof actual.readlinkSync;
  return { ...actual, readlinkSync, default: { ...actual, readlinkSync } };
});

// Files every link policy refuses, as Windows does for one linked onto another share; any other file a policy judges itself.
const refusedFiles = vi.hoisted(() => new Set<string>());
vi.mock('../../config/local-config-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/local-config-path')>();
  return {
    ...actual,
    configLinkPolicy: (bases: readonly string[]) => {
      const judged = actual.configLinkPolicy(bases);
      return (file: string): boolean => !refusedFiles.has(file) && judged(file);
    },
  };
});

// Links whose path ends with one of these, joined with '/', answer the async network check as a drive that did not answer.
const timedOut = vi.hoisted(() => new Set<string>());
vi.mock('../../local-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../local-links')>();
  return {
    ...actual,
    followsLocalLinksOnly: async (...args: Parameters<typeof actual.followsLocalLinksOnly>): Promise<boolean> => {
      const spelled = args[1].join('/');
      if ([...timedOut].some((suffix) => spelled.endsWith(suffix))) throw Object.assign(new Error('the drive did not answer'), { code: 'ETIMEDOUT' });
      return actual.followsLocalLinksOnly(...args);
    },
  };
});

import { FolderRuntime } from '../folder-runtime';
import { AgentRegistry } from '../subagents/agent-types';
import type { WorkspaceAgentRegistry } from '../subagents/workspace-agent-registry';
import { DRIVE_ANSWER_TTL_MS } from '../../local-links';
import { LinkTargetWatchers, type WatchTarget } from '../../assets';
import { recordTerminatedCall, takeTerminatedCalls } from '../terminated-calls';
import { PiRuntime, renamedRuleNoticeMemory } from '../pi-runtime';
import { initPiLoader, type PiCodingAgentModule } from '../pi-loader';
import { McpClientManager } from '../mcp/mcp-client-manager';
import { assignServerToolNames } from '../mcp/naming';
import type { LegacyToolNameInput, NoticeMemory, PersonalToolLists } from '../mcp/tool-name-migration';
import { renamedRuleNoticeKey, type McpRenamedToolRuleNotice } from '../../../shared/types/mcp';
import type { PanelGateContext } from '../permission-gate';
import type { CheckpointService } from '../checkpoint-service';
import { folderKey } from '../../workspace-folders/folder-key';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import { installLogSink } from '../../logger';

/** Trust and watchers for the folder runtimes built here; trusted by default, as the host is. */
const testPlatform = createFakePlatform();

const FS_READS = ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync', 'openSync', 'accessSync', 'opendirSync'] as const;

/**
 * Records each call pi makes to the node:fs reads in FS_READS, with its path, until stop(). pi imports node:fs as an ES
 * module, so the wrappers reach it only through the builtin's CommonJS object and syncBuiltinESMExports.
 */
async function recordPiFsCalls(): Promise<{ calls: Array<{ name: string; file: string }>; stop: () => void }> {
  type Read = ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown };
  const realFs = (await vi.importActual<{ default: Record<(typeof FS_READS)[number], Read> }>('node:fs')).default;
  const calls: Array<{ name: string; file: string }> = [];
  const originals = new Map<(typeof FS_READS)[number], Read>();
  const record = (name: string, read: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    if (new Error().stack?.includes('pi-coding-agent')) calls.push({ name, file: String(args[0]) });
    return read(...args);
  };
  for (const name of FS_READS) {
    const read = realFs[name];
    originals.set(name, read);
    realFs[name] = Object.assign(record(name, read), read.native ? { native: record(name, read.native) } : {});
  }
  syncBuiltinESMExports();
  return {
    calls,
    stop: () => {
      for (const [name, read] of originals) realFs[name] = read;
      syncBuiltinESMExports();
    },
  };
}

/** The recorded calls naming file or a path below it, other than those of the reads in allowed. */
function callsOn(calls: ReadonlyArray<{ name: string; file: string }>, file: string, allowed: readonly string[] = []): string[] {
  const key = file.toLowerCase();
  return calls
    .filter(({ name, file: called }) => !allowed.includes(name) && (called.toLowerCase() === key || called.toLowerCase().startsWith(key + path.sep)))
    .map(({ name, file: called }) => `${name} ${called}`);
}

/** The lines Damocles logs from now on. */
function captureLog(): string[] {
  const lines: string[] = [];
  installLogSink({ appendLine: (line) => void lines.push(line), show: () => undefined, dispose: () => undefined });
  return lines;
}


/** A folder runtime with no services, for the registry and republisher bookkeeping that needs none. */
function bareFolder(made: FolderRuntime[], cwd = '/tmp/ws'): FolderRuntime {
  const folder = new FolderRuntime({
    pi: {} as PiCodingAgentModule,
    mcpModule: piMcp,
    cwd,
    agentDir: '/tmp/agent',
    modelRuntime: {} as ModelRuntime,
    planModelIds: () => undefined,
    userMcp: new McpClientManager({ clientVersion: 'test' }),
    createFolderMcp: (reservedToolNames) => new McpClientManager({ clientVersion: 'test', reservedToolNames }),
    noticeMemory: { has: () => false, add: async () => {} },
    additionMemory: { has: () => false, add: async () => {} },
    projectDisabledTools: () => null,
    personalDisabledTools: () => ({ rewrite: async () => undefined, lists: () => [] }),
    toolExposureSetting: () => ({}),
    resourceExposureSetting: () => ({}),
    trust: testPlatform.trust,
    fileWatchers: testPlatform.fileWatchers,
    notifications: testPlatform.notifications,
  });
  made.push(folder);
  return folder;
}

describe('per-session registries are released by their owner only', () => {
  const made: FolderRuntime[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
  });

  type Registries = {
    _panelRegistry: Map<string, unknown>;
    _checkpointRegistry: Map<string, unknown>;
    _activeToolRefreshers: Map<string, unknown>;
    _ruleNoticePosters: Map<string, unknown>;
  };
  const entries = (folder: FolderRuntime) => {
    const r = folder as unknown as Registries;
    return [r._panelRegistry, r._checkpointRegistry, r._activeToolRefreshers, r._ruleNoticePosters].map((m) => m.get('sess-x'));
  };
  const owner = () => ({ gate: {} as PanelGateContext, checkpoints: {} as CheckpointService, refresh: () => {}, post: () => {} });
  const register = (folder: FolderRuntime, o: ReturnType<typeof owner>) => {
    folder.registerPanel('sess-x', o.gate);
    folder.registerCheckpointService('sess-x', o.checkpoints);
    folder.registerActiveToolRefresher('sess-x', o.refresh);
    folder.registerRuleNoticePoster('sess-x', o.post);
  };
  const unregister = (folder: FolderRuntime, o: ReturnType<typeof owner>) => {
    folder.unregisterPanel('sess-x', o.gate);
    folder.unregisterCheckpointService('sess-x', o.checkpoints);
    folder.unregisterActiveToolRefresher('sess-x', o.refresh);
    folder.unregisterRuleNoticePoster('sess-x', o.post);
  };

  it("a late unregister from the previous owner leaves the new owner's entry in every registry", () => {
    // Two panels can hold one session id; the older closing after the newer registered must not strip
    // the newer's gate, or every tool call there hits the fail-closed fallback.
    const folder = bareFolder(made);
    const older = owner();
    const newer = owner();
    register(folder, older);
    register(folder, newer);

    unregister(folder, older);

    expect(entries(folder)).toEqual([newer.gate, newer.checkpoints, newer.refresh, newer.post]);
  });

  it("the current owner's unregister still removes its entries", () => {
    const folder = bareFolder(made);
    const only = owner();
    register(folder, only);

    unregister(folder, only);

    expect(entries(folder)).toEqual([undefined, undefined, undefined, undefined]);
  });

  // A lookup after dispose would build a second registry, with watchers nothing disposes, that no reload of this folder reaches.
  it('refuses its agent registry once disposed', async () => {
    const folder = bareFolder(made);
    await folder.dispose();

    expect(() => folder.getWorkspaceAgentRegistry()).toThrow('/tmp/ws): agent registry used after dispose');
  });
});

describe('renamed-tool rule migration', () => {
  const OLD = 'mcp__context7__resolve-library-id';
  const NEW = 'mcp__context7__resolve_library_id';
  const made: FolderRuntime[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
    H.home = '';
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeRules(file: string, allow: string[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ permissions: { allow } }, null, 2)}\n`);
  }

  function memory(): NoticeMemory {
    const shown = new Set<string>();
    const key = (location: Parameters<NoticeMemory['has']>[0], entry: { old: string; new: string }) => JSON.stringify([renamedRuleNoticeKey(location), entry.old, entry.new]);
    return {
      has: (location, entry) => shown.has(key(location, entry)),
      add: async (location, entries) => {
        for (const entry of entries) shown.add(key(location, entry));
      },
    };
  }

  /** A folder whose MCP view knows context7's renamed tool, with its own `.damocles` settings files. */
  function migrationFolder(
    platform: ReturnType<typeof createFakePlatform>,
    {
      noticeMemory = memory(),
      personalDisabledTools = () => ({ rewrite: async () => undefined, lists: () => [] }),
      retiredResources = { user: [], folder: [] },
    }: {
      noticeMemory?: NoticeMemory;
      personalDisabledTools?: (trusted: boolean, stillTrusted: () => boolean) => PersonalToolLists;
      retiredResources?: LegacyToolNameInput['retiredResources'];
    } = {},
  ) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-fr-rename-')));
    dirs.push(root);
    H.home = path.join(root, 'home');
    const cwd = path.join(root, 'ws');
    const files = { local: path.join(cwd, '.damocles', 'settings.local.json'), project: path.join(cwd, '.damocles', 'settings.json') };
    writeRules(files.local, [OLD]);
    writeRules(files.project, [OLD]);
    const userMcp = new McpClientManager({ clientVersion: 'test' });
    const folder = new FolderRuntime({
      pi: {} as PiCodingAgentModule,
      mcpModule: piMcp,
      cwd,
      agentDir: path.join(root, 'agent'),
      modelRuntime: {} as ModelRuntime,
      planModelIds: () => undefined,
      userMcp,
      createFolderMcp: (reservedToolNames) => new McpClientManager({ clientVersion: 'test', reservedToolNames }),
      noticeMemory,
      additionMemory: { has: () => false, add: async () => {} },
      projectDisabledTools: () => null,
      personalDisabledTools,
      toolExposureSetting: () => ({}),
      resourceExposureSetting: () => ({}),
      trust: platform.trust,
      fileWatchers: platform.fileWatchers,
      notifications: platform.notifications,
    });
    made.push(folder);
    const tools = assignServerToolNames('context7', ['resolve-library-id'], new Set());
    const userServers = ['context7', ...retiredResources.user.map((entry) => entry.serverName)];
    const input: LegacyToolNameInput = {
      userServers,
      visibleUserServers: userServers,
      folderServers: [],
      userTools: [{ serverName: 'context7', rawToolName: 'resolve-library-id', piName: tools.get('resolve-library-id')! }],
      folderTools: [],
      retiredResources,
    };
    (folder as unknown as { _mcpView: { legacyToolNameInput(): LegacyToolNameInput } })._mcpView.legacyToolNameInput = () => input;
    const toolsChanged = () => (userMcp as unknown as { emitToolsChanged(): void }).emitToolsChanged();
    const settled = () => (folder as unknown as { _ruleMigration: Promise<void> })._ruleMigration;
    const rules = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf-8')) as { permissions: { allow: string[] } }).permissions.allow;
    return { folder, cwd, files, toolsChanged, settled, rules };
  }

  it('runs again for the folder files when trust is granted, with an unchanged rename map', async () => {
    const platform = createFakePlatform({ trusted: false });
    const { folder, cwd, files, toolsChanged, settled, rules } = migrationFolder(platform);
    const posted: McpRenamedToolRuleNotice[][] = [];
    folder.registerRuleNoticePoster('sess-a', (notices) => posted.push(notices));

    toolsChanged();
    await settled();
    expect(rules(files.local)).toEqual([OLD]);
    expect(posted).toEqual([]);

    platform.trust.grantTrust([cwd]);
    await settled();
    expect(rules(files.local)).toEqual([NEW]);
    expect(rules(files.project)).toEqual([OLD]);
    expect(posted).toEqual([[{ path: files.project, displayPath: { message: '{0}', args: [files.project] }, rules: [{ old: OLD, new: NEW }] }]]);
  });

  it('writes no folder file when trust is revoked while the run waits for the folder\'s agents', async () => {
    const platform = createFakePlatform();
    const { folder, cwd, files, toolsChanged, settled, rules } = migrationFolder(platform);
    let land!: () => void;
    const loaded = new Promise<void>((resolve) => { land = resolve; });
    const waits = vi.fn(() => loaded);
    vi.spyOn(folder, 'getWorkspaceAgentRegistry').mockReturnValue({ whenLoaded: waits, getRegistry: () => new AgentRegistry() } as unknown as WorkspaceAgentRegistry);

    toolsChanged();
    await vi.waitFor(() => expect(waits).toHaveBeenCalled());
    platform.trust.revokeTrust([cwd]);
    land();
    await settled();

    expect(rules(files.local)).toEqual([OLD]);
  });

  it('retries a run that failed instead of treating its inputs as done', async () => {
    const platform = createFakePlatform();
    let failures = 1;
    const base = memory();
    const flaky: NoticeMemory = {
      has: (location, entry) => {
        if (failures-- > 0) throw new Error('state unavailable');
        return base.has(location, entry);
      },
      add: base.add,
    };
    const { folder, toolsChanged, settled } = migrationFolder(platform, { noticeMemory: flaky });
    const posted: McpRenamedToolRuleNotice[][] = [];
    folder.registerRuleNoticePoster('sess-a', (notices) => posted.push(notices));

    toolsChanged();
    await settled();
    expect(posted).toEqual([]);

    toolsChanged();
    await settled();
    expect(posted).toHaveLength(1);
  });

  it('hands notices found before any panel to the first panels once, however quickly they register', async () => {
    const platform = createFakePlatform();
    const { folder, files, toolsChanged, settled } = migrationFolder(platform);
    toolsChanged();
    await settled();

    const posted: Record<string, McpRenamedToolRuleNotice[][]> = { a: [], b: [] };
    folder.registerRuleNoticePoster('sess-a', (notices) => posted['a']!.push(notices));
    folder.registerRuleNoticePoster('sess-b', (notices) => posted['b']!.push(notices));
    await settled();

    const expected = [[{ path: files.project, displayPath: { message: '{0}', args: [files.project] }, rules: [{ old: OLD, new: NEW }] }]];
    expect(posted).toEqual({ a: expected, b: expected });
  });

  const everywhere = { old: OLD, new: NEW, perFolder: false };
  const thisFolder = { old: 'mcp__docs__get_readme', new: 'mcp__docs__read_mcp_resource(docs://readme)', perFolder: true };

  it('remembers a notice outside the folder across workspaces unless its replacement holds only in this folder, and the folder\u2019s own per workspace', async () => {
    const first = createFakePlatform();
    const second = createFakePlatform();
    const home = path.join(os.tmpdir(), 'home');
    const folderA = path.join(os.tmpdir(), 'ws-a');
    const homeFile = { path: path.join(home, '.damocles', 'hooks.json'), displayPath: { message: '' } };
    const folderFile = { path: path.join(folderA, '.damocles', 'settings.json'), displayPath: { message: '' } };
    await renamedRuleNoticeMemory(first.state, folderA).add(homeFile, [everywhere, thisFolder]);
    await renamedRuleNoticeMemory(first.state, folderA).add(folderFile, [everywhere]);

    const otherWorkspace = renamedRuleNoticeMemory({ workspace: second.state.workspace, global: first.state.global }, folderA);
    expect(otherWorkspace.has(homeFile, everywhere)).toBe(true);
    expect(otherWorkspace.has(homeFile, thisFolder)).toBe(false);
    expect(otherWorkspace.has(folderFile, everywhere)).toBe(false);
    expect(renamedRuleNoticeMemory(first.state, folderA).has(homeFile, thisFolder)).toBe(true);
    expect(renamedRuleNoticeMemory(first.state, folderA).has(folderFile, everywhere)).toBe(true);
  });

  // A setting names no path; resolving one against the process's working folder could land it in global state.
  it('remembers a workspace setting\u2019s notice per workspace, and a user setting\u2019s by its replacement, wherever the process runs', async () => {
    const first = createFakePlatform();
    const second = createFakePlatform();
    const workspaceSetting = { setting: 'damocles.tools.disabled', displayPath: { message: '' } };
    const userSetting = { setting: 'damocles.tools.disabled', scope: 'user' as const, displayPath: { message: '' } };
    const folderA = path.join(os.tmpdir(), 'ws-a');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'elsewhere'));
    try {
      await renamedRuleNoticeMemory(first.state, folderA).add(workspaceSetting, [everywhere]);
      await renamedRuleNoticeMemory(first.state, folderA).add(userSetting, [everywhere, thisFolder]);
    } finally {
      cwd.mockRestore();
    }

    const otherWorkspace = renamedRuleNoticeMemory({ workspace: second.state.workspace, global: first.state.global }, folderA);
    expect(renamedRuleNoticeMemory(first.state, folderA).has(workspaceSetting, everywhere)).toBe(true);
    expect(otherWorkspace.has(workspaceSetting, everywhere)).toBe(false);
    expect(otherWorkspace.has(userSetting, everywhere)).toBe(true);
    expect(otherWorkspace.has(userSetting, thisFolder)).toBe(false);
  });

  const retiredSecret: LegacyToolNameInput['retiredResources'] = {
    user: [{ serverName: 'secret', rawToolNames: [], resources: [{ uri: 'secret://passwords', name: 'passwords' }] }],
    folder: [],
  };

  it('rewrites the personal lists at the user scope only in an untrusted folder', async () => {
    const platform = createFakePlatform({ trusted: false });
    const personal = vi.fn((_trusted: boolean, _stillTrusted: () => boolean): PersonalToolLists => ({ rewrite: async () => undefined, lists: () => [] }));
    const { toolsChanged, settled } = migrationFolder(platform, { personalDisabledTools: personal, retiredResources: retiredSecret });

    toolsChanged();
    await settled();

    expect(personal).toHaveBeenCalledWith(false, expect.any(Function));
    expect(personal).not.toHaveBeenCalledWith(true, expect.any(Function));
  });

  // The local scope's list is the folder's own settings file, so its write re-reads the trust the run started under.
  it('hands the personal-list rewrite a live trust check, which a revoke during the run turns false', async () => {
    const platform = createFakePlatform();
    const checks: Array<() => boolean> = [];
    const personal = (_trusted: boolean, stillTrusted: () => boolean): PersonalToolLists => {
      checks.push(stillTrusted);
      return { rewrite: async () => undefined, lists: () => [] };
    };
    const { cwd, toolsChanged, settled } = migrationFolder(platform, { personalDisabledTools: personal, retiredResources: retiredSecret });

    toolsChanged();
    await settled();
    expect(checks.map((check) => check())).toEqual([true]);
    platform.trust.revokeTrust([cwd]);

    expect(checks[0]!()).toBe(false);
  });

  it('runs again after a personal-list rewrite failed, with the same inputs', async () => {
    const platform = createFakePlatform();
    let failures = 1;
    const rewrite = vi.fn(async () => {
      if (failures-- > 0) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    });
    const { toolsChanged, settled } = migrationFolder(platform, {
      personalDisabledTools: () => ({ rewrite, lists: () => [] }),
      retiredResources: retiredSecret,
    });

    toolsChanged();
    await settled();
    toolsChanged();
    await settled();
    toolsChanged();
    await settled();

    expect(rewrite).toHaveBeenCalledTimes(2);
  });
});

describe('ToolSearch republishers', () => {
  const made: FolderRuntime[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
  });

  /**
   * The only private reach-through here, and only for SIZE — growth is invisible from the public
   * surface, since a disposed closure that no longer fires looks identical to one still held. All
   * behaviour is asserted through the public seam.
   */
  const registeredCount = (folder: FolderRuntime): number =>
    (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

  it('fires EVERY registered extension instance, not just the newest', () => {
    // `prepareSessionExtensions` reloads the resource loader per session, so each panel's session binds
    // its own extension instance while earlier panels keep theirs. A single-slot field held only the
    // last one, leaving every earlier panel's ToolSearch description frozen for the session's life.
    const folder = bareFolder(made);
    const fired: string[] = [];
    folder.attachExtensionInstance({} as never, () => fired.push('panelA'));
    folder.attachExtensionInstance({} as never, () => fired.push('panelB'));

    folder.republishToolSearch();

    expect(fired).toEqual(['panelA', 'panelB']);
  });

  it('the returned disposer removes exactly its own entry and leaves peers firing', () => {
    // "Exactly its own" is the load-bearing half: a disposer that cleared the set, or keyed off anything
    // but closure identity, would silently freeze every live panel's menu.
    const folder = bareFolder(made);
    const fired: string[] = [];
    const disposeA = folder.attachExtensionInstance({} as never, () => fired.push('panelA'));
    folder.attachExtensionInstance({} as never, () => fired.push('panelB'));
    folder.attachExtensionInstance({} as never, () => fired.push('panelC'));

    disposeA();
    folder.republishToolSearch();

    expect(fired).toEqual(['panelB', 'panelC']);
    expect(registeredCount(folder)).toBe(2);

    // Double-disposal is a real path (shutdown then teardown) and must not disturb peers.
    disposeA();
    fired.length = 0;
    folder.republishToolSearch();
    expect(fired).toEqual(['panelB', 'panelC']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('a throwing republisher is NOT retired: it stays registered, retries next time, and never aborts its peers', () => {
    // A LIVE panel whose `registerTool` failed for any unrelated reason must not be dropped for good,
    // which would freeze its menu with no further error.
    const folder = bareFolder(made);
    const fired: string[] = [];
    let attempts = 0;
    let failing = true;
    folder.attachExtensionInstance({} as never, () => {
      attempts++;
      if (failing) throw new Error('extension context is no longer active');
      fired.push('recovered');
    });
    folder.attachExtensionInstance({} as never, () => fired.push('live'));

    folder.republishToolSearch();
    expect(attempts).toBe(1);
    expect(fired).toEqual(['live']);
    expect(registeredCount(folder)).toBe(2);

    folder.republishToolSearch();
    expect(attempts).toBe(2);
    expect(fired).toEqual(['live', 'live']);

    failing = false;
    fired.length = 0;
    folder.republishToolSearch();
    expect(fired).toEqual(['recovered', 'live']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('does not grow across repeated teardowns — the count tracks live instances, not lifetime registrations', () => {
    const folder = bareFolder(made);
    const fired: string[] = [];
    folder.attachExtensionInstance({} as never, () => fired.push('survivor'));
    expect(registeredCount(folder)).toBe(1);

    for (let i = 0; i < 20; i++) {
      const dispose = folder.attachExtensionInstance({} as never, () => fired.push(`transient-${i}`));
      expect(registeredCount(folder)).toBe(2);
      dispose();
      expect(registeredCount(folder)).toBe(1);
    }

    folder.republishToolSearch();
    expect(fired).toEqual(['survivor']);
  });

  it('dispose() clears the republisher registry, not just the active-tool refreshers', async () => {
    const folder = bareFolder(made);
    const fired: string[] = [];
    const dispose = folder.attachExtensionInstance({} as never, () => fired.push('gone'));

    await folder.dispose();

    expect(registeredCount(folder)).toBe(0);
    folder.republishToolSearch();
    expect(fired).toEqual([]);
    // A shutdown in flight when the folder went down disposes afterwards; `Set.delete` on a cleared set
    // is inert, so this must not throw.
    expect(() => dispose()).not.toThrow();
  });
});

/**
 * The lifetime of an extension instance NO session ever binds. Only a bound instance receives
 * `session_shutdown`, so only it can retire itself. Bare reloads (asset watchers, trust grant, plugin
 * swaps) and the instance minted at services creation are unbound, so the folder runtime retires them —
 * and must never do so to one that HAS gone live.
 */
describe('unbound extension instances', () => {
  const made: FolderRuntime[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
  });

  const registeredCount = (folder: FolderRuntime): number =>
    (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

  interface FakeLoader {
    /** Republisher calls, in order, labelled by the instance that owns them. */
    fired: string[];
    failNextReload: () => void;
  }

  /**
   * Stands in for the folder's services so the reload paths are drivable without booting pi. Faithful in
   * the two respects the bookkeeping depends on: factories run INSIDE `reload()` (so a reload can identify
   * the instance it just minted), and the reload keeps awaiting afterwards, so overlapping reloads
   * interleave — an atomic fake would make the serialization test vacuous. The creation instance goes
   * through the same adoption `createServices` performs.
   */
  function attachFakeServices(folder: FolderRuntime): FakeLoader {
    const fired: string[] = [];
    let failNext = false;
    let seq = 0;
    const services = {
      resourceLoader: {
        reload: async (): Promise<void> => {
          await Promise.resolve();
          if (failNext) {
            failNext = false;
            throw new Error('packageManager.resolve failed');
          }
          const id = `instance-${++seq}`;
          folder.attachExtensionInstance({} as never, () => fired.push(id));
          await Promise.resolve();
        },
        extendResources: () => undefined,
        getExtensions: () => ({ runtime: { pendingProviderRegistrations: [] }, errors: [] }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
      },
    };
    const internals = folder as unknown as { _services: unknown; _trackCurrentInstanceAsUnbound(): void };
    internals._services = services;
    folder.attachExtensionInstance({} as never, () => fired.push('init'));
    internals._trackCurrentInstanceAsUnbound();
    return { fired, failNextReload: () => { failNext = true; } };
  }

  it('two bare reloads leave exactly ONE unbound republisher, not two', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.reloadBare();
    await folder.reloadBare();

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-2']);
    expect(registeredCount(folder)).toBe(1);

    loader.fired.length = 0;
    await folder.reloadBare();
    await folder.reloadBare();
    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-4']);
    expect(registeredCount(folder)).toBe(1);
  });

  it('a session-bound reload retires the previous BARE instance and keeps the one it mints', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // first session: binds the creation instance, no reload
    await folder.reloadBare(); // instance-1, unbound
    await folder.prepareSessionExtensions(); // second session: reload → instance-2, then binds it

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-2']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('NEVER retires a live session-bound panel’s republisher, however many reloads follow', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // panel A binds the creation instance
    await folder.prepareSessionExtensions(); // panel B binds instance-1

    await folder.reloadBare(); // instance-2
    await folder.reloadBare(); // instance-3
    await folder.reloadBare(); // instance-4

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-1', 'instance-4']);
    expect(registeredCount(folder)).toBe(3);
  });

  it('hands the startup instance to the first session instead of retiring it', async () => {
    // The subscription reconcile hot-reloads right after the first folder's creation, and pi's
    // `_buildRuntime` binds whatever the loader holds, so the first session binds THAT instance.
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.reloadBare(); // startup reconcile: instance-1 supersedes the creation instance
    await folder.prepareSessionExtensions(); // first session binds instance-1 without reloading
    await folder.reloadBare(); // instance-2 must not touch the now-bound instance-1

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-1', 'instance-2']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('a failed session-bound reload releases the instance the session binds instead of retiring it', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // first session binds the creation instance
    await folder.reloadBare(); // instance-1, unbound
    loader.failNextReload();
    await folder.prepareSessionExtensions(); // reload throws → the session binds instance-1
    await folder.reloadBare(); // instance-2

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-1', 'instance-2']);
  });

  it('a failed BARE reload keeps its claim on the instance still in place', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.reloadBare(); // instance-1
    loader.failNextReload();
    await expect(folder.reloadBare()).rejects.toThrow('packageManager.resolve failed');
    await folder.reloadBare(); // instance-2 supersedes instance-1, which must still be retired

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-2']);
    expect(registeredCount(folder)).toBe(1);
  });

  it('overlapping reloads serialize, so neither adopts the other’s instance', async () => {
    // A billing toggle (bare) and a panel starting (session-bound) can be issued in the same tick; each
    // reload reads "the instance I just minted" from one slot, so they must not interleave.
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // panel A binds the creation instance

    const bare = folder.reloadBare();
    const bound = folder.prepareSessionExtensions();
    await Promise.all([bare, bound]);

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-2']);
    expect(registeredCount(folder)).toBe(2);
  });
});

/** Two workspace folders on one real pi runtime. */
describe('folder runtimes on real pi', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    await PiRuntime.disposeInstance();
    refusedFiles.clear();
    H.home = '';
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  /** Two folders, each with its own instructions, skill, markdown agent and hook, under a temp home. */
  function twoFolders(): { a: string; b: string; runtime: PiRuntime } {
    H.home = tempDir('damocles-fr-home-');
    write(path.join(H.home, '.damocles', 'AGENTS.md'), 'Global rules.\n');
    const a = tempDir('damocles-fr-a-');
    const b = tempDir('damocles-fr-b-');
    for (const [dir, name] of [[a, 'alpha'], [b, 'beta']] as const) {
      write(path.join(dir, 'CLAUDE.md'), `${name} rules.\n`);
      write(path.join(dir, `${name}-marker.txt`), `${name} marker`);
      write(path.join(dir, '.damocles', 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: ${name} skill\n---\nBody.\n`);
      write(path.join(dir, '.damocles', 'agents', `${name}-agent.md`), `---\nname: ${name}-agent\ndescription: ${name} agent\n---\nYou are ${name}.\n`);
      write(path.join(dir, '.damocles', 'hooks.json'), JSON.stringify({ hooks: { tool_call: [{ command: `${name}-hook` }] } }));
    }
    return { a, b, runtime: PiRuntime.get(tempDir('damocles-fr-agent-')) };
  }

  const contextOf = (services: AgentSessionServices): string =>
    services.resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.content).join('\n');

  async function sessionOn(services: AgentSessionServices): Promise<AgentSession> {
    const pi = await initPiLoader();
    if (!pi) throw new Error('pi failed to load');
    const { session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory(services.cwd) });
    sessions.push(session);
    return session;
  }

  it('loads each folder’s own CLAUDE.md plus the global one, on one shared model runtime', async () => {
    const { a, b, runtime } = twoFolders();
    const [fa, fb] = await Promise.all([runtime.folder(a), runtime.folder(b)]);

    expect(contextOf(fa.services)).toContain('alpha rules.');
    expect(contextOf(fa.services)).toContain('Global rules.');
    expect(contextOf(fa.services)).not.toContain('beta rules.');
    expect(contextOf(fb.services)).toContain('beta rules.');
    expect(contextOf(fb.services)).toContain('Global rules.');
    expect(contextOf(fb.services)).not.toContain('alpha rules.');

    const prompt = (await sessionOn(fb.services)).systemPrompt;
    expect(prompt).toContain('beta rules.');
    expect(prompt).not.toContain('alpha rules.');

    // A reload of one folder re-reads only that folder's files.
    await fa.reloadBare();
    expect(contextOf(fb.services)).not.toContain('alpha rules.');
    expect(contextOf(fa.services)).toContain('alpha rules.');

    expect(fa.services.modelRuntime).toBe(runtime.modelRuntime);
    expect(fb.services.modelRuntime).toBe(runtime.modelRuntime);
  }, 60_000);

  it('keeps a skill linked onto a share and a link loop out of pi’s skills', async () => {
    const { a, runtime } = twoFolders();
    const root = path.join(a, '.damocles', 'skills');
    const elsewhere = tempDir('damocles-fr-elsewhere-');
    write(path.join(elsewhere, 'nas-skill', 'SKILL.md'), '---\nname: nas-skill\ndescription: d\n---\nBody.\n');
    const folderLink = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    folderLink(path.join(elsewhere, 'nas-skill'), path.join(root, 'nas'));
    folderLink(root, path.join(root, 'loop1'));
    folderLink(root, path.join(root, 'loop2'));
    if (process.platform === 'win32') fakeLinks.set(path.join(root, 'nas').toLowerCase(), '\\\\host\\share\\nas-skill');
    try {
      const fa = await runtime.folder(a);
      const names = fa.services.resourceLoader.getSkills().skills.map((s) => s.name);
      expect(names).toContain('alpha-skill');
      expect(names.filter((name) => name === 'alpha-skill')).toHaveLength(1);
      if (process.platform === 'win32') expect(names).not.toContain('nas-skill');
    } finally {
      fakeLinks.clear();
    }
  }, 60_000);

  // The walk logs what it cannot read and goes on, so no root a file system error hits keeps the folder from its services.
  it('builds a folder\'s services when its command root holds a link loop, a folder it may not read and a link onto a drive that does not answer', async () => {
    const { a, runtime } = twoFolders();
    const commands = path.join(a, '.claude', 'commands');
    write(path.join(commands, 'ok.md'), 'Fine.\n');
    write(path.join(commands, 'locked', 'hidden.md'), 'Hidden.\n');
    const clone = tempDir('damocles-fr-clone-');
    write(path.join(clone, 'far.md'), 'Far.\n');
    const folderLink = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    folderLink(commands, path.join(commands, 'loop'));
    folderLink(clone, path.join(commands, 'nas'));
    timedOut.add('.claude/commands/nas');
    // the walk lists a folder by its real path, which on Windows spells out a short name the temp path may hold
    const locked = fs.realpathSync.native(path.join(commands, 'locked')).toLowerCase();
    const readdir = fs.promises.readdir.bind(fs.promises);
    const denied = vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: fs.PathLike, options?: unknown) =>
      String(dir).toLowerCase() === locked
        ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${String(dir)}'`), { code: 'EACCES' }))
        : readdir(dir, options as never)) as typeof fs.promises.readdir);
    const lines = captureLog();
    try {
      const fa = await runtime.folder(a);

      expect(fa.services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toContain('ok');
      expect(denied).toHaveBeenCalledWith(expect.stringMatching(/locked$/i), expect.anything());
      expect(lines.filter((line) => line.includes('[assets]')).map((line) => line.replace(/^.*\\commands\\|^.*\/commands\//, '')).sort()).toEqual(['locked: EACCES', 'loop: loop', 'nas: unreachable']);
    } finally {
      denied.mockRestore();
      timedOut.clear();
    }
  }, 60_000);

  // fakeLinks change only what a Windows walk reads; off Windows the rule admits every link, so there is nothing to refuse.
  it.runIf(process.platform === 'win32')('walks a link again at each reload, so one pointed onto a share since the last drops its skill', async () => {
    const { a, runtime } = twoFolders();
    const root = path.join(a, '.damocles', 'skills');
    const elsewhere = tempDir('damocles-fr-elsewhere-');
    write(path.join(elsewhere, 'moved-skill', 'SKILL.md'), '---\nname: moved-skill\ndescription: d\n---\nBody.\n');
    fs.symlinkSync(path.join(elsewhere, 'moved-skill'), path.join(root, 'moved'), 'junction');
    try {
      const fa = await runtime.folder(a);
      const names = () => fa.services.resourceLoader.getSkills().skills.map((s) => s.name);
      expect(names()).toContain('moved-skill');
      fakeLinks.set(path.join(root, 'moved').toLowerCase(), '\\\\host\\share\\moved-skill');
      await fa.reloadBare();
      expect(names()).not.toContain('moved-skill');
      expect(names()).toContain('alpha-skill');
    } finally {
      fakeLinks.clear();
    }
  }, 60_000);

  // pi's own walk takes the link policy synchronously, with no drive probe, so a reload would block on a drive that still
  // does not answer: a retry rescans with the probed walk and reloads pi only once that scan finds something else.
  describe('a link onto a drive that did not answer', () => {
    const retries = (sync: { mock: { calls: Array<[Iterable<WatchTarget>]> } }): number =>
      sync.mock.calls.filter(([targets]) => [...targets].some((target) => 'retry' in target)).length;

    afterEach(() => {
      timedOut.clear();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('is asked again for a project command by a scan alone, and pi reloads once the drive answers', async () => {
      const { a, runtime } = twoFolders();
      const clone = tempDir('damocles-fr-clone-');
      write(path.join(clone, 'pickup.md'), '---\ndescription: pick up\n---\nPick up.\n');
      fs.mkdirSync(path.join(a, '.damocles', 'commands'), { recursive: true });
      fs.symlinkSync(clone, path.join(a, '.damocles', 'commands', 'gs'), process.platform === 'win32' ? 'junction' : 'dir');
      const fa = await runtime.folder(a);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      timedOut.add('.damocles/commands/gs');
      await fa.reloadBare();
      const prompts = () => fa.services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name);
      expect(prompts()).not.toContain('gs:pickup');
      const reload = vi.spyOn(fa.services.resourceLoader, 'reload');
      const sync = vi.spyOn(LinkTargetWatchers.prototype, 'sync');

      await vi.advanceTimersByTimeAsync(DRIVE_ANSWER_TTL_MS);
      await vi.waitFor(() => expect(retries(sync)).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();

      timedOut.clear();
      await vi.advanceTimersByTimeAsync(DRIVE_ANSWER_TTL_MS);
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      await vi.waitFor(() => expect(prompts()).toContain('gs:pickup'));
    }, 60_000);

    it('is asked again for a user command by a scan alone, and every folder reloads once the drive answers', async () => {
      const { a, runtime } = twoFolders();
      const clone = tempDir('damocles-fr-clone-');
      write(path.join(clone, 'pickup.md'), '---\ndescription: pick up\n---\nPick up.\n');
      fs.mkdirSync(path.join(H.home, '.claude', 'commands'), { recursive: true });
      fs.symlinkSync(clone, path.join(H.home, '.claude', 'commands', 'team'), process.platform === 'win32' ? 'junction' : 'dir');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      timedOut.add('.claude/commands/team');
      const sync = vi.spyOn(LinkTargetWatchers.prototype, 'sync');
      const fa = await runtime.folder(a);
      await vi.waitFor(() => expect(retries(sync)).toBeGreaterThan(0), { timeout: 20_000 });
      const reload = vi.spyOn(fa.services.resourceLoader, 'reload');
      sync.mockClear();

      await vi.advanceTimersByTimeAsync(DRIVE_ANSWER_TTL_MS);
      await vi.waitFor(() => expect(retries(sync)).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();

      timedOut.clear();
      await vi.advanceTimersByTimeAsync(DRIVE_ANSWER_TTL_MS);
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 20_000 });
      await vi.waitFor(() => expect(fa.services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toContain('team:pickup'));
    }, 60_000);
  });

  it('lets pi refuse every agent file the user link policy refuses: none is read or written, and each is named', async () => {
    const fake = installFakePlatform();
    H.home = tempDir('damocles-fr-home-');
    const agentDir = tempDir('damocles-fr-agent-');
    const files = {
      settings: path.join(agentDir, 'settings.json'),
      models: path.join(agentDir, 'models.json'),
      auth: path.join(agentDir, 'auth.json'),
      store: path.join(agentDir, 'models-store.json'),
    };
    write(files.settings, '{"theme":"dark"}\n');
    write(files.models, '{"providers":{}}\n');
    write(files.auth, '{"anthropic":{"type":"api_key","key":"sk-ant-test"}}\n');
    for (const file of Object.values(files)) refusedFiles.add(file);
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();

    // pi's settings manager recorded the refusal of the file at its load (drainErrors), and Damocles named it once
    expect((runtime as unknown as { _userSettingsLoadError: unknown })._userSettingsLoadError).toMatchObject({ scope: 'global', path: files.settings, error: { code: 'ELINKPOLICY' } });
    const named = fake.notifications.calls.filter((call) => call.text.message === '{0} links to a network share or WSL path, so Damocles does not read it.').map((call) => call.text.args?.[0]);
    expect(named).toEqual(expect.arrayContaining([files.settings, files.models]));
    expect(fake.notifications.calls.map((call) => call.message)).not.toContainEqual(expect.stringContaining('Damocles could not read'));

    const modelRuntime = runtime.modelRuntime!;
    await modelRuntime.refresh({ allowNetwork: false });
    expect(modelRuntime.getError()).toContain(`the link policy refuses it\n\nFile: ${files.models}`);
    await expect(modelRuntime.getAuth('anthropic')).rejects.toThrow(files.auth);

    // nothing seeded, saved or created
    expect(fs.readFileSync(files.settings, 'utf8')).toBe('{"theme":"dark"}\n');
    expect(fs.existsSync(files.store)).toBe(false);
  }, 60_000);

  const folderLink = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

  it('lets pi read no gitdir a folder’s .git file names when the link policy refuses it, and logs the refusal', async () => {
    const lines = captureLog();
    const { a, runtime } = twoFolders();
    const gitDir = path.join(tempDir('damocles-fr-gitdir-'), 'worktrees', 'a');
    write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/a\n');
    write(path.join(gitDir, 'commondir'), '../..\n');
    write(path.join(a, '.git'), `gitdir: ${gitDir}\n`);
    refusedFiles.add(path.join(gitDir, 'HEAD'));

    const fsCalls = await recordPiFsCalls();
    try {
      await runtime.folder(a);
    } finally {
      fsCalls.stop();
    }

    expect(callsOn(fsCalls.calls, gitDir)).toEqual([]);
    expect(lines.filter((line) => line.includes(path.join(gitDir, 'HEAD')) && line.includes('git metadata not read: the link policy refuses it'))).toHaveLength(1);
  }, 60_000);

  it('lets pi read no linked .gitignore of a skill root that the link policy refuses, and logs the refusal', async () => {
    const lines = captureLog();
    const { a, runtime } = twoFolders();
    const ignoreLink = path.join(a, '.damocles', 'skills', '.gitignore');
    folderLink(tempDir('damocles-fr-elsewhere-'), ignoreLink);
    refusedFiles.add(ignoreLink);

    const fsCalls = await recordPiFsCalls();
    try {
      await runtime.folder(a);
    } finally {
      fsCalls.stop();
    }

    // an lstat of the name follows nothing, and is how pi finds that it is a link
    expect(callsOn(fsCalls.calls, ignoreLink, ['lstatSync'])).toEqual([]);
    expect(lines.filter((line) => line.includes(ignoreLink) && line.includes('link not followed: the link policy refuses it'))).toHaveLength(1);
  }, 60_000);

  it('lets pi stat no extension entry of a package that the link policy refuses, and logs the refusal', async () => {
    const lines = captureLog();
    H.home = tempDir('damocles-fr-home-');
    const a = tempDir('damocles-fr-a-');
    const agentDir = tempDir('damocles-fr-agent-');
    const pkg = path.join(agentDir, 'extensions', 'pkg');
    write(path.join(pkg, 'package.json'), JSON.stringify({ pi: { extensions: ['./remote'] } }));
    const elsewhere = tempDir('damocles-fr-elsewhere-');
    write(path.join(elsewhere, 'index.ts'), 'export default () => {};\n');
    const remote = path.join(pkg, 'remote');
    folderLink(elsewhere, remote);
    refusedFiles.add(remote);
    const runtime = PiRuntime.get(agentDir);

    const fsCalls = await recordPiFsCalls();
    try {
      await runtime.folder(a);
    } finally {
      fsCalls.stop();
    }

    expect(callsOn(fsCalls.calls, remote)).toEqual([]);
    expect(callsOn(fsCalls.calls, elsewhere)).toEqual([]);
    expect(lines.filter((line) => line.includes(remote) && line.includes('link not followed: the link policy refuses it'))).toHaveLength(1);
  }, 60_000);

  it('logs a refusal once while it persists across reloads, and again when it comes back after it was gone', async () => {
    const lines = captureLog();
    const { a, runtime } = twoFolders();
    const elsewhere = tempDir('damocles-fr-elsewhere-');
    write(path.join(elsewhere, 'nas-skill', 'SKILL.md'), '---\nname: nas-skill\ndescription: d\n---\nBody.\n');
    const link = path.join(a, '.damocles', 'skills', 'nas');
    folderLink(path.join(elsewhere, 'nas-skill'), link);
    refusedFiles.add(link);
    const logged = () => lines.filter((line) => line.includes(link) && line.includes('link not followed: the link policy refuses it')).length;

    const fa = await runtime.folder(a);
    expect(logged()).toBe(1);
    await fa.reloadBare();
    expect(logged()).toBe(1);
    refusedFiles.delete(link);
    await fa.reloadBare();
    expect(fa.services.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain('nas-skill');
    refusedFiles.add(link);
    await fa.reloadBare();
    expect(logged()).toBe(2);
  }, 60_000);

  it('creates one runtime per folder key and lists only finished ones', async () => {
    const { a, b, runtime } = twoFolders();
    const [first, second] = await Promise.all([runtime.folder(a), runtime.folder(a)]);
    expect(second).toBe(first);
    expect(first.cwd).toBe(a);
    expect(first.key).toBe(folderKey(a));
    if (process.platform === 'win32') expect(await runtime.folder(a.toUpperCase())).toBe(first);

    expect(runtime.folders()).toEqual([first]);
    const fb = await runtime.folder(b);
    expect(runtime.folders()).toEqual([first, fb]);
  }, 60_000);

  it('points cwd, project skills, markdown agents and hooks at the folder', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);

    expect(fb.services.cwd).toBe(b);
    const read = (await sessionOn(fb.services)).getToolDefinition('read');
    if (!read) throw new Error('pi native `read` is not registered on this session');
    const result = await read.execute('cwd-probe', { path: 'beta-marker.txt' }, undefined, undefined, undefined as never);
    expect(JSON.stringify(result.content)).toContain('beta marker');

    const skills = (folder: typeof fa) => folder.services.resourceLoader.getSkills().skills.map((s) => s.name);
    expect(skills(fb)).toContain('beta-skill');
    expect(skills(fb)).not.toContain('alpha-skill');
    expect(skills(fa)).toContain('alpha-skill');

    const agents = (folder: typeof fa) => folder.getWorkspaceAgentRegistry().getRegistry().getAvailableConfigs().map((c) => c.name);
    await fb.getWorkspaceAgentRegistry().whenLoaded();
    expect(agents(fb)).toContain('beta-agent');
    expect(agents(fb)).not.toContain('alpha-agent');

    const hooks = (folder: typeof fa) => folder.getHooksDispatchDeps().config.getEntries('tool_call').map((e) => e.command);
    expect(fb.getHooksDispatchDeps().workspaceRoot).toBe(b);
    expect(hooks(fb)).toContain('beta-hook');
    expect(hooks(fb)).not.toContain('alpha-hook');
  }, 60_000);

  it('keeps the pristine-session rule and the ToolSearch republishers per folder', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);
    const reloadA = vi.spyOn(fa.services.resourceLoader, 'reload');
    const reloadB = vi.spyOn(fb.services.resourceLoader, 'reload');
    const republishers = (folder: FolderRuntime) =>
      (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;
    expect(republishers(fa)).toBe(1);
    expect(republishers(fb)).toBe(1);

    await fa.prepareSessionExtensions(); // A's first session binds A's creation instance
    await fb.prepareSessionExtensions(); // so does B's, even though A already bound one
    expect(reloadA).not.toHaveBeenCalled();
    expect(reloadB).not.toHaveBeenCalled();

    await fa.prepareSessionExtensions(); // A's second session reloads A only
    expect(reloadA).toHaveBeenCalledTimes(1);
    expect(reloadB).not.toHaveBeenCalled();
    expect(republishers(fa)).toBe(2);
    expect(republishers(fb)).toBe(1);

    await fb.reloadBare();
    await fb.reloadBare();
    expect(republishers(fa)).toBe(2);
    expect(republishers(fb)).toBe(2);
  }, 60_000);

  it('fans an MCP tools change out to every folder', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);
    const refreshed: string[] = [];
    fa.registerActiveToolRefresher('sess-a', () => refreshed.push('a'));
    fb.registerActiveToolRefresher('sess-b', () => refreshed.push('b'));

    (runtime.getUserMcp() as unknown as { emitToolsChanged(): void }).emitToolsChanged();

    expect(refreshed.sort()).toEqual(['a', 'b']);
  }, 60_000);

  it('disposes one folder without touching the other', async () => {
    const fake = installFakePlatform();
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);
    const anchoredOn = (dir: string) =>
      fake.fileWatchers.watchers.filter((w) => w.base === dir);
    expect(anchoredOn(a).length).toBeGreaterThan(0);

    await runtime.disposeFolder(fa.key);

    expect(fa.disposed).toBe(true);
    expect(anchoredOn(a).every((w) => w.disposed)).toBe(true);
    expect(runtime.folders()).toEqual([fb]);
    await expect(fb.reloadBare()).resolves.toBeUndefined();
    expect(contextOf(fb.services)).toContain('beta rules.');

    const again = await runtime.folder(a);
    expect(again).not.toBe(fa);

    await PiRuntime.disposeInstance();
    expect(fb.disposed).toBe(true);
    expect(again.disposed).toBe(true);
  }, 60_000);
});

describe('createSubagentSession store', () => {
  const made: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const assistantMessage = (provider: string, model: string) =>
    ({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      api: 'anthropic-messages',
      provider,
      model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    }) as unknown as Parameters<SessionManager['appendMessage']>[0];

  const baseOpts = (workspace: string) => ({
    cwd: workspace,
    systemPrompt: 'probe',
    tools: [],
    customTools: [],
    extensionFactory: () => {},
  });

  /** A signed-in reasoning model from the runtime's own catalog, so the reopen check can resolve it. */
  async function reasoningModel(runtime: PiRuntime) {
    await runtime.modelRuntime!.setRuntimeApiKey('anthropic', 'test-key');
    const model = runtime.modelRuntime!.getModels('anthropic').find((m) => m.reasoning);
    if (!model) throw new Error('no anthropic reasoning model in the catalog');
    expect(runtime.modelRuntime!.hasConfiguredAuth('anthropic')).toBe(true);
    return model;
  }

  it('a file store writes into the given dir under the given id, from the first user message on', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    const file = session.sessionManager.getSessionFile()!;
    expect(path.dirname(file)).toBe(storeDir);
    expect(path.basename(file)).toMatch(/_agent-1\.jsonl$/);
    expect(session.sessionManager.getSessionId()).toBe('agent-1');
    expect(fs.existsSync(file)).toBe(false);

    session.sessionManager.appendCustomEntry('damocles-agent-launch', { agentId: 'agent-1' });
    expect(fs.existsSync(file)).toBe(false);
    session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'the task' }], timestamp: Date.now() });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; id: string });
    expect(lines[0]).toMatchObject({ type: 'session', id: 'agent-1' });
    expect(lines.map((l) => l.type)).toEqual(expect.arrayContaining(['custom', 'message']));
    folder.forgetSubagentSession(session);
  }, 60_000);

  it('letting go of a nested session clears the calls the gate recorded for it', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const runtime = PiRuntime.get(tempDir('damocles-store-agent-'));
    const folder = await runtime.folder(workspace);
    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: path.join(workspace, 'subagents'), id: 'agent-1' } });
    recordTerminatedCall('agent-1', { toolCallId: 'c1', toolName: 'Bash', cause: 'user' });
    folder.forgetSubagentSession(session);
    expect(takeTerminatedCalls('agent-1')).toEqual([]);

    const running = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: path.join(workspace, 'subagents'), id: 'agent-2' } });
    recordTerminatedCall(running.sessionId, { toolCallId: 'c2', toolName: 'Bash', cause: 'hook' });
    await folder.dispose();
    expect(takeTerminatedCalls('agent-2')).toEqual([]);
  }, 60_000);

  it('reopen restores the messages, the recorded model and the thinking level from the file', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);
    const model = await reasoningModel(runtime);

    const session = await folder.createSubagentSession({
      ...baseOpts(workspace),
      model,
      thinkingLevel: 'medium',
      store: { kind: 'file', dir: storeDir, id: 'agent-1' },
    });
    session.sessionManager.appendCustomEntry('damocles-agent-launch', { agentId: 'agent-1' });
    session.sessionManager.appendMessage(assistantMessage(model.provider, model.id));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const reopened = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } });
    expect(reopened.sessionManager.getSessionFile()).toBe(file);
    expect(reopened.sessionManager.getSessionId()).toBe('agent-1');
    expect(reopened.messages.map((m) => m.role)).toEqual(['assistant']);
    expect(reopened.model?.provider).toBe(model.provider);
    expect(reopened.model?.id).toBe(model.id);
    expect(reopened.thinkingLevel).toBe('medium');
    await expect(folder.assertResumableModel(file, 'agent-1')).resolves.toBeUndefined();
    folder.forgetSubagentSession(reopened);
  }, 60_000);

  // The check runs before the resume owns the file, whose stopped run may still append to it; pi's open completes a torn last line.
  it('the resume check reads the recorded model without writing the file, accepted or refused', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const runtime = PiRuntime.get(tempDir('damocles-store-agent-'));
    const folder = await runtime.folder(workspace);
    const model = await reasoningModel(runtime);
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const torn = '{"type":"message","id":"torn"';

    const usable = await folder.createSubagentSession({ ...baseOpts(workspace), model, store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    usable.sessionManager.appendMessage(assistantMessage(model.provider, model.id));
    const usableFile = usable.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(usable);
    fs.appendFileSync(usableFile, torn);
    const usableBytes = fs.readFileSync(usableFile);
    await expect(folder.assertResumableModel(usableFile, 'agent-1')).resolves.toBeUndefined();
    expect(fs.readFileSync(usableFile).equals(usableBytes)).toBe(true);

    const unusable = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-2' } });
    unusable.sessionManager.appendMessage(assistantMessage('anthropic', 'no-such-model'));
    const unusableFile = unusable.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(unusable);
    fs.appendFileSync(unusableFile, torn);
    const unusableBytes = fs.readFileSync(unusableFile);
    await expect(folder.assertResumableModel(unusableFile, 'agent-2')).rejects.toThrow('Cannot resume "agent-2": its model anthropic/no-such-model is not configured or not signed in.');
    expect(fs.readFileSync(unusableFile).equals(unusableBytes)).toBe(true);
  }, 60_000);

  it("reopen stops reading the file when its run is stopped, rejecting with the stop's reason", async () => {
    const workspace = tempDir('damocles-store-ws-');
    const runtime = PiRuntime.get(tempDir('damocles-store-agent-'));
    const folder = await runtime.folder(workspace);
    const model = await reasoningModel(runtime);
    const session = await folder.createSubagentSession({ ...baseOpts(workspace), model, store: { kind: 'file', dir: path.join(workspace, 'subagents'), id: 'agent-1' } });
    session.sessionManager.appendMessage(assistantMessage(model.provider, model.id));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);
    const stop = new AbortController();
    const reason = new Error('stopped');
    stop.abort(reason);

    await expect(folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' }, signal: stop.signal })).rejects.toBe(reason);
  }, 60_000);

  it('reopen throws the resume error, instead of falling back, when the recorded model is unavailable', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);
    await reasoningModel(runtime);

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    session.sessionManager.appendMessage(assistantMessage('anthropic', 'no-such-model'));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const error = 'Cannot resume "agent-1": its model anthropic/no-such-model is not configured or not signed in.';
    await expect(
      folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } }),
    ).rejects.toThrow(error);
    await expect(folder.assertResumableModel(file, 'agent-1')).rejects.toThrow(error);
  }, 60_000);

  it('reopen throws the resume error when the recorded model exists but its provider is not signed in', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);
    const models = runtime.modelRuntime!;
    const signedOut = models.getModels().find((m) => !models.hasConfiguredAuth(m.provider));
    if (!signedOut) throw new Error('every catalog provider is signed in, so no signed-out model can be recorded');

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    session.sessionManager.appendMessage(assistantMessage(signedOut.provider, signedOut.id));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const error = `Cannot resume "agent-1": its model ${signedOut.provider}/${signedOut.id} is not configured or not signed in.`;
    await expect(folder.assertResumableModel(file, 'agent-1')).rejects.toThrow(error);
    await expect(
      folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } }),
    ).rejects.toThrow(error);
  }, 60_000);

  it('reopen throws the resume error when the recorded GitHub Copilot model is outside the plan of the stored sign-in', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
      'github-copilot': { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999, availableModelIds: ['claude-haiku-5.5'] },
    }));
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    session.sessionManager.appendMessage(assistantMessage('github-copilot', 'claude-opus-5.5'));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const error = 'Cannot resume "agent-1": your GitHub Copilot plan does not include Opus 5.5 (GitHub Copilot), the model its session recorded.';
    await expect(folder.assertResumableModel(file, 'agent-1')).rejects.toThrow(error);
    await expect(
      folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } }),
    ).rejects.toThrow(error);
  }, 60_000);
});
