import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpResourceTools } from '../mcp-resource-tools';
import { managerWithFake, specOf, type FakeResources } from '../../mcp/__tests__/fake-server-manager';
import type { McpClientManager } from '../../mcp/mcp-client-manager';
import type { McpResourceServer } from '../../mcp/tool-source';
import { disabledResourceMatcher, type McpResourceRuleFilter } from '../../../permission-handler/mcp-resource-rule';
import { removeSavedMcpOutputs } from '../../mcp/content';
import { MCP_RESOURCE_TOOL_NAMES } from '../../../../shared/tool-names';
import { MAX_IMAGE_BASE64_LENGTH } from '../../../../shared/types/content';
import { base64Of, IMAGE_BYTES } from '../../../../shared/__tests__/image-bytes';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

const PI_RESOURCES = path.resolve(__dirname, '../../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/resources.js');

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: { server: string; tool: string; fullOutputPath?: string } };
type Execute = (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<Result>;

const NO_RULES: McpResourceRuleFilter = { serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false };

const DOCS: FakeResources = {
  pageSize: 2,
  resources: [
    { uri: 'docs://a', name: 'a', _meta: { secret: 1 }, icons: [{ src: 'x' }] } as never,
    { uri: 'ui://panel', name: 'panel' },
    { uri: 'docs://b', name: 'b', server: 'other' } as never,
    { uri: 'docs://app', name: 'app', mimeType: 'text/html;profile=mcp-app' },
  ],
  templates: [{ uriTemplate: 'docs://{id}', name: 'doc' }, { uriTemplate: 'ui://{x}', name: 'ui' }],
  contents: {
    'docs://text': [{ uri: 'docs://text', text: 'hello' }],
    'docs://image': [{ uri: 'docs://image', mimeType: 'image/png', blob: base64Of(IMAGE_BYTES.png) }],
    'docs://bin': [{ uri: 'docs://bin', mimeType: 'application/pdf', blob: Buffer.from([0, 1, 2, 3]).toString('base64') }],
    'docs://json': [{ uri: 'docs://json', mimeType: 'application/json', blob: Buffer.from('{"k":1}').toString('base64') }],
    'docs://dir': [
      { uri: 'docs://dir/one', text: 'one' },
      { uri: 'docs://dir/secret', text: 'TOP SECRET' },
    ],
  },
};

const managers: McpClientManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  await removeSavedMcpOutputs();
});

async function liveManager(resources: Record<string, FakeResources> = { docs: DOCS, wiki: { resources: [{ uri: 'wiki://home', name: 'home' }] } }) {
  const pool = managerWithFake({ git: [{ name: 'status' }] }, undefined, resources);
  managers.push(pool.manager);
  await pool.manager.reconcile(Object.fromEntries([...Object.keys(resources), 'git'].map((name) => [name, specOf({ command: name })])));
  return pool;
}

function toolsOver(manager: McpClientManager, filter: McpResourceRuleFilter = NO_RULES, frozenServers?: McpResourceServer[], disabledEntries: string[] = []) {
  const ruleFilter = vi.fn(async () => filter);
  const tools = createMcpResourceTools({
    source: () => manager,
    ruleFilter,
    disabledResource: () => disabledResourceMatcher(disabledEntries),
    ...(frozenServers ? { frozenServers } : {}),
  });
  const run = (name: string, params: unknown, ctx: unknown = {}): Promise<Result> =>
    (tools.find((t) => t.name === name)!.execute as unknown as Execute)('tc-1', params, undefined, undefined, ctx);
  return { tools, run, ruleFilter };
}

const json = (result: Result): Record<string, unknown> => JSON.parse(result.content[0]!.text!) as Record<string, unknown>;

