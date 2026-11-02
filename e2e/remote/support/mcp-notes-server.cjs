// A minimal MCP server over stdio (newline-delimited JSON-RPC) with one read-only tool and one resource, each naming the
// machine it runs on and whether its NOTES_TOKEN is set, never the token itself.
const os = require('node:os');
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const where = () => `on ${os.hostname()} with the token ${process.env.NOTES_TOKEN ? 'set' : 'unset'}`;

rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = (value) => send({ jsonrpc: '2.0', id: request.id, result: value });
  switch (request.method) {
    case 'initialize':
      return result({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'e2e-notes', version: '1.0.0' } });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: [{ name: 'whoami', description: 'Names the machine it runs on.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] });
    case 'tools/call':
      return result({ content: [{ type: 'text', text: `whoami ran ${where()}` }] });
    case 'resources/list':
      return result({ resources: [{ uri: 'notes://today', name: 'today', mimeType: 'text/plain' }] });
    case 'resources/templates/list':
      return result({ resourceTemplates: [] });
    case 'resources/read':
      return result({ contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: `today's notes, read ${where()}` }] });
    default:
      return send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `no method ${request.method}` } });
  }
});
