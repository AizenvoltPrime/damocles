import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createLsTool } from '../ls-tool';

/** Every access, stat, lstat and readdir the override's operations make; pi's own ls, loaded from node_modules, is not seen here. */
const calls = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: ((file: string, ...rest: never[]) => {
      calls.push(`access ${path.basename(file)}`);
      return (actual.access as (...args: unknown[]) => Promise<void>)(file, ...rest);
    }) as typeof actual.access,
    stat: ((file: string, ...rest: never[]) => {
      calls.push(`stat ${path.basename(file)}`);
      return (actual.stat as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.stat,
    lstat: ((file: string, ...rest: never[]) => {
      calls.push(`lstat ${path.basename(file)}`);
      return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.lstat,
    readdir: ((dir: string, ...rest: never[]) => {
      calls.push(`readdir ${path.basename(dir)}`);
      return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof actual.readdir,
  };
});

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  calls.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Result = { content: Array<{ type: string; text?: string }> };

function run(tool: ToolDefinition, cwd: string, params: { path: string }): Promise<Result> {
  return tool.execute('tc', params as never, undefined, undefined, { cwd } as never) as Promise<Result>;
}

describe('the ls override', () => {
  it('lists what pi\'s own ls lists, through the override\'s exists, stat and readdir', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-ls-'));
    dirs.push(cwd);
    const listed = path.join(cwd, 'listed');
    fs.mkdirSync(path.join(listed, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(listed, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(listed, 'notes.txt'), 'notes\n');
    // Plain Node, as Vitest runs, sees any .asar as a file; the e2e test in agent-tools.spec.ts covers Electron's fs.
    fs.writeFileSync(path.join(listed, 'x.asar'), 'archive bytes');

    const mine = await run(createLsTool(pi, cwd, NO_HOSTS), cwd, { path: 'listed' });
    const pis = await run(pi.createLsToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'listed' });

    expect(mine.content).toEqual(pis.content);
    expect(mine.content[0]?.text).toBe('.env\nnotes.txt\nsub/\nx.asar');
    // the listed folder's own stat follows links; on Windows a child is lstat'd and followed only when it is a link that stays local
    const child = process.platform === 'win32' ? 'lstat' : 'stat';
    expect(calls).toEqual(expect.arrayContaining(['access listed', 'readdir listed', 'stat listed', `${child} x.asar`, `${child} sub`]));
  });

  // A file symlink whose target is a named pipe this test serves: an open of the target shows as a connection, as an open of
  // \\host\share would send the user's Windows sign-in to that host.
  it.runIf(process.platform === 'win32')('lists a child link whose target leaves this computer unfollowed, opening nothing, and follows a local one', async (ctx) => {
    const pipe = `\\\\.\\pipe\\damocles-ls-${process.pid}`;
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-ls-'));
      dirs.push(cwd);
      const listed = path.join(cwd, 'listed');
      fs.mkdirSync(path.join(cwd, 'real'), { recursive: true });
      fs.mkdirSync(listed);
      fs.writeFileSync(path.join(listed, 'a.txt'), 'a');
      fs.symlinkSync(path.join(cwd, 'real'), path.join(listed, 'docs'), 'junction');
      symlink(ctx, pipe, path.join(listed, 'remote'), 'file');
      symlink(ctx, path.join(cwd, 'real'), path.join(listed, 'linked'), 'dir');
      const result = await run(createLsTool(pi, cwd, NO_HOSTS), cwd, { path: 'listed' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connections).toBe(0);
      expect(result.content[0]?.text).toBe('a.txt\ndocs/\nlinked/\nremote');
    } finally {
      server.close();
    }
  });

  it.runIf(process.platform === 'win32')('asks for the chat\'s hosts only when a child is a link', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-ls-'));
    dirs.push(cwd);
    fs.mkdirSync(path.join(cwd, 'listed', 'sub'), { recursive: true });
    const hosts = vi.fn(NO_HOSTS);
    await run(createLsTool(pi, cwd, hosts), cwd, { path: 'listed' });
    expect(hosts).not.toHaveBeenCalled();
  });
});

const NO_HOSTS = (): Promise<ReadonlySet<string>> => Promise.resolve(new Set());

// A real symlink, which needs Developer Mode or an elevated process on Windows; the test skips without either.
function symlink(ctx: TestContext, target: string, at: string, type: 'file' | 'dir'): void {
  try {
    fs.symlinkSync(target, at, type);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
    throw err;
  }
}
