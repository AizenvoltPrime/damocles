import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { JSON_RPC_ERROR_CODES, McpError, type JsonRpcMessage, type McpTransport } from '@earendil-works/pi-mcp';
import { loadMcpClient, type McpClientBundle } from '../mcp-client-loader';
import { failureForLog, McpServerConnectError } from '../connect-failure';
import {
  DEFAULT_MCP_TIMEOUT_MS,
  HEALTH_PING_TIMEOUT_MS,
  McpServerManager,
  timeoutMsOf,
  type McpServerManagerOptions,
} from '../server-manager';
import type { McpServerDefinition, McpServerSpec } from '../types';
import { MCP_STDERR_TAIL_CHARS, type McpServerConfig } from '../../../../shared/types/mcp';
import { createInMemoryMcpServer, type InMemoryMcpServer, type InMemoryMcpServerOptions } from './in-memory-mcp-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { installPlatform } from '../../../platform-host';
import { setMcpSecretStorage } from '../mcp-auth';
import { authenticateMcpServer, createMcpAuthProviderFactory, shutdownOAuth } from '../mcp-auth-flow';
import { stopCallbackServer } from '../mcp-callback-server';
import { startFakeOAuthServer, type FakeOAuthServer } from './fake-oauth-server';
import { installLogSink } from '../../../logger';

const echoServer = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'echo-server.mjs');

let bundle: McpClientBundle;
let manager: McpServerManager | undefined;

beforeEach(async () => {
  const loaded = await loadMcpClient();
  if (!loaded) throw new Error('pi-mcp failed to load');
  bundle = loaded;
});

afterEach(async () => {
  await manager?.closeAll();
  manager = undefined;
  vi.unstubAllEnvs();
});

const spec = (config: McpServerConfig = { command: 'in-memory' }, over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  config,
  valueFormat: 'pi',
  folderScoped: false,
  trusted: true,
  ...over,
});

/** A manager whose transports all lead to `server`; the rest of the connect path is the shipped one. */
function managerFor(server: InMemoryMcpServer, options: Partial<McpServerManagerOptions> = {}): McpServerManager {
  manager = new McpServerManager({
    client: bundle,
    clientVersion: '9.9.9-test',
    transportFactory: () => server.clientTransport,
    ...options,
  });
  return manager;
}

async function connected(options: InMemoryMcpServerOptions = {}, managerOptions: Partial<McpServerManagerOptions> = {}) {
  const server = await createInMemoryMcpServer(options);
  const pool = managerFor(server, managerOptions);
  const connection = await pool.connect('mem', spec());
  return { server, pool, connection };
}

/** Resolves once `predicate` holds for a message the client sent. */
function nextMessage(server: InMemoryMcpServer, predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
  return vi.waitFor(() => {
    const found = server.received.find(predicate);
    if (!found) throw new Error('not yet');
    return found;
  });
}

/** A tool entry pi-mcp accepts: `inputSchema` is required by the protocol. */
const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('McpServerManager on pi-mcp: handshake', () => {
  it('introduces itself as Damocles and advertises no elicitation or sampling until a handler is set', async () => {
    const { server } = await connected();
    expect(server.initializeParams()).toMatchObject({ clientInfo: { name: 'Damocles', version: '9.9.9-test' } });
    expect((server.initializeParams()?.['capabilities'] ?? {}) as Record<string, unknown>).not.toHaveProperty('elicitation');
    expect((server.initializeParams()?.['capabilities'] ?? {}) as Record<string, unknown>).not.toHaveProperty('sampling');
  });

  it('advertises form elicitation and routes the server\u2019s request to the handler with its server name', async () => {
    const server = await createInMemoryMcpServer();
    const pool = managerFor(server);
    const handler = vi.fn(async () => ({ action: 'accept' as const, content: { ok: true } }));
    pool.setElicitationHandler(handler);
    await pool.connect('mem', spec());

    expect(server.initializeParams()?.['capabilities']).toMatchObject({ elicitation: { form: {} } });
    const response = await server.request('elicitation/create', { message: 'Pick', requestedSchema: { type: 'object', properties: {} } });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ message: 'Pick' }), 'mem');
    expect(response).toMatchObject({ result: { action: 'accept', content: { ok: true } } });
  });

  it('reads server info and trimmed instructions', async () => {
    const { connection } = await connected({ instructions: '  Use search first.\nThen fetch.  ', serverInfo: { name: 'docs', version: '2.0.0' } });
    expect(connection.serverInfo).toEqual({ name: 'docs', version: '2.0.0' });
    expect(connection.instructions).toBe('Use search first.\nThen fetch.');
  });

  it('opens one connection for concurrent connects to the same server', async () => {
    const server = await createInMemoryMcpServer();
    const pool = managerFor(server);
    const [a, b] = await Promise.all([pool.connect('mem', spec()), pool.connect('mem', spec())]);
    expect(a).toBe(b);
    expect(server.requestsFor('initialize')).toHaveLength(1);
  });
});

