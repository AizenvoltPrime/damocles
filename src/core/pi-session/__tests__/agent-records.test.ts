import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  agentInvocationsOnBranch,
  agentResultTextOnBranch,
  deliveredBackgroundResults,
  fetchedAgentResultsOnBranch,
  findAgentFile,
  indexAgentFiles,
  indexTeamMemberFiles,
  injectedAgentResultsOnBranch,
  isAgentInvocationData,
  isAgentStatusData,
  parseAgentLaunchData,
  parseAgentSegmentData,
  isSubagentResultFetchDetails,
  latestSubagentInvocations,
  readAgentFile,
  resolveAgentStatus,
  segmentForInvocation,
  subagentBranchIndex,
  subagentsDir,
  teamMemberSessionId,
  type SubagentLaunchData,
} from '../agent-records';
import {
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_AGENT_LAUNCH_ENTRY,
  DAMOCLES_AGENT_SEGMENT_ENTRY,
  DAMOCLES_AGENT_STATUS_ENTRY,
} from '../session-store/constants';
import { SUBAGENT_RESULTS_CUSTOM_TYPE } from '../subagents/background-results';

const made: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-agent-records-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function launch(agentId: string): SubagentLaunchData {
  return {
    agentId,
    kind: 'subagent',
    agentType: 'Explore',
    description: 'find things',
    prompt: 'look around',
    background: true,
    templatePath: '/agents/explore.md',
    modelLabel: 'haiku',
  };
}

const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() });
const assistant = (text: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as unknown as Parameters<SessionManager['appendMessage']>[0];

/** Write an agent session through pi's own SessionManager, exactly as a subagent run does. */
function writeAgentSession(dir: string, fileId: string, agentId: string, build: (sm: SessionManager) => void): string {
  const sm = SessionManager.create(dir, dir, { id: fileId });
  sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, launch(agentId));
  build(sm);
  return sm.getSessionFile()!;
}

describe('agent-records — custom entries round-trip through a pi session file', () => {
  it('reads back the launch, messages and status pi persisted', async () => {
    const dir = tempDir();
    const file = writeAgentSession(dir, 'agent-1', 'agent-1', (sm) => {
      sm.appendMessage(user('look around'));
      sm.appendMessage(assistant('found it'));
      sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'completed', result: 'found it' });
    });
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/_agent-1\.jsonl$/);

    const read = await readAgentFile(file);
    expect(read?.launch).toEqual(launch('agent-1'));
    expect(read?.status).toEqual({ status: 'completed', result: 'found it' });
    expect(read?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('validators reject malformed persisted payloads', () => {
    expect(parseAgentLaunchData(launch('a'))).toEqual(launch('a'));
    expect(parseAgentLaunchData({ ...launch('a'), background: 'yes' })).toBeNull();
    expect(parseAgentLaunchData({ agentId: 'm', kind: 'team-member', teamId: 't', attempt: 1, memberName: 'n', role: 'lead', task: 'x' })).not.toBeNull();
    expect(parseAgentLaunchData({ agentId: 'm', kind: 'team-member', teamId: 't', attempt: 1.5, memberName: 'n', role: 'lead', task: 'x' })).toBeNull();
    expect(isAgentStatusData({ status: 'stopped', stopReason: 'user', result: '' })).toBe(true);
    expect(isAgentStatusData({ status: 'stopped', stopReason: 'bored', result: '' })).toBe(false);
    expect(isAgentStatusData({ status: 'running', result: '' })).toBe(false);
    expect(isAgentInvocationData({ kind: 'subagent', id: 'abc', toolCallId: 'tc', resume: false })).toBe(true);
    expect(isAgentInvocationData({ kind: 'subagent', id: '../etc', toolCallId: 'tc', resume: false })).toBe(false);
    expect(isAgentInvocationData({ kind: 'widget', id: 'abc', toolCallId: 'tc', resume: false })).toBe(false);
  });

  it('a file without a valid launch entry is not an agent file', async () => {
    const dir = tempDir();
    const sm = SessionManager.create(dir, dir, { id: 'plain' });
    sm.appendMessage(user('hi'));
    sm.appendMessage(assistant('hello'));
    expect(await readAgentFile(sm.getSessionFile()!)).toBeNull();
  });
});

