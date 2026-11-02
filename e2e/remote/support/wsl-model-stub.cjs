// An OpenAI chat-completions stub that runs inside a WSL distro, where the distro's agent reaches it on its own loopback:
// a WSL 2 distro in NAT mode cannot reach a server on this computer. Usage: node wsl-model-stub.cjs <port> <replies.json> <log>
// Each streamed request takes the next reply ({ chunks, toolCalls? }); with none left it echoes. Each request appends a line
// to <log>, so the spec counts them from the distro.
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const [port, repliesFile, logFile] = process.argv.slice(2);
const replies = JSON.parse(fs.readFileSync(repliesFile, 'utf8'));
let calls = 0;

function chunk(id, delta, finishReason) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'gpt-6-luna', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

http.createServer((req, res) => {
  const parts = [];
  req.on('data', (part) => parts.push(part));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    fs.appendFileSync(logFile, `${req.method} ${req.url} tools=${(body.tools || []).length}\n`);
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions') || !body.stream) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"stub serves streamed completions only"}}');
      return;
    }
    // a sub-call (a title) offers only its output tool and takes no scripted reply
    const reply = (body.tools || []).length === 1 ? { chunks: ['Title'] } : (replies.shift() || { chunks: ['Echo'] });
    const id = `chatcmpl-wsl-${Date.now()}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(chunk(id, { role: 'assistant', content: '' }, null));
    for (const text of reply.chunks) res.write(chunk(id, { content: text }, null));
    const toolCalls = reply.toolCalls || [];
    toolCalls.forEach((call, index) => {
      res.write(chunk(id, { tool_calls: [{ index, id: `call_${++calls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, null));
    });
    res.write(chunk(id, {}, toolCalls.length > 0 ? 'tool_calls' : 'stop'));
    res.end('data: [DONE]\n\n');
  });
}).listen(Number(port), '127.0.0.1');
