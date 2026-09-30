import { describe, it, expect, vi } from 'vitest';

const order: string[] = [];
// When set, the next run resolves only when the test releases it.
let heldRun: Promise<{ status: 'completed'; text: string }> | null = null;

vi.mock('../team-runner', () => ({
  TeamRunner: class {
    run(): Promise<{ status: 'completed'; text: string }> {
      order.push('run');
      return heldRun ?? Promise.resolve({ status: 'completed', text: 'synthesis' });
    }
    getOperatorSteers(): [] {
      return [];
    }
  },
}));

import { TeamService } from '../index';
import type { AgentInvocationData } from '../../pi-session/agent-records';

function service(recorded: AgentInvocationData[]): TeamService {
  return new TeamService({
    cwd: '/cwd',
    onMessage: () => undefined,
    getSessionId: () => 'sess',
    getPermissionMode: () => 'default',
    resolveRoleModel: () => ({ dollarBilled: false }),
    buildEngine: () => ({}) as never,
    recordInvocation: (data) => {
      order.push('record');
      recorded.push(data);
    },
    parentBranch: () => [],
    assertResumableModel: () => undefined,
    requestInterruptionCheck: () => undefined,
  });
}

describe('TeamService.createTeam', () => {
  it('indexes the team on the parent branch under its create_team call before the team starts', async () => {
    order.length = 0;
    const recorded: AgentInvocationData[] = [];
    const teams = service(recorded);
    teams.setPendingToolUseId('tc-team');

    const result = await teams.createTeam({ title: 't', brief: 'b', agents: [{ name: 'lead', role: 'lead' }] });

    expect(order).toEqual(['record', 'run']);
    expect(recorded).toEqual([{ kind: 'team', id: expect.stringMatching(/^[0-9a-f-]{36}$/), toolCallId: 'tc-team', resume: false }]);
    expect(result).toBe('synthesis');
  });
});

describe('TeamService.whenRunSettled', () => {
  it('settles only once the running team has finished, and at once when none ran', async () => {
    const teams = service([]);
    await teams.whenRunSettled();

    let release!: () => void;
    heldRun = new Promise((r) => { release = () => r({ status: 'completed', text: 'done' }); });
    const creating = teams.createTeam({ title: 't', brief: 'b', agents: [{ name: 'lead', role: 'lead' }] });
    heldRun = null;
    let settled = false;
    const waiting = teams.whenRunSettled().then(() => { settled = true; });

    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    release();
    await waiting;
    await creating;
    expect(settled).toBe(true);
  });
});