describe('MCP resource tools: parity with pi 1.3.0', () => {
  it('declares pi\u2019s names, descriptions and parameter schemas', async () => {
    const pi = (await import(pathToFileURL(PI_RESOURCES).href)) as {
      createMcpResourceToolDefinitions: (options: { servers: () => never[]; exposure: string }) => Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    };
    const theirs = pi.createMcpResourceToolDefinitions({ servers: () => [], exposure: 'deferred' });
    const ours = createMcpResourceTools({ source: () => null, disabledResource: () => () => false, ruleFilter: async () => NO_RULES });

    expect(ours.map((t) => t.name)).toEqual([...MCP_RESOURCE_TOOL_NAMES]);
    expect(theirs.map((t) => t.name)).toEqual(ours.map((t) => t.name));
    for (const [index, tool] of ours.entries()) {
      const pis = theirs[index]!;
      expect(tool.description, tool.name).toBe(pis.description);
      const schema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
      expect(schema['properties'], tool.name).toEqual(pis.parameters['properties']);
      expect(schema['required'], tool.name).toEqual(pis.parameters['required']);
      expect(schema['additionalProperties'], tool.name).toBe(false);
    }
  });
});

describe('list_mcp_resources and list_mcp_resource_templates', () => {
  it('with a server lists one page plus its cursor, leaving out MCP Apps, icons and _meta, and keeping the server tag', async () => {
    const { manager } = await liveManager();
    const { run } = toolsOver(manager);

    const first = json(await run('list_mcp_resources', { server: 'docs' }));
    expect(first).toEqual({ server: 'docs', resources: [{ server: 'docs', uri: 'docs://a', name: 'a' }], nextCursor: '2' });

    const second = json(await run('list_mcp_resources', { server: 'docs', cursor: '2' }));
    expect(second).toEqual({ server: 'docs', resources: [{ server: 'docs', uri: 'docs://b', name: 'b' }] });
  });

  it('without a server lists every page of every server with resources, sorted by server', async () => {
    const { manager } = await liveManager();
    const { run } = toolsOver(manager);

    const all = json(await run('list_mcp_resources', {}));
    expect(all).toEqual({
      resources: [
        { server: 'docs', uri: 'docs://a', name: 'a' },
        { server: 'docs', uri: 'docs://b', name: 'b' },
        { server: 'wiki', uri: 'wiki://home', name: 'home' },
      ],
    });
  });

  it('reports a server that fails a cross-server list under errors and lists the rest', async () => {
    const { manager, fake } = await liveManager();
    fake.listResources.mockImplementation(async (name: string) => {
      if (name === 'wiki') throw new Error('wiki is down');
      return [...(DOCS.resources ?? [])];
    });
    const { run } = toolsOver(manager);

    const all = json(await run('list_mcp_resources', {}));
    expect(all['errors']).toEqual([{ server: 'wiki', error: 'wiki is down' }]);
    expect((all['resources'] as unknown[]).length).toBe(2);
  });

  it('refuses a cursor without a server', async () => {
    const { manager } = await liveManager();
    await expect(toolsOver(manager).run('list_mcp_resources', { cursor: '2' })).rejects.toThrow('cursor can only be used when a server is specified');
  });

  it('leaves out a server the rules cover and a resource a deny covers, and names what it left out', async () => {
    const { manager } = await liveManager();
    const filter: McpResourceRuleFilter = {
      ...NO_RULES,
      serverCovered: (server) => server === 'wiki',
      resourceDenied: (server, uri) => server === 'docs' && uri === 'docs://b',
    };
    const { run, ruleFilter } = toolsOver(manager, filter);

    const result = await run('list_mcp_resources', {});
    expect(json(result)).toEqual({ resources: [{ server: 'docs', uri: 'docs://a', name: 'a' }] });
    expect(result.content[1]!.text).toBe('[Left out because the user\'s permission settings cover them: MCP server wiki; 1 resource of server docs]');
    expect(ruleFilter).toHaveBeenCalledWith('list_mcp_resources');

    const named = await run('list_mcp_resources', { server: 'docs', cursor: '2' });
    expect(json(named)['resources']).toEqual([]);
    expect(named.content[1]!.text).toContain('1 resource of server docs');
  });

  it('lists templates by page or across servers, filtered by server only', async () => {
    const { manager } = await liveManager();
    const filter: McpResourceRuleFilter = { ...NO_RULES, resourceDenied: () => true };
    const { run, ruleFilter } = toolsOver(manager, filter);

    expect(json(await run('list_mcp_resource_templates', { server: 'docs' }))).toEqual({
      server: 'docs',
      resourceTemplates: [{ server: 'docs', uriTemplate: 'docs://{id}', name: 'doc' }],
    });
    expect(json(await run('list_mcp_resource_templates', {}))).toEqual({ resourceTemplates: [{ server: 'docs', uriTemplate: 'docs://{id}', name: 'doc' }] });
    expect(ruleFilter).toHaveBeenCalledWith('list_mcp_resource_templates');
  });
});

