import { afterEach, describe, expect, it, vi } from 'vitest';
// The REAL pi bash definition and shell lookup, so the environment asserted below is the one pi's spawn context builds.
import { createBashToolDefinition, getShellConfig } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../../pi-loader';
import { processLauncher, type LaunchedProcess } from '../../../process-launcher';
import type { SpawnSpec } from '../../../process-launcher/protocol';
import { createBashTool } from '../bash-tool';
import { currentShellLease, withShellCredentials, type ShellCredentialLease } from '../shell-credentials';

const pi = { createBashToolDefinition, getShellConfig } as unknown as PiCodingAgentModule;
const CWD = process.cwd();
const ctx = undefined as never;

function textOf(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('tool result did not start with a text block');
  return first.text;
}

type FakeLease = ShellCredentialLease & { heldBy: ReturnType<typeof vi.fn<(shell: LaunchedProcess) => void>>; release: ReturnType<typeof vi.fn<() => void>> };

function leaseOf(env: Record<string, string>): FakeLease {
  return { env, heldBy: vi.fn<(shell: LaunchedProcess) => void>(), release: vi.fn<() => void>() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('withShellCredentials', () => {
  it('runs the call under its own lease and releases it once the call ends, a failed call included', async () => {
    const lease = leaseOf({ DAMOCLES_CREDENTIAL_NONCE: 'n' });
    await expect(withShellCredentials(async () => lease, 'call-1', async () => currentShellLease())).resolves.toBe(lease);
    expect(lease.release).toHaveBeenCalledTimes(1);
    const failing = leaseOf({});
    await expect(withShellCredentials(async () => failing, 'call-2', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(failing.release).toHaveBeenCalledTimes(1);
    await expect(withShellCredentials(async () => undefined, 'call-3', async () => currentShellLease())).resolves.toBeUndefined();
  });
});

describe("the bash tool's git credentials", () => {
  const launches = (): { spy: ReturnType<typeof vi.spyOn>; specs: () => SpawnSpec[] } => {
    const spy = vi.spyOn(processLauncher(), 'launch');
    return { spy, specs: () => spy.mock.calls.map((call) => call[0] as SpawnSpec) };
  };

  it("starts no shell before its call's credentials are registered, then runs it with them over the chat's variables and hands it the lease", async () => {
    const { spy, specs } = launches();
    let grant!: (lease: ShellCredentialLease) => void;
    const credentials = vi.fn(() => new Promise<ShellCredentialLease | undefined>((resolve) => (grant = resolve)));
    const tool = createBashTool(pi, CWD, { getShellOptions: () => ({ env: { DAMOCLES_CREDENTIAL_NONCE: 'relay-terminal', DAMOCLES_WORKTREE_INDEX: '2' } }), shellJob: undefined, shellCredentials: credentials });
    const pending = tool.execute('bash-cred', { command: 'echo "$DAMOCLES_CREDENTIAL_NONCE $DAMOCLES_WORKTREE_INDEX"' }, undefined, undefined, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(credentials).toHaveBeenCalledWith('bash-cred');
    expect(spy).not.toHaveBeenCalled();
    const lease = leaseOf({ DAMOCLES_CREDENTIAL_NONCE: 'call-nonce' });
    grant(lease);
    expect(textOf(await pending)).toContain('call-nonce 2');
    expect(specs()).toEqual([expect.objectContaining({ reportsLeftRunning: true })]);
    const shell = spy.mock.results[0]!.value as LaunchedProcess;
    expect(lease.heldBy).toHaveBeenCalledWith(shell);
    expect(lease.release).toHaveBeenCalledTimes(1);
    // nothing the command started outlived it
    await expect(shell.leftRunning).resolves.toBe(false);
  }, 30_000);

  it('tells its lease when the command left a job running past the shell', async () => {
    const { spy } = launches();
    const lease = leaseOf({ DAMOCLES_CREDENTIAL_NONCE: 'call-nonce' });
    const tool = createBashTool(pi, CWD, { getShellOptions: () => ({}), shellJob: undefined, shellCredentials: async () => lease });
    await tool.execute('bash-background', { command: 'sleep 3 > /dev/null 2>&1 &' }, undefined, undefined, ctx);
    const shell = spy.mock.results[0]!.value as LaunchedProcess;
    expect(lease.heldBy).toHaveBeenCalledWith(shell);
    await expect(shell.leftRunning).resolves.toBe(true);
  }, 30_000);

  it.runIf(process.platform === 'win32')("replaces an inherited GIT_CONFIG_PARAMETERS in any letter case with the takeover's", async () => {
    const { specs } = launches();
    vi.stubEnv('Git_Config_Parameters', "'core.pager=less'");
    const lease = leaseOf({ DAMOCLES_CREDENTIAL_NONCE: 'call-nonce', GIT_CONFIG_PARAMETERS: "'core.pager=less' 'credential.helper='" });
    const tool = createBashTool(pi, CWD, { getShellOptions: () => ({}), shellJob: undefined, shellCredentials: async () => lease });
    await tool.execute('bash-case', { command: 'true' }, undefined, undefined, ctx);
    const env = specs()[0]!.env!;
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'GIT_CONFIG_PARAMETERS')).toEqual(['GIT_CONFIG_PARAMETERS']);
    expect(env['GIT_CONFIG_PARAMETERS']).toBe(lease.env['GIT_CONFIG_PARAMETERS']);
  }, 30_000);
});
