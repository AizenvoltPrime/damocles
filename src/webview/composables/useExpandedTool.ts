import { computed, type ComputedRef } from "vue";
import type { ToolCall, ToolResultOwner } from "@shared/types/session";
import { useUIStore, useStreamingStore, useSubagentStore } from "@/stores";
import { useTeamStore } from "@/stores/useTeamStore";

interface ExpandedTool {
  tool: ToolCall;
  /** Where the result is stored; undefined when the tool's file cannot be named. */
  owner: ToolResultOwner | undefined;
}

/** Searches only the store named by the source; a tool id is not unique across stores. */
function findExpandedTool(): ExpandedTool | undefined {
  const uiStore = useUIStore();
  const toolId = uiStore.expandedToolId;
  if (!toolId) return undefined;

  switch (uiStore.expandedToolSource) {
    case "session": {
      for (const msg of useStreamingStore().messages) {
        const tool = msg.toolCalls?.find((t) => t.id === toolId);
        if (tool) return { tool, owner: { kind: "session" } };
      }
      return undefined;
    }
    case "subagent": {
      // Both collections, matching useSubagentStore.updateSubagentToolMetadata.
      for (const subagent of Object.values(useSubagentStore().subagents)) {
        const owner: ToolResultOwner | undefined = subagent.sdkAgentId ? { kind: "subagent", agentId: subagent.sdkAgentId } : undefined;
        const live = subagent.toolCalls.find((t) => t.id === toolId);
        if (live) return { tool: live, owner };
        for (const msg of subagent.messages) {
          const sealed = msg.toolCalls?.find((t) => t.id === toolId);
          if (sealed) return { tool: sealed, owner };
        }
      }
      return undefined;
    }
    case "team": {
      const teamStore = useTeamStore();
      for (const [agentId, messages] of Object.entries(teamStore.agentMessages)) {
        for (const msg of messages) {
          const tool = msg.toolCalls?.find((t) => t.id === toolId);
          if (!tool) continue;
          const team = Object.values(teamStore.teams).find((t) => t.agents.some((a) => a.agentId === agentId));
          return { tool, owner: team ? { kind: "team", teamId: team.teamId, agentId } : undefined };
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export function resolveExpandedTool(): ToolCall | undefined {
  return findExpandedTool()?.tool;
}

function sameOwner(a: ToolResultOwner, b: ToolResultOwner): boolean {
  switch (a.kind) {
    case "session":
      return b.kind === "session";
    case "subagent":
      return b.kind === "subagent" && a.agentId === b.agentId;
    case "team":
      return b.kind === "team" && a.teamId === b.teamId && a.agentId === b.agentId;
  }
}

export function useExpandedTool(): {
  tool: ComputedRef<ToolCall | undefined>;
  owner: ComputedRef<ToolResultOwner | undefined>;
} {
  const found = computed(findExpandedTool);
  const tool = computed(() => found.value?.tool);
  // Keeps the previous object when value-equal, since every search builds a new owner and streaming reruns it per token.
  const owner = computed<ToolResultOwner | undefined>((prev) => {
    const next = found.value?.owner;
    return prev && next && sameOwner(prev, next) ? prev : next;
  });
  return { tool, owner };
}
