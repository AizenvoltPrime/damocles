// A Vite-like dev server for the target, Node built-ins only: it prints Vite's Local line, serves a page whose title shows
// message.txt and how often the document loaded, and pushes each change of message.txt to the page over a websocket on
// /hmr, which updates the title in place (a hot update, no reload). /cookie sets and shows a cookie; /probe.html is the
// client-network probe of remote-browser.spec.ts; /favicon.ico is a 1x1 PNG. Run: node dev-server.mjs <folder> <port>
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';

const [folder, portText] = process.argv.slice(2);
const port = Number(portText);
const messageFile = join(folder, 'message.txt');
const message = () => readFileSync(messageFile, 'utf8').trim();
const sockets = new Set();
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const PAGE = `<!doctype html><meta charset="utf-8"><title>loading</title><body><h1 id="m"></h1><script>
const loads = Number(sessionStorage.getItem('loads') || '0') + 1;
sessionStorage.setItem('loads', String(loads));
const show = (text) => { document.getElementById('m').textContent = text; document.title = text + ' · loads ' + loads; };
show(__MESSAGE__);
const hmr = new WebSocket('ws://' + location.host + '/hmr');
hmr.onmessage = (event) => show(event.data);
</script>`;

// one unmasked text frame; RFC 6455 5.2: a length past 125 takes 126 and 16 bits, past 65535 127 and 64 bits
const frame = (text) => {
  const payload = Buffer.from(text);
  let header;
  if (payload.length <= 125) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header.writeUInt16BE(payload.length, 2);
    header[1] = 126;
  } else {
    header = Buffer.alloc(10);
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    header[1] = 127;
  }
  header[0] = 0x81;
  return Buffer.concat([header, payload]);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  console.log(`request ${req.url}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE.replace('__MESSAGE__', JSON.stringify(message())));
    return;
  }
  if (url.pathname === '/cookie') {
    const set = url.searchParams.get('set');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(set ? { 'set-cookie': `${set}=1; Path=/` } : {}) });
    res.end('<!doctype html><title>cookies</title><script>document.title = "cookies:" + document.cookie;</script>');
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(ICON);
    return;
  }
  if (url.pathname === '/probe.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(join(folder, 'probe.html')));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/hmr') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
});

watchFile(messageFile, { interval: 100 }, () => {
  const text = message();
  console.log(`hmr update ${text}`);
  for (const socket of sockets) socket.write(frame(text));
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  VITE v5.0.0  ready in 120 ms');
  console.log('');
  console.log(`  ➜  Local:   http://localhost:${port}/`);
});
