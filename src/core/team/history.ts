import { TeamPersistence } from './persistence';
import { teamIdForToolCall } from '../pi-session/agent-records';
import { initPiLoader } from '../pi-session/pi-loader';
import * as path from 'path';
import { resolvePiSessionFile } from '../pi-session/session-store';
import { readSessionFileEntries } from '../pi-session/session-store/session-file-entries';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { TeamState, TeamAgentHistoryMessage } from '../../shared/types/team';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

export async function loadTeamFromHistory(
  cwd: string,
  sessionId: string,
  teamId: string,
): Promise<TeamState | null> {
  if (!sessionId || !isValidUuid(teamId)) return null;
  return new TeamPersistence(cwd, sessionId).loadTeamState(teamId);
}

/**
 * The team a `create_team` or `resume_team` call ran, from the invocation entries on the parent session's current branch:
 * `liveBranch` while a panel holds the session live, else the stored file's, read without writing it.
 */
export async function findTeamIdByToolUse(cwd: string, sessionId: string, toolUseId: string, liveBranch?: readonly SessionEntry[]): Promise<string | null> {
  if (!sessionId) return null;
  if (liveBranch) return teamIdForToolCall(liveBranch, toolUseId);
  const pi = await initPiLoader();
  if (!pi) throw new Error('The pi runtime is unavailable, so the team cannot be located.');
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return null;
  const entries = await readSessionFileEntries(filePath);
  const stored = pi.SessionManager.inMemory(path.dirname(filePath), undefined, entries as Parameters<typeof pi.SessionManager.inMemory>[2]);
  return teamIdForToolCall(stored.getBranch(), toolUseId);
}

export async function loadAgentConversation(
  cwd: string,
  sessionId: string,
  teamId: string,
  agentId: string,
): Promise<TeamAgentHistoryMessage[]> {
  if (!sessionId || !isValidUuid(teamId) || !isValidUuid(agentId)) return [];
  return new TeamPersistence(cwd, sessionId).loadAgentConversation(teamId, agentId);
}

/** A running member's attempts before the one `before` numbers, from their files (`TeamPersistence.loadAgentAttempts`). */
export async function loadAgentAttempts(
  cwd: string,
  sessionId: string,
  teamId: string,
  agentId: string,
  before: number,
): Promise<TeamAgentHistoryMessage[]> {
  if (!sessionId || !isValidUuid(teamId) || !isValidUuid(agentId)) return [];
  return new TeamPersistence(cwd, sessionId).loadAgentAttempts(teamId, agentId, before);
}
