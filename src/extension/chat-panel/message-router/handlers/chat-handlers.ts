import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { UserContentBlock } from "../../../../shared/types/content";
import { createQueuedMessage } from "../../queue-manager";
import { extractTextFromContent, hasImageContent } from "../../../../shared/utils";
import { log } from "../../../logger";

export function createChatHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, workspaceManager } = deps;

  return {
    sendMessage: async (msg, ctx) => {
      if (msg.type !== "sendMessage") return;

      const msgContent = msg.content;
      const originalTextContent = extractTextFromContent(msgContent);
      if (!originalTextContent.trim() && !hasImageContent(msgContent)) return;

      let transformedContent: string | null = null;
      let preApprovedSkillName: string | null = null;
      const skillMatch = originalTextContent.trim().match(/^\/([a-zA-Z0-9_:-]+)(?:\s+(.*))?$/);
      if (skillMatch) {
        const [, skillName, skillArgs] = skillMatch;
        if (skillName) {
          const enabledPluginIds = settingsManager.getEnabledPluginIds();
          const isSkill = await workspaceManager.isSkill(skillName, enabledPluginIds);
          if (isSkill) {
            ctx.permissionHandler.preApproveSkill(skillName);
            preApprovedSkillName = skillName;
            transformedContent = skillArgs
              ? `Execute skill ${skillName}\nAdditional info: ${skillArgs}`
              : `Execute skill ${skillName}`;
          }
        }
      }

      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const contentBlocks = hasImageContent(msgContent) ? (msgContent as UserContentBlock[]) : undefined;
      postMessage(ctx.panel, { type: "userMessage", content: originalTextContent, ...(contentBlocks !== undefined ? { contentBlocks } : {}), correlationId });

      if (originalTextContent.trim()) {
        storageManager.broadcastPromptHistoryEntry(originalTextContent.trim());
      }

      const baseContent = transformedContent ?? msgContent;
      const finalContent = msg.includeIdeContext ? ctx.ideContextManager.buildContentBlocks(baseContent) : baseContent;

      try {
        await ctx.session.sendMessage(finalContent, msg.agentId, correlationId);
      } catch (err) {
        if (preApprovedSkillName) {
          ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        }
        throw err;
      }
    },

    cancelSession: (_msg, ctx) => {
      ctx.session.cancel();
    },

    clearSession: async (_msg, ctx) => {
      ctx.session.clear();
      ctx.permissionHandler.setDangerouslySkipPermissions(false);
      ctx.permissionHandler.clearSubagentAutoApprovals();
      await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);
      postMessage(ctx.panel, { type: "conversationCleared" });
    },

    queueMessage: async (msg, ctx) => {
      if (msg.type !== "queueMessage") return;

      const msgContent = msg.content;
      const textContent = extractTextFromContent(msgContent);
      if (!textContent.trim() && !hasImageContent(msgContent)) return;

      const queuedMessage = createQueuedMessage(msgContent);
      const injected = ctx.session.queueInput(msgContent, queuedMessage.id);

      if (injected) {
        postMessage(ctx.panel, { type: "messageQueued", message: queuedMessage });
        if (textContent.trim()) {
          storageManager.broadcastPromptHistoryEntry(textContent.trim());
        }
      } else {
        postMessage(ctx.panel, {
          type: "notification",
          message: vscode.l10n.t("Cannot send mid-stream message: no active streaming session"),
          notificationType: "error",
        });
      }
    },

    resumeSession: async (msg, ctx) => {
      if (msg.type !== "resumeSession" || !msg.sessionId) return;

      ctx.session.setResumeSession(msg.sessionId);

      try {
        await deps.historyManager.loadSessionHistory(msg.sessionId, ctx.panel);
        postMessage(ctx.panel, { type: "sessionStarted", sessionId: msg.sessionId });
      } catch (err) {
        log("[MessageRouter] Error loading session history:", err);
        postMessage(ctx.panel, { type: "sessionStarted", sessionId: msg.sessionId });
      }
    },

    interrupt: async (_msg, ctx) => {
      await ctx.session.interrupt();
    },

    cancelAutoCompact: async (_msg, ctx) => {
      await ctx.session.cancelAutoCompact();
    },
  };
}
