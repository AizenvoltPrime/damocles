import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonConfigWriteError, jsonConfigWritesSettled, writeJsonConfig } from '../json-config-write';
import { flushAcrossHeldRename } from '../../../__mocks__/held-rename';

const POSIX = process.platform !== 'win32';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-jcw-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const siblings = (file: string): string[] => fs.readdirSync(path.dirname(file)).sort();
const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

describe('writeJsonConfig modes', () => {
  it.runIf(POSIX)('creates a new file and its directories with the given modes', async () => {
    const file = path.join(dir, 'a', 'b', 'mcp.json');
    await writeJsonConfig(file, () => '{}', { fileMode: 0o600, dirMode: 0o700 });
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(path.dirname(file))).toBe(0o700);
    expect(modeOf(path.join(dir, 'a'))).toBe(0o700);
  });

  it.runIf(POSIX)('keeps an existing file\'s mode when no mode is given', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o640);
    await writeJsonConfig(file, () => '{"a":1}');
    expect(modeOf(file)).toBe(0o640);
  });

  it.runIf(POSIX)('tightens an existing file to the given mode on every write', async () => {
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, '{"mcpServers":{}}');
    fs.chmodSync(file, 0o644);
    await writeJsonConfig(file, () => '{"mcpServers":{"x":{}}}', { fileMode: 0o600 });
    expect(modeOf(file)).toBe(0o600);
    fs.chmodSync(file, 0o644);
    await writeJsonConfig(file, (current) => current!, { fileMode: 0o600 });
    expect(modeOf(file)).toBe(0o600);
  });
});

describe('writeJsonConfig failures', () => {
  it('passes a mutation error through unchanged and leaves the file, the lock and no temp file behind', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{"keep":true}');
    const refusal = new Error('refused');
    await expect(writeJsonConfig(file, () => {
      throw refusal;
    })).rejects.toBe(refusal);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"keep":true}');
    expect(siblings(file)).toEqual(['settings.json']);
  });

  it('removes its temp file when the rename fails', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    const failed = writeJsonConfig(file, () => '{"a":1}');
    await expect(failed).rejects.toBeInstanceOf(JsonConfigWriteError);
    await expect(failed).rejects.toMatchObject({ stage: 'write' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
    expect(siblings(file)).toEqual(['settings.json']);
  });

  it('retries a rename Windows refuses while another process has the target open', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const file = path.join(dir, 'settings.json');
      const rename = fsp.rename.bind(fsp);
      const spy = vi.spyOn(fsp, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
        .mockImplementation(rename);
      await writeJsonConfig(file, () => '{"a":1}');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('refuses to rename once another writer has taken the lock over', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    const failed = writeJsonConfig(file, async () => {
      // Another process's takeover gives the lock dir an mtime this holder never wrote; the heartbeat notices.
      const foreign = new Date(Date.now() + 60_000);
      fs.utimesSync(`${file}.lock`, foreign, foreign);
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      return '{"lost":true}';
    });
    await expect(failed).rejects.toMatchObject({ stage: 'write', code: 'ECOMPROMISED' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
    expect(siblings(file)).toEqual(['settings.json', 'settings.json.lock']);
  }, 10_000);

  it('reports a landed write as a success when the lock cannot be released', async () => {
    const file = path.join(dir, 'settings.json');
    const lockDir = `${file}.lock`;
    await writeJsonConfig(file, () => {
      // A non-empty lock dir fails the release's rmdir, as antivirus holding it open does on Windows.
      fs.writeFileSync(path.join(lockDir, 'held'), '');
      return '{"a":1}';
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
  });
});

describe('writeJsonConfig durability', () => {
  it('flushes the temp file to disk before renaming it over the target', async () => {
    const file = path.join(dir, 'settings.json');
    const events: string[] = [];
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push('sync');
        await sync();
      };
      return handle;
    });
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      events.push('rename');
      await rename(from, to);
    });
    await writeJsonConfig(file, () => '{"a":1}');
    expect(events).toEqual(['sync', 'rename']);
  });

  it('removes a temp file a crashed writer left beside the target', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(`${file}.424242.tmp`, '{"half":');
    fs.writeFileSync(path.join(dir, 'settings.json.notes.tmp'), 'unrelated');
    await writeJsonConfig(file, () => '{}');
    expect(siblings(file)).toEqual(['settings.json', 'settings.json.notes.tmp']);
  });

  it('does not rewrite a file whose text the mutation leaves unchanged', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{"a":1}\n');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    await writeJsonConfig(file, (current) => current!);
    expect(fs.statSync(file).mtime.getTime()).toBe(old.getTime());
  });
});

