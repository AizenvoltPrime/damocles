import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_HOOK_ENV } from '../../workspace/terminal/terminal-env';
import { serveCliConnection, type CliRequest } from '../cli-protocol';
import { runRemoteCli } from '../cli-remote';

const REPO = path.join(__dirname, '..', '..', '..', '..');

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

// a terminal's CLI socket whose client speaks Greek, recording each request that reaches it
async function socket(): Promise<{ readonly hook: string; readonly handled: CliRequest[] }> {
  const hook = process.platform === 'win32' ? `\\\\.\\pipe\\damocles-cli-remote-test-${randomBytes(8).toString('hex')}` : path.join(os.tmpdir(), `damocles-cli-remote-test-${randomBytes(8).toString('hex')}.sock`);
  const handled: CliRequest[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (connection) => serveCliConnection(connection, async (request) => {
    handled.push(request);
    return request.kind === 'status' ? { ok: true, version: '1.0.0', connected: true, language: 'el' } : { ok: true };
  }, () => undefined));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(hook, resolve));
  return { hook, handled };
}

async function run(hook: string, argv: readonly string[]): Promise<{ readonly code: number; readonly err: string }> {
  let err = '';
  const code = await runRemoteCli({ argv, env: { [CLI_HOOK_ENV]: hook }, cwd: '/srv/app', root: REPO, out: () => undefined, err: (text) => { err += text; }, connect: (target) => net.connect(target) });
  return { code, err };
}

describe('the damocles command in a target\'s terminal', () => {
  it('prints the server version server-package.json names for --version, without the terminal\'s socket', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cli-remote-version-'));
    try {
      writeFileSync(path.join(root, 'server-package.json'), JSON.stringify({ version: '3.7.0', serverVersion: '3.7.0+0123456789ab' }));
      let out = '';
      const code = await runRemoteCli({ argv: ['--version'], env: {}, cwd: '/srv/app', root, out: (text) => { out += text; }, err: () => undefined, connect: () => { throw new Error('connected'); } });
      expect({ code, out }).toEqual({ code: 0, out: '3.7.0+0123456789ab\n' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the bound a request breaks in the attached client\'s language, and sends nothing past it', async () => {
    const { hook, handled } = await socket();
    const many = Array.from({ length: 65 }, (_, index) => `/srv/app/${index}.log`);
    expect(await run(hook, many)).toEqual({ code: 1, err: 'damocles: ένα αίτημα ορίζει έως 64 διαδρομές.\n' });
    const long = `/srv/${'a'.repeat(4096)}`;
    expect(await run(hook, [long])).toEqual({ code: 1, err: `damocles: το ${path.resolve('/srv/app', long).slice(0, 80)}… ξεπερνά τους 4096 χαρακτήρες.\n` });
    expect(handled.map((request) => request.kind)).toEqual(['status', 'status']);
    // within every bound the request goes out
    expect(await run(hook, ['/srv/app/a.ts'])).toEqual({ code: 0, err: '' });
    expect(handled.at(-1)).toEqual({ kind: 'open', cwd: '/srv/app', items: [{ path: path.resolve('/srv/app', '/srv/app/a.ts') }], wait: false });
  });
});
