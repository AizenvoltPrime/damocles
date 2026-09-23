import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { reconcileInterruptions, type NoticeMessage } from '../interruption-notice';
import { readAgentFile, type LiveAgentStatus } from '../agent-records';

// A recording pass-through, so a case can fail one file's read.
vi.mock('../agent-records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-records')>();
  return { ...actual, readAgentFile: vi.fn(actual.readAgentFile) };
});
import {
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_AGENT_LAUNCH_ENTRY,
  DAMOCLES_AGENT_STATUS_ENTRY,
  DAMOCLES_INTERRUPTION_NOTICE,
} from '../session-store/constants';

const made: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-notice-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.mocked(readAgentFile).mockReset();
});

const A = '0a1b2c3d-4e5f-4a0';
const B = '9f8e7d6c-5b4a-4b1';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[]) =>
  ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude', usage, stopReason: 'toolUse', timestamp: Date.now() }) as unknown as Parameters<SessionManager['appendMessage']>[0];
const agentResult = (toolCallId: string, details: Record<string, unknown>) =>
  ({ role: 'toolResult', toolCallId, toolName: 'Agent', content: [{ type: 'text', text: '' }], details, isError: false, timestamp: Date.now() }) as unknown as Parameters<SessionManager['appendMessage']>[0];

/** A subagent file with a launch, one exchange and, when given, a terminal status. */
function writeAgentFile(dir: string, agentId: string, status?: Record<string, unknown>): void {
  const sm = SessionManager.create(dir, dir, { id: agentId });
  sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, {
    agentId, kind: 'subagent', agentType: 'Explore', description: `task of ${agentId.slice(0, 4)}`, prompt: 'p', background: false,
  });
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'p' }], timestamp: Date.now() });
  sm.appendMessage(assistant([{ type: 'text', text: 'working' }]));
  if (status) sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { ...status, result: 'partial' });
}

/** The parent's `Agent` call for `agentId`, its invocation entry and, when given, its tool result. */
function invoke(parent: SessionManager, agentId: string, toolCallId: string, opts: { resume?: boolean; details?: Record<string, unknown> } = {}): void {
  const args = opts.resume ? { resume: agentId } : { description: `spawned ${agentId.slice(0, 4)}`, prompt: 'p', subagent_type: 'Explore' };
  parent.appendMessage(assistant([{ type: 'toolCall', id: toolCallId, name: 'Agent', arguments: args }]));
  parent.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: agentId, toolCallId, resume: opts.resume ?? false });
  if (opts.details) parent.appendMessage(agentResult(toolCallId, opts.details));
}

/** The teams a case marked resumable, as `TeamPersistence.isResumable` would report them. */
const resumableTeams = new Set<string>();
afterEach(() => resumableTeams.clear());

async function reconcile(
  parent: SessionManager,
  dir: string,
  live: (id: string) => LiveAgentStatus | undefined = () => undefined,
  teamResumable: (teamId: string) => Promise<boolean> = async (teamId) => resumableTeams.has(teamId),
) {
  const sent: NoticeMessage[] = [];
  const announced = await reconcileInterruptions({
    branch: parent.getBranch(),
    subagentDir: dir,
    liveSubagent: live,
    teamResumable,
    send: async (message) => {
      sent.push(message);
      parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  });
  return { sent, announced };
}

describe('reconcileInterruptions', () => {
  it('ESC: a foreground agent stopped by the user gets one hidden notice naming its resume call', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'user' });
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'stopped', stopReason: 'user' } });

    const { sent } = await reconcile(parent, dir);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ customType: DAMOCLES_INTERRUPTION_NOTICE, display: false, details: { agents: [{ kind: 'subagent', id: A, toolCallId: 'tc1' }] } });
    expect(sent[0]!.content).toContain(`subagent ${A} ("task of 0a1b"): resume with Agent({resume:"${A}"})`);
    expect(sent[0]!.content.endsWith('Do not resume unless the user asks to continue.')).toBe(true);
  });

  it('reload: a background agent the panel shut down is listed', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'shutdown' });
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'async_launched' } });

    const { announced } = await reconcile(parent, dir);

    expect(announced.map((a) => a.id)).toEqual([A]);
  });

  it('crash: an agent with no status anywhere is interrupted and listed', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A);
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'async_launched' } });

    const { sent } = await reconcile(parent, dir);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.details.agents).toEqual([{ kind: 'subagent', id: A, toolCallId: 'tc1' }]);
  });

  it('no file: an agent stopped before its first response is listed with its spawn description', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');

    const { sent } = await reconcile(parent, dir, (id) => (id === A ? { toolCallId: 'tc1', status: 'stopped', stopReason: 'user' } : undefined));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain(`subagent ${A} ("spawned 0a1b")`);
  });

  it('finished, budget-stopped and still-running agents are not listed, so nothing is sent', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'completed' });
    writeAgentFile(dir, B, { status: 'stopped', stopReason: 'budget' });
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc2');
    invoke(parent, '1234abcd-0000-4000', 'tc3');

    const { sent } = await reconcile(parent, dir, (id) => (id === '1234abcd-0000-4000' ? { toolCallId: 'tc3', status: 'running' } : undefined));

    expect(sent).toEqual([]);
  });

  it('an invocation an earlier notice listed is not repeated; a later interruption of the same agent is', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'user' });
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'stopped', stopReason: 'user' } });

    expect((await reconcile(parent, dir)).sent).toHaveLength(1);
    expect((await reconcile(parent, dir)).sent).toHaveLength(0);

    invoke(parent, A, 'tc2', { resume: true, details: { agentId: A, status: 'stopped', stopReason: 'user' } });
    const again = await reconcile(parent, dir);
    expect(again.sent).toHaveLength(1);
    expect(again.sent[0]!.details.agents).toEqual([{ kind: 'subagent', id: A, toolCallId: 'tc2' }]);
  });

  it('an agent whose file cannot be read is skipped, and the others are still listed', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'user' });
    writeAgentFile(dir, B, { status: 'completed' });
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc2');
    const read = vi.mocked(readAgentFile);
    const real = read.getMockImplementation()!;
    read.mockImplementation((file) =>
      file.endsWith(`_${B}.jsonl`) ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : real(file),
    );

    const { announced } = await reconcile(parent, dir);

    // B finished; read as "no file" it would have been listed as interrupted.
    expect(announced.map((a) => a.id)).toEqual([A]);
  });

  it('an agent invoked only on a rewound branch is not listed', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'user' });
    writeAgentFile(dir, B, { status: 'stopped', stopReason: 'user' });
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'stopped', stopReason: 'user' } });
    const forkPoint = parent.getLeafId()!;
    invoke(parent, B, 'tc2', { details: { agentId: B, status: 'stopped', stopReason: 'user' } });
    parent.branch(forkPoint);

    const { announced } = await reconcile(parent, dir);

    expect(announced.map((a) => a.id)).toEqual([A]);
  });
});