describe('read_mcp_resource', () => {
  it('returns text as text and an image as an image block', async () => {
    const { manager } = await liveManager();
    const { run } = toolsOver(manager);

    expect((await run('read_mcp_resource', { server: 'docs', uri: 'docs://text' })).content).toEqual([{ type: 'text', text: 'hello' }]);
    expect((await run('read_mcp_resource', { server: 'docs', uri: 'docs://json' })).content).toEqual([{ type: 'text', text: '{"k":1}' }]);
    const image = await run('read_mcp_resource', { server: 'docs', uri: 'docs://image' });
    expect(image.content).toEqual([{ type: 'image', data: base64Of(IMAGE_BYTES.png), mimeType: 'image/png' }]);
    expect(image.details).toEqual({ server: 'docs', tool: 'read_mcp_resource' });
  });

  it('sends an image as the type its bytes carry, svg as text, and any image the providers do not take as a saved file', async () => {
    const oversized = new Uint8Array((MAX_IMAGE_BASE64_LENGTH / 4) * 3 + 3);
    oversized.set(IMAGE_BYTES.png);
    const blobs: Record<string, { mimeType: string; blob: string }> = {
      'docs://jpeg-as-png': { mimeType: 'image/png', blob: base64Of(IMAGE_BYTES.jpeg) },
      'docs://jpg': { mimeType: 'image/jpg', blob: base64Of(IMAGE_BYTES.jpeg) },
      'docs://svg': { mimeType: 'image/svg+xml', blob: base64Of(IMAGE_BYTES.svg) },
      'docs://tiff': { mimeType: 'image/tiff', blob: base64Of(IMAGE_BYTES.tiff) },
      'docs://tiff-as-png': { mimeType: 'image/png', blob: base64Of(IMAGE_BYTES.tiff) },
      'docs://huge': { mimeType: 'image/png', blob: base64Of(oversized) },
      'docs://garbled': { mimeType: 'image/png', blob: 'not base64!' },
    };
    const contents = Object.fromEntries(Object.entries(blobs).map(([uri, blob]) => [uri, [{ uri, ...blob }]]));
    const { manager } = await liveManager({ docs: { ...DOCS, contents: { ...DOCS.contents, ...contents } } });
    const read = async (uri: string) => (await toolsOver(manager).run('read_mcp_resource', { server: 'docs', uri })).content;

    expect(await read('docs://jpeg-as-png')).toEqual([{ type: 'image', data: base64Of(IMAGE_BYTES.jpeg), mimeType: 'image/jpeg' }]);
    expect(await read('docs://jpg')).toEqual([{ type: 'image', data: base64Of(IMAGE_BYTES.jpeg), mimeType: 'image/jpeg' }]);
    expect(await read('docs://svg')).toEqual([{ type: 'text', text: Buffer.from(IMAGE_BYTES.svg).toString('utf8') }]);
    for (const uri of ['docs://tiff', 'docs://tiff-as-png', 'docs://huge', 'docs://garbled']) {
      const content = await read(uri);
      expect(content, uri).toHaveLength(1);
      expect(content[0]!.type, uri).toBe('text');
      expect(content[0]!.text, uri).toMatch(new RegExp(String.raw`^\[Binary resource ${uri} \(image/(png|tiff), [^)]+\) saved to .+damocles-mcp-[0-9a-f]{16}\.bin\]$`));
    }
  });

  it('saves other binary content to an owner-only temp file whose name holds nothing from the server, removed at shutdown', async () => {
    const { manager } = await liveManager();
    const result = await toolsOver(manager).run('read_mcp_resource', { server: 'docs', uri: 'docs://bin' });

    const text = result.content[0]!.text!;
    const match = /^\[Binary resource docs:\/\/bin \(application\/pdf, 4B\) saved to (.+)\]$/.exec(text);
    expect(match).not.toBeNull();
    const file = match![1]!;
    expect(path.basename(file)).toMatch(/^damocles-mcp-[0-9a-f]{16}\.bin$/);
    expect(readFileSync(file)).toEqual(Buffer.from([0, 1, 2, 3]));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    await removeSavedMcpOutputs();
    expect(existsSync(file)).toBe(false);
  });

  it('labels each content of a read that returns several with its URI', async () => {
    const { manager } = await liveManager();
    const result = await toolsOver(manager).run('read_mcp_resource', { server: 'docs', uri: 'docs://dir' });
    expect(result.content.map((block) => block.text)).toEqual(['docs://dir/one:', 'one', 'docs://dir/secret:', 'TOP SECRET']);
  });

  it('leaves out a content whose URI a deny covers, as a directory read returns, and says so', async () => {
    const { manager } = await liveManager();
    const denied = (_server: string, uri: string): boolean => uri === 'docs://dir/secret';
    const filter: McpResourceRuleFilter = { ...NO_RULES, resourceDenied: denied, resourceDenyRule: (server, uri) => (denied(server, uri) ? 'mcp__docs' : undefined), contentCovered: denied };
    const { run, ruleFilter } = toolsOver(manager, filter);

    const result = await run('read_mcp_resource', { server: 'docs', uri: 'docs://dir' });
    const text = result.content.map((block) => block.text).join('\n');
    expect(text).not.toContain('TOP SECRET');
    expect(text).toContain('one');
    expect(text).toContain('[Left out because the user\'s permission settings cover them: 1 content of server docs]');
    expect(ruleFilter).toHaveBeenCalledWith('read_mcp_resource');
  });

  it('leaves out a content an ask rule covers that the read itself was not asked under, and counts it', async () => {
    const { manager } = await liveManager();
    const contentCovered = vi.fn((_server: string, uri: string, readUri: string) => uri === 'docs://dir/secret' && readUri === 'docs://dir');
    const { run } = toolsOver(manager, { ...NO_RULES, contentCovered });

    const text = (await run('read_mcp_resource', { server: 'docs', uri: 'docs://dir' })).content.map((block) => block.text).join('\n');
    expect(text).not.toContain('TOP SECRET');
    expect(text).toContain('one');
    expect(text).toContain('[Left out because the user\'s permission settings cover them: 1 content of server docs]');
    expect(contentCovered).toHaveBeenCalledWith('docs', 'docs://dir/secret', 'docs://dir');
  });

  describe('a resource the tool lists turn off with a URI-scoped entry', () => {
    const OFF = ['mcp__docs__read_mcp_resource(docs://b)', 'mcp__docs__read_mcp_resource(docs://dir/secret)'];

    it('is left out of lists and directory reads with no notice, while templates are untouched', async () => {
      const { manager } = await liveManager();
      const { run } = toolsOver(manager, NO_RULES, undefined, OFF);

      const listed = await run('list_mcp_resources', {});
      expect(json(listed)).toEqual({ resources: [{ server: 'docs', uri: 'docs://a', name: 'a' }, { server: 'wiki', uri: 'wiki://home', name: 'home' }] });
      expect(listed.content).toHaveLength(1);
      expect(json(await run('list_mcp_resources', { server: 'docs', cursor: '2' }))['resources']).toEqual([]);
      expect(json(await run('list_mcp_resource_templates', { server: 'docs' }))['resourceTemplates']).toEqual([{ server: 'docs', uriTemplate: 'docs://{id}', name: 'doc' }]);
      const directory = await run('read_mcp_resource', { server: 'docs', uri: 'docs://dir' });
      expect(directory.content.map((block) => block.text)).toEqual(['one']);
    });

    it('cannot be read, and the read fails before any request reaches the server', async () => {
      const { manager, fake } = await liveManager();
      const { run } = toolsOver(manager, NO_RULES, undefined, OFF);
      fake.readResource.mockClear();

      await expect(run('read_mcp_resource', { server: 'docs', uri: 'docs://b' })).rejects.toThrow('Resource "docs://b" of MCP server "docs" is turned off for this agent in the user\'s settings.');
      expect(fake.readResource).not.toHaveBeenCalled();
      await expect(run('read_mcp_resource', { server: 'docs', uri: 'docs://text' })).resolves.toBeDefined();
    });

    it('is read per call, so a change to the list applies to the next call', async () => {
      const { manager } = await liveManager();
      const entries: string[] = [];
      const tools = createMcpResourceTools({ source: () => manager, ruleFilter: async () => NO_RULES, disabledResource: () => disabledResourceMatcher(entries) });
      const read = (uri: string) => (tools.find((t) => t.name === 'read_mcp_resource')!.execute as unknown as Execute)('tc', { server: 'docs', uri }, undefined, undefined, {});

      await expect(read('docs://text')).resolves.toBeDefined();
      entries.push('mcp__docs__read_mcp_resource(docs://*)');
      await expect(read('docs://text')).rejects.toThrow(/turned off for this agent/);
    });
  });

  it('says an empty resource is empty', async () => {
    const { manager } = await liveManager();
    expect((await toolsOver(manager).run('read_mcp_resource', { server: 'docs', uri: 'docs://none' })).content).toEqual([{ type: 'text', text: 'Resource docs://none is empty.' }]);
  });

  it('needs a server and a URI, and uses them exactly as sent', async () => {
    const { manager, fake } = await liveManager();
    const { run } = toolsOver(manager);
    await expect(run('read_mcp_resource', { uri: 'docs://text' })).rejects.toThrow('server must be provided');
    await expect(run('read_mcp_resource', { server: 'docs' })).rejects.toThrow('uri must be provided');
    await expect(run('read_mcp_resource', { server: ' docs', uri: 'docs://text' })).rejects.toThrow('MCP server " docs" is not available here. Servers with resources: docs, wiki.');
    await run('read_mcp_resource', { server: 'docs', uri: ' docs://text' });
    expect(fake.readResource).toHaveBeenLastCalledWith('docs', ' docs://text', expect.anything());
  });

  it('fails for a server without resources and for one whose resources are Off', async () => {
    const pool = managerWithFake({}, undefined, { off: { resources: [] }, docs: DOCS });
    managers.push(pool.manager);
    await pool.manager.reconcile({ off: specOf({ command: 'x', exposeResources: false }), docs: specOf({ command: 'x' }), git: specOf({ command: 'x' }) });
    const { run } = toolsOver(pool.manager);

    await expect(run('read_mcp_resource', { server: 'git', uri: 'x://a' })).rejects.toThrow('MCP server "git" offers no resources');
    await expect(run('list_mcp_resources', { server: 'off' })).rejects.toThrow(/resources of MCP server "off" are turned off/);
    expect(json(await run('list_mcp_resources', {}))).toEqual({ resources: expect.any(Array) });
  });

  it('passes the panel\u2019s elicitation UI only when the session has one', async () => {
    const { manager } = await liveManager();
    const spy = vi.spyOn(manager, 'readResource');
    const { run } = toolsOver(manager);
    const ui = { select: vi.fn(), input: vi.fn(), notify: vi.fn() };

    await run('read_mcp_resource', { server: 'docs', uri: 'docs://text' }, { hasUI: true, ui });
    await run('read_mcp_resource', { server: 'docs', uri: 'docs://text' }, { hasUI: false, ui });

    expect(spy.mock.calls[0]![2]).toMatchObject({ elicitationUi: ui });
    expect('elicitationUi' in (spy.mock.calls[1]![2] as object)).toBe(false);
  });
});

