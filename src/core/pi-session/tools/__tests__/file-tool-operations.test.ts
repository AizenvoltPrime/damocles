import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createReadTool } from '../read-tool';
import { createWriteTool } from '../write-tool';
import { createEditTool } from '../edit-tool';

/**
 * Every file call of the overrides' own operations, which the build gives `original-fs` under Electron. pi's tools, loaded from
 * node_modules, import the real `fs`, which this mock never reaches; `watchPiFs` records those (docs/invariants.md "Tool overrides").
 */
const ours = vi.hoisted(() => ({ calls: [] as string[], dir: '' }));

const recording = vi.hoisted(() => <T extends object>(actual: T, relative: (file: string) => string): T => {
  const recorded = { ...actual };
  for (const name of ['access', 'realpath', 'open', 'readFile', 'writeFile', 'mkdir', 'stat'] as const) {
    const original = (actual as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
    (recorded as Record<string, unknown>)[name] = (file: unknown, ...rest: unknown[]) => {
      if (ours.dir && String(file).startsWith(ours.dir)) ours.calls.push(`${name} ${relative(String(file))}`);
      return original(file, ...rest);
    };
  }
  return recorded;
});

vi.mock('node:fs/promises', async (importOriginal) => recording(await importOriginal<typeof import('node:fs/promises')>(), (file) => path.relative(ours.dir, file)));

// the bundle maps node:fs to original-fs as it maps node:fs/promises, so a call through its promises is the overrides' own too
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = recording(actual.promises, (file) => path.relative(ours.dir, file));
  return { ...actual, promises, default: { ...actual, promises } };
});

/** The real `fs`, which pi's tools import and `watchPiFs` patches. */
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const FS_NAMES = ['access', 'realpath', 'open', 'readFile', 'writeFile', 'mkdir', 'stat', 'lstat'] as const;

/** Records each call the real `fs` gets for a path under `dir` while `run` runs, which only pi's own code makes here. */
async function watchPiFs<T>(dir: string, run: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const promises = realFs.promises as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = new Map(FS_NAMES.map((name) => [name, promises[name]!]));
  const calls: string[] = [];
  for (const [name, original] of originals) {
    promises[name] = (file: unknown, ...rest: unknown[]) => {
      if (String(file).startsWith(dir)) calls.push(`${name} ${path.relative(dir, String(file))}`);
      return original(file, ...rest);
    };
  }
  syncBuiltinESMExports();
  try {
    return { result: await run(), calls };
  } finally {
    for (const [name, original] of originals) promises[name] = original;
    syncBuiltinESMExports();
  }
}

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  ours.calls = [];
  ours.dir = '';
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-file-ops-')));
  dirs.push(dir);
  ours.dir = dir;
  return dir;
}

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown };

function run(tool: ToolDefinition | unknown, cwd: string, params: Record<string, unknown>): Promise<Result> {
  return (tool as ToolDefinition).execute('tc', params as never, undefined, undefined, { cwd } as never) as Promise<Result>;
}

/** The text, or the error message, a call ends with. */
function outcome(result: Promise<Result>): Promise<unknown> {
  return result.then((r) => r.content, (error: unknown) => ({ error: (error as Error).message }));
}

