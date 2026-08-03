import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { resolveSessionFilePath } from "../../session-file-path";
import { buildPlanImplementationMessage } from "../utils";
import { syncPermissionRulesToClaudeSettings } from "../../settings-manager/utils";
import { computePlanFilePath } from "../../../paths";
import { log } from "../../../logger";

/** Write the approved plan to a session's deterministic plan path, creating the plans dir if needed. */
async function writePlanFile(planFilePath: string, planContent: string): Promise<void> {
  await fs.mkdir(path.dirname(planFilePath), { recursive: true });
  await fs.writeFile(planFilePath, planContent);
}

/** Shown to the user and fed back to the model when a clear-context approval finds no plan file to hand
 *  off (a should-be-unreachable state, since ExitPlanMode is blocked when no plan file exists). Single
 *  source so the user toast and the model feedback can't drift. */
const PLAN_FILE_UNAVAILABLE_MESSAGE = "Plan file no longer available — please re-run the plan.";

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

    answerForm: (msg, ctx) => {
      if (msg.type !== "answerForm") return;
      // Forwards the in-process form answer (values keyed by field.id, or null on cancel) to FormManager.
      // The `values` payload is never logged here or in the message-router core (it logs only message.type).
      ctx.permissionHandler.resolveForm(msg.toolUseId, msg.values);
    },

    approvePlan: async (msg, ctx) => {
      if (msg.type !== "approvePlan") return;

      if (msg.clearContext && msg.approved) {
        // The plan file on disk is the single source of truth — read it (captured before the swap) and
        // hand the FULL plan to the continuation session. The planning session's own plan file already
        // holds the full plan (block-on-no-file guarantees it exists), so it is never overwritten here.
        // This is the SECOND read of the plan file (the first was at overlay-render time in
        // PlanManager.handleExitPlanMode). Re-reading here is deliberate: it picks up any edit the user
        // made to the plan file while the approval overlay was open. Safe because the agent is paused on
        // the pending ExitPlanMode approval between the two reads, so no turn can mutate the file.
        const fullPlan = await ctx.session.getPlanContent();
        if (!fullPlan) {
          // Should be unreachable (ExitPlanMode is blocked when no plan file exists). Never persist empty
          // content: skip the swap and tell the user to re-run the plan.
          log("[approvePlan] clear-context: getPlanContent returned null; skipping swap");
          ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, false, {
            feedback: PLAN_FILE_UNAVAILABLE_MESSAGE,
          });
          vscode.window.showInformationMessage(vscode.l10n.t(PLAN_FILE_UNAVAILABLE_MESSAGE));
          return;
        }

        ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, false, {
          feedback: "User chose to clear context and start fresh",
        });

        const persistenceId = ctx.session.persistenceSessionId;
        const transcriptPath = persistenceId
          ? await resolveSessionFilePath(workspacePath, persistenceId)
          : null;

        const newMessage = buildPlanImplementationMessage(fullPlan, transcriptPath);
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
        await ctx.session.whenReplaced();
        const continuationId = ctx.session.currentSessionId;
        if (continuationId) {
          await writePlanFile(computePlanFilePath(continuationId, newMessage), fullPlan);
        }

        await ctx.session.sendMessage(newMessage, undefined, correlationId);

        return;
      }

      ctx.permissionHandler.resolvePlanApproval(msg.toolUseId, msg.approved, {
        ...(msg.approvalMode !== undefined ? { approvalMode: msg.approvalMode } : {}),
        ...(msg.feedback !== undefined ? { feedback: msg.feedback } : {}),
      });

      // The model's plan file already holds the full plan (it is the authoritative source); nothing to
      // write on normal approve.

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
