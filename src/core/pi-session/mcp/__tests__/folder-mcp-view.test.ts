import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MCP_METADATA_CACHE_DIR } from '../paths';
import { createMcpToolName } from '../naming';
import { retiredResourceToolNames } from '../tool-name-migration';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { FolderMcpView } from '../folder-mcp-view';
import { McpClientManager } from '../mcp-client-manager';
import { FolderRuntime } from '../../folder-runtime';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpTool } from '../types';
import { fakeServerManager, managerWithFake, specOf } from './fake-server-manager';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';

// FolderRuntime migrates renamed-tool rules in ~/.damocles/settings*.json, so home points into a temp dir.
const { fakeHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { fakeHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'damocles-folder-view-home-')) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

/** Trust and watchers for the folder runtimes built here; trusted by default, as the host is. */
const testPlatform = createFakePlatform();

const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../../logger', () => ({ log: logMock }));

const TOOLS: Record<string, McpTool[]> = {
  alpha: [{ name: 'a_run' }],
  beta: [{ name: 'b_run' }],
  shared: [{ name: 'ping', annotations: { readOnlyHint: true } }],
  hidden: [{ name: 'secret' }],
};

const cfg = (command: string) => specOf({ command });

const disposables: { dispose(): unknown }[] = [];
afterEach(async () => {
  for (const d of disposables.splice(0)) await d.dispose();
});

function track<T extends { dispose(): unknown }>(value: T): T {
  disposables.push(value);
  return value;
}

/** A user manager plus a folder manager behind one view, wired the way `FolderRuntime` wires them. */
function viewOver(user: McpClientManager, folderTools: Record<string, McpTool[]> = TOOLS) {
  const holder: { view?: FolderMcpView } = {};
  const folder = managerWithFake(folderTools, () => holder.view!.reservedToolNames());
  track(folder.manager);
  const view = track(new FolderMcpView(user, folder.manager));
  holder.view = view;
  return { view, folder };
}

function userManager(tools: Record<string, McpTool[]> = TOOLS) {
  const user = managerWithFake(tools);
  track(user.manager);
  return user;
}

const sortedNames = (view: FolderMcpView) => view.allToolNames().sort();

