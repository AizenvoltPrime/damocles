import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { belowFloor, FLOOR_FILE, installDirOf, MAX_FLOOR_BYTES, raiseFloor, readFloor } from '../security-floor';

let installDir: string;
let lines: string[];
const log = (line: string): void => {
  lines.push(line);
};

beforeEach(() => {
  installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-floor-'));
  lines = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(installDir, { recursive: true, force: true });
});

const floorFile = (): string => path.join(installDir, FLOOR_FILE);

describe('the host\'s security floor', () => {
  it('is absent until a daemon raises it, then holds that minimum', async () => {
    expect(await readFloor(installDir, log)).toBeUndefined();
    expect(lines).toEqual([]);
    await raiseFloor(installDir, '3.8.0', log);
    expect(await readFloor(installDir, log)).toBe('3.8.0');
    expect(fs.readFileSync(floorFile(), 'utf8')).toBe('3.8.0\n');
    expect(lines).toEqual(['[floor] the host\'s security floor is now 3.8.0']);
  });

  it('is raised only upward: a lower or equal minimum leaves the file untouched', async () => {
    await raiseFloor(installDir, '3.8.0', log);
    const written = fs.statSync(floorFile()).mtimeMs;
    for (const minimum of ['3.7.9', '3.8.0', '3.8.0-beta.1']) await raiseFloor(installDir, minimum, log);
    expect(await readFloor(installDir, log)).toBe('3.8.0');
    expect(fs.statSync(floorFile()).mtimeMs).toBe(written);
    await raiseFloor(installDir, '3.10.0', log);
    expect(await readFloor(installDir, log)).toBe('3.10.0');
    expect(lines.at(-1)).toBe('[floor] the host\'s security floor is now 3.10.0, raised from 3.8.0');
  });

  it('is written to a temporary file and renamed into place, owner-only, leaving nothing else in the install folder', async () => {
    await raiseFloor(installDir, '3.8.0', log);
    await raiseFloor(installDir, '3.9.0', log);
    expect(fs.readdirSync(installDir)).toEqual([FLOOR_FILE]);
    if (process.platform !== 'win32') expect(fs.statSync(floorFile()).mode & 0o777).toBe(0o600);
  });

  it('leaves the floor as it was and no temporary file when the write fails', async () => {
    await expect(raiseFloor(path.join(installDir, 'missing'), '3.8.0', log)).rejects.toThrow();
    await expect(raiseFloor(installDir, '3.8.0+0123456789ab', log)).rejects.toThrow('is no app version');
    expect(fs.readdirSync(installDir)).toEqual([]);
  });

  it('reads anything but an app version as no floor, and says so in the log; a later minimum replaces it', async () => {
    for (const text of ['', 'latest\n', '3.8\n', '3.8.0+0123456789ab\n', '3.8.0\n3.9.0\n', '../3.8.0']) {
      fs.writeFileSync(floorFile(), text);
      lines = [];
      expect(await readFloor(installDir, log), JSON.stringify(text)).toBeUndefined();
      expect(lines).toEqual([`[floor] ${floorFile()} holds no version, so the host has no security floor`]);
    }
    await raiseFloor(installDir, '3.8.0', log);
    expect(await readFloor(installDir, log)).toBe('3.8.0');
  });

  it('keeps a higher floor when the file cannot be read, which tells no floor from an unread one', async () => {
    await raiseFloor(installDir, '3.9.0', log);
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    for (const name of ['lstat', 'open', 'readFile'] as const) {
      const real = fs.promises[name] as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        if (String(file) === floorFile()) throw denied;
        return real(file, ...rest);
      }) as never);
    }
    await expect(readFloor(installDir, log)).rejects.toBe(denied);
    await expect(raiseFloor(installDir, '3.8.0', log)).rejects.toBe(denied);
    vi.restoreAllMocks();
    expect(await readFloor(installDir, log)).toBe('3.9.0');
  });

  it('reads anything but a regular file of at most a few hundred bytes as no floor, and says so in the log', async () => {
    fs.writeFileSync(floorFile(), `3.8.0${' '.repeat(4096)}\n`);
    expect(await readFloor(installDir, log)).toBeUndefined();
    expect(lines).toEqual([`[floor] ${floorFile()} is refused, so the host has no security floor: it holds more than ${MAX_FLOOR_BYTES} bytes`]);
    fs.rmSync(floorFile());
    fs.mkdirSync(floorFile());
    lines = [];
    expect(await readFloor(installDir, log)).toBeUndefined();
    expect(lines).toEqual([`[floor] ${floorFile()} is refused, so the host has no security floor: it is not a regular file`]);
    fs.rmdirSync(floorFile());
    if (process.platform === 'win32') return;
    const elsewhere = path.join(installDir, 'elsewhere');
    fs.writeFileSync(elsewhere, '3.8.0\n');
    fs.symlinkSync(elsewhere, floorFile());
    lines = [];
    expect(await readFloor(installDir, log)).toBeUndefined();
    expect(lines).toEqual([`[floor] ${floorFile()} is refused, so the host has no security floor: it is not a regular file`]);
  });

  it('is raised under its own lock beside it, which daemons of machines sharing the install folder take in turn', async () => {
    const release = await lockfile.lock(floorFile(), { lockfilePath: `${floorFile()}.lock`, realpath: false });
    const raising = raiseFloor(installDir, '3.8.0', log);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fs.existsSync(floorFile())).toBe(false);
    await release();
    await raising;
    expect(await readFloor(installDir, log)).toBe('3.8.0');
    await Promise.all(['3.9.0', '3.10.0', '3.8.5', '3.9.9'].map((minimum) => raiseFloor(installDir, minimum, log)));
    expect(await readFloor(installDir, log)).toBe('3.10.0');
    expect(fs.readdirSync(installDir)).toEqual([FLOOR_FILE]);
  });

  it('is above an app of a lower version, a prerelease of it included, and never above the same or a newer one', () => {
    expect(belowFloor('3.7.9', '3.8.0')).toBe(true);
    expect(belowFloor('3.8.0-beta.1', '3.8.0')).toBe(true);
    expect(belowFloor('nightly', '3.8.0')).toBe(true);
    for (const appVersion of ['3.9.0-a..b', '3.9.01', '3.9.0-01']) expect(belowFloor(appVersion, '3.8.0'), appVersion).toBe(true);
    expect(belowFloor('3.8.0', '3.8.0')).toBe(false);
    expect(belowFloor('3.10.0', '3.8.0')).toBe(false);
  });
});

describe('the install folder of a server', () => {
  it('is the folder that holds its version folder, and none for a checkout or the desktop app\'s own daemon', () => {
    const install = path.join(os.homedir(), '.damocles', 'server');
    expect(installDirOf(path.join(install, '3.8.0+0123456789ab-linux-x64'), '3.8.0+0123456789ab')).toBe(install);
    expect(installDirOf(path.join(install, '3.8.0-win32-arm64'), '3.8.0')).toBe(install);
    expect(installDirOf(path.join(os.homedir(), 'src', 'damocles'), '3.8.0')).toBeUndefined();
    expect(installDirOf(path.join(install, '3.8.0+0123456789ab-linux-x64'), '3.8.0+fedcba987654')).toBeUndefined();
  });
});
