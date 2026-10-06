import type { HandlerRegistry } from "../types";
import { requestAttention } from "@/composables/useAttention";

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

    runChatCommand: (msg, ctx) => {
      switch (msg.command) {
        case "subscriptionUsage":
          ctx.stores.subscriptionUsageStore.requestOverlay();
          break;
      }
    },
  };
}
