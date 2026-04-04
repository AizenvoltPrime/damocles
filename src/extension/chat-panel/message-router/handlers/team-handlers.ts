import type { HandlerDependencies, HandlerRegistry } from "../types";

export function createTeamHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, teamService } = deps;

  return {
    requestTeamData: async (msg, ctx) => {
      if (msg.type !== "requestTeamData") return;
      if (!teamService) return;

      try {
        const team = await teamService.loadTeamFromHistory(msg.teamId);
        if (team) {
          postMessage(ctx.host, { type: "teamStarted", team });
        }
      } catch (err) {
        console.error('[TeamHandlers] Failed to load team data:', err);
      }
    },

    cancelTeamAgent: async (msg) => {
      if (msg.type !== "cancelTeamAgent") return;
      if (!teamService) return;
      try {
        teamService.cancelAgent(msg.teamId, msg.agentId);
      } catch (err) {
        console.error('[TeamHandlers] Failed to cancel agent:', err);
      }
    },

    requestTeamAgentData: async (msg, ctx) => {
      if (msg.type !== "requestTeamAgentData") return;
      if (!teamService) return;
      try {
        const messages = await teamService.loadAgentConversation(msg.teamId, msg.agentId);
        postMessage(ctx.host, {
          type: "teamAgentDataLoaded",
          teamId: msg.teamId,
          agentId: msg.agentId,
          messages,
        });
      } catch {
        postMessage(ctx.host, {
          type: "teamAgentDataLoaded",
          teamId: msg.teamId,
          agentId: msg.agentId,
          messages: [],
        });
      }
    },

    teamAgentPermissionResponse: async (msg) => {
      if (msg.type !== "teamAgentPermissionResponse") return;
      if (!teamService) return;
      teamService.resolvePermission(msg.requestId, msg.behavior);
    },
  };
}
