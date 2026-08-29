import { ref, toValue, type MaybeRefOrGetter } from "vue";
import { defineStore } from "pinia";
import { useStreamingStore, useSubagentStore } from "@/stores";
import { useTeamStore } from "@/stores/useTeamStore";
import type { ExpandedToolSource } from "@/stores/useUIStore";
import { useVSCode } from "./useVSCode";

export interface PendingToolCancel {
  requestId: string;
  toolUseId: string;
  source: ExpandedToolSource;
}

/** Held outside the control so a transcript card and an overlay showing the same call agree it is stopping. */
const usePendingCancelStore = defineStore("pendingToolCancel", () => {
  const pending = ref<PendingToolCancel[]>([]);

  function add(entry: PendingToolCancel): void {
    // One entry per call, so a rejection cannot leave an older request of the same card behind.
    pending.value = [
      ...pending.value.filter((p) => p.toolUseId !== entry.toolUseId || p.source !== entry.source),
      entry,
    ];
  }

  function has(toolUseId: string, source: ExpandedToolSource): boolean {
    return pending.value.some((p) => p.toolUseId === toolUseId && p.source === source);
  }

  /** A request id names exactly one request, so a rejected second click cannot clear an accepted first one. */
  function take(toolUseId: string, requestId: string | undefined): PendingToolCancel[] {
    const isRejected = (p: PendingToolCancel): boolean =>
      requestId === undefined ? p.toolUseId === toolUseId : p.requestId === requestId;

    const rejected = pending.value.filter(isRejected);
    if (rejected.length > 0) {
      pending.value = pending.value.filter((p) => !isRejected(p));
    }
    return rejected;
  }

  return { pending, add, has, take };
});

/** Drops the requests the extension rejected and reports which store each of them marked. */
export function takeRejectedCancels(toolUseId: string, requestId: string | undefined): PendingToolCancel[] {
  return usePendingCancelStore().take(toolUseId, requestId);
}

export interface ToolCancel {
  requestCancel: (toolUseId: string, note?: string) => void;
  isCancelPending: (toolUseId: string) => boolean;
}

/** Asks the extension to cancel one running shell call and flags it optimistically in the store `source` names. */
export function useToolCancel(source: MaybeRefOrGetter<ExpandedToolSource> = "session"): ToolCancel {
  const { postMessage } = useVSCode();
  const streamingStore = useStreamingStore();
  const subagentStore = useSubagentStore();
  const teamStore = useTeamStore();
  const pendingCancels = usePendingCancelStore();

  function markCancelRequested(resolvedSource: ExpandedToolSource, toolUseId: string): void {
    switch (resolvedSource) {
      case "subagent":
        subagentStore.markSubagentToolCancelRequested(toolUseId);
        return;
      case "team":
        teamStore.markAgentToolCancelRequested(toolUseId);
        return;
      case "session":
        streamingStore.markToolCancelRequested(toolUseId);
        return;
    }
  }

  function requestCancel(toolUseId: string, note?: string): void {
    const resolvedSource = toValue(source);
    const requestId = crypto.randomUUID();

    pendingCancels.add({ requestId, toolUseId, source: resolvedSource });
    postMessage({ type: "cancelToolCall", toolUseId, requestId, ...(note !== undefined && { note }) });
    markCancelRequested(resolvedSource, toolUseId);
  }

  function isCancelPending(toolUseId: string): boolean {
    return pendingCancels.has(toolUseId, toValue(source));
  }

  return { requestCancel, isCancelPending };
}
