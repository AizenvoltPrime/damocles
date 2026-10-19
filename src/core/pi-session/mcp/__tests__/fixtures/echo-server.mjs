// Minimal stdio MCP echo server used by the Phase 6 end-to-end test (US-014.9).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {}, resources: {}, completions: {} } });

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const RESOURCES = [
  { uri: 'echo://text', name: 'text', mimeType: 'text/plain' },
  { uri: 'echo://image', name: 'image', mimeType: 'image/png' },
  { uri: 'echo://bin', name: 'bin', mimeType: 'application/octet-stream' },
  { uri: 'echo://dir', name: 'dir', description: 'A directory: reading it returns its children.' },
  { uri: 'ui://panel', name: 'panel', mimeType: 'text/html;profile=mcp-app' },
];
const CONTENTS = {
  'echo://text': [{ uri: 'echo://text', mimeType: 'text/plain', text: 'hello resource' }],
  'echo://image': [{ uri: 'echo://image', mimeType: 'image/png', blob: PNG }],
  'echo://bin': [{ uri: 'echo://bin', mimeType: 'application/octet-stream', blob: Buffer.from([0, 1, 2, 3]).toString('base64') }],
  'echo://dir': [
    { uri: 'echo://dir/a', mimeType: 'text/plain', text: 'child a' },
    { uri: 'echo://dir/b', mimeType: 'text/plain', text: 'child b' },
    { uri: 'echo://dir/sub/c', mimeType: 'text/plain', text: 'child c' },
  ],
  'echo://dir/sub': [{ uri: 'echo://dir/sub/c', mimeType: 'text/plain', text: 'child c' }],
  'ui://panel': [{ uri: 'ui://panel', mimeType: 'text/html;profile=mcp-app', text: '<p>app</p>' }],
};
const PAGE_SIZE = 2;
const received = { 'resources/list': 0 };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo back the provided text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'env',
      description: 'Return the names of the environment variables the server process received.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'crash',
      description: 'Exit the server process shortly after responding (drop simulation).',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'received',
      description: 'Return how many resources/list requests the server answered.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  received['resources/list'] += 1;
  const start = Number(request.params?.cursor ?? 0);
  const end = start + PAGE_SIZE;
  return { resources: RESOURCES.slice(start, end), ...(end < RESOURCES.length ? { nextCursor: String(end) } : {}) };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    { uriTemplate: 'echo://items/{id}', name: 'item' },
    { uriTemplate: 'ui://apps/{id}', name: 'app' },
  ],
}));

const ITEM = /^echo:\/\/items\/([^/]+)$/;
const ITEM_IDS = ['apple', 'apricot', 'banana'];

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const item = ITEM.exec(request.params.uri);
  if (item) return { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: `item ${decodeURIComponent(item[1])}` }] };
  return { contents: CONTENTS[request.params.uri] ?? [] };
});

server.setRequestHandler(CompleteRequestSchema, async (request) => {
  const { ref, argument } = request.params;
  const values = ref.type === 'ref/resource' && ref.uri === 'echo://items/{id}' && argument.name === 'id'
    ? ITEM_IDS.filter((id) => id.startsWith(argument.value))
    : [];
  return { completion: { values, total: values.length, hasMore: false } };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'crash') {
    setTimeout(() => process.exit(1), 50);
    return { content: [{ type: 'text', text: 'crashing' }] };
  }
  if (request.params.name === 'env') {
    return { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env)) }] };
  }
  if (request.params.name === 'received') {
    return { content: [{ type: 'text', text: JSON.stringify(received) }] };
  }
  const text = request.params.arguments?.text ?? '';
  return { content: [{ type: 'text', text: `echo: ${text}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
