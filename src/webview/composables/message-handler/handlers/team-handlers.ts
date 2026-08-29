import { useTeamStore } from '@/stores/useTeamStore';
import type { HandlerRegistry } from "../types";

export function createTeamHandlers(): Partial<HandlerRegistry> {
  return {
    teamStarted: (msg) => {
      useTeamStore().handleTeamStarted(msg.team);
      return { skipScroll: true };
    },
    teamPhaseUpdate: (msg) => {
      useTeamStore().handleTeamPhaseUpdate(msg.teamId, msg.phase);
      return { skipScroll: true };
    },
    teamAgentStatusUpdate: (msg) => {
      useTeamStore().handleAgentStatusUpdate(msg.teamId, msg.agentId, msg.status, msg.progressSummary, msg.logFilePath, msg.model);
      return { skipScroll: true };
    },
    teamAgentUsageUpdate: (msg) => {
      useTeamStore().handleAgentUsageUpdate(msg.teamId, msg.agentId, {
        totalInputTokens: msg.totalInputTokens,
        totalOutputTokens: msg.totalOutputTokens,
        cacheReadTokens: msg.cacheReadTokens,
        cacheCreationTokens: msg.cacheCreationTokens,
        costUsd: msg.costUsd,
      });
      return { skipScroll: true };
    },
    teamAgentToolCall: (msg) => {
      useTeamStore().handleAgentToolCall(msg.teamId, msg.agentId, msg.toolName);
      return { skipScroll: true };
    },
    teamMessage: (msg) => {
      useTeamStore().handleTeamMessage(msg.teamId, msg.message);
      return { skipScroll: true };
    },
    teamScratchpadUpdate: (msg) => {
      useTeamStore().handleScratchpadUpdate(msg.teamId, msg.entry);
      return { skipScroll: true };
    },
    teamCompleted: (msg) => {
      useTeamStore().handleTeamCompleted(msg.teamId, msg.status, msg.result);
      return { skipScroll: true };
    },
    teamAgentStreamDelta: (msg) => {
      useTeamStore().handleAgentStreamDelta(msg.agentId, msg.deltaType, msg.text);
      return { skipScroll: true };
    },
    teamAgentAssistant: (msg) => {
      useTeamStore().handleAgentAssistant(msg.agentId, msg.messageId, msg.content, msg.timestamp);
      return { skipScroll: true };
    },
    teamAgentUserMessage: (msg) => {
      useTeamStore().handleAgentUserMessage(msg.agentId, msg.content, msg.timestamp);
      return { skipScroll: true };
    },
    teamAgentToolResult: (msg) => {
      useTeamStore().handleAgentToolResult(msg.agentId, msg.toolUseId, msg.result, msg.isError, msg.metadata);
      return { skipScroll: true };
    },
    teamAgentToolProgress: (msg) => {
      useTeamStore().handleAgentToolProgress(msg.agentId, msg.toolUseId, msg.output, msg.outputTruncated);
      return { skipScroll: true };
    },
    teamAgentTurnComplete: () => {
      return { skipScroll: true };
    },
    teamAgentDataLoaded: (msg) => {
      useTeamStore().handleAgentDataLoaded(msg.agentId, msg.messages);
      return { skipScroll: true };
    },
    teamAgentPermissionRequest: (msg) => {
      useTeamStore().handlePermissionRequest({
        requestId: msg.requestId,
        teamId: msg.teamId,
        agentId: msg.agentId,
        agentName: msg.agentName,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
      });
      return { skipScroll: false };
    },
  };
}