describe('agent-records — segments', () => {
  it('splits messages at each segment entry and keeps each segment’s own status', async () => {
    const dir = tempDir();
    const file = writeAgentSession(dir, 'agent-2', 'agent-2', (sm) => {
      sm.appendMessage(user('first'));
      sm.appendMessage(assistant('partial'));
      sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'stopped', stopReason: 'user', result: 'partial' });
      sm.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, { toolCallId: 'tc-resume', message: 'carry on' });
      sm.appendMessage(user('carry on'));
      sm.appendMessage(assistant('done'));
      sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'completed', result: 'done' });
    });

    const read = (await readAgentFile(file))!;
    expect(read.segments).toHaveLength(2);
    const [first, second] = read.segments;
    expect(first!.toolCallId).toBeNull();
    expect(first!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(first!.status).toEqual({ status: 'stopped', stopReason: 'user', result: 'partial' });
    expect(second!.toolCallId).toBe('tc-resume');
    expect(second!.message).toBe('carry on');
    expect(second!.status?.status).toBe('completed');
    expect(read.status?.status).toBe('completed');
    expect(read.messages).toHaveLength(4);

    expect(segmentForInvocation(read, { toolCallId: 'tc-launch', resume: false })).toBe(first);
    expect(segmentForInvocation(read, { toolCallId: 'tc-resume', resume: true })).toBe(second);
    expect(segmentForInvocation(read, { toolCallId: 'tc-other', resume: true })).toBeUndefined();
  });

  it('sums each segment’s billed usage, cache warms and compactions included, by pi’s session-total rule', async () => {
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) =>
      ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
    const billed = (u: ReturnType<typeof usage>) => ({ ...(assistant('work') as object), usage: u }) as unknown as Parameters<SessionManager['appendMessage']>[0];
    const dir = tempDir();
    const file = writeAgentSession(dir, 'agent-u', 'agent-u', (sm) => {
      sm.appendMessage(user('first'));
      sm.appendMessage(billed(usage(10, 20, 300, 40, 0.5)));
      sm.appendUsage('cache_warm', 'anthropic', 'claude', usage(0, 1, 900, 0, 0.05));
      sm.appendCompaction('summary', null, 5000, undefined, false, usage(4000, 600, 0, 0, 0.2));
      sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'stopped', stopReason: 'user', result: '' });
      sm.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, { toolCallId: 'tc-resume' });
      sm.appendMessage(user('carry on'));
      sm.appendMessage(billed(usage(1, 2, 330, 4, 0.25)));
    });

    const [first, second] = (await readAgentFile(file))!.segments;
    expect(first!.usage).toEqual({ totalInputTokens: 4010, totalOutputTokens: 621, cacheReadTokens: 1200, cacheCreationTokens: 40, costUsd: expect.closeTo(0.75) });
    // A resumed invocation shows only its own run.
    expect(second!.usage).toEqual({ totalInputTokens: 1, totalOutputTokens: 2, cacheReadTokens: 330, cacheCreationTokens: 4, costUsd: 0.25 });
  });
});

describe('agent-records — launch billing flag', () => {
  it('accepts a launch with or without the flag and rejects a non-boolean one', () => {
    expect(parseAgentLaunchData({ ...launch('a'), dollarBilled: false })).not.toBeNull();
    expect(parseAgentLaunchData(launch('a'))).not.toBeNull();
    expect(parseAgentLaunchData({ ...launch('a'), dollarBilled: 'yes' })).toBeNull();
  });
});