describe('FolderMcpView: what a folder sees', () => {
  it('A sees alpha+shared, B sees beta+shared, and neither reaches the other folder', async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared') });
    const a = viewOver(user.manager);
    const b = viewOver(user.manager);
    a.view.setUserVisible(['shared']);
    b.view.setUserVisible(['shared']);
    await a.folder.manager.reconcile({ alpha: cfg('alpha') });
    await b.folder.manager.reconcile({ beta: cfg('beta') });

    expect(sortedNames(a.view)).toEqual(['mcp__alpha__a_run', 'mcp__shared__ping']);
    expect(sortedNames(b.view)).toEqual(['mcp__beta__b_run', 'mcp__shared__ping']);
    expect(b.view.getServerStatuses().map((s) => s.name).sort()).toEqual(['beta', 'shared']);
    expect(b.view.getToolDescriptor('mcp__alpha__a_run')).toBeUndefined();
    expect(b.view.isMcpReadOnly('mcp__shared__ping')).toBe(true);
    await expect(b.view.callTool('mcp__alpha__a_run', {})).rejects.toThrow('Unknown MCP tool');
    expect(a.folder.fake.callTool).not.toHaveBeenCalled();
  });

  it('hides a user server that is not in userVisible from names, descriptors and statuses', async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared'), hidden: cfg('hidden') });
    const { view, folder } = viewOver(user.manager);
    view.setUserVisible(['shared']);
    await folder.manager.reconcile({});

    expect(sortedNames(view)).toEqual(['mcp__shared__ping']);
    expect(view.getServerStatuses().map((s) => s.name)).toEqual(['shared']);
    expect(view.getToolDescriptor('mcp__hidden__secret')).toBeUndefined();
    await expect(view.callTool('mcp__hidden__secret', {})).rejects.toThrow('Unknown MCP tool');
    expect(user.fake.callTool).not.toHaveBeenCalled();
  });

  it('two folders with shared visible open ONE user connection for it', async () => {
    const user = userManager();
    const a = viewOver(user.manager);
    const b = viewOver(user.manager);
    await user.manager.reconcile({ shared: cfg('shared') });
    // Every panel feeds the same union; the signature dedup keeps it to one connect.
    await user.manager.reconcile({ shared: cfg('shared') });
    a.view.setUserVisible(['shared']);
    b.view.setUserVisible(['shared']);
    await a.folder.manager.reconcile({ alpha: cfg('alpha') });
    await b.folder.manager.reconcile({ beta: cfg('beta') });

    const sharedConnects = [...user.connected(), ...a.folder.connected(), ...b.folder.connected()].filter(
      (name) => name === 'shared',
    );
    expect(sharedConnects).toEqual(['shared']);
    await a.view.callTool('mcp__shared__ping', {});
    await b.view.callTool('mcp__shared__ping', {});
    expect(user.fake.callTool).toHaveBeenCalledTimes(2);
  });

  it("B's own shared replaces the user shared in B only; A's names do not move", async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('user-shared') });
    const a = viewOver(user.manager);
    const b = viewOver(user.manager, { shared: [{ name: 'b_version' }] });
    a.view.setUserVisible(['shared']);
    b.view.setUserVisible([]);
    await a.folder.manager.reconcile({ alpha: cfg('alpha') });
    await b.folder.manager.reconcile({ shared: cfg('b-shared') });

    expect(sortedNames(a.view)).toEqual(['mcp__alpha__a_run', 'mcp__shared__ping']);
    expect(sortedNames(b.view)).toEqual(['mcp__shared__b_version']);
    expect(b.view.getServerStatuses()).toHaveLength(1);
    await b.view.callTool('mcp__shared__b_version', {});
    expect(b.folder.fake.callTool).toHaveBeenCalledTimes(1);
    expect(user.fake.callTool).not.toHaveBeenCalled();
  });

  it('a folder tool whose name a visible user tool holds gets the hash suffix; the user tool keeps its name', async () => {
    const user = userManager({ 'a-b': [{ name: 'x' }] });
    await user.manager.reconcile({ 'a-b': cfg('user-ab') });
    const { view, folder } = viewOver(user.manager, { 'a.b': [{ name: 'x' }] });
    view.setUserVisible(['a-b']);
    await folder.manager.reconcile({ 'a.b': cfg('folder-ab') });

    expect(sortedNames(view)).toEqual(['mcp__a_b__x', expect.stringMatching(/^mcp__a_b__x_[0-9a-f]{8}$/)]);
    expect(folder.manager.getToolDescriptor(sortedNames(view)[1]!)?.serverName).toBe('a.b');
    await view.callTool('mcp__a_b__x', {});
    expect(user.fake.callTool).toHaveBeenCalledTimes(1);
    expect(folder.fake.callTool).not.toHaveBeenCalled();
  });

  it('a user server that appears later takes its tool name back from the folder server', async () => {
    const user = userManager({ a_b: [{ name: 'x' }] });
    await user.manager.reconcile({});
    const { view, folder } = viewOver(user.manager, { 'a-b': [{ name: 'x' }] });
    await folder.manager.reconcile({ 'a-b': cfg('folder-ab') });
    expect(sortedNames(view)).toEqual(['mcp__a_b__x']);

    view.setUserVisible(['a_b']);
    await user.manager.reconcile({ a_b: cfg('user-ab') });

    expect(sortedNames(view)).toEqual(['mcp__a_b__x', expect.stringMatching(/^mcp__a_b__x_[0-9a-f]{8}$/)]);
    await view.callTool('mcp__a_b__x', {});
    expect(user.fake.callTool).toHaveBeenCalledTimes(1);
    expect(folder.fake.callTool).not.toHaveBeenCalled();
  });

  it('refuses a tool name both managers claim instead of picking one', async () => {
    const user = userManager({ 'd-p': [{ name: 'x' }] });
    await user.manager.reconcile({ 'd-p': cfg('user-dp') });
    // No reservation provider: models a folder rename still in flight onto the user tool name.
    const folder = managerWithFake({ 'd.p': [{ name: 'x' }] });
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager));
    view.setUserVisible(['d-p']);
    await folder.manager.reconcile({ 'd.p': cfg('folder-dp') });

    expect(folder.manager.allToolNames()).toEqual(['mcp__d_p__x']);
    expect(view.allToolNames()).toEqual([]);
    expect(view.getToolDescriptor('mcp__d_p__x')).toBeUndefined();
    await expect(view.callTool('mcp__d_p__x', {})).rejects.toThrow('Unknown MCP tool');
    expect(user.fake.callTool).not.toHaveBeenCalled();
    expect(folder.fake.callTool).not.toHaveBeenCalled();
  });

  it('describes its tools\u2019 legacy names for the rule migration, with the folder prefix suffixed around user servers', async () => {
    const user = userManager({ 'my-server': [{ name: 'a-b' }] });
    await user.manager.reconcile({ 'my-server': cfg('u') });
    const { view, folder } = viewOver(user.manager, { 'my.server': [{ name: 'x-y' }] });
    view.setUserVisible(['my-server']);
    await folder.manager.reconcile({ 'my.server': cfg('f') });

    const input = view.legacyToolNameInput();
    expect(input).toMatchObject({ userServers: ['my-server'], visibleUserServers: ['my-server'], folderServers: ['my.server'] });
    expect(input.userTools.map((t) => t.rawToolName)).toEqual(['a-b']);
    expect(input.folderTools.map((t) => t.rawToolName)).toEqual(['x-y']);
  });

  it('describes every user server\u2019s retired resources, a hidden one\u2019s too, which older builds named the visible ones beside', async () => {
    const cacheFile = (server: string) => join(MCP_METADATA_CACHE_DIR, `${createHash('sha256').update(server).digest('hex').slice(0, 32)}.json`);
    mkdirSync(MCP_METADATA_CACHE_DIR, { recursive: true });
    for (const [server, uri] of [['a.b', 'dot://x'], ['a_b', 'under://x'], ['docs', 'docs://x']] as const) {
      writeFileSync(cacheFile(server), JSON.stringify({ version: 1, configHash: 'older', tools: [], resources: [{ uri, name: 'x' }], cachedAt: Date.now() }));
    }
    try {
      const user = userManager({ 'a.b': [], a_b: [] });
      await user.manager.reconcile({ 'a.b': cfg('dot'), a_b: cfg('under') });
      const { view, folder } = viewOver(user.manager, { docs: [] });
      view.setUserVisible(['a_b']);
      await folder.manager.reconcile({ docs: cfg('docs') });

      const input = view.legacyToolNameInput();
      expect(input.retiredResources.user.map((entry) => entry.serverName)).toEqual(['a.b', 'a_b']);
      expect(input.retiredResources.folder.map((entry) => entry.serverName)).toEqual(['docs']);
      const retired = retiredResourceToolNames(input);
      expect(retired.get(createMcpToolName('a_b', 'get_x', () => true))!.map((tool) => tool.uri)).toEqual(['under://x']);
      expect([...retired.values()].flat().map((tool) => tool.uri)).not.toContain('dot://x');
    } finally {
      for (const server of ['a.b', 'a_b', 'docs']) rmSync(cacheFile(server), { force: true });
    }
  });

  it('connects only what it is fed: a server absent from the folder partition never connects', async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared') });
    const b = viewOver(user.manager);
    b.view.setUserVisible(['shared']);
    await b.folder.manager.reconcile({ beta: cfg('beta') });

    expect(b.folder.connected()).toEqual(['beta']);
    expect(user.connected()).toEqual(['shared']);
  });

  it('fires once per user change, also when the change moves a folder prefix', async () => {
    const user = userManager({ a_b: [{ name: 'x' }] });
    await user.manager.reconcile({});
    const { view, folder } = viewOver(user.manager, { 'a-b': [{ name: 'x' }] });
    await folder.manager.reconcile({ 'a-b': cfg('folder-ab') });
    view.setUserVisible(['a_b']);
    const userEmits = vi.fn();
    user.manager.onToolsChanged(userEmits);
    const listener = vi.fn();
    view.onToolsChanged(listener);

    await user.manager.reconcile({ a_b: cfg('user-ab') });

    expect(sortedNames(view)).toEqual(['mcp__a_b__x', expect.stringMatching(/^mcp__a_b__x_[0-9a-f]{8}$/)]);
    expect(userEmits.mock.calls.length).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(userEmits.mock.calls.length);
  });

  it('logs a lasting tool-name conflict once, not on every change', async () => {
    logMock.mockClear();
    const user = userManager({ 'd-p': [{ name: 'x' }], other: [{ name: 'y' }] });
    await user.manager.reconcile({ 'd-p': cfg('user-dp') });
    // No reservation provider: models a folder rename still in flight onto the user tool name.
    const folder = managerWithFake({ 'd.p': [{ name: 'x' }] });
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager));
    view.setUserVisible(['d-p', 'other']);
    await folder.manager.reconcile({ 'd.p': cfg('folder-dp') });
    await user.manager.reconcile({ 'd-p': cfg('user-dp'), other: cfg('other') });

    const conflictLogs = logMock.mock.calls.filter(([message]) => String(message).includes('claimed by both'));
    expect(conflictLogs).toHaveLength(1);
  });

  it('fires onToolsChanged on a userVisible change, and not on an identical one', async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared') });
    const { view, folder } = viewOver(user.manager);
    await folder.manager.reconcile({});
    const listener = vi.fn();
    view.onToolsChanged(listener);

    view.setUserVisible(['shared']);
    view.setUserVisible(['shared']);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(sortedNames(view)).toEqual(['mcp__shared__ping']);
  });
});

