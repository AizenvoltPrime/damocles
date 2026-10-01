import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { rgPath } from '@vscode/ripgrep';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createFindTool, createGrepTool, fdGlobMatcher, GREP_PARAMETER_NAMES, resolveToCwd } from '../search-tools';

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
    ['a single file', { pattern: 'needle', path: 'src/deep/util.spec.ts' }],
    ['a pattern that starts with a dash', { pattern: '-foo' }],
    ['no match', { pattern: 'absent-token' }],
  ];

  it.each(cases)('matches pi grep for %s', async (_label, params) => {
    const expected = await execute(piGrep(), params);
    const actual = await execute(createGrepTool(pi, root, resolveRg), params);
    expect(sortedText(actual)).toEqual(sortedText(expected));
    expect(actual.details).toEqual(expected.details);
  });

  it('fails like pi grep on an invalid regex', async () => {
    const expected = await execute(piGrep(), { pattern: '(' }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(expected).toMatch(/regex parse error/);
    await expect(execute(createGrepTool(pi, root, resolveRg), { pattern: '(' })).rejects.toThrow(expected);
  });

  it('runs the bundled ripgrep when rg is on no PATH and pi may not download', async () => {
    vi.stubEnv('PI_OFFLINE', '1');
    vi.stubEnv('PATH', '');
    await expect(run(pi.createGrepToolDefinition(root) as never, { pattern: 'needle' })).rejects.toThrow(/not available/);
    expect(await run(createGrepTool(pi, root, resolveRg), { pattern: 'answer' })).toBe('src/app.ts:1: export const answer = 42;');
  });

  it('handles every parameter of pi grep schema', () => {
    const properties = (pi.createGrepToolDefinition(root).parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual([...GREP_PARAMETER_NAMES].sort());
    expect(createGrepTool(pi, root, resolveRg).name).toBe('grep');
  });

  it('rejects a missing path and an aborted call', async () => {
    const tool = createGrepTool(pi, root, resolveRg);
    await expect(run(tool, { pattern: 'x', path: 'nope' })).rejects.toThrow(`Path not found: ${join(root, 'nope')}`);
    await expect(run(tool, { pattern: 'x' }, AbortSignal.abort())).rejects.toThrow('Operation aborted');
  });
});

describe('find', () => {
  const find = (params: Record<string, unknown>, signal?: AbortSignal): Promise<string> => run(createFindTool(pi, root, resolveRg), params, signal);
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
    expect(await find({ pattern: '*', limit: 1 })).toMatch(/\n\n\[1 results limit reached\. Use limit=2 for more, or refine pattern\]$/);
    expect(await find({ pattern: '*', limit: 0 })).toBe('No files found matching pattern');
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
    const ours = createFindTool(pi, root, resolveRg);
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
});

describe('resolveToCwd', () => {
  it('resolves like pi: @ prefix, home, and relative paths', () => {
    expect(resolveToCwd('@src/app.ts', root)).toBe(join(root, 'src', 'app.ts'));
    expect(resolveToCwd('~', root)).toBe(homedir());
    expect(resolveToCwd('..', join(root, 'src'))).toBe(root);
  });
});
