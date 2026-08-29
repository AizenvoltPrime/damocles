import { computed, type ComputedRef } from "vue";
import type { ToolCall } from "@shared/types/session";
import { useUIStore, useStreamingStore, useSubagentStore } from "@/stores";
import { useTeamStore } from "@/stores/useTeamStore";

/** Searches only the store named by the source; a tool id is not unique across stores. */
export function resolveExpandedTool(): ToolCall | undefined {
  const uiStore = useUIStore();
  const toolId = uiStore.expandedToolId;
  if (!toolId) return undefined;

  switch (uiStore.expandedToolSource) {
    case "session": {
      for (const msg of useStreamingStore().messages) {
        const tool = msg.toolCalls?.find((t) => t.id === toolId);
        if (tool) return tool;
      }
      return undefined;
    }
    case "subagent": {
      // Both collections, matching useSubagentStore.updateSubagentToolMetadata.
      for (const subagent of Object.values(useSubagentStore().subagents)) {
        const live = subagent.toolCalls.find((t) => t.id === toolId);
        if (live) return live;
        for (const msg of subagent.messages) {
          const sealed = msg.toolCalls?.find((t) => t.id === toolId);
          if (sealed) return sealed;
        }
      }
      return undefined;
    }
    case "team": {
      for (const messages of Object.values(useTeamStore().agentMessages)) {
        for (const msg of messages) {
          const tool = msg.toolCalls?.find((t) => t.id === toolId);
          if (tool) return tool;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export function useExpandedTool(): ComputedRef<ToolCall | undefined> {
  return computed(() => resolveExpandedTool());
}
