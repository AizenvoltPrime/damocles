// A minimal MCP server over stdio (newline-delimited JSON-RPC): enough for a client to connect and list one tool.
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'e2e-stdio', version: '1.0.0' },
        },
      });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { tools: [{ name: 'e2e_ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } }] },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id: request.id, result: {} });
      return;
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `no method ${request.method}` } });
  }
});
