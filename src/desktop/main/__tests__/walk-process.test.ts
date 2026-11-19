import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkSpec, WalkStream } from '../../../core/search-walk';

type FakeChild = EventEmitter & { stderr: EventEmitter; pid: undefined; postMessage: (message: unknown) => void; kill: ReturnType<typeof vi.fn<() => void>> };

// Each fork runs the walk process's body on this thread behind a parent port, as the utility process runs dist/walk-child.js.
const electron = vi.hoisted(() => ({ forks: [] as Array<{ args: unknown[]; child: FakeChild }>, lateStderr: '' }));

vi.mock('electron', async () => {
  const { portWalkChannel } = await import('../../../core/search-walk/walk-channels');
  const { serveWalks } = await import('../../../core/search-walk/walk-serve');
  return {
    utilityProcess: {
      fork: (...args: unknown[]) => {
        const port = new EventEmitter();
        let exited = false;
        const child: FakeChild = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
          pid: undefined,
          postMessage: (message: unknown) => {
            const data = structuredClone(message);
            setImmediate(() => port.emit('message', { data }));
          },
          kill: vi.fn(() => {
            if (exited) return;
            exited = true;
            // Electron reports the exit before the stderr pipe closes
            setImmediate(() => {
              child.emit('exit', 1);
              setImmediate(() => {
                child.stderr.emit('data', Buffer.from(electron.lateStderr));
                child.stderr.emit('close');
              });
            });
          }),
        });
        serveWalks(portWalkChannel(Object.assign(port, {
          postMessage: (reply: unknown) => {
            const copy = structuredClone(reply);
            setImmediate(() => {
              if (!exited) child.emit('message', copy);
            });
          },
        })));
        electron.forks.push({ args, child });
        return child;
      },
    },
  };
});

import { WALK_IDLE_MS } from '../../../core/search-walk/walk-host';
import { ALL_IGNORE_FILES } from '../../../core/search-walk/walk';
import { mainWalkHost, WALK_SERVICE_NAME } from '../walk-process';

let root: string;
let logged: string[];

const spec = (): WalkSpec => ({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: [] });

async function all(stream: WalkStream): Promise<string[]> {
  const files: string[] = [];
  for await (const batch of stream) files.push(...batch);
  return files.sort();
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-main-walk-')));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.ts'), '');
  fs.writeFileSync(path.join(root, 'sub', 'b.ts'), '');
  logged = [];
  electron.forks.length = 0;
  electron.lateStderr = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('main\'s walk host', () => {
  it('walks in a utility process forked from the entry, with no ELECTRON_ variable, its stderr piped and no stdin', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    const host = mainWalkHost('/app/dist/walk-child.js', (line) => logged.push(line));
    expect(electron.forks).toHaveLength(0);
    expect(await all(host.walk(spec()))).toEqual(['a.ts', 'sub/b.ts']);
    expect(await all(host.walk({ ...spec(), root: path.join(root, 'sub') }))).toEqual(['b.ts']);
    expect(electron.forks).toHaveLength(1);
    const [entry, args, options] = electron.forks[0]!.args as [string, string[], { env: Record<string, string>; serviceName: string; stdio: unknown }];
    expect(entry).toBe('/app/dist/walk-child.js');
    expect(args).toEqual([]);
    expect(options).toMatchObject({ serviceName: WALK_SERVICE_NAME, stdio: ['ignore', 'ignore', 'pipe'] });
    expect(Object.keys(options.env).some((key) => /^ELECTRON_/i.test(key))).toBe(false);
    await host.close();
    expect(electron.forks[0]!.child.kill).toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it('ends the walks of a utility process that exits, logs its stderr, and forks a fresh one for the next walk', async () => {
    const host = mainWalkHost('/app/dist/walk-child.js', (line) => logged.push(line));
    const walk = host.walk(spec());
    const { child } = electron.forks[0]!;
    child.stderr.emit('data', Buffer.from('Error: Cannot find module'));
    child.emit('error', 'FatalError', 'v8::internal::Heap');
    child.kill();
    await expect(all(walk)).rejects.toThrow('The walk process exited with code 1');
    expect(logged).toEqual(['[walk] the walk process exited with code 1; its stderr ends: Error: Cannot find moduleFatalError at v8::internal::Heap']);
    expect(await all(host.walk(spec()))).toEqual(['a.ts', 'sub/b.ts']);
    expect(electron.forks).toHaveLength(2);
    await host.close();
  });

  it('logs the stderr a crashed utility process wrote after Electron reported its exit', async () => {
    electron.lateStderr = 'Error: last words';
    const host = mainWalkHost('/app/dist/walk-child.js', (line) => logged.push(line));
    const walk = host.walk(spec());
    electron.forks[0]!.child.kill();
    await expect(all(walk)).rejects.toThrow('The walk process exited with code 1');
    expect(logged).toEqual(['[walk] the walk process exited with code 1; its stderr ends: Error: last words']);
    await host.close();
  });

  it('kills an idle utility process WALK_IDLE_MS after its last walk, as no failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host = mainWalkHost('/app/dist/walk-child.js', (line) => logged.push(line));
    expect(await all(host.walk(spec()))).toEqual(['a.ts', 'sub/b.ts']);
    await vi.advanceTimersByTimeAsync(WALK_IDLE_MS);
    expect(electron.forks[0]!.child.kill).toHaveBeenCalledOnce();
    expect(await all(host.walk(spec()))).toEqual(['a.ts', 'sub/b.ts']);
    expect(electron.forks).toHaveLength(2);
    expect(logged).toEqual([]);
    await host.close();
  });

  it('is the walk host main\'s index builds, so no walk process of main starts on its launcher', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(index).toMatch(/this\.walks = mainWalkHost\(appPaths\.workerEntry\('walkChild'\), /);
    expect(index).not.toMatch(/startWalkChild|createWalkHost/);
  });
});