describe('MCP resource tools frozen for a nested agent', () => {
  it('fail permanently for a server whose identity changed since spawn', async () => {
    const { manager } = await liveManager();
    const frozen: McpResourceServer[] = [{ serverName: 'docs', serverId: 'gone/docs', exposure: 'deferred' }];
    const { run } = toolsOver(manager, NO_RULES, frozen);

    await expect(run('read_mcp_resource', { server: 'docs', uri: 'docs://text' })).rejects.toThrow(/no longer available.*permanent/s);
    const listed = json(await run('list_mcp_resources', {}));
    expect(listed['errors']).toEqual([{ server: 'docs', error: expect.stringMatching(/no longer available.*permanent/s) }]);
  });

  it('list only the frozen servers', async () => {
    const { manager } = await liveManager();
    const docs = manager.resourceServers().find((s) => s.serverName === 'docs')!;
    const { run } = toolsOver(manager, NO_RULES, [docs]);

    expect(json(await run('list_mcp_resources', {}))['resources']).toEqual([
      { server: 'docs', uri: 'docs://a', name: 'a' },
      { server: 'docs', uri: 'docs://b', name: 'b' },
    ]);
    await expect(run('list_mcp_resources', { server: 'wiki' })).rejects.toThrow(/no longer available to this agent/);
  });
});
