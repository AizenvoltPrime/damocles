import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { rgPath } from '@vscode/ripgrep';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createFindTool, createGrepTool, fdGlobMatcher, GREP_PARAMETER_NAMES, resolveToCwd } from '../search-tools';
import { BATCH_COMMAND_LINE, commandLineCost, walkedRgRuns } from '../../../search-walk';
import { processLauncher } from '../../../process-launcher';
import { PermissionHandler } from '../../../permission-handler';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { getPiCodingAgent } from '../../pi-loader';

// 8 logical CPUs, so walked Grep keeps 4 rg runs live on any machine.
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), availableParallelism: () => 8 }));

/** Every file the override's own code reads; pi's grep, loaded from node_modules, is not seen here. */
const filesRead = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: ((file: string, ...rest: never[]) => {
      filesRead.push(String(file));
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.readFile,
  };
});

// pi fixes its tool directory when it loads and looks there before PATH, so a developer's downloaded
// `~/.pi/agent/bin/rg` would otherwise replace the bundled rg the oracle is meant to share.
await vi.hoisted(async () => {
  const { tmpdir: osTmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');
  process.env['PI_CODING_AGENT_DIR'] = pathJoin(osTmpdir(), `damocles-search-no-pi-${process.pid}`);
});
// The REAL pi module, imported after the directory is redirected: pi's grep is the oracle for ours.
const pi = (await import('@earendil-works/pi-coding-agent')) as unknown as PiCodingAgentModule;
delete process.env['PI_CODING_AGENT_DIR'];

const resolveRg = (): Promise<string> => Promise.resolve(rgPath);
const noReadRules = (): Promise<(filePath: string) => boolean> => Promise.resolve(() => false);
const noHosts = (): Promise<ReadonlySet<string>> => Promise.resolve(new Set());

type AnyResult = AgentToolResult<unknown>;
type SearchTool = ReturnType<typeof createGrepTool>;

let root: string;

function write(relative: string, content: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function text(result: AnyResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('tool result did not start with a text block');
  return first.text;
}

function execute(tool: SearchTool, params: Record<string, unknown>, signal?: AbortSignal): Promise<AnyResult> {
  return tool.execute('call', params as never, signal, undefined, { cwd: root } as never) as Promise<AnyResult>;
}

async function run(tool: SearchTool, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return text(await execute(tool, params, signal));
}

beforeAll(() => {
  // Outside any git repository, so find must pass --no-require-git for .gitignore to apply, as fd does.
  root = mkdtempSync(join(tmpdir(), 'damocles-search-'));
  write('.gitignore', 'ignored.ts\nbuild/\n');
  write('src/app.ts', 'export const answer = 42;\nconst hidden = "needle";\n');
  write('src/deep/util.spec.ts', 'needle one\nplain\nneedle two\n');
  write('src/README.MD', 'Needle in caps\n');
  write('src/ spaced.ts', 'needle spaced\n');
  write('ignored.ts', 'needle ignored\n');
  write('build/out.ts', 'needle built\n');
  write('node_modules/pkg/index.ts', 'needle vendored\n');
  write('node_modules/pkg/lib/types.d.ts', 'export {};\n');
  write('.config/settings.json', '{"needle": true}\n');
  write('long.txt', `needle ${'x'.repeat(600)}\n`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('grep', () => {
  /** pi's grep resolves `rg` on PATH; offline, it can never download one. */
  const piGrep = (): SearchTool => {
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv('PATH', `${dirname(rgPath)}${delimiter}${process.env['PATH'] ?? ''}`);
    return pi.createGrepToolDefinition(root) as never;
  };
  // ripgrep searches files in parallel, so the order across files differs between runs.
  const sortedText = (result: AnyResult): string[] => text(result).split('\n').sort();

  const cases: Array<[string, Record<string, unknown>]> = [
    ['a plain search', { pattern: 'needle' }],
    ['a case-insensitive literal search in a subdirectory', { pattern: 'NEEDLE', path: 'src', ignoreCase: true, literal: true }],
    ['a glob filter', { pattern: 'needle', glob: '*.spec.ts' }],
    ['context lines', { pattern: 'plain', context: 1 }],
    ['a match limit', { pattern: 'needle', path: 'src/deep/util.spec.ts', limit: 1 }],
    ['exactly as many matches as the limit', { pattern: 'needle', path: 'src/deep/util.spec.ts', limit: 2 }],
    ['a fractional limit and context', { pattern: 'needle', path: 'src/deep/util.spec.ts', limit: 1.5, context: 1.5 }],
    ['a single file', { pattern: 'needle', path: 'src/deep/util.spec.ts' }],
    ['a pattern that starts with a dash', { pattern: '-foo' }],
    ['no match', { pattern: 'absent-token' }],
  ];

  it.each(cases)('matches pi grep for %s', async (_label, params) => {
    const expected = await execute(piGrep(), params);
    const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
    expect(sortedText(actual)).toEqual(sortedText(expected));
    expect(actual.details).toEqual(expected.details);
  });

  it('fails like pi grep on an invalid regex', async () => {
    const expected = await execute(piGrep(), { pattern: '(' }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(expected).toMatch(/regex parse error/);
    await expect(execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: '(' })).rejects.toThrow(expected);
  });

  it('runs the bundled ripgrep when rg is on no PATH and pi may not download', async () => {
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv('PATH', '');
    await expect(run(pi.createGrepToolDefinition(root) as never, { pattern: 'needle' })).rejects.toThrow(/not available/);
    expect(await run(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'answer' })).toBe('src/app.ts:1: export const answer = 42;');
  });

  it('handles every parameter of pi grep schema', () => {
    const properties = (pi.createGrepToolDefinition(root).parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual([...GREP_PARAMETER_NAMES].sort());
    expect(createGrepTool(pi, root, resolveRg, noReadRules, noHosts).name).toBe('grep');
  });

  it('ignores a ripgrep config file, as pi grep does', async () => {
    write('rgconfig/dots.txt', 'aXb\na.b\n');
    const config = `${root}.rgrc`;
    writeFileSync(config, '--fixed-strings\n');
    try {
      const params = { pattern: 'a.b', path: 'rgconfig', literal: false };
      vi.stubEnv('RIPGREP_CONFIG_PATH', config);
      const expected = await execute(piGrep(), params);
      const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
      expect(sortedText(actual)).toEqual(['dots.txt:1: aXb', 'dots.txt:2: a.b']);
      expect(sortedText(actual)).toEqual(sortedText(expected));
    } finally {
      rmSync(config, { force: true });
      rmSync(join(root, 'rgconfig'), { recursive: true, force: true });
    }
  });

  it('rejects a missing path and an aborted call', async () => {
    const tool = createGrepTool(pi, root, resolveRg, noReadRules, noHosts);
    await expect(run(tool, { pattern: 'x', path: 'nope' })).rejects.toThrow(`Path not found: ${join(root, 'nope')}`);
    await expect(run(tool, { pattern: 'x' }, AbortSignal.abort())).rejects.toThrow('Operation aborted');
  });

  describe('below a path', () => {
    beforeAll(() => {
      write('pkg/src/a.ts', 'needle pkg\n');
      write('pkg/src/b.js', 'needle js\n');
      write('pkg/top.ts', 'needle top\n');
      write('pkg/window.txt', 'needle 1\nx\nneedle 3\ny\nz\nneedle 6\n');
      writeFileSync(join(root, 'pkg', 'latin1.txt'), Buffer.from('needle caf\xe9\n', 'latin1'));
      write('pkg/cr.txt', 'one\rtwo needle\r\nnext\r\n');
      writeFileSync(join(root, 'pkg', 'utf16.txt'), Buffer.from('\uFEFFbefore\nneedle 中文\nafter\n', 'utf16le'));
      write('pkg/byte-cap.txt', Array.from({ length: 200 }, () => `needle ${'x'.repeat(400)}`).join('\n'));
    });

    afterAll(() => {
      rmSync(join(root, 'pkg'), { recursive: true, force: true });
    });

    const pkgCases: Array<[string, Record<string, unknown>]> = [
      ['a glob relative to path', { pattern: 'needle', path: 'pkg', glob: 'src/**/*.ts' }],
      ['a glob with a leading ./', { pattern: 'needle', path: 'pkg', glob: './src/*.ts' }],
      ['a negated glob with a leading ./', { pattern: 'needle (pkg|js|top)', path: 'pkg', glob: '!./src/*.ts' }],
      ['context around a match limit', { pattern: 'needle', path: 'pkg/window.txt', context: 2, limit: 1 }],
      ['context after exactly as many matches as the limit', { pattern: 'needle', path: 'pkg/window.txt', context: 1, limit: 3 }],
      ['context in a directory search', { pattern: 'needle 3', path: 'pkg', context: 1 }],
      ['a line that is not UTF-8', { pattern: 'needle', path: 'pkg/latin1.txt' }],
      ['a carriage return inside a line', { pattern: 'needle', path: 'pkg/cr.txt', context: 1 }],
      ['overlapping context', { pattern: 'needle', path: 'pkg/window.txt', context: 2 }],
      ['a huge context value', { pattern: 'needle 3', path: 'pkg/window.txt', context: 1e30 }],
      ['context in a UTF-16 file', { pattern: 'needle', path: 'pkg/utf16.txt', context: 1 }],
      ['matches past the byte cap', { pattern: 'needle', path: 'pkg/byte-cap.txt', limit: 150 }],
    ];

    it.each(pkgCases)('matches pi grep for %s', async (_label, params) => {
      const expected = await execute(piGrep(), params);
      const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
      expect(sortedText(actual)).toEqual(sortedText(expected));
      expect(actual.details).toEqual(expected.details);
    });

    it('roots the glob at path, with or without a leading ./', async () => {
      const tool = createGrepTool(pi, root, resolveRg, noReadRules, noHosts);
      expect(await run(tool, { pattern: 'needle', path: 'pkg', glob: 'src/**/*.ts' })).toBe('src/a.ts:1: needle pkg');
      expect(await run(tool, { pattern: 'needle', path: 'pkg', glob: './src/*.ts' })).toBe('src/a.ts:1: needle pkg');
    });

    it('roots the glob at a path that is a link', async () => {
      const link = join(root, 'pkg-link');
      // A junction on Windows, which needs no symlink privilege; the type is ignored elsewhere.
      symlinkSync(join(root, 'pkg'), link, 'junction');
      try {
        const params = { pattern: 'needle', path: 'pkg-link', glob: 'src/**/*.ts' };
        expect(await run(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params)).toBe('src/a.ts:1: needle pkg');
        expect(await run(piGrep(), params)).toBe('src/a.ts:1: needle pkg');
      } finally {
        unlinkSync(link);
      }
    });

    it('takes context lines from rg without reading the file', async () => {
      filesRead.length = 0;
      expect(await run(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle 3', path: 'pkg/window.txt', context: 1 }))
        .toBe('window.txt-2- x\nwindow.txt:3: needle 3\nwindow.txt-4- y');
      expect(filesRead).toEqual([]);
    });

    it('shows a match inside the last allowed match\'s trailing context as context, and only a later match sets the notice', async () => {
      const tool = createGrepTool(pi, root, resolveRg, noReadRules, noHosts);
      expect(await run(tool, { pattern: 'needle', path: 'pkg/window.txt', context: 2, limit: 1 }))
        .toBe('window.txt:1: needle 1\nwindow.txt-2- x\nwindow.txt-3- needle 3\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]');
      expect(await run(tool, { pattern: 'needle', path: 'pkg/window.txt', limit: 3 })).toBe('window.txt:1: needle 1\nwindow.txt:3: needle 3\nwindow.txt:6: needle 6');
    });
  });

  describe('over the files the walk lists', () => {
    const many = 'many';
    // names of about 100 characters, more than one command line holds; one in four matches, so the output stays within pi's cap
    const manyFiles = Math.ceil(BATCH_COMMAND_LINE / 80);
    beforeAll(() => {
      for (let index = 0; index < manyFiles; index++) write(`${many}/${String(index).padStart(4, '0')}-${'n'.repeat(90)}.txt`, `${index % 4 === 0 ? 'needle' : 'other'} ${index}\nplain\n`);
      write(`${many}/sub dir/spaced name.txt`, 'needle spaced\n');
      // a NUL in rg's first read buffer: rg's own walk skips the file, a file named on its command line is searched
      writeFileSync(join(root, many, 'binary.png'), Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n'), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR needle\n')]));
    });

    afterAll(() => {
      rmSync(join(root, many), { recursive: true, force: true });
    });

    it('matches pi grep across several rg runs, each command line within the batch budget', async () => {
      const launch = vi.spyOn(processLauncher(), 'launch');
      try {
        const params = { pattern: 'needle', path: many, limit: manyFiles + 10 };
        const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
        const lengths = launch.mock.calls.map(([spec]) => [spec.file, ...spec.args].reduce((sum, arg) => sum + commandLineCost(arg), 0));
        expect(lengths.length).toBeGreaterThan(1);
        for (const length of lengths) expect(length).toBeLessThanOrEqual(BATCH_COMMAND_LINE);
        launch.mockClear();
        const expected = await execute(piGrep(), params);
        expect(sortedText(actual)).toEqual(sortedText(expected));
        expect(actual.details).toEqual(expected.details);
        expect(text(actual)).not.toContain('binary.png');
      } finally {
        launch.mockRestore();
      }
    });

    it('stops at the match limit across rg runs, as pi grep does', async () => {
      const params = { pattern: 'needle', path: many, limit: 5 };
      const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
      const expected = await execute(piGrep(), params);
      expect(actual.details).toEqual(expected.details);
      expect(text(actual).split('\n').filter((line) => line.includes(': needle'))).toHaveLength(5);
    });

    it('runs up to walkedRgRuns() rg at once, stops at exactly the limit and keeps each file\'s lines together', async () => {
      const launcher = processLauncher();
      const original = launcher.launch.bind(launcher);
      let running = 0;
      let most = 0;
      const launch = vi.spyOn(launcher, 'launch').mockImplementation((spec, options) => {
        const child = original(spec, options);
        most = Math.max(most, ++running);
        // each run stays live a while past its exit, so the runs overlap
        const exited = child.exited.then(async (exit) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          running--;
          return exit;
        });
        return { ...child, exited };
      });
      try {
        const params = { pattern: 'needle|other', path: many, limit: 150, context: 1 };
        const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
        expect(most).toBeGreaterThan(1);
        expect(most).toBeLessThanOrEqual(walkedRgRuns());
        launch.mockRestore();
        const expected = await execute(piGrep(), params);
        expect(actual.details).toEqual(expected.details);
        const lines = text(actual).split('\n\n')[0]!.split('\n');
        expect(lines.filter((line) => /^[^:]+:\d+: /.test(line))).toHaveLength(150);
        const files = lines.map((line) => /^(.+?)[-:]\d+[-:] /.exec(line)![1]);
        expect(files.filter((file, index) => file !== files[index - 1])).toEqual([...new Set(files)]);
      } finally {
        launch.mockRestore();
      }
    });

    it('stops the walk and rg on an abort while rg runs', async () => {
      const controller = new AbortController();
      const launcher = processLauncher();
      const original = launcher.launch.bind(launcher);
      const started: Array<Promise<unknown>> = [];
      const launch = vi.spyOn(launcher, 'launch').mockImplementation((...args) => {
        const child = original(...args);
        started.push(child.exited);
        controller.abort();
        return child;
      });
      try {
        await expect(execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle', path: many }, controller.signal)).rejects.toThrow('Operation aborted');
        expect(started).toHaveLength(1);
        await Promise.all(started);
      } finally {
        launch.mockRestore();
      }
    });

    // writes 200,000 lines and runs both greps over them three times, which passes Vitest's 5 s default on a loaded machine
    it('stops rg inside a large file once the limit is past, as pi grep does', { timeout: 30_000 }, async () => {
      const big = 'big';
      write(`${big}/lines.txt`, Array.from({ length: 200_000 }, (_, index) => `needle ${index}`).join('\n'));
      const launcher = processLauncher();
      const original = launcher.launch.bind(launcher);
      let received = 0;
      const launch = vi.spyOn(launcher, 'launch').mockImplementation((...args) => {
        const child = original(...args);
        child.onData('stdout', (chunk) => { received += chunk.byteLength; });
        return child;
      });
      try {
        const params = { pattern: 'needle', path: big, limit: 5, context: 1 };
        const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
        // rg's whole JSON output for the file is about 40 MB
        expect(received).toBeLessThan(4_000_000);
        launch.mockRestore();
        const expected = await execute(piGrep(), params);
        expect(text(actual)).toBe(text(expected));
        expect(actual.details).toEqual(expected.details);
        // a limit past the file's matches: the hold is released as the file is read, past pi's output cap
        const all = { pattern: 'needle', path: big, limit: 1_000_000 };
        const allActual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), all);
        const allExpected = await execute(piGrep(), all);
        expect(text(allActual)).toBe(text(allExpected));
        expect(allActual.details).toEqual(allExpected.details);
      } finally {
        launch.mockRestore();
        rmSync(join(root, big), { recursive: true, force: true });
      }
    });

    it('shows what rg\'s own walk shows of a file with a NUL early, or past its first read buffer', async () => {
      const binary = 'binary';
      mkdirSync(join(root, binary));
      // rg reports every match past a NUL in a file named on its command line; its walk reports none
      writeFileSync(join(root, binary, 'early.bin'), Buffer.from('head\0\nneedle 1\nneedle 2\nneedle 3\n'));
      // matches more than a read buffer before the NUL show, as rg's walk shows them
      const filler = 'filler line\n'.repeat(8_000);
      writeFileSync(join(root, binary, 'late.bin'), Buffer.from(`${Array.from({ length: 10_000 }, (_, index) => `needle ${index}`).join('\n')}\n${filler}x\0y\nneedle tail\n`));
      try {
        for (const params of [{ pattern: 'needle', path: binary, limit: 100_000 }, { pattern: 'needle', path: binary, limit: 100_000, context: 2 }]) {
          const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
          const expected = await execute(piGrep(), params);
          expect(sortedText(actual)).toEqual(sortedText(expected));
          expect(actual.details).toEqual(expected.details);
          expect(text(actual)).toContain('late.bin:1: needle 0');
          expect(text(actual)).not.toContain('early.bin');
        }
      } finally {
        rmSync(join(root, binary), { recursive: true, force: true });
      }
    });

    // The gap between one run settling and the next starting is microtasks wide; the abort lands at each depth in turn.
    it('drops a file with a NUL early once its matches would end the search, and keeps a UTF-16 file rg decodes', async () => {
      const folder = 'firstbuffer';
      mkdirSync(join(root, folder));
      writeFileSync(join(root, folder, 'early.bin'), Buffer.from('head\0\nneedle 1\nneedle 2\nneedle 3\n'));
      // rg decodes a file opening with a UTF-16 byte order mark before it looks for a NUL
      const utf16 = 'utf16';
      mkdirSync(join(root, utf16));
      writeFileSync(join(root, utf16, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(Array.from({ length: 50 }, (_, index) => `needle ${index}`).join('\r\n'), 'utf16le')]));
      // a U+0000 past the first 64 KiB read of a UTF-16 file, and inside rg's first buffer of the decoded text
      const wideNul = 'utf16nul';
      mkdirSync(join(root, wideNul));
      writeFileSync(join(root, wideNul, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${Array.from({ length: 50 }, (_, index) => `needle ${index}`).join('\r\n')}\r\n${'filler\r\n'.repeat(5_000)}x\0y\r\nneedle tail\r\n`, 'utf16le')]));
      try {
        for (const params of [{ pattern: 'needle', path: folder, limit: 1 }, { pattern: 'needle', path: folder, limit: 1, context: 1 }, { pattern: 'needle', path: utf16, limit: 5 }, { pattern: 'needle', path: utf16, limit: 5, context: 1 }, { pattern: 'needle', path: wideNul, limit: 5 }]) {
          const actual = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), params);
          const expected = await execute(piGrep(), params);
          expect(text(actual)).toBe(text(expected));
          expect(actual.details).toEqual(expected.details);
        }
        expect(await run(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle', path: folder, limit: 1 })).toBe('No matches found');
        expect(await run(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle', path: wideNul, limit: 5 })).toBe('No matches found');
      } finally {
        rmSync(join(root, folder), { recursive: true, force: true });
        rmSync(join(root, utf16), { recursive: true, force: true });
        rmSync(join(root, wideNul), { recursive: true, force: true });
      }
    });

    it('starts no rg once an abort has landed, wherever it lands after a run settles', { timeout: 60_000 }, async () => {
      const launcher = processLauncher();
      const original = launcher.launch.bind(launcher);
      for (let hops = 0; hops < 6; hops++) {
        const controller = new AbortController();
        const abortedAtLaunch: boolean[] = [];
        const launch = vi.spyOn(launcher, 'launch').mockImplementation((...args) => {
          abortedAtLaunch.push(controller.signal.aborted);
          const child = original(...args);
          let settled: Promise<unknown> = Promise.all([child.exited, child.closed]);
          for (let hop = 0; hop < hops; hop++) settled = settled.then(() => undefined);
          void settled.then(() => controller.abort());
          return child;
        });
        try {
          await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle', path: many }, controller.signal).catch((error: Error) => {
            expect(error.message).toBe('Operation aborted');
          });
          expect(abortedAtLaunch, `abort ${hops} hops after the first run settled`).not.toContain(true);
        } finally {
          launch.mockRestore();
        }
      }
    });

    it('keeps the matches of a run that could not read a file, names that file, and still fails on a regex rg refuses', async () => {
      const folder = 'vanishing';
      write(`${folder}/a.txt`, 'needle a\n');
      write(`${folder}/gone.txt`, 'needle gone\n');
      write(`${folder}/z.txt`, 'needle z\n');
      const launcher = processLauncher();
      const original = launcher.launch.bind(launcher);
      // the file goes between the walk's listing and rg's run
      const launch = vi.spyOn(launcher, 'launch').mockImplementation((spec) => {
        rmSync(join(root, folder, 'gone.txt'), { force: true });
        return original(spec);
      });
      try {
        const result = await execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle', path: folder });
        expect(text(result).split('\n\n')[0]!.split('\n').sort()).toEqual(['a.txt:1: needle a', 'z.txt:1: needle z']);
        expect(text(result)).toContain('[ripgrep could not read gone.txt]');
        await expect(execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: '(', path: folder })).rejects.toThrow(/regex parse error/);
      } finally {
        launch.mockRestore();
        rmSync(join(root, folder), { recursive: true, force: true });
      }
    });

    it('fails like rg on a --glob rg cannot parse', async () => {
      const expected = await execute(piGrep(), { pattern: 'needle', path: many, glob: 'a}' }).then(() => 'resolved', (error: Error) => error.message);
      expect(expected).toContain('error parsing glob \'a}\'');
      await expect(execute(createGrepTool(pi, root, resolveRg, noReadRules, noHosts), { pattern: 'needle', path: many, glob: 'a}' }))
        .rejects.toThrow(expected.replace(/^rg: /, ''));
    });
  });
});

describe('find', () => {
  const find = (params: Record<string, unknown>, signal?: AbortSignal): Promise<string> => run(createFindTool(pi, root, noReadRules, noHosts), params, signal);
  const lines = async (params: Record<string, unknown>): Promise<string[]> => (await find(params)).split('\n').sort();

  it('matches a name pattern anywhere, honoring .gitignore and skipping node_modules', async () => {
    expect(await lines({ pattern: '*.ts' })).toEqual(['src/ spaced.ts', 'src/app.ts', 'src/deep/util.spec.ts']);
  });

  it('searches below a path that is itself inside node_modules', async () => {
    expect(await lines({ pattern: '*.d.ts', path: 'node_modules/pkg' })).toEqual(['lib/types.d.ts']);
  });

  it('matches a path pattern at any depth', async () => {
    expect(await lines({ pattern: 'deep/*.ts' })).toEqual(['src/deep/util.spec.ts']);
    expect(await lines({ pattern: 'src/**/*.spec.ts' })).toEqual(['src/deep/util.spec.ts']);
  });

  it('lists matching directories with a trailing slash and includes hidden files', async () => {
    expect(await lines({ pattern: 'deep' })).toEqual(['src/deep/']);
    expect(await lines({ pattern: '*.json' })).toEqual(['.config/settings.json']);
  });

  it('matches case-insensitively only for an all-lowercase pattern', async () => {
    expect(await lines({ pattern: '*.md' })).toEqual(['src/README.MD']);
    expect(await find({ pattern: '*.Md' })).toBe('No files found matching pattern');
  });

  it('reads a leading ! literally and rejects extglobs, as fd does', async () => {
    expect(await find({ pattern: '!*.ts' })).toBe('No files found matching pattern');
    expect(await find({ pattern: '@(app).ts' })).toBe('No files found matching pattern');
  });

  it('searches from the given path and reports the limit with the retry hint', async () => {
    expect(await lines({ pattern: '*.ts', path: 'src/deep' })).toEqual(['util.spec.ts']);
    expect(await find({ pattern: '*', limit: 1 })).toMatch(/^[^\n]+\n\n\[1 results limit reached\. Use limit=2 for more, or refine pattern\]$/);
  });

  it('gives no notice for exactly as many results as the limit, and reads a limit below 1 as 1', async () => {
    expect(await find({ pattern: '*.ts', path: 'src/deep', limit: 1 })).toBe('util.spec.ts');
    expect(await find({ pattern: '*', limit: 0 })).toMatch(/^[^\n]+\n\n\[1 results limit reached\. Use limit=2 for more, or refine pattern\]$/);
  });

  it('matches the entries below a directory for a trailing /**, not the directory itself', async () => {
    expect(await lines({ pattern: 'src/deep/**' })).toEqual(['src/deep/util.spec.ts']);
  });

  it.runIf(process.platform === 'win32')('reads \\ as a path separator on Windows', async () => {
    expect(await lines({ pattern: String.raw`src\**\*.ts` })).toEqual(['src/ spaced.ts', 'src/app.ts', 'src/deep/util.spec.ts']);
    expect(await lines({ pattern: String.raw`src\deep\**` })).toEqual(['src/deep/util.spec.ts']);
  });

  it('ignores a ripgrep config file', async () => {
    const config = `${root}.rgrc`;
    writeFileSync(config, '--max-depth=1\n');
    try {
      vi.stubEnv('RIPGREP_CONFIG_PATH', config);
      expect(await lines({ pattern: '*.ts' })).toEqual(['src/ spaced.ts', 'src/app.ts', 'src/deep/util.spec.ts']);
    } finally {
      rmSync(config, { force: true });
    }
  });

  it('rejects a missing path, a file path and an aborted call', async () => {
    await expect(find({ pattern: '*', path: 'nope' })).rejects.toThrow(`Path not found: ${join(root, 'nope')}`);
    await expect(find({ pattern: '*', path: 'src/app.ts' })).rejects.toThrow(`Search path is not a directory: ${join(root, 'src', 'app.ts')}`);
    await expect(find({ pattern: '*' }, AbortSignal.abort())).rejects.toThrow('Operation aborted');
  });

  // A mode-000 directory is still readable to root and has no POSIX meaning on Windows.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a miss, not an error, when rg skips an unreadable directory', async () => {
    write('locked/secret.ts', '');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      expect(await find({ pattern: '*.nothing' })).toBe('No files found matching pattern');
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
      rmSync(join(root, 'locked'), { recursive: true, force: true });
    }
  });

  it('keeps pi find name and schema', () => {
    const ours = createFindTool(pi, root, noReadRules, noHosts);
    expect(ours.name).toBe('find');
    expect(ours.parameters).toEqual(pi.createFindToolDefinition(root).parameters);
  });
});

describe('fdGlobMatcher', () => {
  it('anchors a path pattern only when it already starts at the root', () => {
    expect(fdGlobMatcher('src/*.ts')('/work/repo/src/a.ts')).toBe(true);
    expect(fdGlobMatcher('/work/*/src/*.ts')('/work/repo/src/a.ts')).toBe(true);
    expect(fdGlobMatcher('/src/*.ts')('/work/repo/src/a.ts')).toBe(false);
  });

  it('reads brackets, parentheses and pipes as fd does', () => {
    expect(fdGlobMatcher('[!a]*.ts')('/r/a.ts')).toBe(false);
    expect(fdGlobMatcher('[!a]*.ts')('/r/b.ts')).toBe(true);
    expect(fdGlobMatcher('[ab].ts')('/r/[ab].ts')).toBe(false);
    expect(fdGlobMatcher('a (1).ts')('/r/a (1).ts')).toBe(true);
    expect(fdGlobMatcher('a|b.ts')('/r/a|b.ts')).toBe(true);
    expect(fdGlobMatcher('a|b.ts')('/r/a')).toBe(false);
  });
});

/** pi 1.5.2's `test/suite/regressions/3302-find-path-glob.test.ts`, run against Damocles' find. */
describe('pi find path glob regressions', () => {
  let tempRoot: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'damocles-3302-'));
    mkdirSync(join(tempRoot, 'some', 'parent', 'child'), { recursive: true });
    mkdirSync(join(tempRoot, 'src', 'foo', 'bar'), { recursive: true });
    writeFileSync(join(tempRoot, 'some', 'parent', 'child', 'file.ext'), '');
    writeFileSync(join(tempRoot, 'some', 'parent', 'child', 'test.spec.ts'), '');
    writeFileSync(join(tempRoot, 'src', 'foo', 'bar', 'example.spec.ts'), '');
    writeFileSync(join(tempRoot, 'src', 'direct.spec.ts'), '');
    writeFileSync(join(tempRoot, 'src', 'a&b (1).ts'), '');
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function runFind(params: Record<string, unknown>): Promise<string[]> {
    const result = await createFindTool(pi, tempRoot, noReadRules, noHosts).execute('call', params as never, undefined, undefined, { cwd: tempRoot } as never);
    const found = text(result as AnyResult);
    if (found === 'No files found matching pattern') return [];
    return found.split('\n').filter((line) => line.length > 0 && !line.startsWith('[')).sort();
  }

  it('matches a subtree, a leading ** and a path pattern at any depth without crossing directories', async () => {
    expect(await runFind({ pattern: '*.spec.ts' })).toEqual(['some/parent/child/test.spec.ts', 'src/direct.spec.ts', 'src/foo/bar/example.spec.ts']);
    expect(await runFind({ pattern: 'some/parent/child/**' })).toEqual(['some/parent/child/file.ext', 'some/parent/child/test.spec.ts']);
    expect(await runFind({ pattern: '**/parent/child/*' })).toEqual(['some/parent/child/file.ext', 'some/parent/child/test.spec.ts']);
    expect(await runFind({ pattern: 'src/**/*.spec.ts' })).toEqual(['src/direct.spec.ts', 'src/foo/bar/example.spec.ts']);
    expect(await runFind({ pattern: 'src/*.spec.ts' })).toEqual(['src/direct.spec.ts']);
  });

  it.runIf(process.platform === 'win32')('matches Windows backslash patterns like forward-slash ones', async () => {
    expect(await runFind({ pattern: String.raw`src\**\*.spec.ts` })).toEqual(['src/direct.spec.ts', 'src/foo/bar/example.spec.ts']);
    expect(await runFind({ pattern: String.raw`src\*.spec.ts` })).toEqual(['src/direct.spec.ts']);
    expect(await runFind({ pattern: String.raw`**\parent\child\*` })).toEqual(['some/parent/child/file.ext', 'some/parent/child/test.spec.ts']);
    expect(await runFind({ pattern: String.raw`src\**/*.spec.ts` })).toEqual(['src/direct.spec.ts', 'src/foo/bar/example.spec.ts']);
  });

  it('supports braces, classes and literal regex characters in a path pattern', async () => {
    expect(await runFind({ pattern: '{src,some}/**/[et]*.spec.ts' })).toEqual(['some/parent/child/test.spec.ts', 'src/foo/bar/example.spec.ts']);
    expect(await runFind({ pattern: 'src/[!x]&b (1).ts' })).toEqual(['src/a&b (1).ts']);
  });

  it('stops a path pattern at the result limit', async () => {
    const result = await createFindTool(pi, tempRoot, noReadRules, noHosts).execute('call', { pattern: 'src/**/*.spec.ts', limit: 1 } as never, undefined, undefined, { cwd: tempRoot } as never);
    expect((result.details as { resultLimitReached?: number } | undefined)?.resultLimitReached).toBe(1);
    expect(text(result as AnyResult).split('\n')[0]).toMatch(/^src\/(direct|foo\/bar\/example)\.spec\.ts$/);
  });

  it.runIf(process.platform !== 'win32')('keeps \\ as a glob escape on POSIX', async () => {
    writeFileSync(join(tempRoot, 'src', '*.ts'), '');
    writeFileSync(join(tempRoot, 'src', 'other.ts'), '');
    expect(await runFind({ pattern: String.raw`src/\*.ts` })).toEqual(['src/*.ts']);
  });
});

describe('Read rules over a search rooted above what they cover', () => {
  it('grep and find leave the covered files out, and say so', async () => {
    write('vault/key.txt', 'needle vaulted\n');
    const settingsDir = join(homedir(), '.damocles');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(vault/**)'] } }));
    try {
      const handler = new PermissionHandler(createFakePlatform(), getPiCodingAgent);
      handler.setCwd(root);
      handler.setWorkspacePath(root);
      const readRuleFilter = (): Promise<(filePath: string) => boolean> => handler.readRuleFilter();
      const all = (result: AnyResult): string => result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

      const grepped = await run(createGrepTool(pi, root, resolveRg, readRuleFilter, noHosts), { pattern: 'needle' });
      expect(grepped).toContain('src/app.ts');
      expect(grepped).not.toContain('vaulted');
      expect(grepped).toContain('a Read rule');
      expect(await run(createGrepTool(pi, root, resolveRg, readRuleFilter, noHosts), { pattern: 'vaulted' })).toMatch(/^No matches found\n\n\[.*a Read rule/);

      const found = all(await execute(createFindTool(pi, root, readRuleFilter, noHosts), { pattern: '*.txt' }));
      expect(found).toContain('long.txt');
      expect(found).not.toContain('key.txt');
      expect(found).toContain('a Read rule');
    } finally {
      rmSync(join(settingsDir, 'settings.json'), { force: true });
      rmSync(join(root, 'vault'), { recursive: true, force: true });
    }
  });
});

// A link whose target is a named pipe this test serves: an open of the target shows as a connection, as an open of
// \\host\share would send the user's Windows sign-in to that host.
describe.runIf(process.platform === 'win32')('links under the search root', () => {
  let pipe: string;
  let server: net.Server;
  let connections = 0;
  let tree: string;

  beforeAll(async () => {
    pipe = `\\\\.\\pipe\\damocles-search-${process.pid}`;
    server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    connections = 0;
    tree = mkdtempSync(join(tmpdir(), 'damocles-search-links-'));
    mkdirSync(join(tree, '.git'));
    writeFileSync(join(tree, 'a.txt'), 'needle\n');
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));
  const inTree = async (tool: SearchTool, params: Record<string, unknown>): Promise<string> =>
    text(await (tool.execute('call', params as never, undefined, undefined, { cwd: tree } as never) as Promise<AnyResult>));
  const grep = (params: Record<string, unknown>): Promise<string> => inTree(createGrepTool(pi, tree, resolveRg, noReadRules, noHosts), params);
  const glob = (params: Record<string, unknown>): Promise<string> => inTree(createFindTool(pi, tree, noReadRules, noHosts), params);

  it('opens no link a search meets', async (ctx) => {
    symlinkOrSkip(ctx, pipe, join(tree, 'remote.txt'), 'file');
    mkdirSync(join(tree, 'deep', 'er'), { recursive: true });
    symlinkOrSkip(ctx, pipe, join(tree, 'deep', 'er', 'remote.txt'), 'file');
    expect(await grep({ pattern: 'needle' })).toBe('a.txt:1: needle');
    expect(await glob({ pattern: '*.txt' })).toBe('a.txt');
    await settle();
    expect(connections).toBe(0);
  });

  it('reads no ignore file that is a link', async (ctx) => {
    symlinkOrSkip(ctx, pipe, join(tree, '.gitignore'), 'file');
    symlinkOrSkip(ctx, pipe, join(tree, '.ignore'), 'file');
    symlinkOrSkip(ctx, pipe, join(tree, '.rgignore'), 'file');
    expect(await grep({ pattern: 'needle' })).toBe('a.txt:1: needle');
    expect(await glob({ pattern: '*.txt' })).toBe('a.txt');
    await settle();
    expect(connections).toBe(0);
  });

  it('opens no `.git` link, no info/exclude link, and no `.git` file pointer that leads off this computer', async (ctx) => {
    // `gitdir: <gd>` makes rg open <gd>\commondir, a pipe of its own
    const gitDir = `${pipe}-gd`;
    const commondir = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => commondir.listen(`${gitDir}\\commondir`, resolve));
    try {
      writeFileSync(join(tree, '.git', 'x'), '');
      mkdirSync(join(tree, '.git', 'info'));
      symlinkOrSkip(ctx, pipe, join(tree, '.git', 'info', 'exclude'), 'file');
      mkdirSync(join(tree, 'linked'));
      symlinkOrSkip(ctx, pipe, join(tree, 'linked', '.git'), 'file');
      for (const folder of ['pointed', 'pointed/nested']) {
        mkdirSync(join(tree, folder));
        writeFileSync(join(tree, folder, '.git'), `gitdir: ${gitDir}\n`);
        writeFileSync(join(tree, folder, 'b.txt'), 'needle\n');
      }
      expect((await grep({ pattern: 'needle' })).split('\n').sort()).toEqual(['a.txt:1: needle', 'pointed/b.txt:1: needle', 'pointed/nested/b.txt:1: needle']);
      expect((await grep({ pattern: 'needle', path: 'pointed' })).split('\n').sort()).toEqual(['b.txt:1: needle', 'nested/b.txt:1: needle']);
      expect((await glob({ pattern: '*.txt' })).split('\n').sort()).toEqual(['a.txt', 'pointed/b.txt', 'pointed/nested/b.txt']);
      expect((await glob({ pattern: '.git' })).split('\n').sort()).toEqual(['pointed/.git', 'pointed/nested/.git']);
      await settle();
      expect(connections).toBe(0);
    } finally {
      commondir.close();
    }
  });

  it('lists through local links as rg does without following them: no linked file or folder, and nothing under a junction', async (ctx) => {
    mkdirSync(join(tree, 'real'));
    writeFileSync(join(tree, 'real', 'b.txt'), 'needle\n');
    symlinkSync(join(tree, 'real'), join(tree, 'junction'), 'junction');
    symlinkOrSkip(ctx, join(tree, 'real'), join(tree, 'linked'), 'dir');
    symlinkOrSkip(ctx, join(tree, 'a.txt'), join(tree, 'file.txt'), 'file');
    const own = async (params: Record<string, unknown>): Promise<string[]> => {
      vi.stubEnv('PI_OFFLINE', '1');
      vi.stubEnv('PATH', `${dirname(rgPath)}${delimiter}${process.env['PATH'] ?? ''}`);
      return (await inTree(pi.createGrepToolDefinition(tree) as never, params)).split('\n').sort();
    };
    expect((await grep({ pattern: 'needle' })).split('\n').sort()).toEqual(await own({ pattern: 'needle' }));
    expect((await grep({ pattern: 'needle' })).split('\n').sort()).toEqual(['a.txt:1: needle', 'real/b.txt:1: needle']);
    expect((await glob({ pattern: '*.txt' })).split('\n').sort()).toEqual(['a.txt', 'real/b.txt']);
    // rg's own search fails on a folder link whose target is gone, which it stats; the walk never looks behind a link
    symlinkSync(join(tree, 'gone'), join(tree, 'dangling'), 'junction');
    await expect(own({ pattern: 'needle' })).rejects.toThrow(/dangling/);
    expect((await grep({ pattern: 'needle' })).split('\n').sort()).toEqual(['a.txt:1: needle', 'real/b.txt:1: needle']);
  });

  it('applies no .gitignore that is a link to a local file', async (ctx) => {
    writeFileSync(join(tree, 'rules'), 'a.txt\n');
    symlinkOrSkip(ctx, join(tree, 'rules'), join(tree, '.gitignore'), 'file');
    expect(await grep({ pattern: 'needle' })).toBe('a.txt:1: needle');
    expect(await glob({ pattern: '*.txt' })).toBe('a.txt');
  });
});

// A real symlink, which needs Developer Mode or an elevated process on Windows; the test skips without either.
function symlinkOrSkip(ctx: TestContext, target: string, at: string, type: 'file' | 'dir'): void {
  try {
    symlinkSync(target, at, type);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
    throw err;
  }
}

describe('resolveToCwd', () => {
  it('resolves like pi: @ prefix, home, and relative paths', () => {
    expect(resolveToCwd('@src/app.ts', root)).toBe(join(root, 'src', 'app.ts'));
    expect(resolveToCwd('~', root)).toBe(homedir());
    expect(resolveToCwd('..', join(root, 'src'))).toBe(root);
  });
});
