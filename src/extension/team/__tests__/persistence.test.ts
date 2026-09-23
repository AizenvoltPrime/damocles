import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

// Point the Damocles home dir at a throwaway temp dir so the log reads/writes never touch the real
// ~/.damocles tree. The async factory is hoisted above the persistence import, so it sees the temp dir.
vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-team-log-')) };
});

import { DAMOCLES_HOME_DIR } from '../../paths';
import { CANCELLED_TOOL_DETAIL_KEY } from '../../../shared/types/session';
import { TeamPersistence, isTeamCheckpoint } from '../persistence';
import type { TeamCheckpoint } from '../types';
import { ensurePiSessionDir } from '../../pi-session/session-store';
import { DAMOCLES_AGENT_LAUNCH_ENTRY } from '../../pi-session/session-store/constants';
import { teamCheckpointPath, teamEventLogPath, teamMemberSessionId, teamMembersDir, type TeamMemberLaunchData } from '../../pi-session/agent-records';
import { mapPiToolName, normalizeToolDetails, normalizeToolInput } from '../../pi-session/tool-normalization';
import { joinResultText } from '../../pi-session/tool-result-text';
import type { TeamAgentContentBlock } from '../../../shared/types/team';

const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';

afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

type PiMessage = Parameters<SessionManager['appendMessage']>[0];

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const userMessage = (text: string): PiMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
const assistantMessage = (content: unknown[]): PiMessage =>
  ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude', usage, stopReason: 'toolUse', timestamp: Date.now() }) as unknown as PiMessage;
const toolResultMessage = (toolCallId: string, toolName: string, text: string, details: unknown, isError = false): PiMessage =>
  ({ role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], details, isError, timestamp: Date.now() }) as unknown as PiMessage;

function launch(attempt: number, task: string): TeamMemberLaunchData {
  return { agentId: AGENT_ID, kind: 'team-member', teamId: TEAM_ID, attempt, memberName: 'dev', role: 'specialist', task };
}

/** Write one member attempt through pi's own SessionManager, into the dir the runner gives it. */
function writeMemberAttempt(cwd: string, attempt: number, messages: PiMessage[]): { path: string; entryIds: string[] } {
  const dir = teamMembersDir(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID);
  const sm = SessionManager.create(cwd, dir, { id: teamMemberSessionId(AGENT_ID, attempt) });
  sm.appendCustomEntry(DAMOCLES_AGENT_LAUNCH_ENTRY, launch(attempt, 'fix the parser'));
  const entryIds = messages.map((message) => sm.appendMessage(message));
  return { path: sm.getSessionFile()!, entryIds };
}

