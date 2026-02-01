import type { HandlerDependencies, HandlerRegistry } from "../types";
import { getSessionFilePath } from "../../../session";
import { buildPlanImplementationMessage } from "../utils";

export function createPermissionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, settingsManager } = deps;

  return {
    approveEdit: (msg, ctx) => {
      if (msg.type !== "approveEdit") return;

      if (msg.acceptAll && msg.parentToolUseId) {
        ctx.permissionHandler.autoApproveSubagent(msg.parentToolUseId);
      }

      ctx.permissionHandler.resolveApproval(msg.toolUseId, msg.approved, {
        ...(msg.customMessage !== undefined ? { customMessage: msg.customMessage } : {}),
      });
    },

    answerQuestion: (msg, ctx) => {
      if (msg.type !== "answerQuestion") return;
      ctx.permissionHandler.resolveQuestion(msg.toolUseId, msg.answers);
    },

    approvePlan: async (msg, ctx) => {
      if (msg.type !== "approvePlan") return;

      if (msg.clearContext && msg.approved && msg.planContent) {
        const currentSessionId = ctx.session.currentSessionId;

        ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, false, {
          feedback: "User chose to clear context and start fresh",
        });

        const transcriptPath = currentSessionId
          ? await getSessionFilePath(workspacePath, currentSessionId)
          : null;

        const newMessage = buildPlanImplementationMessage(msg.planContent, transcriptPath);
        const correlationId = `plan-impl-${Date.now()}`;

        postMessage(ctx.panel, {
          type: "sessionCleared",
          pendingMessage: { content: newMessage, correlationId },
        });

        await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, "acceptEdits");
        await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);

        ctx.session.setPendingPlanBind(msg.planContent);
        ctx.session.reset();
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
        await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);
      }
    },

    approveEnterPlanMode: async (msg, ctx) => {
      if (msg.type !== "approveEnterPlanMode") return;
      ctx.permissionHandler.resolveEnterPlanApproval(msg.toolUseId, msg.approved, {
        ...(msg.customMessage !== undefined ? { customMessage: msg.customMessage } : {}),
      });

      if (msg.approved) {
        await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, "plan");
        await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);
      }
    },

    approveSkill: (msg, ctx) => {
      if (msg.type !== "approveSkill") return;
      ctx.permissionHandler.resolveSkillApproval(msg.toolUseId, msg.approved, {
        ...(msg.approvalMode !== undefined ? { approvalMode: msg.approvalMode } : {}),
        ...(msg.customMessage !== undefined ? { customMessage: msg.customMessage } : {}),
      });
    },
  };
}
