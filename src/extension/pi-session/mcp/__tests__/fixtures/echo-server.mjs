// Minimal stdio MCP echo server used by the Phase 6 end-to-end test (US-014.9).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });

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
      name: 'crash',
      description: 'Exit the server process shortly after responding (drop simulation).',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'crash') {
    setTimeout(() => process.exit(1), 50);
    return { content: [{ type: 'text', text: 'crashing' }] };
  }
  const text = request.params.arguments?.text ?? '';
  return { content: [{ type: 'text', text: `echo: ${text}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
