import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// A smart-HTTP git server for the source control specs: `git http-backend` as CGI over the bare repositories under root,
// on 127.0.0.1 and a port the OS picks (Hyper-V reserves fixed ranges on Windows), with optional basic auth. It never
// stores or logs the Authorization header, so a test can check that a password appears in no log.

export interface GitHttpServerOptions {
  // the folder holding the bare repositories; a URL path names one relative to it
  readonly root: string;
  // basic auth on every request while set
  readonly user?: string;
  readonly password?: string;
}

export interface GitHttpServer {
  // http://127.0.0.1:<port>/<repoPath>
  url(repoPath: string): string;
  // every request from now on waits until release()
  hold(): void;
  // lets the held requests and every later one through
  release(): void;
  // requests that reached git http-backend, and requests refused for missing or wrong credentials
  readonly requests: { readonly served: number; readonly refused: number; readonly held: number };
  backendPids(): number[];
  close(): Promise<void>;
}

export async function startGitHttpServer(options: GitHttpServerOptions): Promise<GitHttpServer> {
  const counts = { served: 0, refused: 0, held: 0 };
  let gate: { readonly opened: Promise<void>; readonly open: () => void } | undefined;
  const expected = options.user !== undefined ? `Basic ${Buffer.from(`${options.user}:${options.password ?? ''}`).toString('base64')}` : undefined;
  const sockets = new Set<import('node:net').Socket>();
  // killed in close(), or one keeps the served repository open on Windows
  const backends = new Set<ChildProcess>();

  const serve = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    if (expected !== undefined && request.headers.authorization !== expected) {
      counts.refused++;
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"', 'Content-Type': 'text/plain' });
      response.end('Authentication required\n');
      return;
    }
    if (gate) {
      counts.held++;
      await gate.opened;
    }
    counts.served++;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      SystemRoot: process.env['SystemRoot'],
      GIT_CONFIG_NOSYSTEM: '1',
      // git for Windows refuses os.devNull as a config file and takes /dev/null, as POSIX does
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PROJECT_ROOT: options.root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? 'GET',
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      REMOTE_USER: options.user ?? 'anonymous',
      REMOTE_ADDR: '127.0.0.1',
      ...(request.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] } : {}),
      ...(request.headers['git-protocol'] ? { GIT_PROTOCOL: String(request.headers['git-protocol']) } : {}),
    };
    const backend = spawn('git', ['-c', 'http.receivepack=true', '-c', 'uploadpack.allowFilter=true', 'http-backend'], { env, windowsHide: true });
    backends.add(backend);
    backend.on('exit', () => backends.delete(backend));
    request.pipe(backend.stdin);
    backend.stdin.on('error', () => undefined);
    let header = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of header.subarray(0, end).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      headersSent = true;
      response.write(header.subarray(end + 4));
    });
    await new Promise<void>((resolve) => {
      backend.on('close', () => {
        if (!headersSent) response.writeHead(500);
        response.end();
        resolve();
      });
      backend.on('error', () => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
        resolve();
      });
    });
  };

  const server = http.createServer((request, response) => {
    serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: (repoPath) => `http://127.0.0.1:${port}/${repoPath.replace(/^\/+/, '')}`,
    hold: () => {
      if (gate) return;
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      gate = { opened, open };
    },
    release: () => {
      gate?.open();
      gate = undefined;
    },
    requests: counts,
    backendPids: () => [...backends].flatMap((backend) => (backend.pid === undefined ? [] : [backend.pid])),
    close: async () => {
      gate?.open();
      gate = undefined;
      for (const socket of sockets) socket.destroy();
      await Promise.all([...backends].map((backend) => new Promise<void>((resolve) => {
        backend.once('exit', () => resolve());
        if (backend.exitCode !== null || backend.signalCode !== null || !backend.kill()) resolve();
      })));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
