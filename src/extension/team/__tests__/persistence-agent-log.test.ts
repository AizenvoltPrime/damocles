import { describe, it, expect, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

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
import { TeamPersistence } from '../persistence';

/**
 * The agent log is written by the runner and read back only when a user reopens the team, so the entry
 * types the writer emits and the ones the reader recognises are a seam nothing else exercises.
 */

const TEAM_ID = 'team-1';
const AGENT_ID = 'agent-1';

afterAll(() => rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

async function roundTrip(cwd: string, entries: Array<Record<string, unknown>>): Promise<unknown[][]> {
  const persistence = new TeamPersistence(cwd, 'session-1');
  await persistence.initAgentFile(TEAM_ID, AGENT_ID);
  for (const entry of entries) persistence.appendAgentEntry(TEAM_ID, AGENT_ID, entry);
  await persistence.flush();
  return persistence.loadAgentConversation(TEAM_ID, AGENT_ID);
}

function assistantEntry(content: unknown): Record<string, unknown> {
  return { type: 'assistant', agentId: AGENT_ID, content, timestamp: '2026-08-26T00:00:01.000Z' };
}

describe('TeamPersistence agent log round trip', () => {
  it('reads a persisted tool result back, cancelled marker included', async () => {
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 'tc-1',
      content: 'partial',
      is_error: false,
      metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true },
    };
    const turns = await roundTrip(join(DAMOCLES_HOME_DIR, 'with-results'), [
      { type: 'user', agentId: AGENT_ID, content: 'do the task', timestamp: '2026-08-26T00:00:00.000Z' },
      assistantEntry([{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'sleep 300' } }]),
      { type: 'tool_result', agentId: AGENT_ID, content: [toolResult], timestamp: '2026-08-26T00:00:02.000Z' },
    ]);

    expect(turns).toEqual([
      [{ type: 'text', text: 'do the task' }],
      [{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'sleep 300' } }],
      [toolResult],
    ]);
  });

  it('reads a log written before results were persisted, tool calls and nothing else', async () => {
    const turns = await roundTrip(join(DAMOCLES_HOME_DIR, 'without-results'), [
      assistantEntry([{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }]),
    ]);

    expect(turns).toEqual([[{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }]]);
  });

  it('reads both spellings of a tool name back as one, so a log spanning the change renders alike', async () => {
    // The runner used to persist pi's raw name and now persists the display name, with no version
    // marker in the file. A log appended across that change holds both under one key, and the card
    // renderer keys its icon and its IN line off the display name.
    const turns = await roundTrip(join(DAMOCLES_HOME_DIR, 'mixed-spellings'), [
      assistantEntry([{ type: 'tool_use', id: 'tc-1', name: 'bash', input: { command: 'ls' } }]),
      assistantEntry([{ type: 'tool_use', id: 'tc-2', name: 'find', input: { pattern: '*.ts' } }]),
      assistantEntry([{ type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'ls' } }]),
      assistantEntry([{ type: 'tool_use', id: 'tc-4', name: 'mcp__pi__team_send_message', input: { to: 'lead' } }]),
    ]);

    expect(turns).toEqual([
      [{ type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } }],
      [{ type: 'tool_use', id: 'tc-2', name: 'Glob', input: { pattern: '*.ts' } }],
      [{ type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'ls' } }],
      [{ type: 'tool_use', id: 'tc-4', name: 'mcp__pi__team_send_message', input: { to: 'lead' } }],
    ]);
  });
});

describe('TeamPersistence team state round trip', () => {
  it('restores every usage total the agent-completed entry carries', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-state'), 'session-1');
    await persistence.initTeamFile(TEAM_ID);
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
    await persistence.flush();

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]).toMatchObject({
      name: 'lead', status: 'completed', toolCount: 4,
      totalInputTokens: 300, totalOutputTokens: 80,
      cacheReadTokens: 52_900_000, cacheCreationTokens: 30, costUsd: 26.45,
    });
  });

  it('restores each agent own billing flag, so a reloaded card labels its cost the same way', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-billing'), 'session-1');
    await persistence.initTeamFile(TEAM_ID);
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
    await persistence.flush();

    const state = await persistence.loadTeamState(TEAM_ID);

    // A mixed-billing team is the case a single panel-level flag gets wrong.
    expect(state?.agents.map(a => [a.name, a.dollarBilled])).toEqual([['lead', false], ['dev', true]]);
  });

  it('sums the usage of both attempts of a re-dispatched agent, taking its work fields from the last', async () => {
    // Every figure here is the one the observed run recorded for the specialist it cancelled and re-ran.
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-redispatch'), 'session-1');
    await persistence.initTeamFile(TEAM_ID);
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
    await persistence.flush();

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
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-mid-attempt'), 'session-1');
    await persistence.initTeamFile(TEAM_ID);
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
    // The log ends here: the second attempt was still running when the session was reopened.
    persistence.appendTeamEntry({
      type: 'agent-spawned', teamId: TEAM_ID, agentId: AGENT_ID, name: 'alpha',
      specialization: 'read the brief', model: 'opus', attempt: 1, reattempt: true,
      timestamp: '2026-09-01T10:40:46.872Z',
    });
    await persistence.flush();

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]).toMatchObject({
      status: 'running', attempt: 1, toolCount: 0, endTime: null, result: null,
      startTime: new Date('2026-09-01T10:40:46.872Z').getTime(),
      // The cancelled attempt still spent this, so it stays on the card.
      totalOutputTokens: 665,
    });
  });

  it('reads a spawn entry written before the attempt counter as the agent first attempt', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-no-attempt'), 'session-1');
    await persistence.initTeamFile(TEAM_ID);
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
    await persistence.flush();

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]?.attempt).toBe(0);
  });

  it('labels an agent that never spawned as a charge, the safe side of an unknown', async () => {
    const persistence = new TeamPersistence(join(DAMOCLES_HOME_DIR, 'team-billing-unspawned'), 'session-1');
    await persistence.initTeamFile(TEAM_ID);
    persistence.appendTeamEntry({
      type: 'team-created', teamId: TEAM_ID, title: 'Slice 3', toolUseId: 'tu-1',
      agents: [{ name: 'dev', role: 'specialist' }],
      timestamp: '2026-08-26T00:00:00.000Z',
    });
    await persistence.flush();

    const state = await persistence.loadTeamState(TEAM_ID);

    expect(state?.agents[0]?.dollarBilled).toBe(true);
  });
});