/** A member session with every block kind a card renders, the cancelled marker included. */
function recordedMemberSession(): PiMessage[] {
  return [
    userMessage('read the brief and fix the parser'),
    assistantMessage([
      { type: 'thinking', thinking: 'The parser lives in src/parse.ts.', thinkingSignature: 'sig-1' },
      { type: 'text', text: 'Reading the parser first.' },
      { type: 'toolCall', id: 'tc-read', name: 'read', arguments: { path: 'src/parse.ts', limit: 40 } },
      { type: 'toolCall', id: 'tc-grep', name: 'grep', arguments: { pattern: 'todo', ignoreCase: true } },
    ]),
    toolResultMessage('tc-read', 'read', 'export function parse() {}', undefined),
    toolResultMessage('tc-grep', 'grep', 'src/parse.ts:3: // todo', undefined),
    assistantMessage([
      { type: 'toolCall', id: 'tc-edit', name: 'Edit', arguments: { file_path: 'src/parse.ts', old_string: 'a', new_string: 'b' } },
      { type: 'toolCall', id: 'tc-bash', name: 'bash', arguments: { command: 'npm test' } },
    ]),
    toolResultMessage('tc-edit', 'Edit', 'edited', { diff: '-a\n+b', firstChangedLine: 3 }),
    toolResultMessage('tc-bash', 'bash', 'partial output', { [CANCELLED_TOOL_DETAIL_KEY]: true, fullOutputPath: '/tmp/full.log' }),
    userMessage('[STEERING INSTRUCTION: ABSOLUTE PRIORITY]\nskip the slow suite'),
    assistantMessage([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Done; the parser is fixed.' }]),
  ];
}

/**
 * The deleted `teams/agents/<agentId>.jsonl` writer as the reference. Each message stands in for the live
 * event that produced it: a prompt for `emitUserMessage`, an assistant `message_end` for `emitAssistant`,
 * and a `tool_execution_end` whose `result` is the tool's `{ content, details }`. The mapping bodies are
 * copied verbatim from `AgentRunner`.
 */
function legacyLogEntries(messages: readonly PiMessage[]): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const m = message as unknown as Record<string, unknown>;
    if (m['role'] === 'user') {
      const content = (m['content'] as Array<{ text: string }>).map((c) => c.text).join('\n');
      entries.push({ type: 'user', agentId: AGENT_ID, content, timestamp: new Date().toISOString() });
    } else if (m['role'] === 'assistant') {
      const content = m['content'] as ReadonlyArray<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
      const blocks: TeamAgentContentBlock[] = [];
      for (const b of content) {
        if (b.type === 'text' && b.text) {
          blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking') {
          blocks.push({ type: 'thinking', thinking: b.thinking ?? '' });
        } else if (b.type === 'toolCall' && b.id && b.name) {
          const toolName = mapPiToolName(b.name);
          const toolInput = normalizeToolInput(b.name, (b.arguments ?? {}) as Record<string, unknown>);
          blocks.push({ type: 'tool_use', id: b.id, name: toolName, input: toolInput });
        }
      }
      if (blocks.length === 0) continue;
      entries.push({ type: 'assistant', agentId: AGENT_ID, content: blocks, timestamp: new Date().toISOString() });
    } else if (m['role'] === 'toolResult') {
      const result = { content: m['content'], details: m['details'] };
      const resultText = joinResultText(result);
      const details = (result as { details?: unknown } | undefined)?.details;
      const metadata = details && typeof details === 'object'
        ? normalizeToolDetails(details as Record<string, unknown>)
        : undefined;
      const block: TeamAgentContentBlock = {
        type: 'tool_result',
        tool_use_id: m['toolCallId'] as string,
        content: resultText,
        is_error: m['isError'] === true,
        ...(metadata ? { metadata } : {}),
      };
      entries.push({ type: 'tool_result', agentId: AGENT_ID, content: [block], timestamp: new Date().toISOString() });
    }
  }
  return entries;
}

/** The deleted `loadAgentConversation` reader, copied verbatim. */
function legacyReadTurns(entries: ReadonlyArray<Record<string, unknown>>): TeamAgentContentBlock[][] {
  const mapToolNames = (blocks: TeamAgentContentBlock[]): TeamAgentContentBlock[] =>
    blocks.map((block) => (block.type === 'tool_use' ? { ...block, name: mapPiToolName(block.name) } : block));
  const turns: TeamAgentContentBlock[][] = [];
  for (const entry of entries) {
    const entryType = entry['type'] as string;
    if (entryType === 'user') {
      const entryContent = entry['content'];
      if (typeof entryContent === 'string') {
        turns.push([{ type: 'text', text: entryContent }]);
      } else if (Array.isArray(entryContent)) {
        turns.push(entryContent as TeamAgentContentBlock[]);
      }
    } else if (entryType === 'assistant' || entryType === 'tool_result') {
      const entryContent = entry['content'];
      if (Array.isArray(entryContent)) {
        turns.push(mapToolNames(entryContent as TeamAgentContentBlock[]));
      }
    }
  }
  return turns;
}

