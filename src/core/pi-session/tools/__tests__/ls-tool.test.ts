import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createLsTool } from '../ls-tool';

/** Every access, stat and readdir the override's operations make; pi's own ls, loaded from node_modules, is not seen here. */
const calls = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: ((file: string, ...rest: never[]) => {
      calls.push(`access ${path.basename(file)}`);
      return (actual.access as (...args: unknown[]) => Promise<void>)(file, ...rest);
    }) as typeof actual.access,
    stat: ((file: string, ...rest: never[]) => {
      calls.push(`stat ${path.basename(file)}`);
      return (actual.stat as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.stat,
    readdir: ((dir: string, ...rest: never[]) => {
      calls.push(`readdir ${path.basename(dir)}`);
      return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof actual.readdir,
  };
});

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  calls.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Result = { content: Array<{ type: string; text?: string }> };

function run(tool: ToolDefinition, cwd: string, params: { path: string }): Promise<Result> {
  return tool.execute('tc', params as never, undefined, undefined, { cwd } as never) as Promise<Result>;
}

describe('the ls override', () => {
  it('lists what pi\'s own ls lists, through the override\'s exists, stat and readdir', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-ls-'));
    dirs.push(cwd);
    const listed = path.join(cwd, 'listed');
    fs.mkdirSync(path.join(listed, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(listed, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(listed, 'notes.txt'), 'notes\n');
    // Plain Node, as Vitest runs, sees any .asar as a file; the e2e test in agent-tools.spec.ts covers Electron's fs.
    fs.writeFileSync(path.join(listed, 'x.asar'), 'archive bytes');

    const mine = await run(createLsTool(pi, cwd), cwd, { path: 'listed' });
    const pis = await run(pi.createLsToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'listed' });

    expect(mine.content).toEqual(pis.content);
    expect(mine.content[0]?.text).toBe('.env\nnotes.txt\nsub/\nx.asar');
    expect(calls).toEqual(expect.arrayContaining(['access listed', 'readdir listed', 'stat listed', 'stat x.asar', 'stat sub']));
  });
});
