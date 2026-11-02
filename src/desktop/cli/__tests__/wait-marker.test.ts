import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimWaitMarker, deleteWaitMarker } from '../../main/cli-requests';
import { appArgsOf, resourceRootOf, runLocalCli, WAIT_POLL_MS, type AppExit, type LocalCliIo } from '../cli';
import { parseCommandLine, WAIT_MARKER_NAME, waitMarkerFolder } from '../cli-protocol';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-wait-test-'));
  folders.push(folder);
  return folder;
}

type Launch = { readonly file: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv };

// waitDir is created by the command itself, as ~/.damocles/cli-wait is on a first --wait
function io(waitDir: string, overrides: Partial<LocalCliIo> = {}): LocalCliIo & { readonly launched: Launch[]; readonly errors: string[] } {
  const launched: Launch[] = [];
  const errors: string[] = [];
  return {
    argv: [],
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' },
    cwd: path.join(REPO, 'src'),
    execPath: '/Applications/Damocles.app/Contents/MacOS/Damocles',
    distDir: path.join(REPO, 'dist'),
    waitDir,
    out: () => undefined,
    err: (text) => { errors.push(text); },
    launch: async (file, args, env) => {
      launched.push({ file, args, env });
      return { exited: () => undefined };
    },
    readMarker: async (file) => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    isAlive: () => true,
    sleep: async () => undefined,
    launched,
    errors,
    ...overrides,
  };
}

const markerOf = (launch: Launch | undefined): string => parseCommandLine(launch!.args)!.waitMarker!;

