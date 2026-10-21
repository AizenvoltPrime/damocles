import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createBashTool, type ShellOptions } from '../bash-tool';
import { createTrackedPowerShellOperations } from '../powershell-tool';

/** Slice 12a rule 13: the worktree variables reach the agent's shells through pi's spawnHook and the PowerShell env, never process.env. */
describe('the worktree shell environment', () => {
  // A test run from a Damocles worktree chat's shell inherits the variable.
  beforeEach(() => vi.stubEnv('DAMOCLES_WORKTREE_INDEX', undefined));
  afterEach(() => vi.unstubAllEnvs());

  it('adds the variables through spawnHook, rebuilds when they change, and leaves process.env alone', async () => {
    const built: Array<{ spawnHook?: (ctx: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { env: NodeJS.ProcessEnv } }> = [];
    const execute = vi.fn(async () => ({ content: [], details: undefined }));
    const pi = {
      createBashToolDefinition: (_cwd: string, options: (typeof built)[number]) => {
        built.push(options);
        return { name: 'bash', label: 'bash', description: '', parameters: { type: 'object', properties: { command: { type: 'string' } } }, execute };
      },
    } as unknown as PiCodingAgentModule;
    let options: ShellOptions = {};
    const tool = createBashTool(pi, '/w', { getShellOptions: () => options, shellJob: undefined });
    expect(built[0]!.spawnHook).toBeUndefined();
    options = { env: { DAMOCLES_WORKTREE_INDEX: '2', DAMOCLES_PROJECT_FOLDER: '/p' } };
    await tool.execute('t1', { command: 'echo' } as never, undefined, undefined, undefined as never);
    const hook = built.at(-1)!.spawnHook!;
    expect(hook({ command: 'echo', cwd: '/w', env: { PATH: 'x' } }).env).toEqual({ PATH: 'x', DAMOCLES_WORKTREE_INDEX: '2', DAMOCLES_PROJECT_FOLDER: '/p' });
    expect(process.env['DAMOCLES_WORKTREE_INDEX']).toBeUndefined();
  });

  it('merges the variables into the PowerShell tool\'s explicit environment', async () => {
    const ops = createTrackedPowerShellOperations(undefined, () => ({ DAMOCLES_WORKTREE_INDEX: '3' }));
    // The working directory check runs before any spawn, so a missing folder shows the merge never touched process.env.
    await expect(ops.exec('echo', '/no/such/folder', { onData: () => undefined, env: { PATH: 'x' } })).rejects.toThrow('Working directory does not exist');
    expect(process.env['DAMOCLES_WORKTREE_INDEX']).toBeUndefined();
  });
});