describe('FolderMcpView: server actions route to the owning manager', () => {
  async function setup() {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared'), hidden: cfg('hidden') });
    const b = viewOver(user.manager);
    b.view.setUserVisible(['shared']);
    await b.folder.manager.reconcile({ beta: cfg('beta') });
    const spies = {
      userReconnect: vi.spyOn(user.manager, 'reconnectOrAuthenticate'),
      userReauth: vi.spyOn(user.manager, 'reauthenticate'),
      userSignOut: vi.spyOn(user.manager, 'signOut'),
      folderReconnect: vi.spyOn(b.folder.manager, 'reconnectOrAuthenticate'),
    };
    return { user, b, spies };
  }

  it('rejects reconnect, re-auth and sign-out for a user server not visible in the folder', async () => {
    const { user, b, spies } = await setup();
    user.fake.connect.mockClear();

    expect(await b.view.reconnectOrAuthenticate('hidden')).toBe(false);
    expect(await b.view.reauthenticate('hidden')).toBe(false);
    await b.view.signOut('hidden');
    expect(await b.view.reconnectOrAuthenticate('alpha')).toBe(false);

    expect(spies.userReconnect).not.toHaveBeenCalled();
    expect(spies.userReauth).not.toHaveBeenCalled();
    expect(spies.userSignOut).not.toHaveBeenCalled();
    expect(spies.folderReconnect).not.toHaveBeenCalled();
    expect(user.fake.connect).not.toHaveBeenCalled();
  });

  it('sends a folder server to the folder manager and a visible user server to the user manager', async () => {
    const { b, spies } = await setup();

    expect(await b.view.reconnectOrAuthenticate('beta')).toBe(true);
    expect(await b.view.reconnectOrAuthenticate('shared')).toBe(true);

    expect(spies.folderReconnect).toHaveBeenCalledWith('beta');
    expect(spies.userReconnect).toHaveBeenCalledWith('shared');
    expect(spies.userReconnect).toHaveBeenCalledTimes(1);
  });
});