describe('member card history from the member pi session file', () => {
  it('matches the blocks the old log writer and reader produced for the same session (golden)', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'golden');
    const messages = recordedMemberSession();
    writeMemberAttempt(cwd, 0, messages);

    const loaded = await new TeamPersistence(cwd, SESSION_ID).loadAgentConversation(TEAM_ID, AGENT_ID);

    const reference = legacyReadTurns(legacyLogEntries(messages));
    expect(loaded.map((m) => m.content)).toEqual(reference);
    // Guards the reference itself against going vacuous: every block kind and the marker are in it.
    expect(reference.flat().map((b) => b.type)).toEqual(expect.arrayContaining(['text', 'thinking', 'tool_use', 'tool_result']));
    expect(reference.flat()).toContainEqual(expect.objectContaining({ tool_use_id: 'tc-bash', metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true, fullOutputPath: '/tmp/full.log' } }));
  });

  it('maps tool names, inputs, result details and user turns the way the live stream does', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'mapped');
    writeMemberAttempt(cwd, 0, recordedMemberSession());

    const turns = (await new TeamPersistence(cwd, SESSION_ID).loadAgentConversation(TEAM_ID, AGENT_ID)).map((m) => m.content);

    expect(turns[0]).toEqual([{ type: 'text', text: 'read the brief and fix the parser' }]);
    expect(turns[1]).toEqual([
      { type: 'thinking', thinking: 'The parser lives in src/parse.ts.' },
      { type: 'text', text: 'Reading the parser first.' },
      { type: 'tool_use', id: 'tc-read', name: 'Read', input: { file_path: 'src/parse.ts', limit: 40 } },
      { type: 'tool_use', id: 'tc-grep', name: 'Grep', input: { pattern: 'todo', '-i': true } },
    ]);
    expect(turns[2]).toEqual([{ type: 'tool_result', tool_use_id: 'tc-read', content: 'export function parse() {}', is_error: false }]);
    expect(turns[5]).toEqual([{
      type: 'tool_result', tool_use_id: 'tc-edit', content: 'edited', is_error: false,
      metadata: { diff: '-a\n+b', firstChangedLine: 3, editLineNumber: 3 },
    }]);
    expect(turns[6]?.[0]).toMatchObject({ tool_use_id: 'tc-bash', metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true } });
    expect(turns[7]).toEqual([{ type: 'text', text: '[STEERING INSTRUCTION: ABSOLUTE PRIORITY]\nskip the slow suite' }]);
  });

  it('shows every attempt of a redispatched member in attempt order', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'attempts');
    writeMemberAttempt(cwd, 1, [userMessage('second try'), assistantMessage([{ type: 'text', text: 'fixed' }])]);
    writeMemberAttempt(cwd, 0, [userMessage('first try'), assistantMessage([{ type: 'text', text: 'gave up' }])]);

    const history = await new TeamPersistence(cwd, SESSION_ID).loadAgentConversation(TEAM_ID, AGENT_ID);

    expect(history.map((m) => (m.content[0] as { text: string }).text)).toEqual(['first try', 'gave up', 'second try', 'fixed']);
  });

  it('gives each message its role and its session entry id, so user turns are not read as replies', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'roles');
    const steer = '[STEERING INSTRUCTION: ABSOLUTE PRIORITY]\nskip the slow suite';
    const { entryIds } = writeMemberAttempt(cwd, 0, [
      userMessage('fix the parser'),
      userMessage('[Message from lead]: the spec changed'),
      userMessage(steer),
      assistantMessage([{ type: 'text', text: 'On it.' }, { type: 'toolCall', id: 'tc-read', name: 'read', arguments: { path: 'src/parse.ts' } }]),
      toolResultMessage('tc-read', 'read', 'export function parse() {}', undefined),
    ]);

    const history = await new TeamPersistence(cwd, SESSION_ID).loadAgentConversation(TEAM_ID, AGENT_ID);

    expect(history).toEqual([
      { id: `0:${entryIds[0]}`, role: 'user', content: [{ type: 'text', text: 'fix the parser' }] },
      { id: `0:${entryIds[1]}`, role: 'user', content: [{ type: 'text', text: '[Message from lead]: the spec changed' }] },
      { id: `0:${entryIds[2]}`, role: 'user', content: [{ type: 'text', text: steer }] },
      {
        id: `0:${entryIds[3]}`, role: 'assistant',
        content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'tc-read', name: 'Read', input: { file_path: 'src/parse.ts' } }],
      },
      { id: `0:${entryIds[4]}`, role: 'toolResult', content: [{ type: 'tool_result', tool_use_id: 'tc-read', content: 'export function parse() {}', is_error: false }] },
    ]);
  });

  it('keeps message ids distinct across attempts, whose entry ids are unique only within their own file', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'attempt-ids');
    const first = writeMemberAttempt(cwd, 0, [userMessage('first try'), assistantMessage([{ type: 'text', text: 'gave up' }])]);
    const second = writeMemberAttempt(cwd, 1, [userMessage('second try'), assistantMessage([{ type: 'text', text: 'fixed' }])]);
    // Give the second file's message the first file's entry id, a collision pi's per-file ids allow.
    fs.writeFileSync(second.path, fs.readFileSync(second.path, 'utf-8').replaceAll(second.entryIds[0]!, first.entryIds[0]!));

    const history = await new TeamPersistence(cwd, SESSION_ID).loadAgentConversation(TEAM_ID, AGENT_ID);

    expect(history.map((m) => (m.content[0] as { text: string }).text)).toEqual(['first try', 'gave up', 'second try', 'fixed']);
    expect(new Set(history.map((m) => m.id)).size).toBe(4);
  });

  it('is empty for a member that never answered, since pi writes no file until then', async () => {
    const turns = await new TeamPersistence(join(DAMOCLES_HOME_DIR, 'no-file'), SESSION_ID).loadAgentConversation(TEAM_ID, AGENT_ID);
    expect(turns).toEqual([]);
  });

  it('links the card to the spawned attempt session file', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'log-link');
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'Slice 4', toolUseId: 'tu-1',
      agents: [{ name: 'dev', role: 'specialist' }], timestamp: '2026-08-26T00:00:00.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'dev', specialization: 'build it',
      model: 'sonnet', attempt: 1, reattempt: true, timestamp: '2026-08-26T00:00:01.000Z',
    });
    writeMemberAttempt(cwd, 0, [userMessage('first'), assistantMessage([{ type: 'text', text: 'a' }])]);
    const second = writeMemberAttempt(cwd, 1, [userMessage('second'), assistantMessage([{ type: 'text', text: 'b' }])]).path;

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]?.logFilePath).toBe(second);
  });
});

