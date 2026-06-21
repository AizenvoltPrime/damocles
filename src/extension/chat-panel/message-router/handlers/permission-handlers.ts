import * as fs from "fs/promises";
import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { resolveSessionFilePath } from "../../session-file-path";
import { buildPlanImplementationMessage } from "../utils";
import { syncPermissionRulesToClaudeSettings } from "../../settings-manager/utils";
import { computePlanFilePath } from "../../../paths";

/** Write the approved plan to a session's deterministic plan path, creating the plans dir if needed. */
async function writePlanFile(planFilePath: string, planContent: string): Promise<void> {
  await fs.mkdir(path.dirname(planFilePath), { recursive: true });
  await fs.writeFile(planFilePath, planContent);
}

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
        // Independent copy: the planning session keeps its own plan file (written here, before the session
        // swap), and the continuation session gets its own (written below, right after the swap completes
        // and before its first turn). No stored path bridge — each computes deterministically.
        await writePlanFile(ctx.session.getPlanFilePath(), msg.planContent);

        ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, false, {
          feedback: "User chose to clear context and start fresh",
        });

        const persistenceId = ctx.session.persistenceSessionId;
        const transcriptPath = persistenceId
          ? await resolveSessionFilePath(workspacePath, persistenceId)
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
        // Wait only for the session swap (NOT the whole implementation turn), then write the continuation
        // plan file immediately — so "view session plan" works the moment the new session is created, not
        // only after streaming finishes. `newMessage` is the continuation's first user message, so its path
        // equals resolvePlanFilePath(metadata.id, metadata.preview); compute it directly (the branch isn't
        // committed yet at this point, so getPlanFilePath would still slug to `plan`).
        await ctx.session.whenReplaced?.();
        const continuationId = ctx.session.currentSessionId;
        if (continuationId) {
          await writePlanFile(computePlanFilePath(continuationId, newMessage), msg.planContent);
        }

        await ctx.session.sendMessage(newMessage, undefined, correlationId);

        return;
      }

      ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, msg.approved, {
        ...(msg.approvalMode !== undefined ? { approvalMode: msg.approvalMode } : {}),
        ...(msg.feedback !== undefined ? { feedback: msg.feedback } : {}),
      });

      // Guaranteed write: the approved plan is authoritative (the model's live file may differ).
      if (msg.approved && msg.planContent) {
        await writePlanFile(ctx.session.getPlanFilePath(), msg.planContent);
      }

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
