import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostStarters } from '../../workspace/host-starters';
import { BelowFloorError, belowFloorLine, connectToDaemon, floorAbove, FloorUnreadableError, floorUnreadableLine, handOverYield } from '../attach';
import { HAND_OVER_YIELD_MS, markHandedOver, MAX_MARK_BYTES, yieldsUntil } from '../hand-over-mark';
import { raiseFloor } from '../security-floor';
import { localRunPaths, makeRunDir } from '../token';
import { startInProcessDaemon, type InProcessDaemon } from './in-process-daemon';
import { connectClient } from './test-client';

const NO_HOSTS: HostStarters = {
  startPtyHost: () => { throw new Error('no pty host in this test'); },
  startFormatterHost: () => { throw new Error('no formatter host in this test'); },
};

const running: InProcessDaemon[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.shutdown()));
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

// An install folder holding the version folder of `serverVersion`, as stage 1 unpacks it.
function installed(serverVersion: string): { installDir: string; root: string } {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-floor-'));
  folders.push(installDir);
  const root = path.join(installDir, `${serverVersion}-linux-x64`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'server-package.json'), JSON.stringify({ version: serverVersion.split('+')[0], serverVersion }));
  return { installDir, root };
}

describe('a bridge below the host\'s security floor', () => {
  it('starts nothing when no daemon answers, and fails with the floor', async () => {
    const start = vi.fn(async () => undefined);
    const lines: string[] = [];
    const attempt = connectToDaemon({ paths: await localRunPaths(), start, floorAbove: async () => '3.9.0', deadlineMs: 1000, log: (line) => lines.push(line) });
    await expect(attempt).rejects.toBeInstanceOf(BelowFloorError);
    await expect(attempt).rejects.toMatchObject({ floor: '3.9.0' });
    expect(start).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('joins a running daemon whatever the floor, which is not even read', async () => {
    running.push(await startInProcessDaemon({ starters: NO_HOSTS }));
    const start = vi.fn(async () => undefined);
    const floor = vi.fn(async () => '3.9.0');
    const connection = await connectToDaemon({ paths: await localRunPaths(), start, floorAbove: floor, log: () => undefined });
    const client = await connectClient(connection.socket, { clientId: 'older-app' });
    expect(client.outcome.kind).toBe('welcome');
    expect([start.mock.calls.length, floor.mock.calls.length]).toEqual([0, 0]);
    client.protocol.close('done');
  });

  // a bridge below the new floor that finds no pid record yet starts a daemon, which loses the lock and joins this one
  it('is raised by a daemon only once its pid file names it', async () => {
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-floor-'));
    folders.push(installDir);
    const paths = await localRunPaths();
    const raised: boolean[] = [];
    const log = (line: string): void => {
      if (line.startsWith('[floor] the host\'s security floor is now 3.9.0')) raised.push(fs.existsSync(paths.pidFile));
    };
    running.push(await startInProcessDaemon({ starters: NO_HOSTS, floor: { installDir, minimum: '3.9.0' }, log }));
    expect(raised).toEqual([true]);
  });

  it('starts its daemon at or above the floor, and with no floor', async () => {
    const start = vi.fn(async () => {
      running.push(await startInProcessDaemon({ starters: NO_HOSTS }));
    });
    const connection = await connectToDaemon({ paths: await localRunPaths(), start, floorAbove: async () => undefined, log: () => undefined });
    expect(start).toHaveBeenCalledOnce();
    connection.socket.destroy();
  });

  // main's prereq-parse.test.ts reads this very line
  it('writes the fail line stage 1 uses, with the floor', () => {
    expect(belowFloorLine('3.9.0')).toBe('@@DAMOCLES {"kind":"fail","code":"belowFloor","params":{"floor":"3.9.0"}}\n');
  });
});

describe('a bridge after a hand-over', () => {
  const HOUR = 3_600_000;
  let runDir: string;
  const mark = (version: string, at: number): Promise<void> => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-mark-'));
    folders.push(runDir);
    return markHandedOver({ runDir }, version, at);
  };

  const quiet = (): void => undefined;

  it('of the version that left, or of an older one, yields to a newer bridge for 15 seconds', async () => {
    await mark('3.7.0+0123456789ab', HOUR);
    expect(await yieldsUntil({ runDir }, '3.7.0+0123456789ab', quiet, HOUR + 1000)).toBe(HOUR + HAND_OVER_YIELD_MS);
    expect(await yieldsUntil({ runDir }, '3.6.9+fedcba987654', quiet, HOUR + 1000)).toBe(HOUR + HAND_OVER_YIELD_MS);
    expect(await yieldsUntil({ runDir }, '3.7.0+0123456789ab', quiet, HOUR + HAND_OVER_YIELD_MS)).toBeUndefined();
  });

  it('of a newer version, or of another build of the one that left, starts at once: it is the one the daemon made way for', async () => {
    await mark('3.7.0+0123456789ab', HOUR);
    expect(await yieldsUntil({ runDir }, '3.8.0+fedcba987654', quiet, HOUR + 1000)).toBeUndefined();
    expect(await yieldsUntil({ runDir }, '3.7.0+fedcba987654', quiet, HOUR + 1000)).toBeUndefined();
  });

  it('of an older version starts at once when the version that left names no app version', async () => {
    for (const left of ['3.8.01+0123456789ab', '3.8.0-a..b+0123456789ab']) {
      await mark(left, HOUR);
      expect(await yieldsUntil({ runDir }, '3.7.0+fedcba987654', quiet, HOUR + 1000), left).toBeUndefined();
    }
  });

  it('starts at once with no mark, a malformed one or one from the future', async () => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-mark-'));
    folders.push(runDir);
    expect(await yieldsUntil({ runDir }, '3.7.0', quiet, HOUR)).toBeUndefined();
    fs.writeFileSync(path.join(runDir, 'handed-over.json'), '{"version":3,"at":"now"}');
    expect(await yieldsUntil({ runDir }, '3.7.0', quiet, HOUR)).toBeUndefined();
    await markHandedOver({ runDir }, '3.7.0', 2 * HOUR);
    expect(await yieldsUntil({ runDir }, '3.7.0', quiet, HOUR)).toBeUndefined();
  });

  it('starts at once, with a log line, when the mark is no regular file of at most a few hundred bytes', async () => {
    await mark('3.7.0', HOUR);
    const file = path.join(runDir, 'handed-over.json');
    const lines: string[] = [];
    fs.writeFileSync(file, JSON.stringify({ version: '3.7.0', at: HOUR, pad: ' '.repeat(4096) }));
    expect(await yieldsUntil({ runDir }, '3.7.0', (line) => lines.push(line), HOUR + 1000)).toBeUndefined();
    fs.rmSync(file);
    fs.mkdirSync(file);
    expect(await yieldsUntil({ runDir }, '3.7.0', (line) => lines.push(line), HOUR + 1000)).toBeUndefined();
    expect(lines).toEqual([
      `[attach] the hand-over mark ${file} is refused, so this bridge does not yield: it holds more than ${MAX_MARK_BYTES} bytes`,
      `[attach] the hand-over mark ${file} is refused, so this bridge does not yield: it is not a regular file`,
    ]);
  });

  it('starts at once when its own server version cannot be read', async () => {
    const { root } = installed('3.7.0');
    const paths = await localRunPaths();
    await makeRunDir(paths);
    await markHandedOver(paths, '3.7.0', Date.now());
    expect(await handOverYield(root, paths, quiet)).toBeGreaterThan(Date.now());
    expect(await handOverYield(path.join(os.tmpdir(), 'no-such-server-root'), paths, quiet)).toBeUndefined();
    fs.rmSync(path.join(paths.runDir, 'handed-over.json'));
  });

  it('joins the daemon another bridge started while it yields, and starts its own only once the yield is over', async () => {
    const paths = await localRunPaths();
    const start = vi.fn(async () => undefined);
    const joining = connectToDaemon({ paths, start, yieldsUntil: async () => Date.now() + 60_000, log: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(start).not.toHaveBeenCalled();
    running.push(await startInProcessDaemon({ starters: NO_HOSTS }));
    (await joining).socket.destroy();
    expect(start).not.toHaveBeenCalled();
    await Promise.all(running.splice(0).map((daemon) => daemon.shutdown()));

    const own = vi.fn(async () => {
      running.push(await startInProcessDaemon({ starters: NO_HOSTS }));
    });
    const started = Date.now();
    (await connectToDaemon({ paths, start: own, yieldsUntil: async () => started + 600, log: () => undefined })).socket.destroy();
    expect(own).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  });
});

describe('the floor above a bridge', () => {
  const quiet = (): void => undefined;

  it('is the host\'s floor when the bridge\'s app version is below it, whatever its build', async () => {
    const { installDir, root } = installed('3.7.0+0123456789ab');
    expect(await floorAbove(root, quiet)).toBeUndefined();
    await raiseFloor(installDir, '3.9.0', quiet);
    expect(await floorAbove(root, quiet)).toBe('3.9.0');
  });

  it('is none for an app at or above the floor, a rolled-back one included', async () => {
    const { installDir, root } = installed('3.9.0+0123456789ab');
    await raiseFloor(installDir, '3.9.0', quiet);
    expect(await floorAbove(root, quiet)).toBeUndefined();
    const newer = path.join(installDir, '3.10.0+fedcba987654-linux-x64');
    fs.mkdirSync(newer);
    fs.writeFileSync(path.join(newer, 'server-package.json'), JSON.stringify({ version: '3.10.0', serverVersion: '3.10.0+fedcba987654' }));
    expect(await floorAbove(newer, quiet)).toBeUndefined();
  });

  it('is none for a checkout, which no install folder holds, though a floor file sits beside it', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-checkout-'));
    folders.push(parent);
    const checkout = path.join(parent, 'damocles');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '3.7.0' }));
    await raiseFloor(parent, '3.9.0', quiet);
    expect(await floorAbove(checkout, quiet)).toBeUndefined();
  });

  it('cannot decide, so it throws, when the server\'s version cannot be read', async () => {
    const thrown = floorAbove(path.join(os.tmpdir(), 'no-such-server-root'), quiet);
    await expect(thrown).rejects.toThrow(/cannot be read, so no server was started/);
    await expect(thrown).rejects.toMatchObject({ name: 'FloorUnreadableError', reason: 'ENOENT' });
  });

  it('cannot decide, so it throws, when the floor file cannot be read', async () => {
    const { installDir, root } = installed('3.7.0+0123456789ab');
    const floorFile = path.join(installDir, 'security-floor');
    const lstat = fs.promises.lstat;
    const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation((file, ...rest) => (
      file === floorFile ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : lstat(file, ...rest)
    ) as ReturnType<typeof lstat>);
    try {
      const thrown = floorAbove(root, quiet);
      await expect(thrown).rejects.toThrow(/EACCES/);
      await expect(thrown).rejects.toBeInstanceOf(FloorUnreadableError);
      await expect(thrown).rejects.toMatchObject({ reason: 'EACCES' });
    } finally {
      spy.mockRestore();
    }
  });

  // main's prereq-parse.test.ts reads this very line
  it('writes the fail line stage 1 uses, with the errno code as the reason, or unreadable for anything else', () => {
    expect(floorUnreadableLine(new FloorUnreadableError(Object.assign(new Error('denied'), { code: 'EACCES' })))).toBe('@@DAMOCLES {"kind":"fail","code":"floorUnreadable","params":{"reason":"EACCES"}}\n');
    for (const cause of [new Error('no code'), Object.assign(new Error('odd'), { code: 'not an errno; rm -rf' }), 'text']) {
      expect(new FloorUnreadableError(cause).reason).toBe('unreadable');
    }
  });

  it('starts no daemon when it throws, and the bridge fails with its reason', async () => {
    const start = vi.fn(async () => undefined);
    const attempt = connectToDaemon({ paths: await localRunPaths(), start, floorAbove: async () => { throw new Error('the floor cannot be read'); }, deadlineMs: 1000, log: () => undefined });
    await expect(attempt).rejects.toThrow('the floor cannot be read');
    expect(start).not.toHaveBeenCalled();
  });
});