describe('TeamPersistence event log writes', () => {
  it('has the entry on disk when the append returns, with no flush', () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'sync');
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({ type: 'agent-message', teamId: TEAM_ID, content: 'hello', kind: 'scratchpad-notice' });

    const lines = fs.readFileSync(teamEventLogPath(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID), 'utf-8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: 'agent-message', teamId: TEAM_ID, content: 'hello', kind: 'scratchpad-notice' });
  });

  it('keeps writing after a failed append and reports the failure once from flush()', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'errors');
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    // A directory where the team's log file belongs makes the append itself fail.
    fs.mkdirSync(teamEventLogPath(ensurePiSessionDir(cwd), SESSION_ID, 'team-2'), { recursive: true });

    persistence.appendTeamEntry({ type: 'agent-message', teamId: 'team-2', content: 'lost' });
    persistence.appendTeamEntry({ type: 'agent-message', teamId: TEAM_ID, content: 'kept' });

    const flushed = persistence.flush();
    await expect(flushed).rejects.toBeInstanceOf(AggregateError);
    await expect(flushed).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'EISDIR' })] });
    await expect(persistence.flush()).resolves.toBeUndefined();
    const log = fs.readFileSync(teamEventLogPath(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID), 'utf-8');
    expect(log).toContain('"kept"');
  });
});

