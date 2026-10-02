import {
  LATEST_PROTOCOL_VERSION,
  McpConnectionClosedError,
  McpError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@earendil-works/pi-mcp';
import { createInMemoryTransportPair, type InMemoryTransport } from '@earendil-works/pi-mcp/testing';

export type ServerRequestHandler = (params: Record<string, unknown>, request: JsonRpcRequest) => unknown;

export interface InMemoryMcpServerOptions {
  tools?: Array<Record<string, unknown>>;
  resources?: Array<Record<string, unknown>>;
  /** Items per `tools/list` and `resources/list` page; unset sends one page. */
  pageSize?: number;
  instructions?: string;
  serverInfo?: { name: string; version: string };
  /** Server capabilities; default tools and resources, both with listChanged. */
  capabilities?: Record<string, unknown>;
}

/**
 * A scripted MCP server on pi-mcp's in-memory transport. `clientTransport` is what the code under
 * test connects to; everything the client sends is recorded in `received`.
 */
export interface InMemoryMcpServer {
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
  received: JsonRpcMessage[];
  tools: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  /** Params of the client's `initialize` request, once it arrived. */
  initializeParams(): Record<string, unknown> | undefined;
  setHandler(method: string, handler: ServerRequestHandler): void;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  /** Send a server→client request (for example `elicitation/create`) and resolve with the client's response. */
  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  /** Drop the connection from the server side, as a crashed process would. */
  drop(): Promise<void>;
  requestsFor(method: string): JsonRpcRequest[];
}

function page<T>(items: T[], cursor: unknown, pageSize: number | undefined): { items: T[]; nextCursor?: string } {
  if (!pageSize) return { items };
  const start = typeof cursor === 'string' ? Number(cursor) : 0;
  const end = start + pageSize;
  return end < items.length ? { items: items.slice(start, end), nextCursor: String(end) } : { items: items.slice(start) };
}

export async function createInMemoryMcpServer(options: InMemoryMcpServerOptions = {}): Promise<InMemoryMcpServer> {
  const pair = createInMemoryTransportPair();
  const received: JsonRpcMessage[] = [];
  const handlers = new Map<string, ServerRequestHandler>();
  const pendingToClient = new Map<string | number, (response: JsonRpcResponse) => void>();
  let nextId = 1;

  const server: InMemoryMcpServer = {
    clientTransport: pair.client,
    serverTransport: pair.server,
    received,
    tools: options.tools ?? [],
    resources: options.resources ?? [],
    initializeParams: () => {
      const init = received.find((m): m is JsonRpcRequest => 'method' in m && m.method === 'initialize' && 'id' in m);
      return init?.params as Record<string, unknown> | undefined;
    },
    setHandler: (method, handler) => {
      handlers.set(method, handler);
    },
    notify: (method, params) =>
      pair.server.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }),
    request: (method, params) => {
      const id = `server-${nextId++}`;
      const response = new Promise<JsonRpcResponse>((resolve) => pendingToClient.set(id, resolve));
      void pair.server.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
      return response;
    },
    drop: () => pair.server.close(),
    requestsFor: (method) =>
      received.filter((m): m is JsonRpcRequest => 'method' in m && 'id' in m && m.method === method),
  };

  handlers.set('initialize', () => ({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: options.capabilities ?? { tools: { listChanged: true }, resources: { listChanged: true } },
    serverInfo: options.serverInfo ?? { name: 'in-memory', version: '1.0.0' },
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
  }));
  handlers.set('ping', () => ({}));
  handlers.set('tools/list', (params) => {
    const { items, nextCursor } = page(server.tools, params['cursor'], options.pageSize);
    return { tools: items, ...(nextCursor ? { nextCursor } : {}) };
  });
  handlers.set('resources/list', (params) => {
    const { items, nextCursor } = page(server.resources, params['cursor'], options.pageSize);
    return { resources: items, ...(nextCursor ? { nextCursor } : {}) };
  });
  handlers.set('tools/call', (params) => ({
    content: [{ type: 'text', text: `called ${String(params['name'])}` }],
    isError: false,
  }));

  pair.server.onMessage((message) => {
    received.push(message);
    if (!('method' in message)) {
      const resolve = pendingToClient.get(message.id);
      pendingToClient.delete(message.id);
      resolve?.(message);
      return;
    }
    if (!('id' in message)) return;
    const request = message;
    const handler = handlers.get(request.method);
    void (async () => {
      try {
        if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
        const result = await handler((request.params ?? {}) as Record<string, unknown>, request);
        await pair.server.send({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
        await pair.server.send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
        });
      }
    })().catch((error: unknown) => {
      // The client may close before a late answer goes out; any other send failure is a test bug.
      if (!(error instanceof McpConnectionClosedError)) throw error;
    });
  });
  await pair.server.start();
  return server;
}
