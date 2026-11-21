import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { processLauncher, runProcess, type LaunchedProcess, type ProcessExit } from '../../process-launcher';
import { ALL_IGNORE_FILES, BATCH_COMMAND_LINE, batchLineBudget, commandLineCost, runWalkedRg, walkedRgRuns, walkHost, type HeldEvents, type RgLineEvent, type RgRunEnd, type WalkIgnore } from '..';

// The logical CPUs walkedRgRuns sees: 8 gives 4 runs at once on any machine.
const cpus = vi.hoisted(() => ({ count: 8 }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), availableParallelism: () => cpus.count }));

// The engine Grep and desktop Search share, against rg 15 searching over its own walk (`rg --json --hidden -- .`): on link-free
// trees the two give the same match and context events, binary files included, whether a file's events are held to its end or
// released early through a read of the file.

const NO_IGNORE: WalkIgnore = { files: false, global: false, parents: false };
let base: string;
let counter = 0;

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-walked-rg-')));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function tree(entries: Record<string, string | Buffer>): string {
  const root = path.join(base, `t-${++counter}`);
  for (const [name, content] of Object.entries(entries)) {
    const at = path.join(root, name);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, content);
  }
  return root;
}

// Each file's match and context events in rg's order, by its '/'-separated path below the search root.
function lineEvents(events: readonly RgLineEvent[]): Record<string, string[]> {
  const files: Record<string, string[]> = {};
  for (const event of events) {
    if (event.type !== 'match' && event.type !== 'context') continue;
    const data = event.data as { path: { text: string }; line_number: number; lines: unknown; submatches?: Array<{ start: number; end: number }> };
    const file = data.path.text.replace(/^\.[\\/]/, '').replaceAll('\\', '/');
    (files[file] ??= []).push(JSON.stringify([event.type, data.line_number, data.lines, data.submatches?.map(({ start, end }) => [start, end])]));
  }
  return files;
}

