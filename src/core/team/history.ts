import { TeamPersistence } from './persistence';
import { teamIdForToolCall } from '../pi-session/agent-records';
import { initPiLoader } from '../pi-session/pi-loader';
import { ensurePiSessionDir, resolvePiSessionFile } from '../pi-session/session-store';
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

/** The team a `create_team` or `resume_team` call ran, from the invocation entries on the parent session's current branch. */
export async function findTeamIdByToolUse(cwd: string, sessionId: string, toolUseId: string): Promise<string | null> {
  if (!sessionId) return null;
  const pi = await initPiLoader();
  if (!pi) throw new Error('The pi runtime is unavailable, so the team cannot be located.');
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) return null;
  const branch = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd)).getBranch();
  return teamIdForToolCall(branch, toolUseId);
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
