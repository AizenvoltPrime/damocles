import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { rgPath } from '@vscode/ripgrep';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createFindTool, createGrepTool } from '../search-tools';
import { processLauncher } from '../../../process-launcher';
import { createWalkHost, installWalkHost, startWalkChild, type WalkHost } from '../../../search-walk';
import { buildWalkChild } from '../../../../__mocks__/built-walk-child';

// Grep and Glob list through the walk process: every walk of theirs starts or reuses the built dist/walk-child.js, none runs here.

const pi = (await import('@earendil-works/pi-coding-agent')) as unknown as PiCodingAgentModule;
const noReadRules = (): Promise<(filePath: string) => boolean> => Promise.resolve(() => false);
const noHosts = (): Promise<ReadonlySet<string>> => Promise.resolve(new Set());

let root: string;
let built: Awaited<ReturnType<typeof buildWalkChild>>;
let walks: WalkHost;
let previous: WalkHost | undefined;
const logged: string[] = [];

function write(relative: string, content: string): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function text(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('tool result did not start with a text block');
  return first.text;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'damocles-search-process-'));
  write('.gitignore', 'ignored.ts\n');
  write('src/app.ts', 'const a = "needle";\n');
  write('src/deep/util.ts', 'needle deep\n');
  write('ignored.ts', 'needle ignored\n');
  write('node_modules/pkg/index.ts', 'needle vendored\n');
  built = await buildWalkChild();
  walks = createWalkHost(() => startWalkChild(built.entry), (line) => logged.push(line));
  previous = installWalkHost(walks);
});

afterAll(async () => {
  await walks.close();
  installWalkHost(previous!);
  built.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('Grep and Glob through the walk process', () => {
  it('list on one walk process started by the first walk, rg matching what it listed', async () => {
    const launcher = processLauncher();
    const launch = vi.spyOn(launcher, 'launch');
    try {
      const grep = createGrepTool(pi, root, () => Promise.resolve(rgPath), noReadRules, noHosts);
      const grepped = await grep.execute('call', { pattern: 'needle' } as never, undefined, undefined, { cwd: root } as never);
      // outside a repository rg applies no .gitignore, and Glob applies it as fd's --no-require-git does
      expect(text(grepped as AgentToolResult<unknown>).split('\n').sort()).toEqual(['ignored.ts:1: needle ignored', 'node_modules/pkg/index.ts:1: needle vendored', 'src/app.ts:1: const a = "needle";', 'src/deep/util.ts:1: needle deep']);
      const find = createFindTool(pi, root, noReadRules, noHosts);
      const found = await find.execute('call', { pattern: '*.ts' } as never, undefined, undefined, { cwd: root } as never);
      expect(text(found as AgentToolResult<unknown>).split('\n').sort()).toEqual(['src/app.ts', 'src/deep/util.ts']);
      const walkStarts = launch.mock.calls.filter(([spec]) => spec.args[0] === built.entry);
      expect(walkStarts).toHaveLength(1);
      expect(walkStarts[0]![0].file).toBe(process.execPath);
      expect(launch.mock.calls.filter(([spec]) => spec.file === rgPath).length).toBeGreaterThan(0);
      expect(logged).toEqual([]);
    } finally {
      launch.mockRestore();
    }
  });

  it('reads the hosts of the chat only on Windows, the one place a .git pointer is placed with them', async () => {
    const hosts = vi.fn(noHosts);
    await createGrepTool(pi, root, () => Promise.resolve(rgPath), noReadRules, hosts).execute('call', { pattern: 'needle' } as never, undefined, undefined, { cwd: root } as never);
    await createFindTool(pi, root, noReadRules, hosts).execute('call', { pattern: '*.ts' } as never, undefined, undefined, { cwd: root } as never);
    expect(hosts).toHaveBeenCalledTimes(process.platform === 'win32' ? 2 : 0);
  });
});