// a 1x1 PNG pi can decode
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe("the file tools' operations", () => {
  it('pi\'s own read touches its file through the real fs, which the watch records', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\n');
    const { calls } = await watchPiFs(cwd, () => run(pi.createReadToolDefinition(cwd), cwd, { path: 'a.txt' }));
    expect(calls).toEqual(expect.arrayContaining(['access a.txt', 'open a.txt']));
  });

  it.each([
    ['a text file', 'a.txt', Buffer.from('one\r\ntwo\nthree\n')],
    ['an image', 'dot.png', PNG],
    ['a file named as an archive', 'app.asar', Buffer.from('archive bytes\n')],
  ])('read reads %s as pi\'s read does, finding and keying it only through its own operations', async (_what, name, bytes) => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, name), bytes);
    const pis = await outcome(run(pi.createReadToolDefinition(cwd), cwd, { path: name }));
    ours.calls = [];

    const { result, calls } = await watchPiFs(cwd, () => outcome(run(createReadTool(pi, cwd), cwd, { path: name })));

    expect(result).toEqual(pis);
    expect(calls).toEqual([]);
    expect(ours.calls).toEqual(expect.arrayContaining([`access ${name}`, `realpath ${name}`, `open ${name}`]));
  });

  it('read fails on a missing file as pi\'s read does, asking only its own operations', async () => {
    const cwd = tempDir();
    const pis = await outcome(run(pi.createReadToolDefinition(cwd), cwd, { path: 'gone.txt' }));
    ours.calls = [];

    const { result, calls } = await watchPiFs(cwd, () => outcome(run(createReadTool(pi, cwd), cwd, { path: 'gone.txt' })));

    expect(result).toEqual(pis);
    expect(calls).toEqual([]);
    expect(ours.calls).toContain('access gone.txt');
  });

  it.each([
    ['replaces a file', 'a.txt', true],
    ['creates a file in a new folder', 'new/b.txt', false],
  ])('write %s as pi\'s write does, keying it only through its own realpath', async (_what, name, exists) => {
    const cwd = tempDir();
    const theirs = tempDir();
    ours.dir = cwd;
    if (exists) {
      fs.writeFileSync(path.join(cwd, name), 'old\n');
      fs.writeFileSync(path.join(theirs, name), 'old\n');
    }
    const content = 'new\r\ncontent\n';
    const pis = await outcome(run(pi.createWriteToolDefinition(theirs), theirs, { path: name, content }));

    const { result, calls } = await watchPiFs(cwd, () => outcome(run(createWriteTool(pi, cwd), cwd, { path: name, content })));

    expect(result).toEqual(pis);
    expect(fs.readFileSync(path.join(cwd, name))).toEqual(fs.readFileSync(path.join(theirs, name)));
    expect(calls).toEqual([]);
    expect(ours.calls).toEqual(expect.arrayContaining([`realpath ${path.normalize(name)}`, `open ${path.normalize(name)}`]));
  });

  it('Edit makes one replacement as pi\'s edit does, reaching the file only through its own operations', async () => {
    const cwd = tempDir();
    const theirs = tempDir();
    ours.dir = cwd;
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'one\r\ntwo\nthree\n');
    fs.writeFileSync(path.join(theirs, 'a.txt'), 'one\r\ntwo\nthree\n');
    const pis = await run(pi.createEditToolDefinition(theirs), theirs, { path: 'a.txt', edits: [{ oldText: 'two', newText: 'TWO' }] });

    const { result, calls } = await watchPiFs(cwd, () => run(createEditTool(pi, cwd), cwd, { file_path: 'a.txt', old_string: 'two', new_string: 'TWO' }));

    expect(result).toEqual(pis);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'))).toEqual(fs.readFileSync(path.join(theirs, 'a.txt')));
    expect(calls).toEqual([]);
    expect(ours.calls).toEqual(['stat a.txt', 'realpath a.txt', 'access a.txt', 'open a.txt', 'open a.txt']);
  });

  it('Edit replace_all reaches the file only through its own operations', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'x one\r\nx\n');

    const { result, calls } = await watchPiFs(cwd, () => run(createEditTool(pi, cwd), cwd, { file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }));

    expect(result.content).toEqual([{ type: 'text', text: 'Successfully replaced 1 block(s) in a.txt.' }]);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('y one\r\ny\n');
    expect(calls).toEqual([]);
    expect(ours.calls).toEqual(['stat a.txt', 'realpath a.txt', 'access a.txt', 'open a.txt', 'open a.txt']);
  });

  it('Edit fails on a missing file as pi\'s edit does, asking only its own operations', async () => {
    const cwd = tempDir();
    const pis = await outcome(run(pi.createEditToolDefinition(cwd), cwd, { path: 'gone.txt', edits: [{ oldText: 'a', newText: 'b' }] }));
    ours.calls = [];

    const { result, calls } = await watchPiFs(cwd, () => outcome(run(createEditTool(pi, cwd), cwd, { file_path: 'gone.txt', old_string: 'a', new_string: 'b' })));

    expect(result).toEqual(pis);
    expect(calls).toEqual([]);
    expect(ours.calls).toEqual(['stat gone.txt', 'realpath gone.txt', 'access gone.txt']);
  });
});