describe('TeamPersistence team state round trip', () => {
  it('restores every usage total the agent-completed entry carries', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-state'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'Slice 3', toolUseId: 'tu-1',
      agents: [{ name: 'lead', role: 'lead', model: 'opus' }],
      timestamp: '2026-08-26T00:00:00.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'lead',
      specialization: 'orchestrate', model: 'opus', timestamp: '2026-08-26T00:00:01.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-completed', teamId: TEAM_ID, agentId: AGENT_ID, name: 'lead', status: 'completed',
      result: 'done', toolCallCount: 4, durationMs: 900,
      totalInputTokens: 300, totalOutputTokens: 80,
      cacheReadTokens: 52_900_000, cacheCreationTokens: 30, costUsd: 26.45,
      timestamp: '2026-08-26T00:00:02.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]).toMatchObject({
      name: 'lead', status: 'completed', toolCount: 4,
      totalInputTokens: 300, totalOutputTokens: 80,
      cacheReadTokens: 52_900_000, cacheCreationTokens: 30, costUsd: 26.45,
    });
  });

  it('restores each agent own billing flag, so a reloaded card labels its cost the same way', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-billing'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'Slice 3', toolUseId: 'tu-1',
      agents: [{ name: 'lead', role: 'lead', model: 'opus' }, { name: 'dev', role: 'specialist' }],
      timestamp: '2026-08-26T00:00:00.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'lead',
      specialization: 'orchestrate', model: 'opus', dollarBilled: false,
      timestamp: '2026-08-26T00:00:01.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: 'agent-2', name: 'dev',
      specialization: 'build it', model: 'sonnet', dollarBilled: true,
      timestamp: '2026-08-26T00:00:02.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    // A mixed-billing team is the case a single panel-level flag gets wrong.
    expect(state?.agents.map(a => [a.name, a.dollarBilled])).toEqual([['lead', false], ['dev', true]]);
  });

  it('sums the usage of both attempts of a re-dispatched agent, taking its work fields from the last', async () => {
    // Every figure here is the one the observed run recorded for the specialist it cancelled and re-ran.
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-redispatch'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'remediation check', toolUseId: 'tu-1',
      agents: [{ name: 'alpha', role: 'specialist' }],
      timestamp: '2026-09-01T10:39:33.604Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha',
      specialization: 'read the brief', model: 'opus', attempt: 0,
      timestamp: '2026-09-01T10:40:23.547Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-completed', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha', status: 'cancelled',
      result: 'ALPHA-READ-1: FULL', toolCallCount: 5, durationMs: 14_914,
      totalInputTokens: 8, totalOutputTokens: 665,
      cacheReadTokens: 56_118, cacheCreationTokens: 19_628, costUsd: 0.15659350000000002,
      timestamp: '2026-09-01T10:40:38.479Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha',
      specialization: 'read the brief', model: 'opus', attempt: 1, reattempt: true,
      timestamp: '2026-09-01T10:40:46.872Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-completed', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha', status: 'completed',
      result: 'ALPHA-DONE: reported the read outcome after redispatch.', toolCallCount: 4, durationMs: 28_654,
      totalInputTokens: 8, totalOutputTokens: 1106,
      cacheReadTokens: 73_473, cacheCreationTokens: 1960, costUsd: 0.06200525,
      timestamp: '2026-09-01T10:41:15.527Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]).toMatchObject({
      name: 'alpha', status: 'completed', attempt: 1,
      // Work is per attempt: the card times and counts the run that finished last.
      toolCount: 4,
      result: 'ALPHA-DONE: reported the read outcome after redispatch.',
      // Spend is cumulative: the cancelled attempt burned these tokens under the same name.
      totalInputTokens: 16, totalOutputTokens: 1771,
      cacheReadTokens: 129_591, cacheCreationTokens: 21_588,
    });
    expect(state?.agents[0]?.costUsd).toBeCloseTo(0.21859875, 10);
    expect(state?.totalToolCount).toBe(4);
  });

  it('restores a team reopened mid-attempt without the dead attempt work on the card', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-mid-attempt'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'remediation check', toolUseId: 'tu-1',
      agents: [{ name: 'alpha', role: 'specialist' }],
      timestamp: '2026-09-01T10:39:33.604Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha',
      specialization: 'read the brief', model: 'opus', attempt: 0,
      timestamp: '2026-09-01T10:40:23.547Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-completed', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha', status: 'cancelled',
      result: 'ALPHA-READ-1: FULL', toolCallCount: 5, durationMs: 14_914,
      totalInputTokens: 8, totalOutputTokens: 665,
      cacheReadTokens: 56_118, cacheCreationTokens: 19_628, costUsd: 0.15659350000000002,
      timestamp: '2026-09-01T10:40:38.479Z',
    });
    // The log ends here: a reload killed the second attempt, and the run with it.
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha',
      specialization: 'read the brief', model: 'opus', attempt: 1, reattempt: true,
      timestamp: '2026-09-01T10:40:46.872Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    const respawned = new Date('2026-09-01T10:40:46.872Z').getTime();
    expect(state?.agents[0]).toMatchObject({
      status: 'cancelled', attempt: 1, toolCount: 0, endTime: respawned, result: null,
      startTime: respawned,
      // The cancelled attempt still spent this, so it stays on the card.
      totalOutputTokens: 665,
    });
  });

  it('reads a spawn entry written before the attempt counter as the agent first attempt', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-no-attempt'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'Slice 3', toolUseId: 'tu-1',
      agents: [{ name: 'dev', role: 'specialist' }],
      timestamp: '2026-08-26T00:00:00.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'dev',
      specialization: 'build it', model: 'sonnet',
      timestamp: '2026-08-26T00:00:01.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]?.attempt).toBe(0);
  });

  it('labels an agent that never spawned as a charge, the safe side of an unknown', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-billing-unspawned'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'Slice 3', toolUseId: 'tu-1',
      agents: [{ name: 'dev', role: 'specialist' }],
      timestamp: '2026-08-26T00:00:00.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]?.dollarBilled).toBe(true);
  });
});

