import { describe, it, expect, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-team-history-')) };
});

import { DAMOCLES_HOME_DIR } from '../../paths';
import { findTeamIdByToolUse } from '../history';
import { ensurePiSessionDir } from '../../pi-session/session-store';
import { DAMOCLES_AGENT_INVOCATION_ENTRY } from '../../pi-session/session-store/constants';

afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

const TEAM_ID = '0b6f6d1e-4c1a-4b8e-9f2a-1c2d3e4f5a6b';

type PiMessage = Parameters<SessionManager['appendMessage']>[0];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string): PiMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
const assistant = (content: unknown[]): PiMessage =>
  ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude', usage, stopReason: 'toolUse', timestamp: Date.now() }) as unknown as PiMessage;
const createTeamCall = (toolCallId: string): PiMessage =>
  assistant([{ type: 'toolCall', id: toolCallId, name: 'create_team', arguments: { title: 't', brief: 'b', agents: [] } }]);
const createTeamResult = (toolCallId: string): PiMessage =>
  ({ role: 'toolResult', toolCallId, toolName: 'create_team', content: [{ type: 'text', text: 'synthesis' }], isError: false, timestamp: Date.now() }) as unknown as PiMessage;

/** A parent session in the workspace session dir, where the handler resolves it by id. */
function parentSession(cwd: string): SessionManager {
  return SessionManager.create(cwd, ensurePiSessionDir(cwd));
}

describe('findTeamIdByToolUse', () => {
  it('resolves the team a create_team call started from its invocation entry', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'resolves');
    const sm = parentSession(cwd);
    sm.appendMessage(user('build it with a team'));
    sm.appendMessage(createTeamCall('tc-team'));
    sm.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'team', id: TEAM_ID, toolCallId: 'tc-team', resume: false });
    sm.appendMessage(createTeamResult('tc-team'));

    expect(await findTeamIdByToolUse(cwd, sm.getSessionId(), 'tc-team')).toBe(TEAM_ID);
    expect(await findTeamIdByToolUse(cwd, sm.getSessionId(), 'tc-other')).toBeNull();
  });

  it('resolves a resume_team call to the same team as its create_team call', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'resume');
    const sm = parentSession(cwd);
    sm.appendMessage(user('build it with a team'));
    sm.appendMessage(createTeamCall('tc-team'));
    sm.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'team', id: TEAM_ID, toolCallId: 'tc-team', resume: false });
    sm.appendMessage(createTeamResult('tc-team'));
    sm.appendMessage(user('continue'));
    sm.appendMessage(assistant([{ type: 'toolCall', id: 'tc-resume', name: 'resume_team', arguments: { team_id: TEAM_ID } }]));
    sm.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'team', id: TEAM_ID, toolCallId: 'tc-resume', resume: true });

    expect(await findTeamIdByToolUse(cwd, sm.getSessionId(), 'tc-resume')).toBe(TEAM_ID);
    expect(await findTeamIdByToolUse(cwd, sm.getSessionId(), 'tc-team')).toBe(TEAM_ID);
  });

  it('does not resolve an invocation the branch was rewound past', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'rewound');
    const sm = parentSession(cwd);
    sm.appendMessage(user('build it with a team'));
    const beforeTeam = sm.getLeafId()!;
    sm.appendMessage(createTeamCall('tc-team'));
    sm.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'team', id: TEAM_ID, toolCallId: 'tc-team', resume: false });
    sm.appendMessage(createTeamResult('tc-team'));
    sm.branch(beforeTeam);
    sm.appendMessage(assistant([{ type: 'text', text: 'doing it alone instead' }]));

    expect(await findTeamIdByToolUse(cwd, sm.getSessionId(), 'tc-team')).toBeNull();
  });

  it('finds nothing in a session recorded before invocation entries, so its card shows the tool call only', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'legacy');
    const sm = parentSession(cwd);
    sm.appendMessage(user('build it with a team'));
    sm.appendMessage(createTeamCall('tc-team'));
    sm.appendMessage(createTeamResult('tc-team'));

    expect(await findTeamIdByToolUse(cwd, sm.getSessionId(), 'tc-team')).toBeNull();
  });
});