describe('FolderRuntime: one folder manager per folder over the one user manager', () => {
  function folderRuntime(cwd: string, user: McpClientManager, tools: Record<string, McpTool[]>) {
    const pool = fakeServerManager(tools);
    const runtime = new FolderRuntime({
      pi: {} as PiCodingAgentModule,
      cwd,
      agentDir: '/tmp/agent',
      modelRuntime: {} as ModelRuntime,
      planModelIds: () => undefined,
      userMcp: user,
      createFolderMcp: (reservedToolNames) =>
        new McpClientManager({ clientVersion: 'test', serverManagerFactory: pool.factory, reservedToolNames }),
      noticeMemory: { has: () => false, add: async () => {} },
      additionMemory: { has: () => false, add: async () => {} },
      projectDisabledTools: () => null,
      personalDisabledTools: () => ({ rewrite: async () => undefined, lists: () => [] }),
      toolExposureSetting: () => ({}),
      resourceExposureSetting: () => ({}),
      trust: testPlatform.trust,
      fileWatchers: testPlatform.fileWatchers,
    });
    track(runtime);
    return { runtime, pool };
  }

  it('reconcileFolder on B with a changed config reconnects only B', async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared') });
    const a = folderRuntime('/ws/a', user.manager, TOOLS);
    const b = folderRuntime('/ws/b', user.manager, TOOLS);
    await a.runtime.reconcileFolder({ alpha: cfg('alpha') }, ['shared']);
    await b.runtime.reconcileFolder({ beta: cfg('beta') }, ['shared']);
    user.fake.connect.mockClear();
    user.fake.close.mockClear();
    a.pool.fake.connect.mockClear();
    a.pool.fake.close.mockClear();

    await b.runtime.reconcileFolder({ beta: cfg('beta-v2') }, ['shared']);
    await a.runtime.reconcileFolder({ alpha: cfg('alpha') }, ['shared']);

    expect(b.pool.connected()).toEqual(['beta', 'beta']);
    expect(a.pool.fake.connect).not.toHaveBeenCalled();
    expect(a.pool.fake.close).not.toHaveBeenCalled();
    expect(user.fake.connect).not.toHaveBeenCalled();
    expect(user.fake.close).not.toHaveBeenCalled();
    expect(a.runtime.mcp.allToolNames().sort()).toEqual(['mcp__alpha__a_run', 'mcp__shared__ping']);
    expect(b.runtime.mcp.allToolNames().sort()).toEqual(['mcp__beta__b_run', 'mcp__shared__ping']);
  });

  it('an unchanged folder partition does not reconnect anything', async () => {
    const user = userManager();
    await user.manager.reconcile({});
    const a = folderRuntime('/ws/a', user.manager, TOOLS);
    await a.runtime.reconcileFolder({ alpha: cfg('alpha') }, []);
    a.pool.fake.connect.mockClear();

    await a.runtime.reconcileFolder({ alpha: cfg('alpha') }, []);

    expect(a.pool.fake.connect).not.toHaveBeenCalled();
    expect(a.pool.fake.close).not.toHaveBeenCalled();
  });

  it('disposing a folder closes its servers and leaves the user manager connected', async () => {
    const user = userManager();
    await user.manager.reconcile({ shared: cfg('shared') });
    const a = folderRuntime('/ws/a', user.manager, TOOLS);
    await a.runtime.reconcileFolder({ alpha: cfg('alpha') }, ['shared']);

    await a.runtime.dispose();

    expect(a.pool.fake.closeAll.mock.calls.length + a.pool.fake.close.mock.calls.length).toBeGreaterThan(0);
    expect(user.fake.closeAll).not.toHaveBeenCalled();
    expect(user.manager.getServerStatus('shared')?.status).toBe('connected');
  });

  it('a single folder names its tools as one manager holding every server would', async () => {
    const tools: Record<string, McpTool[]> = {
      github: [{ name: 'list_issues' }],
      context7: [{ name: 'query-docs' }],
      playwright: [{ name: 'navigate' }],
      'my-db': [{ name: 'query' }],
    };
    const userServers = { github: cfg('gh'), context7: cfg('c7') };
    const folderServers = { playwright: cfg('pw'), 'my-db': cfg('db') };
    const legacy = userManager(tools);
    await legacy.manager.reconcile({ ...userServers, ...folderServers });

    const user = userManager(tools);
    await user.manager.reconcile(userServers);
    const only = folderRuntime('/ws/only', user.manager, tools);
    await only.runtime.reconcileFolder(folderServers, Object.keys(userServers));

    expect(only.runtime.mcp.allToolNames().sort()).toEqual(legacy.manager.allToolNames().sort());
  });
});