describe('reconcileInterruptions for teams', () => {
  const T1 = '3f2b8c1e-9d4a-4e6b-8a1c-2b3d4e5f6a7b';
  const T2 = '7c6d5e4f-3a2b-4c1d-9e8f-0a1b2c3d4e5f';

  /** The parent's `create_team` or `resume_team` call and its invocation entry. */
  function invokeTeam(parent: SessionManager, teamId: string, toolCallId: string, opts: { resume?: boolean; title?: string } = {}): void {
    const args = opts.resume ? { team_id: teamId } : { title: opts.title ?? 'untitled', brief: 'b', agents: [] };
    parent.appendMessage(assistant([{ type: 'toolCall', id: toolCallId, name: opts.resume ? 'resume_team' : 'create_team', arguments: args }]));
    parent.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'team', id: teamId, toolCallId, resume: opts.resume ?? false });
  }

  const leaveUnusedCheckpoint = (teamId: string): void => void resumableTeams.add(teamId);

  it('lists a cancelled team once, with its title and resume_team call; a second reconcile repeats nothing', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invokeTeam(parent, T1, 'tc-team', { title: 'Slice 5 resume' });
    leaveUnusedCheckpoint(T1);

    const first = await reconcile(parent, dir);
    const second = await reconcile(parent, dir);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.details.agents).toEqual([{ kind: 'team', id: T1, toolCallId: 'tc-team' }]);
    expect(first.sent[0]!.content).toContain(`- team ${T1} ("Slice 5 resume"): resume with resume_team({team_id:"${T1}"})`);
    expect(first.sent[0]!.content.endsWith('Do not resume unless the user asks to continue.')).toBe(true);
    expect(second.sent).toEqual([]);
  });

  it('a team with no unused checkpoint (completed, failed or already resumed) is not listed', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invokeTeam(parent, T1, 'tc-team');

    expect((await reconcile(parent, dir)).sent).toEqual([]);
  });

  it('a team cancelled again after a resume is listed under the resume call', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invokeTeam(parent, T1, 'tc-team', { title: 'first' });
    leaveUnusedCheckpoint(T1);
    expect((await reconcile(parent, dir)).sent).toHaveLength(1);

    invokeTeam(parent, T1, 'tc-resume', { resume: true });
    const again = await reconcile(parent, dir);

    expect(again.sent).toHaveLength(1);
    expect(again.sent[0]!.details.agents).toEqual([{ kind: 'team', id: T1, toolCallId: 'tc-resume' }]);
    expect(again.sent[0]!.content).toContain(`- team ${T1} ("first")`);
  });

  it('lists a subagent and a team in the same notice, and not a team invoked only on another branch', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'user' });
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'stopped', stopReason: 'user' } });
    invokeTeam(parent, T1, 'tc-team', { title: 'kept' });
    leaveUnusedCheckpoint(T1);
    const forkPoint = parent.getLeafId()!;
    invokeTeam(parent, T2, 'tc-team-2', { title: 'rewound' });
    leaveUnusedCheckpoint(T2);
    parent.branch(forkPoint);

    const { sent } = await reconcile(parent, dir);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.details.agents).toEqual([
      { kind: 'subagent', id: A, toolCallId: 'tc1' },
      { kind: 'team', id: T1, toolCallId: 'tc-team' },
    ]);
  });

  it('skips a team whose resume state cannot be read and still lists the others', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invokeTeam(parent, T1, 'tc-team', { title: 'unreadable' });
    invokeTeam(parent, T2, 'tc-team-2', { title: 'fine' });
    leaveUnusedCheckpoint(T2);

    const { sent } = await reconcile(parent, dir, undefined, async (teamId) => {
      if (teamId === T1) throw new Error('EACCES');
      return resumableTeams.has(teamId);
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.details.agents).toEqual([{ kind: 'team', id: T2, toolCallId: 'tc-team-2' }]);
  });
});
