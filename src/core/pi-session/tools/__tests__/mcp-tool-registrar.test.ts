import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ExtensionAPI, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpToolSource } from '../../mcp/tool-source';
import type { McpToolDescriptor } from '../../mcp/types';
import { managerWithFake, specOf } from '../../mcp/__tests__/fake-server-manager';
import { McpToolRegistrar } from '../mcp-tools';
import { NO_RESOURCE_READ, type ResourceReadReach } from '../../mcp/content';
import type { PanelGateContext } from '../../permission-gate';
import { FolderRuntime } from '../../folder-runtime';
import { createDamoclesExtensionFactory } from '../../damocles-extension';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { log } from '../../../logger';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

const STALE = 'This extension ctx is stale after session replacement or reload.';

const NO_REACH = () => async () => NO_RESOURCE_READ;

/**
 * An extension instance as pi builds one: `registerTool` throws once pi has invalidated it, which
 * `AgentSession.dispose()` does to the instance its session was bound to.
 */
function fakeInstance() {
  const names: string[] = [];
  let stale = false;
  const registerTool = vi.fn((tool: { name: string }) => {
    if (stale) throw new Error(STALE);
    names.push(tool.name);
  });
  const api = { registerTool, on: () => () => undefined, getAllTools: () => [] } as unknown as ExtensionAPI;
  return { api, registerTool, names: () => [...names], invalidate: () => { stale = true; } };
}

function descriptor(piName: string): McpToolDescriptor {
  return {
    piName,
    serverName: 'srv',
    serverId: 'test/srv',
    rawToolName: piName,
    description: piName,
    inputSchema: { type: 'object', properties: {} },
    readOnly: false,
    exposure: 'deferred',
    exposureSource: 'config',
    configExposure: 'deferred',
  };
}

function mutableSource(initial: string[]) {
  let names = [...initial];
  const source = {
    getAllToolDescriptors: () => names.map(descriptor),
    getToolDescriptor: (piName: string) => (names.includes(piName) ? descriptor(piName) : undefined),
  } as unknown as McpToolSource;
  return { source, set: (next: string[]) => { names = [...next]; } };
}

describe('McpToolRegistrar', () => {
  afterEach(() => vi.mocked(log).mockClear());

  it('registers the current tools on attach', () => {
    const { source } = mutableSource(['mcp__srv__a', 'mcp__srv__b']);
    const registrar = new McpToolRegistrar(piStub, source, NO_REACH);
    const instance = fakeInstance();

    registrar.attach(instance.api);

    expect(instance.names()).toEqual(['mcp__srv__a', 'mcp__srv__b']);
  });

  it('tops up EVERY attached instance, not only the newest', () => {
    // Each panel on a folder binds its own instance. Topping up only the last one minted left every
    // earlier panel without a server that connected after it opened.
    const tools = mutableSource(['mcp__srv__a']);
    const registrar = new McpToolRegistrar(piStub, tools.source, NO_REACH);
    const older = fakeInstance();
    const newer = fakeInstance();
    registrar.attach(older.api);
    registrar.attach(newer.api);

    tools.set(['mcp__srv__a', 'mcp__srv__b']);
    registrar.syncRegistration();

    expect(older.names()).toEqual(['mcp__srv__a', 'mcp__srv__b']);
    expect(newer.names()).toEqual(['mcp__srv__a', 'mcp__srv__b']);
  });

  it('never touches a detached instance, so its invalidation cannot surface as a stale-ctx error', () => {
    // The shipped failure: the registrar kept the newest instance after its session was disposed, and
    // the next MCP connect threw "extension ctx is stale" once per tool.
    const tools = mutableSource([]);
    const registrar = new McpToolRegistrar(piStub, tools.source, NO_REACH);
    const live = fakeInstance();
    const disposed = fakeInstance();
    registrar.attach(live.api);
    const detach = registrar.attach(disposed.api);

    detach();
    disposed.invalidate();
    tools.set(['mcp__blender__render', 'mcp__context7__query_docs']);
    registrar.syncRegistration();

    expect(live.names()).toEqual(['mcp__blender__render', 'mcp__context7__query_docs']);
    expect(disposed.registerTool).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a stale detach does not evict the same instance attached again', () => {
    const { source } = mutableSource([]);
    const registrar = new McpToolRegistrar(piStub, source, NO_REACH);
    const instance = fakeInstance();
    const firstDetach = registrar.attach(instance.api);
    registrar.attach(instance.api);

    firstDetach();

    expect((registrar as unknown as { instances: Map<unknown, unknown> }).instances.has(instance.api)).toBe(true);
  });

  it('a tool pi rejects does not keep the other tools out, and is retried on the next sync', () => {
    const tools = mutableSource(['mcp__srv__bad', 'mcp__srv__good']);
    const registrar = new McpToolRegistrar(piStub, tools.source, NO_REACH);
    const instance = fakeInstance();
    instance.registerTool.mockImplementationOnce(() => { throw new Error('must define an object parameter schema'); });

    registrar.attach(instance.api);
    expect(instance.names()).toEqual(['mcp__srv__good']);

    registrar.syncRegistration();
    expect(instance.names()).toEqual(['mcp__srv__good', 'mcp__srv__bad']);
  });
});

/**
 * The logged sequence end to end: two sessions on one folder, the newer one disposed, then a folder MCP
 * server connects. Drives the real extension factory and `FolderRuntime`, so a mismatch at the join
 * (detaching something other than what was attached) fails here even when both halves pass alone.
 */
