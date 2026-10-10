import { useTeamStore } from '@/stores/useTeamStore';
import type { HandlerRegistry } from "../types";

export function createTeamHandlers(): Partial<HandlerRegistry> {
  return {
    teamStarted: (msg) => {
      useTeamStore().handleTeamStarted(msg.team);
    },
    teamPhaseUpdate: (msg) => {
      useTeamStore().handleTeamPhaseUpdate(msg.teamId, msg.phase);
    },
    teamAgentStatusUpdate: (msg) => {
      useTeamStore().handleAgentStatusUpdate(msg.teamId, msg.agentId, msg.status, msg.progressSummary, msg.logFilePath, msg.model, msg.dollarBilled, msg.attempt, msg.effort, msg.stopwatch, msg.result);
    },
    teamAgentUsageUpdate: (msg) => {
      useTeamStore().handleAgentUsageUpdate(msg.teamId, msg.agentId, {
        totalInputTokens: msg.totalInputTokens,
        totalOutputTokens: msg.totalOutputTokens,
        cacheReadTokens: msg.cacheReadTokens,
        cacheCreationTokens: msg.cacheCreationTokens,
        costUsd: msg.costUsd,
      });
    },
    teamAgentToolCall: (msg) => {
      useTeamStore().handleAgentToolCall(msg.teamId, msg.agentId, msg.toolName);
    },
    teamMessage: (msg) => {
      useTeamStore().handleTeamMessage(msg.teamId, msg.message);
    },
    teamScratchpadUpdate: (msg) => {
      useTeamStore().handleScratchpadUpdate(msg.teamId, msg.entry);
    },
    teamCompleted: (msg) => {
      useTeamStore().handleTeamCompleted(msg.teamId, msg.status, msg.result, msg.run);
    },
    teamCancelRejected: (msg) => {
      useTeamStore().clearCancelRequest(msg.teamId);
    },
    teamAgentStreamDelta: (msg) => {
      useTeamStore().handleAgentStreamDelta(msg.agentId, msg.deltaType, msg.text);
    },
    teamAgentAssistant: (msg) => {
      useTeamStore().handleAgentAssistant(msg.agentId, msg.messageId, msg.content, msg.timestamp);
    },
    teamAgentUserMessage: (msg) => {
      useTeamStore().handleAgentUserMessage(msg.agentId, msg.content, msg.timestamp, msg.images);
    },
    teamAgentToolResult: (msg) => {
      useTeamStore().handleAgentToolResult(msg.agentId, msg.toolUseId, msg.result, msg.isError, msg.metadata, msg.imageCount);
    },
    teamAgentToolProgress: (msg) => {
      useTeamStore().handleAgentToolProgress(msg.agentId, msg.toolUseId, msg.output, msg.outputTruncated);
    },
    teamAgentDataLoaded: (msg) => {
      useTeamStore().handleAgentDataLoaded(msg.agentId, msg.messages);
    },
  };
}
