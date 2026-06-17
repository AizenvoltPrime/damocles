import type { HandlerDependencies, HandlerRegistry } from "../types";
import { getSessionFilePath } from "../../../session";
import { buildPlanImplementationMessage } from "../utils";
import { syncPermissionRulesToClaudeSettings } from "../../settings-manager/utils";

export function createPermissionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, settingsManager } = deps;

  return {
    approveEdit: async (msg, ctx) => {
      if (msg.type !== "approveEdit") return;

      if (msg.acceptAll && msg.parentToolUseId) {
        ctx.permissionHandler.autoApproveSubagent(msg.parentToolUseId);
      }

      if (msg.updatedPermissions?.length) {
        await syncPermissionRulesToClaudeSettings(msg.updatedPermissions, workspacePath);
      }

      ctx.permissionHandler.resolveApproval(msg.toolUseId, msg.approved, {
        ...(msg.customMessage !== undefined ? { customMessage: msg.customMessage } : {}),
        ...(msg.updatedPermissions?.length ? { updatedPermissions: msg.updatedPermissions } : {}),
      });
    },

    answerQuestion: (msg, ctx) => {
      if (msg.type !== "answerQuestion") return;
      ctx.permissionHandler.resolveQuestion(msg.toolUseId, msg.answers, msg.annotations);
    },

    approvePlan: async (msg, ctx) => {
      if (msg.type !== "approvePlan") return;

      if (msg.clearContext && msg.approved && msg.planContent) {
        const planPath = ctx.session.planPath;

        ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, false, {
          feedback: "User chose to clear context and start fresh",
        });

        const persistenceId = ctx.session.persistenceSessionId;
        const transcriptPath = persistenceId
          ? await getSessionFilePath(workspacePath, persistenceId)
          : null;

        const newMessage = buildPlanImplementationMessage(msg.planContent, transcriptPath);
        const correlationId = `plan-impl-${Date.now()}`;

        postMessage(ctx.host, {
          type: "sessionCleared",
          pendingMessage: { content: newMessage, correlationId },
        });

        await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, "acceptEdits");
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
        settingsManager.sendModelForPanel(ctx.host, ctx.panelId);

        ctx.session.clear();
        if (planPath) ctx.session.planPath = planPath;
        await ctx.session.sendMessage(newMessage, undefined, correlationId);

        return;
      }

      ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, msg.approved, {
        ...(msg.approvalMode !== undefined ? { approvalMode: msg.approvalMode } : {}),
        ...(msg.feedback !== undefined ? { feedback: msg.feedback } : {}),
      });

      if (msg.approved && msg.approvalMode) {
        const newMode = msg.approvalMode === "acceptEdits" ? "acceptEdits" : "default";
        await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, newMode);
        await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      }
    },

    approveSkill: (msg, ctx) => {
      if (msg.type !== "approveSkill") return;
      ctx.permissionHandler.resolveSkillApproval(msg.toolUseId, msg.approved, {
        ...(msg.approvalMode !== undefined ? { approvalMode: msg.approvalMode } : {}),
        ...(msg.customMessage !== undefined ? { customMessage: msg.customMessage } : {}),
      });
    },

    answerElicitation: (msg, ctx) => {
      if (msg.type !== "answerElicitation") return;
      ctx.permissionHandler.resolveElicitation(msg.elicitationId, {
        action: msg.action,
        ...(msg.content !== undefined ? { content: msg.content } : {}),
      });
    },

    extensionUiResponse: (msg, ctx) => {
      if (msg.type !== "extensionUiResponse") return;
      // Bridges a pi-extension `ctx.ui.*` dialog answer back to the per-session UI context (US-026).
      ctx.session.resolveExtensionUiResponse?.(msg.requestId, msg.value);
    },
  };
}