describe('TeamPersistence.loadTeamState after a resume', () => {
  function cancelledTeam(cwd: string): TeamPersistence {
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'resumable', toolUseId: 'tu-create',
      agents: [{ name: 'lead', role: 'lead' }, { name: 'dev', role: 'specialist' }, { name: 'rev', role: 'specialist' }, { name: 'idle', role: 'specialist' }],
      timestamp: '2026-09-01T10:00:00.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: 'lead-1', name: 'lead', specialization: 'Lead: resumable',
      model: 'opus', attempt: 0, timestamp: '2026-09-01T10:00:01.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'dev', specialization: 'build it',
      model: 'sonnet', attempt: 0, timestamp: '2026-09-01T10:00:02.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: 'rev-1', name: 'rev', specialization: 'review it',
      model: 'sonnet', attempt: 0, timestamp: '2026-09-01T10:00:03.000Z',
    });
    for (const [agentId, name] of [['lead-1', 'lead'], [AGENT_ID, 'dev'], ['rev-1', 'rev']] as const) {
      persistence.appendTeamEntry({
        type: 'agent-completed', teamId: TEAM_ID, agentId, name, status: 'cancelled', result: null,
        toolCallCount: 2, durationMs: 10, timestamp: '2026-09-01T10:05:00.000Z',
      });
    }
    persistence.appendTeamEntry({
      type: 'team-completed', teamId: TEAM_ID, status: 'cancelled', synthesizedResult: '## Partial Team Results',
      agentResults: [], timestamp: '2026-09-01T10:05:01.000Z',
    });
    return persistence;
  }

  it('shows a cancelled team as cancelled until it is resumed', async () => {
    const state = await cancelledTeam(join(DAMOCLES_HOME_DIR, 'resume-before')).loadTeamState(TEAM_ID);

    expect(state).toMatchObject({ status: 'cancelled', result: '## Partial Team Results' });
    expect(state?.agents.map((a) => a.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'pending']);
  });

  it('a resumed run the log never ends, loaded with no runner, reads as cancelled with its active members cancelled', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'resume-after');
    const persistence = cancelledTeam(cwd);
    const devFile = writeMemberAttempt(cwd, 0, [userMessage('build it'), assistantMessage([{ type: 'text', text: 'halfway' }])]).path;
    persistence.appendTeamEntry({ type: 'team-resumed', teamId: TEAM_ID, toolUseId: 'tu-resume', checkpoint: 1, message: 'continue', timestamp: '2026-09-01T11:00:00.000Z' });
    persistence.appendTeamEntry({
      type: 'agent-resumed', teamId: TEAM_ID, agentId: 'lead-1', name: 'lead', attempt: 0, resumeCount: 1,
      mode: 'relaunch', status: 'running', timestamp: '2026-09-01T11:00:01.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-resumed', teamId: TEAM_ID, agentId: AGENT_ID, name: 'dev', attempt: 0, resumeCount: 1,
      mode: 'relaunch', status: 'running', timestamp: '2026-09-01T11:00:02.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-resumed', teamId: TEAM_ID, agentId: 'rev-1', name: 'rev', attempt: 0, resumeCount: 1,
      mode: 'park', status: 'awaiting-review', timestamp: '2026-09-01T11:00:03.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    const last = Date.parse('2026-09-01T11:00:03.000Z');
    expect(state).toMatchObject({ status: 'cancelled', result: null, endTime: last, toolUseId: 'tu-create' });
    expect(state?.agents.map((a) => [a.name, a.status, a.endTime])).toEqual([
      ['lead', 'cancelled', last],
      ['dev', 'cancelled', last],
      ['rev', 'cancelled', last],
      ['idle', 'pending', null],
    ]);
    expect(state?.agents[1]).toMatchObject({ attempt: 0, logFilePath: devFile });
  });

  it('a first run the log never ends, loaded with no runner, reads as cancelled too', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'first-run-open'), SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'killed', toolUseId: 'tu-create',
      agents: [{ name: 'lead', role: 'lead' }, { name: 'dev', role: 'specialist' }], timestamp: '2026-09-01T10:00:00.000Z',
    });
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: 'lead-1', name: 'lead', specialization: 'Lead: killed',
      model: 'opus', attempt: 0, timestamp: '2026-09-01T10:00:01.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    const last = Date.parse('2026-09-01T10:00:01.000Z');
    expect(state).toMatchObject({ status: 'cancelled', endTime: last });
    expect(state?.agents.map((a) => [a.name, a.status])).toEqual([['lead', 'cancelled'], ['dev', 'pending']]);
  });

  it('a second cancel after the resume shows the team cancelled again', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'resume-recancel');
    const persistence = cancelledTeam(cwd);
    persistence.appendTeamEntry({ type: 'team-resumed', teamId: TEAM_ID, toolUseId: 'tu-resume', checkpoint: 1, timestamp: '2026-09-01T11:00:00.000Z' });
    persistence.appendTeamEntry({
      type: 'agent-resumed', teamId: TEAM_ID, agentId: AGENT_ID, name: 'dev', attempt: 0, resumeCount: 1,
      mode: 'relaunch', status: 'running', timestamp: '2026-09-01T11:00:02.000Z',
    });
    persistence.appendTeamEntry({
      type: 'team-completed', teamId: TEAM_ID, status: 'cancelled', synthesizedResult: 'second partial',
      agentResults: [], timestamp: '2026-09-01T11:05:00.000Z',
    });

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state).toMatchObject({ status: 'cancelled', result: 'second partial' });
  });
});

