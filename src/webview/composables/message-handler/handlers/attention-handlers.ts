import type { HandlerRegistry } from "../types";
import { requestAttention } from "@/composables/useAttention";
import { useUsageStatsStore } from "@/stores/useUsageStatsStore";

/** A desktop notification's action and the command registry reach a chat's UI here (AD10, AD11). */
export function createAttentionHandlers(): Partial<HandlerRegistry> {
  return {
    focusAttention: (msg, ctx) => {
      const { permissionStore, questionStore, formStore, elicitationStore } = ctx.stores;
      if (msg.kind === "plan") {
        // As the plan banner's Review plan does.
        if (permissionStore.pendingPlanApproval) permissionStore.showPlanOverlay();
        return;
      }
      const pending = msg.kind === "approval"
        ? permissionStore.currentPermission !== null || permissionStore.pendingSkillApproval !== null
        : questionStore.pendingQuestion !== null || formStore.pendingForm !== null || elicitationStore.pendingElicitations.length > 0;
      requestAttention(msg.kind, pending);
    },

    openTeamOverlay: (msg, ctx) => {
      const { teamStore } = ctx.stores;
      if (Object.hasOwn(teamStore.teams, msg.teamId)) teamStore.openOverlay(msg.teamId);
    },

    // Each opens what the chat header's control for it opens, as App.vue's header handlers do.
    runChatCommand: (msg, ctx) => {
      const { stores, bridge } = ctx;
      switch (msg.command) {
        case "contextUsage":
          stores.contextUsageStore.openOverlay();
          bridge.postMessage({ type: "requestContextUsage" });
          break;
        case "subscriptionUsage":
          stores.subscriptionUsageStore.requestOverlay();
          break;
        case "usageStatistics":
          useUsageStatsStore().openOverlay();
          break;
        case "mcpServers":
          if (stores.uiStore.openMcpPanel()) bridge.postMessage({ type: "requestMcpStatus" });
          break;
        case "tools":
          if (stores.uiStore.openToolsPanel()) bridge.postMessage({ type: "requestToolStatus" });
          break;
        case "memory":
          stores.uiStore.openMemoryPanel();
          break;
        case "rewind":
          stores.uiStore.openRewindBrowser();
          bridge.postMessage({ type: "requestRewindHistory" });
          break;
        case "sideQuestion":
          ctx.refs.chatInputRef.value?.prependInput("/btw ");
          break;
        case "openSessionLog":
          bridge.postMessage({ type: "openSessionLog" });
          break;
        case "viewSessionPlan":
          bridge.postMessage({ type: "openSessionPlan" });
          break;
      }
    },
  };
}
