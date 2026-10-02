import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  collectUndeliveredFromFiles,
  deliverUndeliveredResults,
  type UndeliveredFileResult,
  type UndeliveredResultsMessage,
} from '../undelivered-results';
import { deliveredBackgroundResults, readAgentFile, subagentBranchIndex } from '../agent-records';
import { SUBAGENT_RESULTS_CUSTOM_TYPE } from '../subagents/background-results';
import type { AgentRecord } from '../subagents/types';
import { emptyAgentUsage } from '../../../shared/usage-accounting';
import {
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_AGENT_LAUNCH_ENTRY,
  DAMOCLES_AGENT_SEGMENT_ENTRY,
  DAMOCLES_AGENT_STATUS_ENTRY,
} from '../session-store/constants';

// A recording pass-through, so a case can fail one file's read.
vi.mock('../agent-records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-records')>();
  return { ...actual, readAgentFile: vi.fn(actual.readAgentFile) };
});

const made: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-undelivered-'));
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
const toolResult = (toolCallId: string, toolName: string, details: Record<string, unknown>) =>
  ({ role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: '' }], details, isError: false, timestamp: Date.now() }) as unknown as Parameters<SessionManager['appendMessage']>[0];

type Status = { status: string; stopReason?: string; result: string };

/** A background subagent file: the launch segment ending in `launch`, then one resume segment per entry of `resumes`. */
function writeAgentFile(dir: string, agentId: string, launch?: Status, resumes: Array<{ toolCallId: string; status?: Status }> = []): void {
  const sm = SessionManager.create(dir, dir, { id: agentId });
  sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, {
    agentId, kind: 'subagent', agentType: 'Explore', description: `task of ${agentId.slice(0, 4)}`, prompt: 'p', background: true,
  });
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'p' }], timestamp: Date.now() });
  sm.appendMessage(assistant([{ type: 'text', text: 'working' }]));
  if (launch) sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, launch);
  for (const resume of resumes) {
    sm.appendCustomEntry(DAMOCLES_AGENT_SEGMENT_ENTRY, { toolCallId: resume.toolCallId });
    sm.appendMessage(assistant([{ type: 'text', text: 'resumed' }]));
    if (resume.status) sm.appendCustomEntry(DAMOCLES_AGENT_STATUS_ENTRY, resume.status);
  }
}

/** The parent's `Agent` call for `agentId`, its invocation entry and its tool result (background by default). */
function invoke(parent: SessionManager, agentId: string, toolCallId: string, opts: { resume?: boolean; details?: Record<string, unknown> } = {}): void {
  const args = opts.resume ? { resume: agentId } : { description: 'd', prompt: 'p', subagent_type: 'Explore', run_in_background: true };
  parent.appendMessage(assistant([{ type: 'toolCall', id: toolCallId, name: 'Agent', arguments: args }]));
  parent.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: agentId, toolCallId, resume: opts.resume ?? false });
  parent.appendMessage(toolResult(toolCallId, 'Agent', opts.details ?? { agentId, status: 'async_launched' }));
}

function rec(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: B, type: 'Plan', description: 'live one', status: 'completed', toolCallId: 'tc-live', background: true,
    toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, usage: emptyAgentUsage(), compactionCount: 0,
    ...over,
  };
}

/** One prompt start: collect from files, deliver live and cold, and append what was sent to the parent. */
async function promptStart(parent: SessionManager, dir: string, opts: { live?: AgentRecord[]; isLive?: (id: string) => boolean; append?: boolean } = {}) {
  const scan = await collectUndeliveredFromFiles({ branch: parent.getBranch(), subagentDir: dir, isLive: opts.isLive ?? (() => false) });
  return { ...(await deliverTo(parent, opts.live ?? [], scan.results, opts.append)), incomplete: scan.incomplete };
}

/** The delivery half of a prompt start, over results collected earlier. */
async function deliverTo(parent: SessionManager, live: AgentRecord[], cold: UndeliveredFileResult[], append?: boolean) {
  const sent: UndeliveredResultsMessage[] = [];
  const delivered = await deliverUndeliveredResults({
    live,
    cold,
    delivered: () => deliveredBackgroundResults(subagentBranchIndex(parent.getBranch())),
    send: async (message) => {
      sent.push(message);
      if (append === false) return false;
      parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      return true;
    },
  });
  return { sent, delivered };
}