describe('TeamPersistence checkpoint files', () => {
  const CANCELLED_AT = 1_700_000_000_000;
  const checkpoint = (cancelledAt = CANCELLED_AT): TeamCheckpoint => ({
    version: 1,
    teamId: TEAM_ID,
    cancelledAt,
    members: [{
      agentId: AGENT_ID, name: 'dev', role: 'specialist', attempt: 1, resumeCount: 2, status: 'running',
      undelivered: [{ text: '[Message from lead]: later', echoed: false }],
      usage: { totalInputTokens: 1, totalOutputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.5 },
      toolCallCount: 12,
    }],
    readerCursors: [['lead', [['__proto__', 2]]]],
    review: {
      specialistReviewRounds: [['dev', 1]], reviewedSpecialists: [], confirmedComplete: ['dev'],
      reportedSummaries: [['dev', 'done']], pendingStandby: [], owedTerminalAction: [], nudgeDelivered: [],
      terminalNudgeDelivered: [], briefConflicts: [], conflictNudges: 0, leadReviewStalls: 1,
      lastReviewRoundNotification: null,
    },
    operatorSteers: [{ memberName: 'dev', message: 'use the new parser' }],
  });
  const pathIn = (cwd: string, cancelledAt = CANCELLED_AT): string => teamCheckpointPath(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID, cancelledAt);

  function teamWithLog(cwd: string): TeamPersistence {
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 't', brief: 'b', toolUseId: 'tu-create',
      agents: [{ name: 'dev', role: 'specialist' }], timestamp: '2026-09-01T10:00:00.000Z',
    });
    return persistence;
  }
  const resumedFrom = (persistence: TeamPersistence, cancelledAt: number): void =>
    persistence.appendTeamEntry({ type: 'team-resumed', teamId: TEAM_ID, toolUseId: `tu-${cancelledAt}`, checkpoint: cancelledAt, timestamp: '2026-09-01T11:00:00.000Z' });

  it('keeps one file per cancel, reads each back exactly, and leaves no temp file behind', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'checkpoint-rt');
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);

    expect(persistence.writeCheckpoint(checkpoint())).toBe(true);
    expect(persistence.writeCheckpoint(checkpoint(CANCELLED_AT + 5))).toBe(true);

    expect(await persistence.readCheckpoint(TEAM_ID, CANCELLED_AT)).toEqual(checkpoint());
    expect(await persistence.readCheckpoint(TEAM_ID, CANCELLED_AT + 5)).toEqual(checkpoint(CANCELLED_AT + 5));
    expect(fs.readdirSync(join(pathIn(cwd), '..')).sort()).toEqual([`${CANCELLED_AT}.json`, `${CANCELLED_AT + 5}.json`]);
  });

  it('reads a missing or malformed checkpoint, or one whose cancel time is not its file name, as absent', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'checkpoint-bad');
    const persistence = new TeamPersistence(cwd, SESSION_ID);
    persistence.initTeamFile(TEAM_ID);
    expect(await persistence.readCheckpoint(TEAM_ID, CANCELLED_AT)).toBeNull();

    fs.mkdirSync(join(pathIn(cwd), '..'), { recursive: true });
    fs.writeFileSync(pathIn(cwd), '{"version":1,"teamId":"team-1"');
    expect(await persistence.readCheckpoint(TEAM_ID, CANCELLED_AT)).toBeNull();

    fs.writeFileSync(pathIn(cwd), JSON.stringify({ ...checkpoint(), members: [{ agentId: AGENT_ID }] }));
    expect(await persistence.readCheckpoint(TEAM_ID, CANCELLED_AT)).toBeNull();

    fs.writeFileSync(pathIn(cwd), JSON.stringify(checkpoint(CANCELLED_AT + 1)));
    expect(await persistence.readCheckpoint(TEAM_ID, CANCELLED_AT)).toBeNull();
  });

  it('offers the newest checkpoint until a team-resumed entry names it, and never an older one', async () => {
    const persistence = teamWithLog(join(DAMOCLES_HOME_DIR, 'checkpoint-newest'));
    expect(await persistence.isResumable(TEAM_ID)).toBe(false);

    persistence.writeCheckpoint(checkpoint());
    persistence.writeCheckpoint(checkpoint(CANCELLED_AT + 10));
    expect((await persistence.resumableCheckpoint(await persistence.readEventLog(TEAM_ID)))?.cancelledAt).toBe(CANCELLED_AT + 10);

    resumedFrom(persistence, CANCELLED_AT + 10);

    expect(await persistence.resumableCheckpoint(await persistence.readEventLog(TEAM_ID))).toBeNull();
    expect(await persistence.isResumable(TEAM_ID)).toBe(false);
  });

  it('orders checkpoints by cancel time, not by name, and ignores files that are not checkpoints', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'checkpoint-order');
    const persistence = teamWithLog(cwd);
    persistence.writeCheckpoint(checkpoint(9_000));
    persistence.writeCheckpoint(checkpoint(10_000));
    fs.writeFileSync(`${pathIn(cwd, 20_000)}.tmp`, '{}');

    expect((await persistence.resumableCheckpoint(await persistence.readEventLog(TEAM_ID)))?.cancelledAt).toBe(10_000);
  });

  it('a team with no event log is not resumable', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'checkpoint-nolog'), SESSION_ID);
    persistence.writeCheckpoint(checkpoint());

    expect(await persistence.isResumable(TEAM_ID)).toBe(false);
  });

  it('refuses a team-resumed entry that does not name its checkpoint', async () => {
    const persistence = teamWithLog(join(DAMOCLES_HOME_DIR, 'checkpoint-unnamed'));
    persistence.appendTeamEntry({ type: 'team-resumed', teamId: TEAM_ID, toolUseId: 'tu-resume', timestamp: '2026-09-01T11:00:00.000Z' });

    await expect(persistence.readEventLog(TEAM_ID)).rejects.toThrow('"checkpoint" is not a checkpoint time');
  });

  it('isTeamCheckpoint accepts a written checkpoint and rejects a wrong version, cancel time or field', () => {
    expect(isTeamCheckpoint(checkpoint())).toBe(true);
    expect(isTeamCheckpoint({ ...checkpoint(), version: 2 })).toBe(false);
    expect(isTeamCheckpoint({ ...checkpoint(), cancelledAt: -1 })).toBe(false);
    expect(isTeamCheckpoint({ ...checkpoint(), cancelledAt: '1' })).toBe(false);
    expect(isTeamCheckpoint({ ...checkpoint(), review: { ...checkpoint().review, reviewedSpecialists: 'dev' } })).toBe(false);
  });
});
