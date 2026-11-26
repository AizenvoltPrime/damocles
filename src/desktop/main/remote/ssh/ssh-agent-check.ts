// Whether the SSH client's own agent answers, for a host that forwards it: docs/invariants.md "ssh starts with one fixed
// option set", the ForwardAgent option.
import { runProcess } from '../../../../core/process-launcher';
import { openSshToolBeside } from '../../../../core/system-tools';

// ssh-add -l exits 0 listing keys, 1 for an agent holding none, and 2 when it reaches no agent
const NO_AGENT_EXIT = 2;
const AGENT_CHECK_TIMEOUT_MS = 5000;

type Env = Readonly<Record<string, string | undefined>>;

export interface AgentCheckDeps {
  // ssh-add from ssh's own folder (openSshToolBeside)
  readonly sshAdd: (ssh: string) => Promise<string | undefined>;
  // `ssh-add -l` with env; its exit code, null when it gave no answer in time
  readonly run: (sshAdd: string, env: Env, timeoutMs: number) => Promise<number | null>;
  readonly log: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether an agent answers `ssh-add -l` beside ssh with ssh's environment; undefined, logged, when that cannot be told. */
export async function agentAnswers(ssh: string, env: Env, deps: AgentCheckDeps): Promise<boolean | undefined> {
  const sshAdd = await deps.sshAdd(ssh);
  if (sshAdd === undefined) {
    deps.log(`no ssh-add beside ${ssh}, so whether an SSH agent runs is not checked`);
    return undefined;
  }
  let code: number | null;
  try {
    code = await deps.run(sshAdd, env, AGENT_CHECK_TIMEOUT_MS);
  } catch (err) {
    deps.log(`ssh-add -l did not run: ${messageOf(err)}`);
    return undefined;
  }
  if (code === NO_AGENT_EXIT) return false;
  if (code === 0 || code === 1) return true;
  deps.log(code === null ? 'ssh-add -l gave no answer in time, so whether an SSH agent runs is not known' : `ssh-add -l exited with ${code}, so whether an SSH agent runs is not known`);
  return undefined;
}

/** agentAnswers on this process's launcher. */
export function systemAgentAnswers(ssh: string, env: Env, log: (line: string) => void): Promise<boolean | undefined> {
  return agentAnswers(ssh, env, {
    sshAdd: (client) => openSshToolBeside(client, 'ssh-add'),
    run: async (sshAdd, callEnv, timeoutMs) => (await runProcess({ file: sshAdd, args: ['-l'], env: callEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs })).exit?.code ?? null,
    log,
  });
}