describe('FolderMcpView: per-tool exposure', () => {
  const C7: Record<string, McpTool[]> = {
    context7: [{ name: 'resolve-library-id' }, { name: 'query-docs' }, { name: 'get_docs' }, { name: 'get_page' }],
    local: [{ name: 'run' }],
  };

  /** A view whose exposure context is mutable, read on every call as the folder runtime's is. */
  function exposedView(config: Parameters<typeof specOf>[0], inspection: Record<string, unknown> = {}, trusted = true) {
    const user = userManager(C7);
    const holder: { view?: FolderMcpView } = {};
    const folder = managerWithFake(C7, () => holder.view!.reservedToolNames());
    track(folder.manager);
    const context = { inspection, resourceInspection: {} as Record<string, unknown>, trusted };
    const view = track(new FolderMcpView(user.manager, folder.manager, () => context));
    holder.view = view;
    return { user, folder, view, context, ready: async () => {
      await user.manager.reconcile({ context7: specOf(config) });
      view.setUserVisible(['context7']);
    } };
  }

  const exposureOf = (view: FolderMcpView) =>
    Object.fromEntries(view.getAllToolDescriptors().map((d) => [d.rawToolName, `${d.exposure}/${d.exposureSource}`]));

  it('a config `toolExposure: {"get_*": "direct"}` makes those tools Always loaded, sourced from config', async () => {
    const { view, ready } = exposedView({ command: 'c7', toolExposure: { 'get_*': 'direct' } });
    await ready();
    expect(exposureOf(view)).toEqual({
      'resolve-library-id': 'deferred/config',
      'query-docs': 'deferred/config',
      get_docs: 'direct/config',
      get_page: 'direct/config',
    });
    expect(view.deferrableToolNames().sort()).toEqual(['mcp__context7__query_docs', 'mcp__context7__resolve_library_id']);
    expect(view.offToolNames()).toEqual([]);
    const tools = view.getServerStatuses().find((s) => s.name === 'context7')!.tools!;
    expect(tools.find((t) => t.name === 'get_docs')).toMatchObject({ exposure: 'direct', exposureSource: 'config', configExposure: 'direct' });
  });

  it('turning one context7 tool off leaves the others loadable', async () => {
    const { view, ready } = exposedView({ command: 'c7' }, { userValue: { context7: { 'resolve-library-id': 'off' } } });
    await ready();
    expect(view.offToolNames()).toEqual(['mcp__context7__resolve_library_id']);
    expect(view.deferrableToolNames()).toEqual(expect.arrayContaining(['mcp__context7__query_docs', 'mcp__context7__get_docs']));
    expect(view.deferrableToolNames()).not.toContain('mcp__context7__resolve_library_id');
    // Still listed: the panel shows it, with the scope that turned it off.
    expect(view.getToolDescriptor('mcp__context7__resolve_library_id')).toMatchObject({ exposure: 'off', exposureSource: 'user' });
  });

  it('a project Off overrides a user On in a trusted folder only, and the row names the winning scope', async () => {
    const inspection = {
      userValue: { context7: { 'query-docs': 'deferred', get_docs: 'direct' } },
      projectValue: { context7: { 'query-docs': 'off' } },
    };
    const { view, ready, context } = exposedView({ command: 'c7' }, inspection);
    await ready();
    expect(exposureOf(view)['query-docs']).toBe('off/project');
    expect(exposureOf(view)['get_docs']).toBe('direct/user');
    const row = () => view.getServerStatuses().find((s) => s.name === 'context7')!.tools!.find((t) => t.name === 'query-docs');
    expect(row()).toMatchObject({ exposure: 'off', exposureSource: 'project' });

    context.trusted = false;
    expect(exposureOf(view)['query-docs']).toBe('deferred/user');
    expect(row()).toMatchObject({ exposure: 'deferred', exposureSource: 'user' });
  });

  it('a setting change applies on the next read, with no reconnect', async () => {
    const { user, view, ready, context } = exposedView({ command: 'c7' });
    await ready();
    const connects = user.fake.connect.mock.calls.length;
    context.inspection = { localValue: { context7: { 'query-docs': 'direct' } } };
    expect(exposureOf(view)['query-docs']).toBe('direct/local');
    expect(user.fake.connect.mock.calls.length).toBe(connects);
  });

  it('pendingDirectServers names a connecting server only when it has, or may have, an Always-loaded tool', () => {
    const { user, view, context } = exposedView({ command: 'c7' });
    // Fed but never started: every server is still connecting.
    user.manager.initialize({
      context7: specOf({ command: 'c7' }),
      local: specOf({ command: 'local', toolExposure: { run: 'direct' } }),
    });
    view.setUserVisible(['context7', 'local']);
    expect(view.pendingDirectServers()).toEqual(['local']);

    context.inspection = { userValue: { context7: { 'query-docs': 'direct' } } };
    expect(view.pendingDirectServers().sort()).toEqual(['context7', 'local']);
  });

  it('a connected server is never pending', async () => {
    const { view, ready } = exposedView({ command: 'c7', exposure: 'direct' });
    await ready();
    expect(view.pendingDirectServers()).toEqual([]);
  });
});