describe('agent-records — effort', () => {
  it('keeps a pi thinking level and drops any other effort without rejecting the entry', () => {
    expect(parseAgentLaunchData({ ...launch('a'), effort: 'high' })).toEqual({ ...launch('a'), effort: 'high' });
    expect(parseAgentLaunchData({ ...launch('a'), effort: 'ultracode' })).toEqual(launch('a'));
    expect(parseAgentLaunchData({ ...launch('a'), effort: 3 })).toEqual(launch('a'));
    expect(parseAgentSegmentData({ toolCallId: 'tc', effort: 'minimal' })).toEqual({ toolCallId: 'tc', effort: 'minimal' });
    expect(parseAgentSegmentData({ toolCallId: 'tc' })).toEqual({ toolCallId: 'tc' });
    expect(parseAgentSegmentData({ toolCallId: 'tc', effort: 'High' })).toEqual({ toolCallId: 'tc' });
  });

  // A newer build sharing ~/.damocles can write a level this build does not know.
  it('a launch or resume segment with an unknown effort still loads, and the resume keeps its own segment', async () => {
    const dir = tempDir();
    const sm = SessionManager.create(dir, dir, { id: 'agent-n' });
    sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, { ...launch('agent-n'), effort: 'hyper' });
    sm.appendMessage(user('first'));
    sm.appendMessage(assistant('partial'));
    sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'stopped', stopReason: 'user', result: 'partial' });
    sm.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, { toolCallId: 'tc-resume', effort: 'hyper' });
    sm.appendMessage(user('carry on'));
    sm.appendMessage(assistant('done'));
    sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'completed', result: 'done' });

    const read = (await readAgentFile(sm.getSessionFile()!))!;
    expect(read.launch).toEqual(launch('agent-n'));
    expect(read.segments).toHaveLength(2);
    expect(read.segments[1]).not.toHaveProperty('effort');
    expect(segmentForInvocation(read, { toolCallId: 'tc-resume', resume: true })?.status).toEqual({ status: 'completed', result: 'done' });
    expect((await indexAgentFiles(dir)).paths.get('agent-n')).toBe(sm.getSessionFile());
  });

  it('keeps each run’s effort: the launch entry’s for the spawn, the segment’s for a resume', async () => {
    const dir = tempDir();
    const sm = SessionManager.create(dir, dir, { id: 'agent-e' });
    sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, { ...launch('agent-e'), effort: 'medium' });
    sm.appendMessage(user('first'));
    sm.appendMessage(assistant('partial'));
    sm.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, { toolCallId: 'tc-resume', effort: 'high' });
    sm.appendMessage(user('carry on'));

    const read = (await readAgentFile(sm.getSessionFile()!))!;
    expect(read.launch).toMatchObject({ effort: 'medium' });
    expect(read.segments[0]).not.toHaveProperty('effort');
    expect(read.segments[1]!.effort).toBe('high');
  });
});