describe('MCP registration across extension instances (real FolderRuntime)', () => {
  let folder: FolderRuntime | null = null;
  afterEach(async () => {
    await folder?.dispose();
    folder = null;
  });

  it('a server connecting after the newest session shut down reaches the live one and nothing else', async () => {
    const platform = createFakePlatform();
    const runtime = new FolderRuntime({
      pi: piStub,
      cwd: '/tmp/ws',
      agentDir: '/tmp/agent',
      modelRuntime: {} as ModelRuntime,
      planModelIds: () => undefined,
      userMcp: managerWithFake({}).manager,
      createFolderMcp: (reservedToolNames) => managerWithFake({ blender: [{ name: 'render' }] }, reservedToolNames).manager,
      noticeMemory: { has: () => false, add: async () => {} },
      additionMemory: { has: () => false, add: async () => {} },
      projectDisabledTools: () => null,
      personalDisabledTools: () => ({ rewrite: async () => undefined, lists: () => [] }),
      toolExposureSetting: () => ({}),
      resourceExposureSetting: () => ({}),
      trust: platform.trust,
      fileWatchers: platform.fileWatchers,
    });
    folder = runtime;
    const instanceWithEvents = () => {
      const instance = fakeInstance();
      const own = new Map<string, Array<(...args: unknown[]) => unknown>>();
      Object.assign(instance.api, {
        on: (event: string, handler: (...args: unknown[]) => unknown) => {
          own.set(event, [...(own.get(event) ?? []), handler]);
          return () => undefined;
        },
      });
      const shutdown = async () => {
        for (const handler of own.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'quit' });
      };
      return { ...instance, shutdown };
    };
    const factory = createDamoclesExtensionFactory(
      { get: () => undefined, values: () => [] },
      { get: () => undefined },
      undefined,
      (api, republish) => runtime.attachExtensionInstance(api, republish),
    );
    const live = instanceWithEvents();
    const disposed = instanceWithEvents();
    factory(live.api);
    factory(disposed.api);

    // pi emits `session_shutdown`, then `AgentSession.dispose()` invalidates the instance.
    await disposed.shutdown();
    disposed.invalidate();
    disposed.registerTool.mockClear();

    await runtime.reconcileFolder({ blender: specOf({ command: 'blender' }, { folderScoped: true }) }, []);

    expect(live.names()).toContain('mcp__blender__render');
    expect(disposed.registerTool).not.toHaveBeenCalled();
    expect(vi.mocked(log).mock.calls.filter(([message]) => String(message).includes('[McpToolRegistrar]'))).toEqual([]);
  });

  it("a resource link's read hint is the calling panel's own, and a session with no panel gets none", async () => {
    const platform = createFakePlatform();
    const pool = managerWithFake({ docs: [{ name: 'search' }] }, undefined, { docs: { resources: [] } });
    pool.fake.callTool.mockResolvedValue({ content: [{ type: 'resource_link', uri: 'docs://a', name: 'a' }], isError: false } as never);
    const runtime = new FolderRuntime({
      pi: piStub,
      cwd: '/tmp/ws',
      agentDir: '/tmp/agent',
      modelRuntime: {} as ModelRuntime,
      planModelIds: () => undefined,
      userMcp: managerWithFake({}).manager,
      createFolderMcp: () => pool.manager,
      noticeMemory: { has: () => false, add: async () => {} },
      additionMemory: { has: () => false, add: async () => {} },
      projectDisabledTools: () => null,
      personalDisabledTools: () => ({ rewrite: async () => undefined, lists: () => [] }),
      toolExposureSetting: () => ({}),
      resourceExposureSetting: () => ({}),
      trust: platform.trust,
      fileWatchers: platform.fileWatchers,
    });
    folder = runtime;
    const instance = fakeInstance();
    const registered: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> }> = [];
    instance.registerTool.mockImplementation((tool: { name: string }) => { registered.push(tool as (typeof registered)[number]); });
    runtime.attachExtensionInstance(instance.api, () => undefined);
    await runtime.reconcileFolder({ docs: specOf({ command: 'docs' }, { folderScoped: true }) }, []);
    const panel = (reach: ResourceReadReach) => ({ mcpResourceReach: async () => reach }) as unknown as PanelGateContext;
    runtime.registerPanel('loaded', panel({ readTool: 'direct', unreadable: () => false }));
    runtime.registerPanel('deferred', panel({ readTool: 'deferred', unreadable: () => false }));
    runtime.registerPanel('disabled', panel({ readTool: null, unreadable: () => false }));
    const search = registered.find((tool) => tool.name === 'mcp__docs__search')!;
    const linkFrom = async (sessionId: string) =>
      (await search.execute('tc', {}, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } })).content[0]!.text;

    expect(await linkFrom('loaded')).toBe('[Resource docs://a "a". Read it with read_mcp_resource (server "docs")]');
    expect(await linkFrom('deferred')).toBe('[Resource docs://a "a". Read it with read_mcp_resource (server "docs"), after loading it with ToolSearch({tools:["mcp_resources"]})]');
    expect(await linkFrom('disabled')).toBe('[Resource docs://a "a"]');
    expect(await linkFrom('no-panel')).toBe('[Resource docs://a "a"]');

    // Only a result holding a resource link asks the panel.
    const reach = vi.fn(async () => ({ readTool: 'direct' as const, unreadable: () => false }));
    runtime.registerPanel('counted', { mcpResourceReach: reach } as unknown as PanelGateContext);
    pool.fake.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'plain' }], isError: false } as never);
    expect(await linkFrom('counted')).toBe('plain');
    expect(reach).not.toHaveBeenCalled();
    expect(await linkFrom('counted')).toBe('[Resource docs://a "a". Read it with read_mcp_resource (server "docs")]');
    expect(reach).toHaveBeenCalledWith('docs');
  });
});
