import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunOutput, SpawnSpec } from '../../../process-launcher';

const state = vi.hoisted(() => ({
  dir: '',
  runs: [] as Array<{ spec: SpawnSpec; options: RunOptions | undefined }>,
  cacheAnswers: [] as Array<RunOutput['exit']>,
}));

vi.mock('../paths', () => ({
  get MCP_NPX_CACHE_PATH() {
    return path.join(state.dir, 'npx-cache.json');
  },
}));

vi.mock('../../../process-launcher', () => ({
  runProcess: vi.fn(async (spec: SpawnSpec, options?: RunOptions): Promise<RunOutput> => {
    state.runs.push({ spec, options });
    if (spec.args[0] !== 'config') return { exit: { code: 0, signal: null }, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const exit = state.cacheAnswers.shift() ?? null;
    return { exit, stdout: Buffer.from(exit ? path.join(state.dir, 'no-npm-cache') : ''), stderr: Buffer.alloc(0) };
  }),
}));

let savedPath: string | undefined;
let savedCache: string | undefined;

beforeEach(() => {
  vi.resetModules();
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-npx-resolver-'));
  state.runs.length = 0;
  state.cacheAnswers.length = 0;
  savedPath = process.env['PATH'];
  savedCache = process.env['NPM_CONFIG_CACHE'];
  delete process.env['NPM_CONFIG_CACHE'];
});

afterEach(() => {
  process.env['PATH'] = savedPath;
  if (savedCache !== undefined) process.env['NPM_CONFIG_CACHE'] = savedCache;
  else delete process.env['NPM_CONFIG_CACHE'];
  fs.rmSync(state.dir, { recursive: true, force: true });
});

function npmOnPath(name: string): string {
  const bin = path.join(state.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), '');
  process.env['PATH'] = bin;
  return path.join(bin, name);
}

const configRuns = () => state.runs.filter((run) => run.spec.args[0] === 'config');

describe('resolveNpxBinary', () => {
  it('bounds npm\'s cache folder answer, and asks again after npm did not answer in time', async () => {
    npmOnPath(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const { resolveNpxBinary } = await import('../npx-resolver');
    state.cacheAnswers.push(null, { code: 0, signal: null });

    expect(await resolveNpxBinary('npx', ['-y', 'some-mcp-server'])).toBeNull();
    // the first answer timed out, so the read after the cache warm-up asked again and kept that answer
    expect(configRuns()).toHaveLength(2);
    expect(configRuns().every((run) => typeof run.options?.timeoutMs === 'number')).toBe(true);

    expect(await resolveNpxBinary('npx', ['-y', 'some-mcp-server'])).toBeNull();
    expect(configRuns()).toHaveLength(2);
  });

  it('resolves a cached package whose package.json starts with a BOM, as npm reads it', async () => {
    const cacheDir = path.join(state.dir, 'npm-cache');
    const packageDir = path.join(cacheDir, '_npx', 'abc123', 'node_modules', 'some-mcp-server');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), `\uFEFF${JSON.stringify({ name: 'some-mcp-server', bin: 'cli.js' })}`);
    fs.writeFileSync(path.join(packageDir, 'cli.js'), '#!/usr/bin/env node\n');
    process.env['NPM_CONFIG_CACHE'] = cacheDir;
    const { resolveNpxBinary } = await import('../npx-resolver');

    expect(await resolveNpxBinary('npx', ['-y', 'some-mcp-server', '--flag'])).toEqual({
      binPath: path.join(packageDir, 'cli.js'),
      extraArgs: ['--flag'],
      isJs: true,
    });
  });

  it.runIf(process.platform === 'win32')('runs an npm.exe shim when the PATH folder holds no npm.cmd', async () => {
    const npm = npmOnPath('npm.exe');
    const { resolveNpxBinary } = await import('../npx-resolver');
    state.cacheAnswers.push({ code: 0, signal: null });

    await resolveNpxBinary('npx', ['-y', 'some-mcp-server']);

    expect(configRuns()[0]?.spec.file).toBe(npm);
  });
});