describe('undelivered background results', () => {
  it('incident: a completed background agent whose turn was aborted and panel closed is delivered once, then never again', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc-spawn');
    writeAgentFile(dir, A, { status: 'completed', result: 'found the leak' });

    const first = await promptStart(parent, dir);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toMatchObject({
      customType: SUBAGENT_RESULTS_CUSTOM_TYPE,
      display: false,
      details: { agents: [{ agentId: A, toolCallId: 'tc-spawn', status: 'completed', result: 'found the leak' }] },
    });
    expect(first.sent[0]!.content).toContain('This background subagent finished during an earlier turn that ended before its result reached you.');
    expect(first.sent[0]!.content).toContain('## Explore — task of 0a1b\nfound the leak');
    expect(first.delivered).toEqual([{ agentId: A, toolCallId: 'tc-spawn' }]);

    const second = await promptStart(parent, dir);
    expect(second.sent).toEqual([]);
    expect(second.delivered).toEqual([]);
  });

  it('delivers the turn-limit and error outcomes a file records', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc2');
    writeAgentFile(dir, A, { status: 'aborted', result: 'partial (aborted)' });
    writeAgentFile(dir, B, { status: 'error', result: 'boom' });

    const { delivered } = await promptStart(parent, dir);

    expect(delivered).toEqual([{ agentId: A, toolCallId: 'tc1' }, { agentId: B, toolCallId: 'tc2' }]);
  });

  it.each([
    ['stopped by the user', { status: 'stopped', stopReason: 'user', result: 'half' }],
    ['stopped by an abort kill', { status: 'stopped', stopReason: 'shutdown', result: 'half' }],
    ['interrupted with no status', undefined],
  ])('a file agent %s is left to the interruption notice', async (_label, status) => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    writeAgentFile(dir, A, status as Status | undefined);

    expect((await promptStart(parent, dir)).sent).toEqual([]);
  });

  it('a foreground agent is never delivered: its result was the Agent tool result', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1', { details: { agentId: A, status: 'completed' } });
    writeAgentFile(dir, A, { status: 'completed', result: 'done' });

    expect((await promptStart(parent, dir)).sent).toEqual([]);
  });

  it('an invocation the keep-alive injected or GetSubagentResult fetched is in D and is not delivered', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc2');
    writeAgentFile(dir, A, { status: 'completed', result: 'a' });
    writeAgentFile(dir, B, { status: 'completed', result: 'b' });
    parent.appendCustomMessageEntry(SUBAGENT_RESULTS_CUSTOM_TYPE, 'injected', false, {
      agents: [{ agentId: A, toolCallId: 'tc1', status: 'completed', result: 'a' }],
    });
    parent.appendMessage(assistant([{ type: 'toolCall', id: 'tc-get', name: 'GetSubagentResult', arguments: { agent_id: B } }]));
    parent.appendMessage(toolResult('tc-get', 'GetSubagentResult', { agentId: B, toolCallId: 'tc2', status: 'completed' }));
    const read = vi.mocked(readAgentFile);

    expect((await promptStart(parent, dir)).sent).toEqual([]);
    // Nothing on the branch was a candidate, so no file was read.
    expect(read).not.toHaveBeenCalled();
  });

  it('a live record outranks its file: the file is skipped and the record is delivered, a card stop included', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc-live');
    writeAgentFile(dir, A, { status: 'completed', result: 'from the file' });
    writeAgentFile(dir, B, { status: 'completed', result: 'stale file text' });
    const live = rec({ status: 'stopped', stopReason: 'user', result: 'half done' });

    const { sent, delivered } = await promptStart(parent, dir, { live: [live], isLive: (id) => id === B });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.details.agents.map((a) => [a.agentId, a.toolCallId, a.status])).toEqual([
      [B, 'tc-live', 'stopped'],
      [A, 'tc1', 'completed'],
    ]);
    expect(sent[0]!.content).toContain(`## Plan — live one\nhalf done (STOPPED BY THE USER before completion; output is partial. Resume it with Agent({resume:"${B}"})`);
    expect(sent[0]!.content).not.toContain('stale file text');
    expect(delivered).toEqual([{ agentId: B, toolCallId: 'tc-live' }, { agentId: A, toolCallId: 'tc1' }]);
  });

  it('only the latest invocation of a resumed agent counts', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, A, 'tc2', { resume: true });
    writeAgentFile(dir, A, { status: 'stopped', stopReason: 'user', result: 'first half' }, [{ toolCallId: 'tc2', status: { status: 'completed', result: 'all of it' } }]);

    const { sent } = await promptStart(parent, dir);

    expect(sent[0]!.details.agents).toEqual([{ agentId: A, toolCallId: 'tc2', status: 'completed', result: 'all of it' }]);
  });

  it('an earlier completed run does not count when the latest resume was interrupted', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, A, 'tc2', { resume: true });
    writeAgentFile(dir, A, { status: 'completed', result: 'old' }, [{ toolCallId: 'tc2' }]);

    expect((await promptStart(parent, dir)).sent).toEqual([]);
  });

  it('an unreadable file is skipped, the others are still delivered, and the scan reports itself incomplete', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc2');
    writeAgentFile(dir, A, { status: 'completed', result: 'a' });
    writeAgentFile(dir, B, { status: 'completed', result: 'b' });
    const read = vi.mocked(readAgentFile);
    const actual = await vi.importActual<typeof import('../agent-records')>('../agent-records');
    read.mockImplementation((file) =>
      file.endsWith(`_${A}.jsonl`) ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : actual.readAgentFile(file),
    );

    const first = await promptStart(parent, dir);
    expect(first.delivered).toEqual([{ agentId: B, toolCallId: 'tc2' }]);
    expect(first.incomplete).toBe(true);

    // The transient error is gone at the next prompt, whose scan delivers the rest.
    read.mockImplementation((file) => actual.readAgentFile(file));
    const second = await promptStart(parent, dir);
    expect(second.delivered).toEqual([{ agentId: A, toolCallId: 'tc1' }]);
    expect(second.incomplete).toBe(false);
  });

  it('a candidate with no indexed file is incomplete while another file could not be indexed, and not otherwise', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');

    expect((await promptStart(parent, dir)).incomplete).toBe(false);

    // A directory, so reading it as a file fails with EISDIR.
    fs.mkdirSync(path.join(dir, '0-unreadable.jsonl'));
    expect((await promptStart(parent, dir)).incomplete).toBe(true);
  });

  it('a scan that read every candidate is complete', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    writeAgentFile(dir, A, { status: 'completed', result: 'a' });

    expect((await promptStart(parent, dir)).incomplete).toBe(false);
  });

  it('of two prompt starts that collected the same results, only the first delivers them', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    invoke(parent, B, 'tc-live');
    writeAgentFile(dir, A, { status: 'completed', result: 'a' });
    const live = [rec({})];
    const first = await collectUndeliveredFromFiles({ branch: parent.getBranch(), subagentDir: dir, isLive: (id) => id === B });
    const second = await collectUndeliveredFromFiles({ branch: parent.getBranch(), subagentDir: dir, isLive: (id) => id === B });

    const one = await deliverTo(parent, live, first.results);
    const two = await deliverTo(parent, live, second.results);

    expect(one.delivered).toEqual([{ agentId: B, toolCallId: 'tc-live' }, { agentId: A, toolCallId: 'tc1' }]);
    expect(two.sent).toEqual([]);
    expect(parent.getBranch().filter((e) => e.type === 'custom_message' && e.customType === SUBAGENT_RESULTS_CUSTOM_TYPE)).toHaveLength(1);
  });

  it('nothing counts as delivered when the message was not appended', async () => {
    const dir = tempDir();
    const parent = SessionManager.inMemory('/ws');
    invoke(parent, A, 'tc1');
    writeAgentFile(dir, A, { status: 'completed', result: 'a' });

    const { sent, delivered } = await promptStart(parent, dir, { append: false });

    expect(sent).toHaveLength(1);
    expect(delivered).toEqual([]);
  });
});
