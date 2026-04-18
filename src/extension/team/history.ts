import { TeamPersistence } from './persistence';
import type { TeamState, TeamAgentContentBlock } from '../../shared/types/team';

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

export async function loadAgentConversation(
  cwd: string,
  sessionId: string,
  teamId: string,
  agentId: string,
): Promise<TeamAgentContentBlock[][]> {
  if (!sessionId || !isValidUuid(teamId) || !isValidUuid(agentId)) return [];
  return new TeamPersistence(cwd, sessionId).loadAgentConversation(teamId, agentId);
}
