import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { copyForkAgentData } from '../fork-agent-data';
import {
  findAgentFile,
  indexTeamMemberFiles,
  listTeamCheckpoints,
  readAgentFile,
  subagentsDir,
  teamCheckpointPath,
  teamCheckpointsDir,
  teamEventLogPath,
  teamMembersDir,
  teamMemberSessionId,
  type AgentInvocationData,
} from '../agent-records';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_AGENT_STATUS_ENTRY } from '../session-store/constants';

type Message = Parameters<SessionManager['appendMessage']>[0];

const SOURCE = 'source-session';
const TARGET = 'fork-session';
const TEAM = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const MEMBER = '6fa459ea-ee8a-4ca4-894e-db77e160355e';

const made: string[] = [];
let sessionDir: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-fork-agents-'));
  made.push(sessionDir);
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `fn` with the clock at `ms`, so every entry it appends carries that timestamp. */
function at<T>(ms: number, fn: () => T): T {
  vi.setSystemTime(ms);
  return fn();
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as Message;
const assistant = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as unknown as Message;

function invoke(parent: SessionManager, data: AgentInvocationData): string {
  return parent.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, data);
}

/** A subagent session written through pi: launch and first reply at 1100-1200, a second reply and status at 3000. */
function writeSubagent(agentId: string): string {
  const dir = subagentsDir(sessionDir, SOURCE);
  const sm = at(1100, () => SessionManager.create(dir, dir, { id: agentId }));
  at(1100, () => {
    sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, {
      agentId,
      kind: 'subagent',
      agentType: 'Explore',
      description: 'd',
      prompt: 'p',
      background: false,
    });
    sm.appendMessage(user('look'));
  });
  at(1200, () => sm.appendMessage(assistant('part one')));
  at(3000, () => {
    sm.appendMessage(assistant('part two'));
    sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, { status: 'completed', result: 'part two' });
  });
  return sm.getSessionFile()!;
}

function writeMember(): string {
  const dir = teamMembersDir(sessionDir, SOURCE, TEAM);
  const sm = at(1500, () => SessionManager.create(dir, dir, { id: teamMemberSessionId(MEMBER, 0) }));
  at(1500, () => {
    sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, {
      agentId: MEMBER,
      kind: 'team-member',
      teamId: TEAM,
      attempt: 0,
      memberName: 'lead',
      role: 'lead',
      task: 't',
    });
    sm.appendMessage(user('plan it'));
  });
  at(1600, () => sm.appendMessage(assistant('member early')));
  at(2500, () => sm.appendMessage(assistant('member late')));
  return sm.getSessionFile()!;
}

function writeEventLog(extra: Array<Record<string, unknown>> = []): string {
  const file = teamEventLogPath(sessionDir, SOURCE, TEAM);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (entry: Record<string, unknown> & { ms: number }) => {
    const { ms, ...rest } = entry;
    return JSON.stringify({ teamId: TEAM, ...rest, timestamp: new Date(ms).toISOString() });
  };
  const entries = [{ type: 'team-created', ms: 1500 }, { type: 'agent-spawned', ms: 1900 }, { type: 'agent-completed', ms: 2500 }, ...extra];
  fs.writeFileSync(file, entries.map((e) => line(e as Record<string, unknown> & { ms: number })).join('\n') + '\n');
  return file;
}

/** A checkpoint of a cancel at `cancelledAt`, its file modified at `mtimeMs`. */
function writeCheckpoint(cancelledAt: number, mtimeMs = cancelledAt): string {
  const file = teamCheckpointPath(sessionDir, SOURCE, TEAM, cancelledAt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, teamId: TEAM, cancelledAt }));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

const forkCheckpoints = (): Promise<number[]> => listTeamCheckpoints(teamCheckpointsDir(sessionDir, TARGET, TEAM));
const forkLogTypes = (): string[] =>
  fs.readFileSync(teamEventLogPath(sessionDir, TARGET, TEAM), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.set(full, fs.readFileSync(full, 'utf8'));
  }
  return out;
}

async function fork(parent: SessionManager, leafId: string, forkPointMs: number): Promise<Error[]> {
  return copyForkAgentData({
    SessionManager,
    sessionDir,
    sourceSessionId: SOURCE,
    targetSessionId: TARGET,
    branch: parent.getBranch(leafId),
    forkPointMs,
  });
}

