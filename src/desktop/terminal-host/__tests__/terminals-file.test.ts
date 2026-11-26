import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostTerminalsFile, runPaths, type RunPaths } from '../../daemon/token';
import { MAX_HOSTED_TERMINALS, type HostedTerminal } from '../host-messages';
import { MAX_TERMINALS_FILE_BYTES, parseHostTerminals, readHostTerminals, writeHostTerminals } from '../terminals-file';

const POSIX = process.platform !== 'win32';
let home: string;
let paths: RunPaths;
let lines: string[];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-terminals-'));
  paths = runPaths(home, '0123456789abcdef');
  await fs.mkdir(paths.terminalHostsDir, { recursive: true });
  lines = [];
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const hosted = (n: number, extra: Partial<HostedTerminal> = {}): HostedTerminal => ({ id: `term-${n}`, pid: 4000 + n, cols: 80, rows: 24, scrollback: 1000, title: 'bash', projectKey: '/home/dev/app', ...extra });
const log = (line: string): void => void lines.push(line);
const parse = (raw: unknown): ReturnType<typeof parseHostTerminals> => parseHostTerminals(JSON.stringify(raw));

describe('a terminal host\'s terminals file', () => {
  it('is written whole through a temporary file, user-only, and read back as written', async () => {
    const file = hostTerminalsFile(paths, 77);
    const content = { hostStart: 'boot:100', terminals: [{ ...hosted(1, { view: '{"rootKey":"a"}', detachedAt: 5 }), start: 'boot:200' }, hosted(2)] };
    await writeHostTerminals(file, content);
    expect(await fs.readdir(paths.terminalHostsDir)).toEqual(['77.terminals']);
    if (POSIX) expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await readHostTerminals(paths, 77, log)).toEqual(content);
    expect(lines).toEqual([]);
  });

  it('keeps the file it had when a write fails before its rename', async () => {
    const file = hostTerminalsFile(paths, 77);
    await writeHostTerminals(file, { hostStart: 'boot:100', terminals: [hosted(1)] });
    // the temporary file's name taken by a folder: the write fails before anything replaces the file
    await fs.mkdir(`${file}.tmp`);
    await expect(writeHostTerminals(file, { hostStart: 'boot:100', terminals: [] })).rejects.toThrow();
    expect(await readHostTerminals(paths, 77, log)).toEqual({ hostStart: 'boot:100', terminals: [hosted(1)] });
  });

  it('refuses to write more than the byte bound, leaving the file it had', async () => {
    const file = hostTerminalsFile(paths, 77);
    await writeHostTerminals(file, { terminals: [hosted(1)] });
    await expect(writeHostTerminals(file, { terminals: [hosted(1), hosted(2)] }, 200)).rejects.toThrow(/more than 200 bytes/);
    expect(await readHostTerminals(paths, 77, log)).toEqual({ terminals: [hosted(1)] });
  });

  it('is none for a host that wrote none', async () => {
    expect(await readHostTerminals(paths, 77, log)).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('is refused whole when it is larger than the bound, without being read', async () => {
    const file = hostTerminalsFile(paths, 77);
    await fs.writeFile(file, '');
    await fs.truncate(file, MAX_TERMINALS_FILE_BYTES + 1);
    expect(await readHostTerminals(paths, 77, log)).toBeUndefined();
    expect(lines).toEqual([`[terminal] the terminals file of the terminal host 77 is refused: it holds ${MAX_TERMINALS_FILE_BYTES + 1} bytes, more than ${MAX_TERMINALS_FILE_BYTES}`]);
  });

  it('is refused whole when it is no JSON, no object, holds no list, a list past the host\'s bound, or a host identity of another type', async () => {
    expect(parseHostTerminals('{"terminals": [')).toBeUndefined();
    for (const raw of [null, [], 'text', {}, { terminals: {} }, { terminals: [], hostStart: 7 }, { terminals: [], hostStart: '' }, { terminals: Array.from({ length: MAX_HOSTED_TERMINALS + 1 }, (_, n) => hosted(n + 1)) }]) {
      expect(parse(raw)).toBeUndefined();
    }
    await fs.writeFile(hostTerminalsFile(paths, 77), '{ not json');
    expect(await readHostTerminals(paths, 77, log)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[terminal\] the terminals file of the terminal host 77 is refused: it does not parse/);
  });

  it('drops each entry outside the host contract or with a malformed identity, and a second entry of one id', () => {
    const good = hosted(1);
    expect(parse({ hostStart: 'b:1', terminals: [
      good,
      { ...hosted(2), pid: '4002' },
      { ...hosted(3), id: 'not-a-terminal' },
      { ...hosted(4), cols: 0 },
      { ...hosted(5), title: 'x'.repeat(1025) },
      { ...hosted(6), start: 42 },
      { ...hosted(7), start: '' },
      'term-8',
      null,
      { ...hosted(1), title: 'again' },
    ] })).toEqual({ hostStart: 'b:1', terminals: [good] });
  });

  it('ignores the fields it does not know, at the top and in each entry', () => {
    expect(parse({ hostStart: 'b:1', later: { any: 1 }, terminals: [{ ...hosted(1), start: 'b:2', later: [1, 2] }] })).toEqual({ hostStart: 'b:1', terminals: [{ ...hosted(1), start: 'b:2' }] });
  });
});
