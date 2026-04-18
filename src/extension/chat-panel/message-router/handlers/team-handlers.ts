import * as fs from 'fs';
import * as readline from 'readline';
import { log } from '../../../logger';
import { getSessionFilePath } from '../../../session';
import { loadTeamFromHistory, loadAgentConversation } from '../../../team/history';
import type { HandlerDependencies, HandlerRegistry } from "../types";

async function findTeamCorrelation(workspacePath: string, sessionId: string, toolUseId: string): Promise<string | null> {
  const filePath = await getSessionFilePath(workspacePath, sessionId);
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('team-correlation')) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry['type'] === 'team-correlation' && entry['toolUseId'] === toolUseId) {
          const teamId = entry['teamId'];
          if (typeof teamId === 'string') return teamId;
        }
      } catch { /* skip malformed lines */ }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

export function createTeamHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, workspacePath } = deps;

  return {
    requestTeamData: async (msg, ctx) => {
      if (msg.type !== "requestTeamData") return;
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) return;
      try {
        const team = await loadTeamFromHistory(workspacePath, sessionId, msg.teamId);
        if (team) postMessage(ctx.host, { type: "teamStarted", team });
      } catch (err) {
        console.error('[TeamHandlers] Failed to load team data:', err);
      }
    },

    requestTeamDataByToolUse: async (msg, ctx) => {
      if (msg.type !== "requestTeamDataByToolUse") return;
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) return;
      try {
        const teamId = await findTeamCorrelation(workspacePath, sessionId, msg.toolUseId);
        if (!teamId) return;
        const team = await loadTeamFromHistory(workspacePath, sessionId, teamId);
        if (team) postMessage(ctx.host, { type: "teamStarted", team });
      } catch (err) {
        log('[TeamHandlers] Failed to load team by toolUseId %s: %O', msg.toolUseId, err);
      }
    },

    cancelTeamAgent: async (msg, ctx) => {
      if (msg.type !== "cancelTeamAgent") return;
      if (!ctx.session.teamService) {
        log('[TeamHandlers] cancelTeamAgent ignored: team service unavailable on panel %s', ctx.panelId);
        return;
      }
      try {
        ctx.session.teamService.cancelAgent(msg.teamId, msg.agentId);
      } catch (err) {
        console.error('[TeamHandlers] Failed to cancel agent:', err);
      }
    },

    requestTeamAgentData: async (msg, ctx) => {
      if (msg.type !== "requestTeamAgentData") return;
      const sessionId = ctx.session.persistenceSessionId;
      try {
        const messages = sessionId
          ? await loadAgentConversation(workspacePath, sessionId, msg.teamId, msg.agentId)
          : [];
        postMessage(ctx.host, { type: "teamAgentDataLoaded", teamId: msg.teamId, agentId: msg.agentId, messages });
      } catch {
        postMessage(ctx.host, { type: "teamAgentDataLoaded", teamId: msg.teamId, agentId: msg.agentId, messages: [] });
      }
    },

    teamAgentPermissionResponse: async (msg, ctx) => {
      if (msg.type !== "teamAgentPermissionResponse") return;
      if (!ctx.session.teamService) {
        log('[TeamHandlers] teamAgentPermissionResponse ignored: team service unavailable on panel %s', ctx.panelId);
        return;
      }
      ctx.session.teamService.resolvePermission(msg.requestId, msg.behavior);
    },
  };
}