describe('copyForkAgentData — subagents', () => {
  it('copies only the subagents invoked on the branch, cut at the fork point, and leaves the source untouched', async () => {
    const parent = SessionManager.inMemory(sessionDir);
    at(1000, () => {
      parent.appendMessage(user('go'));
      invoke(parent, { kind: 'subagent', id: 'sub-on-branch', toolCallId: 'tc1', resume: false });
      invoke(parent, { kind: 'subagent', id: 'sub-no-file', toolCallId: 'tc2', resume: false });
    });
    const leaf = at(2000, () => parent.appendMessage(assistant('parent reply')));
    at(4000, () => invoke(parent, { kind: 'subagent', id: 'sub-after-fork', toolCallId: 'tc3', resume: false }));
    writeSubagent('sub-on-branch');
    writeSubagent('sub-after-fork');
    const before = snapshot(subagentsDir(sessionDir, SOURCE));

    expect(await fork(parent, leaf, 2000)).toEqual([]);

    const targetDir = subagentsDir(sessionDir, TARGET);
    expect(fs.readdirSync(targetDir)).toHaveLength(1);
    const copy = await findAgentFile(targetDir, 'sub-on-branch');
    expect(copy).not.toBeNull();
    const read = (await readAgentFile(copy!))!;
    expect(read.launch.agentId).toBe('sub-on-branch');
    expect(read.messages.map((m) => (m['content'] as Array<{ text: string }>)[0]!.text)).toEqual(['look', 'part one']);
    expect(read.status).toBeUndefined();
    expect(await findAgentFile(targetDir, 'sub-after-fork')).toBeNull();
    expect(snapshot(subagentsDir(sessionDir, SOURCE))).toEqual(before);
  });

  it('writes no copy when the cut holds no assistant message, as with an agent stopped before its first response', async () => {
    const parent = SessionManager.inMemory(sessionDir);
    const leaf = at(1000, () => {
      parent.appendMessage(user('go'));
      return invoke(parent, { kind: 'subagent', id: 'sub-early', toolCallId: 'tc1', resume: false });
    });
    writeSubagent('sub-early');

    expect(await fork(parent, leaf, 1150)).toEqual([]);

    expect(await findAgentFile(subagentsDir(sessionDir, TARGET), 'sub-early')).toBeNull();
  });
});

describe('copyForkAgentData — teams', () => {
  function teamParent(): { parent: SessionManager; leaf: string } {
    const parent = SessionManager.inMemory(sessionDir);
    at(1000, () => {
      parent.appendMessage(user('team up'));
      invoke(parent, { kind: 'team', id: TEAM, toolCallId: 'tc-team', resume: false });
    });
    const leaf = at(2000, () => parent.appendMessage(assistant('team cancelled')));
    return { parent, leaf };
  }

  it('cuts the event log and member sessions at the fork point and copies the checkpoints taken by then', async () => {
    const { parent, leaf } = teamParent();
    writeEventLog();
    writeMember();
    writeCheckpoint(1700);
    writeCheckpoint(1800);
    writeCheckpoint(2600);
    const before = snapshot(path.join(sessionDir, SOURCE));

    expect(await fork(parent, leaf, 2000)).toEqual([]);

    expect(forkLogTypes()).toEqual(['team-created', 'agent-spawned']);
    const members = await indexTeamMemberFiles(teamMembersDir(sessionDir, TARGET, TEAM));
    const copies = members.get(MEMBER)!;
    expect(copies.map((f) => f.attempt)).toEqual([0]);
    const read = (await readAgentFile(copies[0]!.path))!;
    expect(read.messages.map((m) => (m['content'] as Array<{ text: string }>)[0]!.text)).toEqual(['plan it', 'member early']);
    expect(await forkCheckpoints()).toEqual([1700, 1800]);
    expect(fs.readFileSync(teamCheckpointPath(sessionDir, TARGET, TEAM, 1800), 'utf8')).toBe(before.get(teamCheckpointPath(sessionDir, SOURCE, TEAM, 1800)));
    expect(snapshot(path.join(sessionDir, SOURCE))).toEqual(before);
  });

  it('copies a checkpoint the source resumed after the fork point, and cuts that resume from the log', async () => {
    const { parent, leaf } = teamParent();
    at(3000, () => invoke(parent, { kind: 'team', id: TEAM, toolCallId: 'tc-resume', resume: true }));
    writeEventLog([{ type: 'team-resumed', checkpoint: 1800, toolUseId: 'tc-resume', ms: 3000 }]);
    writeCheckpoint(1800);

    expect(await fork(parent, leaf, 2000)).toEqual([]);

    expect(forkLogTypes()).not.toContain('team-resumed');
    expect(await forkCheckpoints()).toEqual([1800]);
  });

  it('decides by the cancel time in the checkpoint, never by the file time', async () => {
    const { parent, leaf } = teamParent();
    writeEventLog();
    writeCheckpoint(1800, 5000);
    writeCheckpoint(2600, 1000);

    expect(await fork(parent, leaf, 2000)).toEqual([]);

    expect(await forkCheckpoints()).toEqual([1800]);
  });

  it('copies nothing for a team invoked after the fork point', async () => {
    const parent = SessionManager.inMemory(sessionDir);
    const leaf = at(1000, () => parent.appendMessage(user('hello')));
    at(3000, () => invoke(parent, { kind: 'team', id: TEAM, toolCallId: 'tc-team', resume: false }));
    writeEventLog();
    writeMember();
    writeCheckpoint(1800);

    expect(await fork(parent, leaf, 1000)).toEqual([]);

    expect(fs.existsSync(path.join(sessionDir, TARGET))).toBe(false);
  });

  it('reports a failed item without stopping the others', async () => {
    const { parent, leaf } = teamParent();
    writeEventLog();
    writeCheckpoint(1800);
    // A directory where the fork's event log belongs makes that one write fail.
    fs.mkdirSync(teamEventLogPath(sessionDir, TARGET, TEAM), { recursive: true });

    const failures = await fork(parent, leaf, 2000);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain(`team ${TEAM} event log`);
    expect(await forkCheckpoints()).toEqual([1800]);
  });
});