describe('writeJsonConfig symlinks', () => {
  it('writes through a symlinked file to its target and keeps the link', async () => {
    const real = path.join(dir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, '{}');
    const link = path.join(dir, 'settings.json');
    fs.symlinkSync(real, link, 'file');
    await writeJsonConfig(link, () => '{"a":1}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"a":1}');
  });

  it('creates the file a dangling symlink names instead of replacing the link', async () => {
    const real = path.join(dir, 'dotfiles', 'settings.json');
    const link = path.join(dir, 'settings.json');
    fs.symlinkSync(real, link, 'file');
    await writeJsonConfig(link, () => '{"a":1}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"a":1}');
  });

  describe('confined to a repository directory', () => {
    let folder: string;
    let claudeFile: string;

    beforeEach(() => {
      folder = path.join(dir, 'repo');
      claudeFile = path.join(folder, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
      fs.writeFileSync(claudeFile, '{"claude":true}');
    });

    it('writes a plain file inside the directory, creating it', async () => {
      const file = path.join(folder, '.damocles', 'settings.json');
      await writeJsonConfig(file, () => '{}', { confineTo: path.join(folder, '.damocles') });
      expect(fs.readFileSync(file, 'utf8')).toBe('{}');
    });

    it('refuses a file symlinked to another tool\'s file', async () => {
      const file = path.join(folder, '.damocles', 'settings.json');
      fs.mkdirSync(path.dirname(file));
      fs.symlinkSync(claudeFile, file, 'file');
      await expect(writeJsonConfig(file, () => '{}', { confineTo: path.join(folder, '.damocles') }))
        .rejects.toMatchObject({ stage: 'write' });
      expect(fs.readFileSync(claudeFile, 'utf8')).toBe('{"claude":true}');
    });

    it('refuses a directory symlinked to another tool\'s directory, even for a file not there yet', async () => {
      fs.symlinkSync(path.dirname(claudeFile), path.join(folder, '.damocles'), 'junction');
      const file = path.join(folder, '.damocles', 'settings.local.json');
      await expect(writeJsonConfig(file, () => '{}', { confineTo: path.join(folder, '.damocles') }))
        .rejects.toMatchObject({ stage: 'write' });
      expect(fs.existsSync(path.join(path.dirname(claudeFile), 'settings.local.json'))).toBe(false);
    });
  });
});

describe('jsonConfigWritesSettled', () => {
  it('resolves with nothing queued', async () => {
    await expect(jsonConfigWritesSettled(path.join(dir, 'none.json'))).resolves.toBeUndefined();
  });

  it('waits for the write in flight and for one queued while it waits, and never rejects', async () => {
    const file = path.join(dir, 'state.json');
    const writes: Array<Promise<unknown>> = [];
    const onDisk = await flushAcrossHeldRename(file, {
      first: () => writes.push(writeJsonConfig(file, () => '1')),
      flush: () => jsonConfigWritesSettled(file),
      second: () => writes.push(
        expect(writeJsonConfig(file, () => { throw new Error('mutation failed'); })).rejects.toThrow('mutation failed'),
        writeJsonConfig(file, () => '2'),
      ),
      onDisk: () => fs.readFileSync(file, 'utf8'),
    });
    expect(onDisk).toBe('2');
    await Promise.all(writes);
  });
});