describe('--wait on this computer', () => {
  it('creates a marker in the markers\' folder, hands its path to the app, and returns once the app deleted it, polling once a second', async () => {
    const waitDir = path.join(await scratch(), 'cli-wait');
    let polls = 0;
    const cli = io(waitDir, {
      argv: ['--wait', 'README.md'],
      sleep: async (ms) => {
        expect(ms).toBe(WAIT_POLL_MS);
        polls++;
        // the app takes the request, then closes the tab after the third poll
        if (polls === 1) expect(await claimWaitMarker(markerOf(cli.launched[0]), waitDir, process.pid)).toBe(true);
        if (polls === 3) await deleteWaitMarker(markerOf(cli.launched[0]), waitDir);
      },
    });
    expect(await runLocalCli(cli)).toBe(0);
    expect(polls).toBe(3);
    expect(WAIT_POLL_MS).toBe(1000);
    const marker = markerOf(cli.launched[0]);
    expect(path.basename(marker)).toMatch(WAIT_MARKER_NAME);
    expect(path.dirname(marker)).toBe(waitDir);
    expect(parseCommandLine(cli.launched[0]!.args)?.request).toEqual({ kind: 'open', cwd: path.join(REPO, 'src'), items: [{ path: path.join(REPO, 'src', 'README.md') }], wait: true });
    expect(await fs.readdir(waitDir)).toEqual([]);
    expect(waitMarkerFolder(path.join('/home', 'ada', '.damocles'))).toBe(path.join('/home', 'ada', '.damocles', 'cli-wait'));
  });

  it('starts the app without ELECTRON_RUN_AS_NODE, a development build with main\'s bundle, and returns at once without --wait', async () => {
    const waitDir = path.join(await scratch(), 'cli-wait');
    const cli = io(waitDir, { argv: ['--user-data-dir', 'profile', 'a.txt:3'] });
    expect(await runLocalCli(cli)).toBe(0);
    const [launch] = cli.launched;
    expect(launch!.file).toBe('/Applications/Damocles.app/Contents/MacOS/Damocles');
    expect(launch!.env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(launch!.args.slice(0, 2)).toEqual([path.join(REPO, 'dist', 'desktop', 'main.js'), `--user-data-dir=${path.join(REPO, 'src', 'profile')}`]);
    expect(parseCommandLine(launch!.args)?.request).toEqual({ kind: 'open', cwd: path.join(REPO, 'src'), items: [{ path: path.join(REPO, 'src', 'a.txt'), line: 3 }], wait: false });
    await expect(fs.stat(waitDir)).rejects.toThrow();
  });

  it('passes unknown switches to the app with a warning when it carries no request', async () => {
    const cli = io(await scratch(), { argv: ['--ozone-platform=wayland', '--password-store=gnome-libsecret'] });
    expect(await runLocalCli(cli)).toBe(0);
    expect(cli.launched[0]!.args).toEqual([path.join(REPO, 'dist', 'desktop', 'main.js'), '--ozone-platform=wayland', '--password-store=gnome-libsecret']);
    expect(cli.errors).toEqual([
      'damocles: --ozone-platform=wayland is not an option of the command, so it is passed to the app as it is.\n',
      'damocles: --password-store=gnome-libsecret is not an option of the command, so it is passed to the app as it is.\n',
    ]);
  });

  it('finds the app\'s own files inside app.asar beside app.asar.unpacked, and starts a packaged app with no app path', () => {
    const unpacked = path.join('/opt/Damocles/resources/app.asar.unpacked', 'dist');
    expect(resourceRootOf(unpacked)).toBe(path.join('/opt/Damocles/resources', 'app.asar'));
    expect(appArgsOf(unpacked)).toEqual([]);
    expect(appArgsOf(path.join(REPO, 'dist'))).toEqual([path.join(REPO, 'dist', 'desktop', 'main.js')]);
  });

  it('removes its marker when the app could not start', async () => {
    const waitDir = await scratch();
    const cli = io(waitDir, { argv: ['--wait', 'a'], launch: async () => { throw new Error('ENOENT'); } });
    expect(await runLocalCli(cli)).toBe(1);
    expect(await fs.readdir(waitDir)).toEqual([]);
  });

  it('names the bound a request breaks before it starts the app or makes a marker, and exits 1', async () => {
    const waitDir = path.join(await scratch(), 'cli-wait');
    const run = async (argv: readonly string[]): Promise<{ readonly code: number; readonly errors: readonly string[]; readonly launched: number }> => {
      const cli = io(waitDir, { argv });
      const code = await runLocalCli(cli);
      return { code, errors: cli.errors, launched: cli.launched.length };
    };
    const many = Array.from({ length: 65 }, (_, index) => `f${index}.log`);
    expect(await run(['--wait', ...many])).toEqual({ code: 1, errors: ['damocles: a request names at most 64 paths.\n'], launched: 0 });
    const long = `${'a'.repeat(4097)}.txt`;
    expect(await run([long])).toEqual({ code: 1, errors: [`damocles: ${path.join(REPO, 'src', long).slice(0, 80)}… is longer than 4096 characters.\n`], launched: 0 });
    // 64 paths within each bound, but over 64 KiB together
    const wide = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, '0')}${'b'.repeat(1100)}`);
    expect(await run(wide)).toEqual({ code: 1, errors: ['damocles: the request is over 64 KiB. Name fewer or shorter paths.\n'], launched: 0 });
    expect(await run(['--remote', `ssh+${'h'.repeat(1100)}`, '/srv'])).toMatchObject({ code: 1, launched: 0 });
    await expect(fs.stat(waitDir)).rejects.toThrow();
  });

  it('says so in one line, with no stack trace, when its marker cannot be made or read', async () => {
    const root = await scratch();
    // a file where the markers' folder should be
    await fs.writeFile(path.join(root, 'cli-wait'), '');
    const blocked = io(path.join(root, 'cli-wait'), { argv: ['--wait', 'a'] });
    expect(await runLocalCli(blocked)).toBe(1);
    expect(blocked.launched).toEqual([]);
    expect(blocked.errors).toHaveLength(1);
    expect(blocked.errors[0]).toMatch(/^damocles: the --wait marker .+damocles-wait-[0-9a-f]{32} could not be created: E[A-Z]+: .*\n$/);
    const unreadable = io(path.join(root, 'ok'), { argv: ['--wait', 'a'], readMarker: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
    expect(await runLocalCli(unreadable)).toBe(1);
    expect(unreadable.errors).toEqual([expect.stringMatching(/^damocles: the --wait marker .+ could not be read: EACCES: permission denied\n$/)]);
  });

  it('ends with an error once the app that claimed the marker is gone, removing the marker', async () => {
    const waitDir = path.join(await scratch(), 'cli-wait');
    let alive = true;
    const cli = io(waitDir, {
      argv: ['--wait', 'a'],
      isAlive: (pid) => {
        expect(pid).toBe(4242);
        return alive;
      },
      sleep: async () => {
        await claimWaitMarker(markerOf(cli.launched[0]), waitDir, 4242);
        // the app crashed after taking the request
        alive = false;
      },
    });
    expect(await runLocalCli(cli)).toBe(1);
    expect(cli.errors).toEqual(['damocles: Damocles ended before the tabs were closed.\n']);
    expect(await fs.readdir(waitDir)).toEqual([]);
  });

  it('ends with an error when the app it started exits before claiming the marker, and keeps waiting after a hand-off', async () => {
    const waitDir = path.join(await scratch(), 'cli-wait');
    const started = (exit: AppExit | undefined) => async () => ({ exited: () => exit });
    const crashed = io(waitDir, { argv: ['--wait', 'a'], launch: started({ code: null, signal: 'SIGSEGV' }) });
    expect(await runLocalCli(crashed)).toBe(1);
    expect(crashed.errors).toEqual(['damocles: Damocles exited before it took the request.\n']);
    const failed = io(waitDir, { argv: ['--wait', 'a'], launch: started({ code: 1, signal: null }) });
    expect(await runLocalCli(failed)).toBe(1);
    expect(await fs.readdir(waitDir)).toEqual([]);
    // a second instance exits 0 once the running app has the request, which claims the marker and later deletes it
    let polls = 0;
    const handedOff = io(waitDir, {
      argv: ['--wait', 'a'],
      launch: async (file, args) => {
        handedOff.launched.push({ file, args, env: {} });
        return { exited: () => ({ code: 0, signal: null }) };
      },
      sleep: async () => {
        polls++;
        if (polls === 2) await claimWaitMarker(markerOf(handedOff.launched[0]), waitDir, process.pid);
        if (polls === 4) await deleteWaitMarker(markerOf(handedOff.launched[0]), waitDir);
      },
    });
    expect(await runLocalCli(handedOff)).toBe(0);
    expect(polls).toBe(4);
    expect(handedOff.errors).toEqual([]);
  });

  it('touches only a regular damocles-wait file directly in the markers\' folder', async () => {
    const waitDir = await scratch();
    const other = await scratch();
    const name = `damocles-wait-${'0'.repeat(32)}`;
    await fs.writeFile(path.join(other, name), '');
    await expect(deleteWaitMarker(path.join(other, name), waitDir)).rejects.toThrow('is not in the wait markers\' folder');
    await expect(claimWaitMarker(path.join(other, name), waitDir, 1)).rejects.toThrow('is not in the wait markers\' folder');
    await fs.writeFile(path.join(waitDir, 'notes.txt'), '');
    await expect(deleteWaitMarker(path.join(waitDir, 'notes.txt'), waitDir)).rejects.toThrow('is not a damocles-wait marker');
    await expect(claimWaitMarker(path.join(waitDir, 'notes.txt'), waitDir, 1)).rejects.toThrow('is not a damocles-wait marker');
    await fs.mkdir(path.join(waitDir, name));
    await expect(deleteWaitMarker(path.join(waitDir, name), waitDir)).rejects.toThrow('is not a file');
    await expect(claimWaitMarker(path.join(waitDir, name), waitDir, 1)).rejects.toThrow('is not a file');
    await fs.rmdir(path.join(waitDir, name));
    // gone already: nothing to do, and nothing to claim
    await expect(deleteWaitMarker(path.join(waitDir, name), waitDir)).resolves.toBeUndefined();
    await expect(claimWaitMarker(path.join(waitDir, name), waitDir, 1)).resolves.toBe(false);
    expect((await fs.readdir(other)).sort()).toEqual([name]);
    expect(await fs.readFile(path.join(other, name), 'utf8')).toBe('');
    expect(await fs.readdir(waitDir)).toEqual(['notes.txt']);
  });
});