describe('agent-records — findAgentFile / indexAgentFiles', () => {
  it('locates a file by its launch entry, not its file name', async () => {
    const dir = tempDir();
    const flush = (sm: SessionManager) => {
      sm.appendMessage(user('go'));
      sm.appendMessage(assistant('ok'));
    };
    writeAgentSession(dir, 'agent-a', 'agent-a', flush);
    const renamed = writeAgentSession(dir, 'unrelated-name', 'agent-b', flush);

    expect(await findAgentFile(dir, 'agent-b')).toBe(renamed);
    expect(await findAgentFile(dir, 'unrelated-name')).toBeNull();
    expect(await findAgentFile(dir, 'missing')).toBeNull();
    expect([...(await indexAgentFiles(dir)).paths.keys()].sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('skips a file that cannot be read and still finds the others in the folder', async () => {
    const dir = tempDir();
    const flush = (sm: SessionManager) => {
      sm.appendMessage(user('go'));
      sm.appendMessage(assistant('ok'));
    };
    // Sorted ahead of the good files, and a directory, so reading it fails with EISDIR.
    fs.mkdirSync(path.join(dir, '0-unreadable.jsonl'));
    const good = writeAgentSession(dir, 'agent-a', 'agent-a', flush);
    const memberSm = SessionManager.create(dir, dir, { id: 'member-a0' });
    memberSm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, { agentId: 'member', kind: 'team-member', teamId: 't', attempt: 0, memberName: 'm', role: 'lead', task: 'x' });
    flush(memberSm);
    const member = memberSm.getSessionFile()!;

    const index = await indexAgentFiles(dir);
    expect([...index.paths.entries()]).toEqual([['agent-a', good], ['member', member]]);
    expect(index.unreadable).toEqual([path.join(dir, '0-unreadable.jsonl')]);
    expect(await findAgentFile(dir, 'agent-a')).toBe(good);
    expect([...(await indexTeamMemberFiles(dir)).keys()]).toEqual(['member']);
  });

  it('an agent stopped before its task was committed has no file, and a missing folder is empty', async () => {
    const dir = tempDir();
    writeAgentSession(dir, 'agent-c', 'agent-c', () => {});
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await findAgentFile(dir, 'agent-c')).toBeNull();
    expect(await indexAgentFiles(path.join(dir, 'nope'))).toEqual({ paths: new Map(), unreadable: [] });
  });

  it('an agent stopped before its first response has a file holding its launch and task', async () => {
    const dir = tempDir();
    const file = writeAgentSession(dir, 'agent-d', 'agent-d', (sm) => {
      sm.appendMessage(user('go'));
      sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'stopped', result: '' });
    });
    expect(await findAgentFile(dir, 'agent-d')).toBe(file);
    const read = (await readAgentFile(file))!;
    expect(read.launch.agentId).toBe('agent-d');
    expect(read.messages.map((m) => m['role'])).toEqual(['user']);
    expect(read.status).toMatchObject({ status: 'stopped' });
  });
});

describe('agent-records — resolveAgentStatus prefers the agent file, then the Agent tool result, then the results injection', () => {
  const fileStatus = { status: 'completed' as const, result: 'from file' };
  const toolResult = { agentId: 'a', status: 'stopped' as const, stopReason: 'budget' as const };
  const injection = { agentId: 'a', toolCallId: 'tc', status: 'error' as const, result: 'boom' };

  it('prefers the agent file’s status entry', () => {
    expect(resolveAgentStatus({ file: fileStatus, toolResult, injection })).toEqual({ status: 'completed', result: 'from file', source: 'agent-file' });
  });

  it('then the Agent tool result details', () => {
    expect(resolveAgentStatus({ toolResult, injection })).toEqual({ status: 'stopped', stopReason: 'budget', source: 'tool-result' });
  });

  it('skips a background acknowledgement and falls to the injection details', () => {
    expect(resolveAgentStatus({ toolResult: { agentId: 'a', status: 'async_launched' }, injection })).toEqual({
      status: 'error',
      result: 'boom',
      source: 'injection',
    });
  });

  it('with no record at all, the agent is interrupted', () => {
    expect(resolveAgentStatus({})).toEqual({ status: 'interrupted', source: 'none' });
  });
});