describe('McpServerManager on pi-mcp: discovery', () => {
  const tools = Array.from({ length: 5 }, (_, i) => tool(`t${i}`));
  const resources = Array.from({ length: 3 }, (_, i) => ({ uri: `mem://r${i}`, name: `r${i}` }));

  it('follows nextCursor through every page of tools and resources', async () => {
    const { server, connection } = await connected({ tools, resources, pageSize: 2 });
    expect(connection.tools.map((t) => t.name)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(connection.resources.map((r) => r.uri)).toEqual(['mem://r0', 'mem://r1', 'mem://r2']);
    expect(server.requestsFor('tools/list')).toHaveLength(3);
    expect(server.requestsFor('resources/list')).toHaveLength(2);
  });

  it('does not ask a server for a list it has no capability for', async () => {
    const { server, connection } = await connected({ tools, capabilities: { tools: {} } });
    expect(connection.tools).toHaveLength(5);
    expect(connection.resources).toEqual([]);
    expect(server.requestsFor('resources/list')).toHaveLength(0);
  });

  it('still connects when resources/list fails, offering no resources', async () => {
    const server = await createInMemoryMcpServer({ tools });
    server.setHandler('resources/list', () => {
      throw new Error('resources broke');
    });
    const connection = await managerFor(server).connect('mem', spec());
    expect(connection.status).toBe('connected');
    expect(connection.resources).toEqual([]);
  });

  it('refetches tools on list_changed and reports it once the new list is in', async () => {
    const onListChanged = vi.fn();
    const { server, connection } = await connected({ tools: tools.slice(0, 1) }, { onListChanged });

    server.tools.push(tool('added'));
    await server.notify('notifications/tools/list_changed');

    await vi.waitFor(() => expect(onListChanged).toHaveBeenCalledWith('mem'));
    expect(connection.tools.map((t) => t.name)).toEqual(['t0', 'added']);
  });

  it('serializes racing list_changed refetches so the last list wins', async () => {
    const { server, connection } = await connected({ tools: tools.slice(0, 1) });
    const gate = deferred();
    let calls = 0;
    server.setHandler('tools/list', async () => {
      calls += 1;
      if (calls === 1) {
        await gate.promise;
        return { tools: [tool('stale')] };
      }
      return { tools: [tool('fresh')] };
    });

    await server.notify('notifications/tools/list_changed');
    await server.notify('notifications/tools/list_changed');
    await vi.waitFor(() => expect(calls).toBe(1));
    gate.resolve();

    await vi.waitFor(() => expect(connection.tools.map((t) => t.name)).toEqual(['fresh']));
    expect(calls).toBe(2);
  });

  it('refetches resources on resources/list_changed', async () => {
    const onListChanged = vi.fn();
    const { server, connection } = await connected({ resources: [] }, { onListChanged });
    server.resources.push({ uri: 'mem://new', name: 'new' });
    await server.notify('notifications/resources/list_changed');
    await vi.waitFor(() => expect(connection.resources.map((r) => r.uri)).toEqual(['mem://new']));
  });
});

describe('McpServerManager on pi-mcp: calls', () => {
  it('calls a tool with its arguments and always asks for progress', async () => {
    const { server, pool } = await connected({ tools: [tool('go')] });
    const result = await pool.callTool('mem', 'go', { a: 1 });
    expect(result).toEqual({ content: [{ type: 'text', text: 'called go' }], isError: false });
    const params = server.requestsFor('tools/call')[0]?.params as Record<string, unknown>;
    expect(params).toMatchObject({ name: 'go', arguments: { a: 1 } });
    expect((params['_meta'] as Record<string, unknown>)['progressToken']).toBeDefined();
  });

  it('keeps a slow call alive while the server reports progress', async () => {
    const { server, pool } = await connected({ tools: [tool('slow')] });
    server.setHandler('tools/call', async (params) => {
      const token = (params['_meta'] as Record<string, unknown>)['progressToken'];
      for (let step = 1; step <= 4; step++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await server.notify('notifications/progress', { progressToken: token, progress: step, total: 4 });
      }
      return { content: [{ type: 'text', text: 'done' }] };
    });

    await expect(pool.callTool('mem', 'slow', {}, { timeoutMs: 250 })).resolves.toMatchObject({ content: [{ text: 'done' }] });
  });

  it('times a call out when the server goes quiet', async () => {
    const { server, pool } = await connected({ tools: [tool('hang')] });
    server.setHandler('tools/call', () => new Promise(() => {}));
    await expect(pool.callTool('mem', 'hang', {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(bundle.mcp.McpTimeoutError);
  });

  it('cancels a call on abort and tells the server', async () => {
    const { server, pool } = await connected({ tools: [tool('hang')] });
    server.setHandler('tools/call', () => new Promise(() => {}));
    const controller = new AbortController();
    const call = pool.callTool('mem', 'hang', {}, { signal: controller.signal });
    await nextMessage(server, (m) => 'method' in m && m.method === 'tools/call');
    controller.abort();

    await expect(call).rejects.toBeInstanceOf(bundle.mcp.McpAbortError);
    await nextMessage(server, (m) => 'method' in m && m.method === 'notifications/cancelled');
  });

  it('reads a resource', async () => {
    const { server, pool } = await connected();
    server.setHandler('resources/read', (params) => ({ contents: [{ uri: params['uri'], text: 'body' }] }));
    await expect(pool.readResource('mem', 'mem://a')).resolves.toEqual({ contents: [{ uri: 'mem://a', text: 'body' }] });
  });

  it('counts a ping answer as alive', async () => {
    const { server, pool } = await connected();
    await expect(pool.answersPing('mem')).resolves.toBe(true);
    expect(server.requestsFor('ping')).toHaveLength(1);
  });

  it('counts a method-not-found reply to ping as alive', async () => {
    const { server, pool } = await connected();
    server.setHandler('ping', () => {
      throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, 'Method not found: ping');
    });
    await expect(pool.answersPing('mem')).resolves.toBe(true);
    expect(pool.getConnection('mem')?.status).toBe('connected');
  });

  it('counts a ping left unanswered for 10 s as dead, whatever the call timeout', async () => {
    const { server, pool } = await connected();
    server.setHandler('ping', () => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let answered: boolean | undefined;
      void pool.answersPing('mem').then((alive) => (answered = alive));
      await vi.advanceTimersByTimeAsync(HEALTH_PING_TIMEOUT_MS - 1);
      expect(answered).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(answered).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(HEALTH_PING_TIMEOUT_MS).toBe(10_000);
  });

  it('counts a connection that closes before answering a ping as dead', async () => {
    const { server, pool } = await connected();
    server.setHandler('ping', () => {
      void server.drop();
      return new Promise(() => {});
    });
    await expect(pool.answersPing('mem')).resolves.toBe(false);
  });

  it('counts in-flight calls so an idle shutdown never cuts one off', async () => {
    const { server, pool } = await connected({ tools: [tool('hang')] });
    const release = deferred<unknown>();
    server.setHandler('tools/call', () => release.promise);
    const call = pool.callTool('mem', 'hang', {});
    await vi.waitFor(() => expect(pool.getConnection('mem')?.inFlight).toBe(1));
    expect(pool.isIdle('mem', -1)).toBe(false);
    release.resolve({ content: [] });
    await call;
    expect(pool.getConnection('mem')?.inFlight).toBe(0);
  });

  it('refuses a call to a server that is not connected', async () => {
    const server = await createInMemoryMcpServer();
    await expect(managerFor(server).callTool('absent', 'x', {})).rejects.toThrow(/not connected/);
  });

  it('uses the configured timeout in seconds, else 120 s', () => {
    expect(timeoutMsOf({ timeout: 2.5 })).toBe(2500);
    expect(timeoutMsOf({})).toBe(DEFAULT_MCP_TIMEOUT_MS);
    expect(DEFAULT_MCP_TIMEOUT_MS).toBe(120_000);
  });
});

describe('McpServerManager on pi-mcp: connection lifetime', () => {
  it('reports a spontaneous drop exactly once and forgets the connection', async () => {
    const onConnectionLost = vi.fn();
    const { server, pool } = await connected({}, { onConnectionLost });

    await server.drop();

    await vi.waitFor(() => expect(onConnectionLost).toHaveBeenCalledTimes(1));
    expect(onConnectionLost).toHaveBeenCalledWith('mem');
    expect(pool.getConnection('mem')).toBeUndefined();
  });

  it('does not report a deliberate close as lost', async () => {
    const onConnectionLost = vi.fn();
    const { server, pool } = await connected({}, { onConnectionLost });
    const closed = new Promise<void>((resolve) => server.serverTransport.onClose(resolve));

    await pool.close('mem');
    await closed;

    expect(onConnectionLost).not.toHaveBeenCalled();
    expect(pool.getConnection('mem')).toBeUndefined();
  });

  it('tears down a connection whose server was closed while it was still connecting', async () => {
    const server = await createInMemoryMcpServer();
    const gate = deferred();
    const init = server.received.length;
    server.setHandler('initialize', async () => {
      await gate.promise;
      return { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'slow', version: '1' } };
    });
    const pool = managerFor(server);
    const serverClosed = new Promise<void>((resolve) => server.serverTransport.onClose(resolve));
    const connecting = pool.connect('mem', spec());
    await vi.waitFor(() => expect(server.received.length).toBeGreaterThan(init));

    await pool.close('mem');
    gate.resolve();

    await expect(connecting).rejects.toThrow(/closed during connect/);
    expect(pool.getConnection('mem')).toBeUndefined();
    await serverClosed;
  });

  it('closeAll tears down a connect still in flight instead of letting it register after teardown', async () => {
    const server = await createInMemoryMcpServer();
    const gate = deferred();
    server.setHandler('initialize', async () => {
      await gate.promise;
      return { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'slow', version: '1' } };
    });
    const pool = managerFor(server);
    const serverClosed = new Promise<void>((resolve) => server.serverTransport.onClose(resolve));
    const connecting = pool.connect('mem', spec());
    await nextMessage(server, (m) => 'method' in m && m.method === 'initialize');

    await pool.closeAll();
    gate.resolve();

    await expect(connecting).rejects.toThrow(/closed during connect/);
    expect(pool.getConnection('mem')).toBeUndefined();
    await serverClosed;
  });

  it('logs a transport error by its message', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const { server } = await connected();

    server.clientTransport.emitError(new Error('MCP stdio message exceeds 4194304 bytes\nforged line'));

    expect(lines.some((line) => line.includes('mem reported an error: MCP stdio message exceeds 4194304 bytes forged line'))).toBe(true);
  });

  it('logs a transport error that quotes server output without that output', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const { server } = await connected();
    // What pi-mcp's stdio and SSE readers emit for a line that is not JSON: V8 quotes the line's start.
    const notJson = (() => {
      try {
        JSON.parse('pw=hunter2');
      } catch (error) {
        return error as SyntaxError;
      }
      throw new Error('JSON.parse accepted the line');
    })();
    expect(notJson.message).toContain('hunter2');

    server.clientTransport.emitError(notJson);
    server.clientTransport.emitError(httpError(403, 'denied: BODY-SECRET'));

    expect(lines.some((line) => line.includes('mem reported an error: received a line that is not JSON'))).toBe(true);
    expect(lines.some((line) => line.includes('mem reported an error: McpHttpError: HTTP status 403'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/hunter2|BODY-SECRET/);
  });

  it('closes the connection when the HTTP session expired, so the next call reconnects', async () => {
    const server = await createInMemoryMcpServer({ tools: [tool('go')] });
    const expiring = failingTransport(server.clientTransport, () => new bundle.mcp.McpSessionExpiredError());
    const pool = managerFor(server, { transportFactory: () => expiring.transport });
    await pool.connect('mem', spec());

    expiring.failNextRequest('tools/call');
    await expect(pool.callTool('mem', 'go', {})).rejects.toBeInstanceOf(bundle.mcp.McpSessionExpiredError);

    expect(pool.getConnection('mem')).toBeUndefined();
  });
});

describe('McpServerManager on pi-mcp: values and errors', () => {
  it('builds the transport from the resolved definition, re-resolving on every connect', async () => {
    vi.stubEnv('DAMOCLES_SM_TOKEN', 'first');
    const server = await createInMemoryMcpServer();
    const seen: McpServerDefinition[] = [];
    const pool = managerFor(server, {
      transportFactory: async (_name, definition) => {
        seen.push(definition);
        return (await createInMemoryMcpServer()).clientTransport;
      },
    });
    const config: McpServerConfig = { command: 'srv', env: { TOKEN: '$DAMOCLES_SM_TOKEN' } };

    await pool.connect('mem', spec(config));
    await pool.close('mem');
    vi.stubEnv('DAMOCLES_SM_TOKEN', 'rotated');
    await pool.connect('mem', spec(config));

    expect(seen.map((d) => d.env)).toEqual([{ TOKEN: 'first' }, { TOKEN: 'rotated' }]);
  });

  it('fails a connect whose variable is missing with errorInfo naming it, before any transport exists', async () => {
    const transportFactory = vi.fn();
    const server = await createInMemoryMcpServer();
    const pool = managerFor(server, { transportFactory });

    const error = await pool.connect('mem', spec({ type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${DAMOCLES_SM_UNSET}' } })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpServerConnectError);
    expect((error as McpServerConnectError).errorInfo).toEqual({
      code: 'missingVariable',
      params: { variable: 'DAMOCLES_SM_UNSET', field: 'headers.Authorization' },
    });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('never runs a command from an untrusted folder source', async () => {
    const transportFactory = vi.fn();
    const pool = managerFor(await createInMemoryMcpServer(), { transportFactory });
    const error = await pool
      .connect('mem', spec({ command: 'srv', env: { T: '!echo x' } }, { folderScoped: true, trusted: false }))
      .catch((e: unknown) => e);
    expect((error as McpServerConnectError).errorInfo).toEqual({ code: 'commandUntrusted', params: { field: 'env.T' } });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('keeps legacy values literal: a leading ! is sent as written', async () => {
    const seen: McpServerDefinition[] = [];
    const pool = managerFor(await createInMemoryMcpServer(), {
      transportFactory: async (_name, definition) => {
        seen.push(definition);
        return (await createInMemoryMcpServer()).clientTransport;
      },
    });
    await pool.connect('mem', spec({ command: 'srv', env: { T: '!echo x' } }, { valueFormat: 'legacy' }));
    expect(seen[0]?.env).toEqual({ T: '!echo x' });
  });

  it('turns an authorization failure into a needs-auth connection for a server with an auth provider', async () => {
    const server = await createInMemoryMcpServer();
    const unauthorized = failingTransport(server.clientTransport, () => new bundle.oauth.McpOAuthAuthorizationRequiredError());
    unauthorized.failNextRequest('initialize');
    const pool = managerFor(server, {
      transportFactory: () => unauthorized.transport,
      authProviderFactory: () => ({ token: async () => undefined }),
    });

    const connection = await pool.connect('remote', spec({ type: 'http', url: 'https://x.test/mcp' }));

    expect(connection.status).toBe('needs-auth');
    expect(connection.tools).toEqual([]);
    expect(connection.errorInfo).toBeUndefined();
  });

  it('keeps a stderr tail out of %O while the panel can still read it', () => {
    const error = new McpServerConnectError('m', { stderrTail: 'SECRET-TAIL' });
    expect(format('%O', error)).not.toContain('SECRET-TAIL');
    expect(error.stderrTail).toBe('SECRET-TAIL');
  });

  it('keeps an HTTP failure body out of %O and out of the log line of the connect error', async () => {
    const server = await createInMemoryMcpServer();
    const failing = failingTransport(server.clientTransport, () => httpError(502, `token=SNIPPET-SECRET ${'x'.repeat(600)} BODY-SECRET`));
    failing.failNextRequest('initialize');
    const pool = managerFor(server, { transportFactory: () => failing.transport });

    const error = await pool.connect('remote', spec({ type: 'http', url: 'https://x.test/mcp' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpServerConnectError);
    // The panel keeps pi-mcp's message, snippet included; nothing past it, and nothing of it in the log.
    expect((error as Error).message).toContain('SNIPPET-SECRET');
    expect(format('%O', error)).not.toContain('BODY-SECRET');
    expect(failureForLog(error)).toBe('McpHttpError: HTTP status 502');
  });

  it('logs a connect that failed on a reply that is not JSON without the reply', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const server = await createInMemoryMcpServer();
    // What StreamableHttpTransport.send rejects with when an application/json reply does not parse.
    const notJson = () => {
      try {
        JSON.parse('token=abc123');
      } catch (error) {
        return error as Error;
      }
      throw new Error('JSON.parse accepted the reply');
    };
    expect(notJson().message).toContain('abc123');
    const failing = failingTransport(server.clientTransport, notJson);
    failing.failNextRequest('initialize');
    const pool = managerFor(server, { transportFactory: () => failing.transport });

    const error = await pool.connect('remote', spec({ type: 'http', url: 'https://x.test/mcp' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpServerConnectError);
    expect(failureForLog(error)).toBe('received a line that is not JSON');
    expect(lines.join('\n')).not.toContain('abc123');
  });

  it('logs a connect that failed on an OAuth error by its code, never its description', async () => {
    const server = await createInMemoryMcpServer();
    const failing = failingTransport(server.clientTransport, () => new bundle.oauth.OAuthError('invalid_request', 'client secret sk-SECRET was rejected'));
    failing.failNextRequest('initialize');
    const pool = managerFor(server, { transportFactory: () => failing.transport });

    const error = await pool.connect('remote', spec({ type: 'http', url: 'https://x.test/mcp' })).catch((e: unknown) => e);

    expect(failureForLog(error)).toBe('OAuth error invalid_request');
  });

  it('logs a failed resources/list by status, never its response body', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });
    const server = await createInMemoryMcpServer({ resources: [{ uri: 'mem://a', name: 'a' }] });
    const failing = failingTransport(server.clientTransport, () => httpError(500, 'stack: password=BODY-SECRET'));
    failing.failNextRequest('resources/list');
    const pool = managerFor(server, { transportFactory: () => failing.transport });

    await pool.connect('mem', spec());

    expect(lines.some((line) => line.includes('resources/list failed for mem: McpHttpError: HTTP status 500'))).toBe(true);
    expect(lines.join('\n')).not.toContain('BODY-SECRET');
  });

  it('reports a plain failure as McpServerConnectError when the server has no auth provider', async () => {
    const server = await createInMemoryMcpServer();
    const unauthorized = failingTransport(server.clientTransport, () => new bundle.oauth.McpOAuthAuthorizationRequiredError());
    unauthorized.failNextRequest('initialize');
    const pool = managerFor(server, { transportFactory: () => unauthorized.transport });

    await expect(pool.connect('remote', spec({ type: 'http', url: 'https://x.test/mcp' }))).rejects.toBeInstanceOf(McpServerConnectError);
  });
});

describe('McpServerManager: real stdio server (SDK echo fixture)', () => {
  const stdioManager = () => (manager = new McpServerManager({ client: bundle, clientVersion: 'test' }));

  it('passes only allowlisted host variables plus the server\u2019s own env, never provider keys', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-must-not-leak');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-must-not-leak');
    const pool = stdioManager();
    await pool.connect('echo', spec({ command: process.execPath, args: [echoServer], env: { OWN_VAR: 'mine' } }));

    const result = await pool.callTool('echo', 'env', {});
    const names = JSON.parse((result.content[0] as { text: string }).text) as string[];
    const upper = names.map((n) => n.toUpperCase());

    expect(upper).toContain('PATH');
    expect(names).toContain('OWN_VAR');
    expect(upper).not.toContain('ANTHROPIC_API_KEY');
    expect(upper).not.toContain('OPENAI_API_KEY');
  }, 30_000);

  it('fails with a sanitized stderr tail when the server exits during the handshake', async () => {
    const pool = stdioManager();
    const script = "process.stderr.write('fatal: bad config \\u001b[31mred\\u001b[0m\\n'); process.exit(3)";
    const error = await pool.connect('broken', spec({ command: process.execPath, args: ['-e', script] })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpServerConnectError);
    const tail = (error as McpServerConnectError).stderrTail ?? '';
    expect(tail).toContain('fatal: bad config');
    expect(tail).not.toContain('\u001b');
  }, 30_000);

  it('cuts the stderr tail on a character boundary, never inside a surrogate pair', async () => {
    const pool = stdioManager();
    const script = `process.stderr.write('\\u{1F600}' + 'x'.repeat(${MCP_STDERR_TAIL_CHARS - 1})); process.exit(3)`;
    const error = await pool.connect('astral', spec({ command: process.execPath, args: ['-e', script] })).catch((e: unknown) => e);

    const tail = (error as McpServerConnectError).stderrTail ?? '';
    expect(tail.startsWith('\u{1F600}')).toBe(true);
    expect(Array.from(tail)).toHaveLength(MCP_STDERR_TAIL_CHARS);
  }, 30_000);

  it('reports a crashed stdio server as lost, once', async () => {
    const onConnectionLost = vi.fn();
    manager = new McpServerManager({ client: bundle, clientVersion: 'test', onConnectionLost });
    await manager.connect('echo', spec({ command: process.execPath, args: [echoServer] }));

    await manager.callTool('echo', 'crash', {});

    await vi.waitFor(() => expect(onConnectionLost).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(manager.getConnection('echo')).toBeUndefined();
  }, 30_000);
});

describe('McpServerManager: streamable HTTP with OAuth (127.0.0.1 fake authorization server)', () => {
  let server: FakeOAuthServer | undefined;
  let authDir: string;
  const previousOAuthDir = process.env['MCP_OAUTH_DIR'];

  beforeEach(async () => {
    authDir = mkdtempSync(join(tmpdir(), 'damocles-sm-oauth-'));
    process.env['MCP_OAUTH_DIR'] = authDir;
    const fake = createFakePlatform();
    // The browser: consent at the fake server, then follow its redirect to Damocles' callback server.
    fake.shell.openExternal = async (url: string) => {
      const callback = await server!.approve(url);
      await fetch(callback);
      return true;
    };
    installPlatform(fake);
    const keychain = new Map<string, string>();
    setMcpSecretStorage({
      isPersistent: true,
      keys: async () => [...keychain.keys()],
      get: async (k: string) => keychain.get(k),
      store: async (k: string, v: string) => { keychain.set(k, v); },
      delete: async (k: string) => { keychain.delete(k); },
      onDidChange: () => ({ dispose: () => {} }),
    });
  });

  afterEach(async () => {
    await shutdownOAuth();
    await stopCallbackServer();
    await server?.close();
    server = undefined;
    rmSync(authDir, { recursive: true, force: true });
    if (previousOAuthDir === undefined) delete process.env['MCP_OAUTH_DIR'];
    else process.env['MCP_OAUTH_DIR'] = previousOAuthDir;
  });

  const httpManager = () =>
    (manager = new McpServerManager({ client: bundle, clientVersion: 'test', authProviderFactory: createMcpAuthProviderFactory(bundle.oauth) }));

  it('reports needs-auth before sign-in, then connects over streamable HTTP with the stored grant', async () => {
    server = await startFakeOAuthServer();
    const pool = httpManager();
    const config: McpServerConfig = { type: 'http', url: server.mcpUrl };

    expect((await pool.connect('remote', spec(config))).status).toBe('needs-auth');
    await pool.close('remote');

    await expect(authenticateMcpServer(bundle.oauth, 'remote', { url: server.mcpUrl, type: 'http' })).resolves.toEqual({ ok: true });
    const connection = await pool.connect('remote', spec(config));

    expect(connection.status).toBe('connected');
    expect(connection.tools.map((t) => t.name)).toEqual(['whoami']);
    expect(server.mcpBearers.at(-1)).toBe(server.issued.at(-1)?.accessToken);
  });

  it('shows a step-up challenge as needs-auth with insufficientScope, and connects after signing in again', async () => {
    server = await startFakeOAuthServer({ scopesSupported: ['read'], requiredScope: 'admin' });
    const pool = httpManager();
    const config: McpServerConfig = { type: 'http', url: server.mcpUrl };
    await authenticateMcpServer(bundle.oauth, 'remote', { url: server.mcpUrl, type: 'http' });

    const challenged = await pool.connect('remote', spec(config));
    expect(challenged).toMatchObject({ status: 'needs-auth', errorInfo: { code: 'insufficientScope' } });
    await pool.close('remote');

    await expect(authenticateMcpServer(bundle.oauth, 'remote', { url: server.mcpUrl, type: 'http' })).resolves.toEqual({ ok: true });
    expect((await pool.connect('remote', spec(config))).status).toBe('connected');
  });

  it('sends a resolved bearer header, and fails closed on an unset bearerTokenEnv', async () => {
    server = await startFakeOAuthServer({ clientCredentials: { clientId: 'c', clientSecret: 's' } });
    // A token the fake server issued, sent as a plain header with no OAuth provider involved.
    const token = await fetch(`${server.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'c', client_secret: 's' }),
    }).then((r) => r.json() as Promise<{ access_token: string }>);
    vi.stubEnv('DAMOCLES_SM_BEARER', token.access_token);
    manager = new McpServerManager({ client: bundle, clientVersion: 'test' });

    const ok = await manager.connect('bearer', spec({ type: 'http', url: server.mcpUrl, headers: { Authorization: 'Bearer $DAMOCLES_SM_BEARER' } }));
    expect(ok.status).toBe('connected');

    const missing = await manager
      .connect('unset', spec({ type: 'http', url: server.mcpUrl, auth: 'bearer', bearerTokenEnv: 'DAMOCLES_SM_UNSET_BEARER' }))
      .catch((e: unknown) => e);
    expect((missing as McpServerConnectError).errorInfo).toEqual({
      code: 'missingVariable',
      params: { variable: 'DAMOCLES_SM_UNSET_BEARER', field: 'bearerTokenEnv' },
    });
  });
});

/** An McpHttpError as pi-mcp's streamable HTTP transport builds it: the message carries the first 500 characters of the body. */
function httpError(status: number, body: string): Error {
  const snippet = body.length > 500 ? `${body.slice(0, 497)}...` : body;
  return new bundle.mcp.McpHttpError(status, `MCP HTTP request failed with status ${status}: ${snippet}`, body);
}

/** Wraps a transport so the next request with a given method fails with `error()` instead of being sent. */
function failingTransport(inner: McpTransport, error: () => Error) {
  const failing = new Set<string>();
  const transport: McpTransport = {
    start: () => inner.start(),
    close: () => inner.close(),
    onMessage: (listener) => inner.onMessage(listener),
    onError: (listener) => inner.onError(listener),
    onClose: (listener) => inner.onClose(listener),
    send: async (message) => {
      if ('method' in message && failing.delete(message.method)) throw error();
      return inner.send(message);
    },
  };
  return { transport, failNextRequest: (method: string) => failing.add(method) };
}