async function rgOwnWalk(root: string, flags: readonly string[], pattern: string, ignore: WalkIgnore): Promise<Record<string, string[]>> {
  const ignoreArgs = ignore.files ? [] : ['--no-ignore'];
  const { exit, stdout, stderr } = await runProcess({ file: rgPath, args: ['--json', '--no-config', '--hidden', ...ignoreArgs, ...flags, '--', pattern, '.'], cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (exit?.code !== 0 && exit?.code !== 1) throw new Error(`rg exited ${exit?.code}: ${stderr.toString()}`);
  return lineEvents(stdout.toString('utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as RgLineEvent));
}

interface Walked {
  readonly events: RgLineEvent[];
  readonly ends: RgRunEnd[];
}

// lineBudget 1 names each file in a run of its own, so several runs are live at once
async function walked(root: string, matchFlags: readonly string[], pattern: string, ignore: WalkIgnore, mustRelease: (held: HeldEvents) => boolean, signal?: AbortSignal, lineBudget?: number): Promise<Walked> {
  const events: RgLineEvent[] = [];
  const ends: RgRunEnd[] = [];
  const flags = ['--json', ...matchFlags];
  let errors: readonly string[] = [];
  await runWalkedRg({
    rgPath,
    cwd: root,
    flags,
    pattern,
    batches: (listing) => {
      const walk = walkHost().walk({ root, requireGit: true, ignore, gitFolders: 'list', overrides: [], lineBudget: lineBudget ?? Math.max(1, batchLineBudget(rgPath, flags, pattern)) }, listing);
      errors = walk.errors;
      return walk;
    },
    signal,
    mustRelease,
    onEvent: (event) => events.push(event),
    done: () => false,
    runEnded: (end) => {
      ends.push(end);
      return undefined;
    },
  });
  expect(errors).toEqual([]);
  return { events, ends };
}

const never = (): boolean => false;
const always = (): boolean => true;
const listOf = (batches: ReadonlyArray<readonly string[]>) => async function* (): AsyncGenerator<readonly string[]> {
  yield* batches;
};

/** folders × files names of about 100 characters, each holding `needle`. */
function wideTree(folders: number, files: number): string {
  const entries: Record<string, string> = {};
  for (let folder = 0; folder < folders; folder++) {
    for (let file = 0; file < files; file++) entries[`d${String(folder).padStart(3, '0')}/${String(file).padStart(2, '0')}-${'n'.repeat(90)}.txt`] = `needle ${folder} ${file}\n`;
  }
  return tree(entries);
}

/** Each folder read below root, as the walk asks for it, slowed so the walk outlasts an rg run. */
function slowListing(root: string, delayMs: number): { readonly read: string[]; restore(): void } {
  const read: string[] = [];
  const original = fs.promises.readdir.bind(fs.promises);
  const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (folder: fs.PathLike, options?: unknown) => {
    if (String(folder).startsWith(root)) {
      read.push(String(folder));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return original(folder, options as never);
  }) as typeof fs.promises.readdir);
  return { read, restore: () => spy.mockRestore() };
}

interface HeldRun {
  // rg's whole stdout, once it exited
  readonly output: Promise<Buffer>;
  // passes bytes to the engine as rg's stdout
  deliver(bytes: Buffer): void;
  // lets the engine see the exit, after what was delivered
  finish(): void;
  readonly killed: boolean;
  // whether the engine holds rg's output paused
  readonly paused: boolean;
}

/** Each rg the engine starts, with its stdout and exit held from the engine until the test passes them on. */
function holdRuns(): { readonly runs: HeldRun[]; restore(): void } {
  const launcher = processLauncher();
  const original = launcher.launch.bind(launcher);
  const runs: HeldRun[] = [];
  const spy = vi.spyOn(launcher, 'launch').mockImplementation((spec, options) => {
    const child = original(spec, options);
    const chunks: Buffer[] = [];
    child.onData('stdout', (chunk) => chunks.push(chunk));
    const listeners: Array<(chunk: Buffer) => void> = [];
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let killed = false;
    let paused = false;
    runs.push({
      output: Promise.all([child.exited, child.closed]).then(() => Buffer.concat(chunks)),
      deliver: (bytes) => {
        for (const listener of listeners) listener(bytes);
      },
      finish: () => open(),
      get killed() {
        return killed;
      },
      get paused() {
        return paused;
      },
    });
    const held: LaunchedProcess = {
      ...child,
      onData: (stream, listener) => (stream === 'stdout' ? void listeners.push(listener) : child.onData(stream, listener)),
      pauseOutput: () => {
        paused = true;
        child.pauseOutput();
      },
      resumeOutput: () => {
        paused = false;
        child.resumeOutput();
      },
      exited: gate.then(() => child.exited),
      closed: gate.then(() => child.closed),
      kill: (opts) => {
        killed = true;
        child.kill(opts);
        open();
      },
    };
    return held;
  });
  return { runs, restore: () => spy.mockRestore() };
}

async function until<T>(value: () => T | undefined | false, what: string): Promise<T> {
  for (const started = Date.now(); Date.now() - started < 4_000; await new Promise((resolve) => setTimeout(resolve, 5))) {
    const found = value();
    if (found !== undefined && found !== false) return found;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));
const pathOf = (event: RgLineEvent): string => event.data?.path?.text ?? '';

describe('runWalkedRg', () => {
  // a test that times out keeps starting rg under the next test's launcher spy
  it('matches what rg matches over its own walk, a file\'s events held to its end or released through a read of it', { timeout: 30_000 }, async () => {
    const filler = 'filler line\n'.repeat(8_000);
    const root = tree({
      '.git/HEAD': 'needle head\n',
      '.gitignore': 'ignored.txt\n',
      'ignored.txt': 'needle ignored\n',
      'crlf.txt': 'one\r\nneedle two\r\nthree\r\n',
      'multi.txt': 'foo\nbar needle\nbaz\n',
      // a NUL in rg's first read buffer: its walk shows nothing of the file
      'early.bin': Buffer.from('head\0\nneedle 1\nneedle 2\n'),
      // a NUL past it: its walk shows the lines more than a read buffer before the NUL
      'late.bin': `${Array.from({ length: 3_000 }, (_, index) => `needle ${index}`).join('\n')}\n${filler}x\0y\nneedle tail\n`,
      // a file opening with a UTF-16 byte order mark, which rg decodes before it looks for a NUL
      'wide.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('before\r\nneedle wide\r\nafter\r\n', 'utf16le')]),
      'wide-nul.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`needle 1\r\n${'filler\r\n'.repeat(5_000)}x\0y\r\n`, 'utf16le')]),
      'src/a.ts': 'export const needle = 1;\n',
    });
    const cases: Array<[string, readonly string[], string, WalkIgnore]> = [
      ['a fixed string', ['--crlf', '--ignore-case', '--fixed-strings'], 'needle', ALL_IGNORE_FILES],
      ['no ignore file, .git searched', ['--crlf', '--ignore-case', '--fixed-strings'], 'needle', NO_IGNORE],
      ['context lines', ['--crlf', '--before-context', '2', '--after-context', '2', '--ignore-case', '--fixed-strings'], 'needle', ALL_IGNORE_FILES],
      ['a multiline regex', ['--crlf', '--ignore-case', '--engine', 'auto', '--multiline'], 'bar needle\\nbaz', ALL_IGNORE_FILES],
      ['a regex end of line at CRLF', ['--crlf', '--ignore-case', '--engine', 'auto'], 'two$', ALL_IGNORE_FILES],
    ];
    for (const [label, flags, pattern, ignore] of cases) {
      const expected = await rgOwnWalk(root, flags, pattern, ignore);
      for (const [mode, mustRelease] of [['held', never], ['released', always]] as const) {
        expect(lineEvents((await walked(root, flags, pattern, ignore, mustRelease)).events), `${label}, ${mode}`).toEqual(expected);
        if (label === 'context lines') expect(lineEvents((await walked(root, flags, pattern, ignore, mustRelease, undefined, 1)).events), `${label}, ${mode}, a run per file`).toEqual(expected);
      }
    }
    const searched = Object.keys(await rgOwnWalk(root, cases[1]![1], cases[1]![2], NO_IGNORE)).sort();
    expect(searched).toEqual(['.git/HEAD', 'crlf.txt', 'ignored.txt', 'late.bin', 'multi.txt', 'src/a.ts', 'wide.txt']);
  });

  it('sends each file\'s end after its released events, and only the end of a file it drops', async () => {
    const root = tree({ 'a.txt': 'needle 1\nplain\nneedle 2\n', 'b.bin': Buffer.from('needle\0\n') });
    for (const mustRelease of [never, always]) {
      const { events } = await walked(root, ['--fixed-strings'], 'needle', ALL_IGNORE_FILES, mustRelease);
      const byFile = (file: string): Array<string | undefined> => events.filter((event) => event.data?.path?.text === file).map((event) => event.type);
      expect(byFile('a.txt')).toEqual(['match', 'match', 'end']);
      expect(byFile('b.bin')).toEqual(['end']);
    }
  });

  it('names every listed file after its own --, so a file named like a flag is searched as a file', async () => {
    const root = tree({ '--pre=x': 'needle\n', 'a.txt': 'needle\n' });
    const events: RgLineEvent[] = [];
    await runWalkedRg({
      rgPath,
      cwd: root,
      flags: ['--json'],
      pattern: 'needle',
      batches: listOf([['--pre=x', 'a.txt']]),
      signal: undefined,
      mustRelease: never,
      onEvent: (event) => events.push(event),
      done: () => false,
      runEnded: (end) => (end.code === 0 ? undefined : new Error(end.stderr)),
    });
    expect(Object.keys(lineEvents(events)).sort()).toEqual(['--pre=x', 'a.txt']);
    const refused = runWalkedRg({ rgPath, cwd: root, flags: ['--json', '--'], pattern: 'needle', batches: listOf([['a.txt']]), signal: undefined, mustRelease: never, onEvent: () => undefined, done: () => false, runEnded: () => undefined });
    await expect(refused).rejects.toThrow('A walked rg run puts its own -- before the files');
  });

  it('counts a held file\'s lines in UTF-8 bytes', async () => {
    const line = 'needle 中文 ünïcode\n';
    const root = tree({ 'wide.txt': line });
    const held: number[] = [];
    await walked(root, ['--fixed-strings'], 'needle', ALL_IGNORE_FILES, ({ bytes }) => {
      held.push(bytes);
      return false;
    });
    expect(held).toEqual([Buffer.byteLength(line)]);
  });

  it('runs rg over batches within the command-line budget, at most walkedRgRuns() at once, while the listing goes on', async () => {
    const folders = 120;
    const root = wideTree(folders, 5);
    const listing = slowListing(root, 30);
    const launcher = processLauncher();
    const original = launcher.launch.bind(launcher);
    let running = 0;
    let most = 0;
    // the root and its folders
    const toList = folders + 1;
    let askedAtFirstRun: number | undefined;
    const lengths: number[] = [];
    const launch = vi.spyOn(launcher, 'launch').mockImplementation((spec) => {
      lengths.push([spec.file, ...spec.args].reduce((sum, arg) => sum + commandLineCost(arg), 0));
      askedAtFirstRun ??= new Set(listing.read).size;
      const child = original(spec);
      most = Math.max(most, ++running);
      void child.exited.then(() => running--);
      return child;
    });
    try {
      const { events, ends } = await walked(root, ['--fixed-strings'], 'needle', ALL_IGNORE_FILES, never);
      expect(lengths.length).toBeGreaterThan(1);
      for (const length of lengths) expect(length).toBeLessThanOrEqual(BATCH_COMMAND_LINE);
      expect(most).toBeLessThanOrEqual(walkedRgRuns());
      expect(new Set(listing.read).size).toBe(toList);
      // an ordering, not an overlap of a run with a read: reads start in bursts, and a fast rg can start and end between two
      expect(askedAtFirstRun).toBeLessThan(toList);
      expect(events.filter((event) => event.type === 'match')).toHaveLength(folders * 5);
      expect(ends.every((end) => end.code === 0 && end.summary)).toBe(true);
    } finally {
      launch.mockRestore();
      listing.restore();
    }
  });

  it('kills the running rg and stops the listing on an abort', async () => {
    const folders = 200;
    const root = wideTree(folders, 5);
    const listing = slowListing(root, 30);
    const controller = new AbortController();
    const launcher = processLauncher();
    const original = launcher.launch.bind(launcher);
    const exits: Array<Promise<ProcessExit>> = [];
    let readAtAbort = 0;
    const launch = vi.spyOn(launcher, 'launch').mockImplementation((spec) => {
      const child = original(spec);
      exits.push(child.exited);
      // once the run holds its child
      queueMicrotask(() => {
        readAtAbort = listing.read.length;
        controller.abort();
      });
      return child;
    });
    try {
      await expect(walked(root, ['--fixed-strings'], 'needle', ALL_IGNORE_FILES, never, controller.signal)).rejects.toThrow('Operation aborted');
      expect(exits).toHaveLength(1);
      const exit = await exits[0]!;
      // a kill: rg searching its batch to the end exits 0
      expect(exit.signal !== null || exit.code !== 0, JSON.stringify(exit)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // the reads already under way when the abort came (READ_AHEAD, 8) are the last
      expect(listing.read.length - readAtAbort).toBeLessThanOrEqual(8);
      expect(listing.read.length).toBeLessThan(folders);
    } finally {
      launch.mockRestore();
      listing.restore();
    }
  });

  it('keeps half the logical CPUs of runs live, at least 1 and at most 4', () => {
    try {
      expect([1, 2, 3, 4, 5, 8, 9, 20, 64].map((count) => {
        cpus.count = count;
        return walkedRgRuns();
      })).toEqual([1, 1, 1, 2, 2, 4, 4, 4, 4]);
    } finally {
      cpus.count = 8;
    }
  });

  describe('with several runs live', () => {
    const tenBatches = (onAbort?: () => void) => async function* (listing: AbortSignal): AsyncGenerator<readonly string[]> {
      if (onAbort) listing.addEventListener('abort', onAbort);
      for (let index = 0; index < 10; index++) yield [index === 1 ? 'gone.txt' : 'a.txt'];
    };

    it('keeps up to walkedRgRuns() runs live and one listed batch beyond them while the listing goes on', async () => {
      const root = tree({ 'a.txt': 'needle\n' });
      const held = holdRuns();
      let listed = 0;
      const events: RgLineEvent[] = [];
      try {
        const search = runWalkedRg({
          rgPath,
          cwd: root,
          flags: ['--json', '--fixed-strings'],
          pattern: 'needle',
          batches: async function* () {
            for (let index = 0; index < 10; index++) {
              listed++;
              yield ['a.txt'];
            }
          },
          signal: undefined,
          mustRelease: never,
          onEvent: (event) => events.push(event),
          done: () => false,
          runEnded: () => undefined,
        });
        await until(() => held.runs.length >= 4, 'four runs');
        await pause();
        expect(held.runs).toHaveLength(4);
        expect(listed).toBe(5);
        const first = held.runs[0]!;
        first.deliver(await first.output);
        first.finish();
        await until(() => held.runs.length >= 5, 'a fifth run once one ended');
        await pause();
        expect(held.runs).toHaveLength(5);
        expect(listed).toBe(6);
        for (let index = 1; index < 10; index++) {
          const run = await until(() => held.runs[index], `run ${index}`);
          run.deliver(await run.output);
          run.finish();
        }
        await search;
        expect(events.filter((event) => event.type === 'match')).toHaveLength(10);
      } finally {
        held.restore();
      }
    });

    it('passes one file\'s events whole, never interleaved with another run\'s file, when runs end out of order', async () => {
      const root = tree({ 'a.txt': 'needle a1\nneedle a2\nneedle a3\n', 'b.txt': 'needle b1\nneedle b2\n' });
      const held = holdRuns();
      const events: RgLineEvent[] = [];
      try {
        const search = runWalkedRg({
          rgPath,
          cwd: root,
          flags: ['--json', '--fixed-strings'],
          pattern: 'needle',
          batches: listOf([['a.txt'], ['b.txt']]),
          signal: undefined,
          // a.txt's events stream once its first match is released through a read of the file
          mustRelease: always,
          onEvent: (event) => events.push(event),
          done: () => false,
          runEnded: () => undefined,
        });
        const first = await until(() => held.runs[0], 'the first run');
        const second = await until(() => held.runs[1], 'the second run');
        const lines = (await first.output).toString('utf8').split(/(?<=\n)/);
        const firstMatch = lines.findIndex((line) => line.includes('"type":"match"'));
        first.deliver(Buffer.from(lines.slice(0, firstMatch + 1).join('')));
        await until(() => events.length > 0, 'a.txt\'s first match');
        second.deliver(await second.output);
        second.finish();
        await pause();
        expect(events.map(pathOf)).toEqual(['a.txt']);
        first.deliver(Buffer.from(lines.slice(firstMatch + 1).join('')));
        first.finish();
        await search;
        expect(events.map((event) => `${pathOf(event)} ${event.type}`)).toEqual(['a.txt match', 'a.txt match', 'a.txt match', 'a.txt end', 'b.txt match', 'b.txt match', 'b.txt end']);
      } finally {
        held.restore();
      }
    });

    it('pauses a run\'s output while another run\'s file holds the sink, and resumes it once that file ends', async () => {
      const root = tree({ 'a.txt': 'needle a1\nneedle a2\n', 'b.txt': 'needle b1\n' });
      const held = holdRuns();
      const events: RgLineEvent[] = [];
      try {
        const search = runWalkedRg({
          rgPath,
          cwd: root,
          flags: ['--json', '--fixed-strings'],
          pattern: 'needle',
          batches: listOf([['a.txt'], ['b.txt']]),
          signal: undefined,
          mustRelease: always,
          onEvent: (event) => events.push(event),
          done: () => false,
          runEnded: () => undefined,
        });
        const first = await until(() => held.runs[0], 'the first run');
        const second = await until(() => held.runs[1], 'the second run');
        const lines = (await first.output).toString('utf8').split(/(?<=\n)/);
        const firstMatch = lines.findIndex((line) => line.includes('"type":"match"'));
        first.deliver(Buffer.from(lines.slice(0, firstMatch + 1).join('')));
        await until(() => events.length > 0, 'a.txt holding the sink');
        second.deliver(await second.output);
        await until(() => second.paused, 'b.txt\'s run paused behind a.txt');
        expect(first.paused).toBe(false);
        first.deliver(Buffer.from(lines.slice(firstMatch + 1).join('')));
        await until(() => !second.paused, 'b.txt\'s run resumed once a.txt ended');
        first.finish();
        second.finish();
        await search;
      } finally {
        held.restore();
      }
    });

    it('kills every live run, stops the listing and starts no run once done() answers true', async () => {
      const root = tree({ 'a.txt': 'needle\n' });
      const held = holdRuns();
      let matched = false;
      let listingStopped = false;
      try {
        const search = runWalkedRg({
          rgPath,
          cwd: root,
          flags: ['--json', '--fixed-strings'],
          pattern: 'needle',
          batches: tenBatches(() => (listingStopped = true)),
          signal: undefined,
          mustRelease: never,
          onEvent: (event) => (matched ||= event.type === 'match'),
          done: () => matched,
          runEnded: () => undefined,
        });
        await until(() => held.runs.length >= 4, 'four runs');
        const third = held.runs[2]!;
        third.deliver(await third.output);
        await search;
        await pause();
        expect(held.runs).toHaveLength(4);
        expect(held.runs.map((run) => run.killed)).toEqual([true, true, true, true]);
        expect(listingStopped).toBe(true);
      } finally {
        held.restore();
      }
    });

    it('kills every live run, stops the listing and starts no run once a run fails', async () => {
      const root = tree({ 'a.txt': 'needle\n' });
      const held = holdRuns();
      let listingStopped = false;
      try {
        const search = runWalkedRg({
          rgPath,
          cwd: root,
          flags: ['--json', '--fixed-strings'],
          pattern: 'needle',
          batches: tenBatches(() => (listingStopped = true)),
          signal: undefined,
          mustRelease: never,
          onEvent: () => undefined,
          done: () => false,
          runEnded: (end) => (end.code === 0 ? undefined : new Error(`failed with ${end.code}`)),
        }).then(() => undefined, (err: Error) => err.message);
        await until(() => held.runs.length >= 4, 'four runs');
        const failing = held.runs[1]!;
        failing.deliver(await failing.output);
        failing.finish();
        expect(await search).toBe('failed with 2');
        await pause();
        expect(held.runs).toHaveLength(4);
        expect(held.runs.map((run) => run.killed)).toEqual([true, false, true, true]);
        expect(listingStopped).toBe(true);
      } finally {
        held.restore();
      }
    });

    it('kills every live run, stops the listing and starts no run on an abort', async () => {
      const root = tree({ 'a.txt': 'needle\n' });
      const held = holdRuns();
      const controller = new AbortController();
      let listingStopped = false;
      try {
        const search = runWalkedRg({
          rgPath,
          cwd: root,
          flags: ['--json', '--fixed-strings'],
          pattern: 'needle',
          batches: tenBatches(() => (listingStopped = true)),
          signal: controller.signal,
          mustRelease: never,
          onEvent: () => undefined,
          done: () => false,
          runEnded: () => undefined,
        }).then(() => undefined, (err: Error) => err.message);
        await until(() => held.runs.length >= 4, 'four runs');
        controller.abort();
        expect(await search).toBe('Operation aborted');
        await pause();
        expect(held.runs).toHaveLength(4);
        expect(held.runs.map((run) => run.killed)).toEqual([true, true, true, true]);
        expect(listingStopped).toBe(true);
      } finally {
        held.restore();
      }
    });
  });

  it('goes on past a run that searched with an error, and stops at one that searched nothing', async () => {
    const root = tree({ 'a.txt': 'needle\n', 'b.txt': 'needle\n' });
    const run = async (pattern: string, batches: string[][]): Promise<{ ends: RgRunEnd[]; error?: string }> => {
      const ends: RgRunEnd[] = [];
      const refused = new Error('refused');
      const error = await runWalkedRg({
        rgPath,
        cwd: root,
        flags: ['--json', '--fixed-strings'],
        pattern,
        batches: listOf(batches),
        signal: undefined,
        mustRelease: never,
        onEvent: () => undefined,
        done: () => false,
        runEnded: (end) => {
          ends.push(end);
          return end.code === 2 && !end.summary ? refused : undefined;
        },
      }).then(() => undefined, (err: Error) => err.message);
      return { ends, ...(error !== undefined ? { error } : {}) };
    };
    const missing = await run('needle', [['a.txt', 'gone.txt'], ['b.txt']]);
    // the two runs are live at once and end in either order
    expect(missing.ends.map(({ code, summary }) => [code, summary]).sort()).toEqual([[0, true], [2, true]]);
    expect(missing.ends.find(({ code }) => code === 2)!.stderr).toContain('gone.txt');
    const regex = await runWalkedRg({
      rgPath, cwd: root, flags: ['--json'], pattern: '(', batches: listOf([['a.txt'], ['b.txt']]), signal: undefined, mustRelease: never, onEvent: () => undefined, done: () => false,
      runEnded: (end) => (end.summary ? undefined : new Error(end.stderr)),
    }).then(() => undefined, (err: Error) => err.message);
    expect(regex).toContain('regex parse error');
  });

  it('ends a slow listing as soon as a run fails, and stops it', async () => {
    const root = tree({ 'a.txt': 'needle\n', 'b.txt': 'needle\n' });
    let listingAborted = false;
    const started = Date.now();
    const error = await runWalkedRg({
      rgPath,
      cwd: root,
      flags: ['--json'],
      pattern: '(',
      // a listing whose next batch comes 30 s later, or when it is stopped
      batches: async function* (listing) {
        yield ['a.txt'];
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          listing.addEventListener('abort', () => {
            listingAborted = true;
            clearTimeout(timer);
            resolve();
          });
        });
        yield ['b.txt'];
      },
      signal: undefined,
      mustRelease: never,
      onEvent: () => undefined,
      done: () => false,
      runEnded: (end) => (end.summary ? undefined : new Error(end.stderr)),
    }).then(() => undefined, (err: Error) => err.message);
    expect(error).toContain('regex parse error');
    expect(listingAborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('drops an event past the byte bound unread, and reads on', async () => {
    const root = tree({ 'big.txt': `needle ${'x'.repeat(4096)}\n`, 'small.txt': 'needle\n' });
    const events: RgLineEvent[] = [];
    let dropped = 0;
    await runWalkedRg({
      rgPath,
      cwd: root,
      flags: ['--json', '--fixed-strings'],
      pattern: 'needle',
      batches: listOf([['big.txt', 'small.txt']]),
      signal: undefined,
      mustRelease: never,
      onEvent: (event) => events.push(event),
      done: () => false,
      runEnded: () => undefined,
      maxEventBytes: 1024,
      onDropped: () => dropped++,
    });
    expect(dropped).toBe(1);
    expect(Object.keys(lineEvents(events))).toEqual(['small.txt']);
  });
});