describe('agent-records — parent branch readers', () => {
  const custom = (customType: string, data: unknown) => ({ type: 'custom', id: `c${Math.random()}`, customType, data }) as unknown as SessionEntry;

  it('lists valid invocation entries in branch order and skips malformed ones', () => {
    const branch = [
      custom(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: 'a1', toolCallId: 'tc1', resume: false }),
      custom(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: 'a/2', toolCallId: 'tc2', resume: false }),
      custom('damocles-steer', { agentId: 'a1', message: 'x' }),
      custom(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'team', id: 't1', toolCallId: 'tc3', resume: true }),
    ];
    expect(agentInvocationsOnBranch(branch).map((i) => i.id)).toEqual(['a1', 't1']);
  });

  it('keys injected results by the invoking tool call id', () => {
    const branch = [
      {
        type: 'custom_message',
        id: 'm1',
        customType: SUBAGENT_RESULTS_CUSTOM_TYPE,
        content: 'model-visible text',
        display: false,
        details: { agents: [{ agentId: 'a1', toolCallId: 'tc1', status: 'error', result: 'boom' }, { agentId: 'bad' }] },
      } as unknown as SessionEntry,
    ];
    const results = injectedAgentResultsOnBranch(branch);
    expect([...results.keys()]).toEqual(['tc1']);
    expect(results.get('tc1')?.result).toBe('boom');
  });

  const toolResult = (toolName: string, details: unknown) =>
    ({ type: 'message', id: `r${Math.random()}`, message: { role: 'toolResult', toolCallId: 'tc-get', toolName, content: [], details, isError: false } }) as unknown as SessionEntry;

  it('keys GetSubagentResult fetch markers by the fetched invocation and skips results that carry none', () => {
    const branch = [
      toolResult('GetSubagentResult', { agentId: 'a1', toolCallId: 'tc1', status: 'completed' }),
      toolResult('GetSubagentResult', undefined),
      toolResult('GetSubagentResult', { agentId: 'a2', toolCallId: 'tc2', status: 'running' }),
      toolResult('Agent', { agentId: 'a3', toolCallId: 'tc3', status: 'completed' }),
    ];
    expect([...fetchedAgentResultsOnBranch(branch)]).toEqual([['tc1', { agentId: 'a1', toolCallId: 'tc1', status: 'completed' }]]);
    expect(isSubagentResultFetchDetails({ agentId: 'a1', toolCallId: '', status: 'completed' })).toBe(false);
  });

  it('D(branch) is every injected and every fetched invocation, and the index carries the fetches', () => {
    const branch = [
      custom(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: 'a1', toolCallId: 'tc1', resume: false }),
      custom(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: 'a2', toolCallId: 'tc2', resume: false }),
      custom(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: 'a1', toolCallId: 'tc3', resume: true }),
      {
        type: 'custom_message',
        id: 'm1',
        customType: SUBAGENT_RESULTS_CUSTOM_TYPE,
        content: 'x',
        display: false,
        details: { agents: [{ agentId: 'a1', toolCallId: 'tc1', status: 'completed', result: 'r' }] },
      } as unknown as SessionEntry,
      toolResult('GetSubagentResult', { agentId: 'a2', toolCallId: 'tc2', status: 'error' }),
    ];
    const index = subagentBranchIndex(branch);
    expect([...index.fetched.keys()]).toEqual(['tc2']);
    expect(deliveredBackgroundResults(index)).toEqual(new Set(['tc1', 'tc2']));
    expect([...latestSubagentInvocations(index)].map(([id, inv]) => [id, inv.toolCallId])).toEqual([['a1', 'tc3'], ['a2', 'tc2']]);
  });

  it("reads a finished Agent call's response text, and nothing from a launch acknowledgement or a thrown call", () => {
    const agentResult = (toolCallId: string, text: string) =>
      ({ type: 'message', id: `r-${toolCallId}`, message: { role: 'toolResult', toolCallId, toolName: 'Agent', content: [{ type: 'text', text }], isError: false } }) as unknown as SessionEntry;
    const branch = [
      agentResult('tc-fg', JSON.stringify({ content: [{ type: 'text', text: 'the answer' }], agentId: 'a1', agentStatus: 'completed' })),
      agentResult('tc-bg', JSON.stringify({ status: 'async_launched', agentId: 'a2' })),
      agentResult('tc-err', 'Subagent "x" was a "y" agent, which is no longer available.'),
    ];
    expect(agentResultTextOnBranch(branch, 'tc-fg')).toBe('the answer');
    expect(agentResultTextOnBranch(branch, 'tc-bg')).toBeUndefined();
    expect(agentResultTextOnBranch(branch, 'tc-err')).toBeUndefined();
    expect(agentResultTextOnBranch(branch, 'tc-none')).toBeUndefined();
  });
});

describe('agent-records — layout', () => {
  it('files agent data under the parent session and refuses unsafe ids', () => {
    expect(subagentsDir('/sessions', 'sess-1')).toBe(path.join('/sessions', 'sess-1', 'subagents'));
    expect(() => subagentsDir('/sessions', '../escape')).toThrow();
    expect(teamMemberSessionId('m1', 2)).toBe('m1.a2');
  });
});
