import { describe, expect, it } from 'vitest';
import { agentAnswers, type AgentCheckDeps } from '../ssh-agent-check';

const SSH = '/opt/openssh/bin/ssh';
const SSH_ADD = '/opt/openssh/bin/ssh-add';

// besideSsh: false when ssh's folder holds no ssh-add
function deps(exit: number | null | Error, besideSsh = true) {
  const runs: Array<{ readonly file: string; readonly env: Readonly<Record<string, string | undefined>> }> = [];
  const logs: string[] = [];
  const check: AgentCheckDeps = {
    sshAdd: async (ssh) => (ssh === SSH && besideSsh ? SSH_ADD : undefined),
    run: async (file, env) => {
      runs.push({ file, env });
      if (exit instanceof Error) throw exit;
      return exit;
    },
    log: (line) => logs.push(line),
  };
  return { check, runs, logs };
}

describe('agentAnswers', () => {
  it('reads ssh-add -l\'s exit 2 as no agent and 0 or 1 as an agent that answered, run from ssh\'s folder with its environment', async () => {
    const env = { SSH_AUTH_SOCK: '/tmp/agent.sock' };
    const none = deps(2);
    expect(await agentAnswers(SSH, env, none.check)).toBe(false);
    expect(none.runs).toEqual([{ file: SSH_ADD, env }]);
    expect(await agentAnswers(SSH, env, deps(0).check)).toBe(true);
    expect(await agentAnswers(SSH, env, deps(1).check)).toBe(true);
  });

  it('cannot tell, and logs why, for a client without ssh-add, a timeout, another exit or a start that failed', async () => {
    const missing = deps(2, false);
    expect(await agentAnswers(SSH, {}, missing.check)).toBeUndefined();
    expect(missing.runs).toEqual([]);
    expect(missing.logs).toEqual([`no ssh-add beside ${SSH}, so whether an SSH agent runs is not checked`]);
    for (const [exit, line] of [
      [null, 'ssh-add -l gave no answer in time, so whether an SSH agent runs is not known'],
      [127, 'ssh-add -l exited with 127, so whether an SSH agent runs is not known'],
      [new Error('spawn EACCES'), 'ssh-add -l did not run: spawn EACCES'],
    ] as const) {
      const run = deps(exit);
      expect(await agentAnswers(SSH, {}, run.check)).toBeUndefined();
      expect(run.logs).toEqual([line]);
    }
  });
});