describe('FolderMcpView: resource servers', () => {
  const docs = { resources: [{ uri: 'docs://a', name: 'a' }] };

  /** A user manager and a folder manager with resources, behind a view whose resource layers and trust are mutable. */
  async function resourceView(context: { resourceInspection: Record<string, unknown>; trusted: boolean }) {
    const user = managerWithFake({}, undefined, { docs, shared: docs });
    track(user.manager);
    const holder: { view?: FolderMcpView } = {};
    const folder = managerWithFake({}, () => holder.view!.reservedToolNames(), { local: docs, shared: docs });
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager, () => ({ inspection: {}, ...context })));
    holder.view = view;
    await user.manager.reconcile({ docs: cfg('docs'), hidden: cfg('hidden'), shared: cfg('user-shared') });
    await folder.manager.reconcile({ local: cfg('local'), shared: cfg('folder-shared') });
    return { view, user, folder };
  }

  it('lists visible servers with resources; an invisible user server is unknown and a shadowed one routes to the folder', async () => {
    const { view, user, folder } = await resourceView({ resourceInspection: {}, trusted: true });
    view.setUserVisible(['shared']);

    expect(view.resourceServers().map((s) => s.serverName)).toEqual(['local', 'shared']);
    const folderShared = folder.manager.resourceServers().find((s) => s.serverName === 'shared')!;
    expect(view.resourceServers().find((s) => s.serverName === 'shared')!.serverId).toBe(folderShared.serverId);
    await expect(view.readResource('docs', 'docs://a')).rejects.toThrow('MCP server "docs" is not available here. Servers with resources: local, shared.');
    await view.readResource('shared', 'docs://a');
    expect(folder.fake.readResource).toHaveBeenCalledWith('shared', 'docs://a', expect.anything());
    expect(user.fake.readResource).not.toHaveBeenCalled();
  });

  it('applies project and local values only in a trusted folder, and an explicit value overrides an Off default', async () => {
    const context = { resourceInspection: { userValue: { docs: 'direct' }, projectValue: { docs: 'off' }, localValue: { local: 'off' } } as Record<string, unknown>, trusted: false };
    const { view } = await resourceView(context);
    view.setUserVisible(['docs']);

    expect(view.resourceServers().map((s) => [s.serverName, s.exposure])).toEqual([['docs', 'direct'], ['local', 'deferred'], ['shared', 'deferred']]);
    expect(view.getServerStatuses().find((s) => s.name === 'docs')).toMatchObject({ resourceExposure: 'direct', resourceExposureSource: 'user' });

    context.trusted = true;
    expect(view.resourceServers().map((s) => s.serverName)).toEqual(['shared']);
    await expect(view.readResource('docs', 'docs://a')).rejects.toThrow(/resources of MCP server "docs" are turned off/);
  });

  it('the expected server id of a frozen call fails as gone once the name routes to another manager', async () => {
    const { view } = await resourceView({ resourceInspection: {}, trusted: true });
    view.setUserVisible(['docs']);
    const frozen = view.resourceServers().find((s) => s.serverName === 'docs')!;

    await expect(view.readResource('docs', 'docs://a', { expectedServerId: `${frozen.serverId}-other` })).rejects.toThrow('MCP server "docs" is no longer available');
    await expect(view.readResource('docs', 'docs://a', { expectedServerId: frozen.serverId })).resolves.toBeDefined();
  });

  it('routes the MCP panel’s own requests like the agent’s: folder first, then a visible user server, else unknown', async () => {
    const { view, user, folder } = await resourceView({ resourceInspection: {}, trusted: true });
    view.setUserVisible(['docs', 'shared']);
    const port = view.userResources();

    await port.listResourcesPage('shared', undefined);
    expect(folder.fake.listResourcesPage).toHaveBeenCalledWith('shared', undefined, expect.anything());
    await port.readResource('docs', 'docs://a');
    expect(user.fake.readResource).toHaveBeenCalledWith('docs', 'docs://a', expect.anything());
    await expect(port.readResource('hidden', 'docs://a')).rejects.toThrow('MCP server "hidden" is not available here.');
    await expect(port.listResourceTemplatesPage('nope', undefined)).rejects.toThrow('MCP server "nope" is not available here.');
  });

  it('the panel’s port names the identity a server routes to, which a folder server of the same name replaces', async () => {
    const { view, user, folder } = await resourceView({ resourceInspection: {}, trusted: true });
    view.setUserVisible(['docs', 'shared']);
    const port = view.userResources();
    const attachedFrom = port.serverIdOf('docs')!;

    expect(attachedFrom).toBe(user.manager.resourceServers().find((s) => s.serverName === 'docs')!.serverId);
    expect(port.serverIdOf('shared')).toBe(folder.manager.resourceServers().find((s) => s.serverName === 'shared')!.serverId);
    expect(port.serverIdOf('hidden')).toBeUndefined();
    await folder.manager.reconcile({ local: cfg('local'), shared: cfg('folder-shared'), docs: cfg('folder-docs') });
    expect(port.serverIdOf('docs')).not.toBe(attachedFrom);
    await expect(port.readResource('docs', 'docs://a', { expectedServerId: attachedFrom })).rejects.toThrow('MCP server "docs" is no longer available');
  });

  it('the panel’s requests ignore an Off resource exposure while the agent’s port still refuses it', async () => {
    const context = { resourceInspection: { userValue: { docs: 'off', local: 'off' } } as Record<string, unknown>, trusted: true };
    const { view, folder } = await resourceView(context);
    view.setUserVisible(['docs']);
    const port = view.userResources();

    await expect(view.readResource('docs', 'docs://a')).rejects.toThrow(/resources of MCP server "docs" are turned off/);
    await expect(view.listResourcesPage('local', undefined)).rejects.toThrow(/resources of MCP server "local" are turned off/);
    await expect(port.readResource('docs', 'docs://a')).resolves.toBeDefined();
    await expect(port.listResourcesPage('local', undefined)).resolves.toMatchObject({ resources: [{ uri: 'docs://a' }] });
    expect(folder.fake.listResourcesPage).toHaveBeenCalledTimes(1);
  });

  it('a server without resources names the servers this folder reaches, never a hidden user server or an Off one', async () => {
    const user = managerWithFake({ git: [{ name: 'status' }] }, undefined, { docs, hidden: docs });
    track(user.manager);
    const holder: { view?: FolderMcpView } = {};
    const folder = managerWithFake({}, () => holder.view!.reservedToolNames(), { local: docs });
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager, () => ({ inspection: {}, resourceInspection: { userValue: { docs: 'off' } }, trusted: true })));
    holder.view = view;
    await user.manager.reconcile({ docs: cfg('docs'), hidden: cfg('hidden'), git: cfg('git') });
    await folder.manager.reconcile({ local: cfg('local') });
    view.setUserVisible(['docs', 'git']);

    const named = 'MCP server "git" offers no resources. Servers with resources: local.';
    await expect(view.readResource('git', 'x://a')).rejects.toThrow(named);
    await expect(view.listResources('git')).rejects.toThrow(named);
    await expect(view.userResources().readResource('git', 'x://a')).rejects.toThrow(named);
  });

  it('the panel’s requests still refuse a server without resources, and complete only through the server’s answer', async () => {
    const user = managerWithFake({ git: [{ name: 'status' }] }, undefined, { docs: { completions: { id: ['alpha', 'beta'] } } });
    track(user.manager);
    const folder = managerWithFake({});
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager, () => ({ inspection: {}, resourceInspection: { userValue: { docs: 'off' } }, trusted: true })));
    await user.manager.reconcile({ docs: specOf({ command: 'docs', exposeResources: false }), git: cfg('git') });
    view.setUserVisible(['docs', 'git']);
    const port = view.userResources();

    await expect(port.readResource('git', 'x://a')).rejects.toThrow('MCP server "git" offers no resources.');
    await expect(port.completeResourceArgument('git', 'x://{id}', 'id', 'a', {})).rejects.toThrow('MCP server "git" offers no resources.');
    await expect(port.completeResourceArgument('docs', 'docs://{id}', 'id', 'a', { other: 'x' })).resolves.toEqual(['alpha']);
    expect(user.fake.completeResourceArgument).toHaveBeenCalledWith('docs', { uri: 'docs://{id}', argument: 'id', value: 'a', context: { other: 'x' } }, expect.anything());
  });
});
