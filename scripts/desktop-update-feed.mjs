import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isEntryPoint } from './entry-point.mjs';

// Test-only update feed for the desktop update tests: serves one directory of electron-builder output
// (latest*.yml, installers, blockmaps) to an installed app whose app-update.yml points at it.
// Loopback only, GET and HEAD only, whole files only; electron-updater falls back to a full download.

const HOST = '127.0.0.1';

const USAGE = `Usage: node scripts/desktop-update-feed.mjs --dir <directory> [--port <port>]

Serves <directory> on http://127.0.0.1:<port>/ until interrupted. --port 0 (the default) picks a free port.
Prints "feed: <url>" once listening.`;

const CONTENT_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.blockmap': 'application/octet-stream',
};

// Resolves a request path to a regular file inside root, or undefined; symlinks leaving root are refused too.
export function feedFile(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split('?', 1)[0]);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..')) return undefined;
  const candidate = resolve(root, `.${decoded}`);
  const inside = (base, target) => {
    const rel = relative(base, target);
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  };
  if (!inside(root, candidate)) return undefined;
  let real;
  try {
    real = realpathSync(candidate);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
    throw err;
  }
  if (!inside(realpathSync(root), real) || !statSync(real).isFile()) return undefined;
  return real;
}

export function startFeedServer({ dir, port = 0, log = (line) => console.log(line) }) {
  const root = resolve(dir);
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const file = feedFile(root, req.url ?? '/');
    log(`[feed] ${method} ${req.url} -> ${file === undefined ? 404 : 200}`);
    if (file === undefined) {
      res.writeHead(404).end();
      return;
    }
    const extension = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': 'no-store',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, HOST, () => {
      server.off('error', rejectStart);
      const address = server.address();
      resolveStart({
        url: `http://${HOST}:${address.port}/`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function parseArgs(argv) {
  const options = { port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === '--dir') options.dir = value;
    else if (arg === '--port') options.port = Number(value);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.dir === undefined) throw new Error('--dir is required');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  return options;
}

if (isEntryPoint(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
  } else {
    const feed = await startFeedServer(options);
    console.log(`feed: ${feed.url}`);
    const stop = () => feed.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
