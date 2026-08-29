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
