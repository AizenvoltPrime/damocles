import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { FolderMcpView } from '../folder-mcp-view';
import { McpClientManager } from '../mcp-client-manager';
import { FolderRuntime } from '../../folder-runtime';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpServerConfig } from '../../../../shared/types/mcp';
import type { McpTool } from '../types';
import { fakeServerManager, managerWithFake } from './fake-server-manager';

const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../../logger', () => ({ log: logMock }));

const TOOLS: Record<string, McpTool[]> = {
  alpha: [{ name: 'a_run' }],
  beta: [{ name: 'b_run' }],
  shared: [{ name: 'ping', annotations: { readOnlyHint: true } }],
  hidden: [{ name: 'secret' }],
};

const cfg = (command: string): McpServerConfig => ({ command });

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
  const folder = managerWithFake(folderTools, () => holder.view!.reservedPrefixes());
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

  it('a folder server colliding with a visible user prefix is renamed, the user tool keeps its name', async () => {
    const user = userManager({ 'a-b': [{ name: 'x' }] });
    await user.manager.reconcile({ 'a-b': cfg('user-ab') });
    const { view, folder } = viewOver(user.manager, { 'a.b': [{ name: 'x' }] });
    view.setUserVisible(['a-b']);
    await folder.manager.reconcile({ 'a.b': cfg('folder-ab') });

    expect(sortedNames(view)).toEqual(['mcp__a_b_2__x', 'mcp__a_b__x']);
    await view.callTool('mcp__a_b__x', {});
    expect(user.fake.callTool).toHaveBeenCalledTimes(1);
    expect(folder.fake.callTool).not.toHaveBeenCalled();
  });

  it('a user server that appears later takes its prefix back from the folder server', async () => {
    const user = userManager({ a_b: [{ name: 'x' }] });
    await user.manager.reconcile({});
    const { view, folder } = viewOver(user.manager, { 'a-b': [{ name: 'x' }] });
    await folder.manager.reconcile({ 'a-b': cfg('folder-ab') });
    expect(sortedNames(view)).toEqual(['mcp__a_b__x']);

    view.setUserVisible(['a_b']);
    await user.manager.reconcile({ a_b: cfg('user-ab') });

    expect(sortedNames(view)).toEqual(['mcp__a_b_2__x', 'mcp__a_b__x']);
    await view.callTool('mcp__a_b__x', {});
    expect(user.fake.callTool).toHaveBeenCalledTimes(1);
    expect(folder.fake.callTool).not.toHaveBeenCalled();
  });

  it('refuses a tool name both managers claim instead of picking one', async () => {
    const user = userManager({ dup: [{ name: 'x' }] });
    await user.manager.reconcile({ dup: cfg('user-dup') });
    // No reservation provider: models a folder rename still in flight onto the user prefix.
    const folder = managerWithFake({ 'dup-': [{ name: 'x' }] });
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager));
    view.setUserVisible(['dup']);
    await folder.manager.reconcile({ 'dup-': cfg('folder-dup') });

    expect(folder.manager.allToolNames()).toEqual(['mcp__dup__x']);
    expect(view.allToolNames()).toEqual([]);
    expect(view.getToolDescriptor('mcp__dup__x')).toBeUndefined();
    await expect(view.callTool('mcp__dup__x', {})).rejects.toThrow('Unknown MCP tool');
    expect(user.fake.callTool).not.toHaveBeenCalled();
    expect(folder.fake.callTool).not.toHaveBeenCalled();
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

    expect(sortedNames(view)).toEqual(['mcp__a_b_2__x', 'mcp__a_b__x']);
    expect(userEmits.mock.calls.length).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(userEmits.mock.calls.length);
  });

  it('logs a lasting tool-name conflict once, not on every change', async () => {
    logMock.mockClear();
    const user = userManager({ dup: [{ name: 'x' }], other: [{ name: 'y' }] });
    await user.manager.reconcile({ dup: cfg('user-dup') });
    // No reservation provider: models a folder rename still in flight onto the user prefix.
    const folder = managerWithFake({ 'dup-': [{ name: 'x' }] });
    track(folder.manager);
    const view = track(new FolderMcpView(user.manager, folder.manager));
    view.setUserVisible(['dup', 'other']);
    await folder.manager.reconcile({ 'dup-': cfg('folder-dup') });
    await user.manager.reconcile({ dup: cfg('user-dup'), other: cfg('other') });

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
      userMcp: user,
      createFolderMcp: (reservedPrefixes) => new McpClientManager({ serverManagerFactory: pool.factory, reservedPrefixes }),
      renameSession: async () => undefined,
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
