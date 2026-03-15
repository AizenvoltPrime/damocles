import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { UserContentBlock } from "../../../../shared/types/content";
import type { MemoryTier, MemoryEntry } from "../../../../shared/types/memory";
import { createQueuedMessage } from "../../queue-manager";
import { extractTextFromContent, hasImageContent } from "../../../../shared/utils";
import { SDK_SKILL_NAMES, SDK_DIRECT_COMMANDS } from "../../../../shared/slashCommands";
import { getBatchPrompt, BATCH_HELP_TEXT, BATCH_NO_GIT_TEXT } from "../../../../shared/batch-prompt";
import { log } from "../../../logger";
import { isRecallSession } from "../../../recall/history-builder";
import { broadcastNodeState } from "./node-handlers";
import { exec } from "child_process";

export function createChatHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, workspaceManager } = deps;

  return {
    sendMessage: async (msg, ctx) => {
      if (msg.type !== "sendMessage") return;

      const msgContent = msg.content;
      const originalTextContent = extractTextFromContent(msgContent);
      if (!originalTextContent.trim() && !hasImageContent(msgContent)) return;

      const memoryMatch = originalTextContent.trim().match(/^\/(remember|note|memories)(?:\s+(.*))?$/);
      if (memoryMatch) {
        const [, command, rawArg] = memoryMatch;
        const arg = rawArg?.trim() ?? '';
        const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        postMessage(ctx.host, { type: "userMessage", content: originalTextContent, correlationId });

        if (command === 'memories') {
          postMessage(ctx.host, { type: 'openMemoryPanel' });
          return;
        }

        if (!deps.memoryService?.isEnabled) {
          postMessage(ctx.host, { type: 'memoryError', message: 'Memory system is not available' });
          return;
        }

        if (command === 'remember' && arg) {
          let tier: MemoryTier = 'session';
          let content = arg;

          if (arg.startsWith('global:')) {
            tier = 'global';
            content = arg.slice('global:'.length).trim();
          } else if (arg.startsWith('project:')) {
            tier = 'project';
            content = arg.slice('project:'.length).trim();
          }

          if (!content) return;

          let memory: MemoryEntry | null = null;
          if (tier === 'session') memory = deps.memoryService.addSessionMemory(ctx.session.memorySessionId, content);
          else if (tier === 'project') memory = deps.memoryService.addProjectMemory(deps.workspacePath, content);
          else memory = deps.memoryService.addGlobalMemory(content);

          if (memory) {
            postMessage(ctx.host, { type: 'memoryCreated', memory });
          }
          return;
        }

        if (command === 'note' && arg) {
          const note = deps.memoryService.addNote(arg);
          if (note) {
            postMessage(ctx.host, { type: 'memoryCreated', memory: note });
          }
          return;
        }
        return;
      }

      let transformedContent: string | null = null;
      let preApprovedSkillName: string | null = null;
      const skillMatch = originalTextContent.trim().match(/^\/([a-zA-Z0-9_:-]+)(?:\s+(.*))?$/);
      if (skillMatch) {
        const [, skillName, skillArgs] = skillMatch;
        if (skillName) {
          if (SDK_DIRECT_COMMANDS.has(skillName)) {
            const result = await resolveDirectCommand(skillName, skillArgs?.trim(), deps.workspacePath);
            if (result.kind === "notification") {
              const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              postMessage(ctx.host, { type: "userMessage", content: originalTextContent, correlationId });
              postMessage(ctx.host, { type: "notification", message: result.content, notificationType: "info" });
              return;
            }
            transformedContent = result.content;
          } else {
            const enabledPluginIds = settingsManager.getEnabledPluginIds();
            const isSkill = await workspaceManager.isSkill(skillName, enabledPluginIds);
            if (isSkill || SDK_SKILL_NAMES.has(skillName)) {
              ctx.permissionHandler.preApproveSkill(skillName);
              preApprovedSkillName = skillName;
              transformedContent = skillArgs
                ? `Execute skill ${skillName}\nAdditional info: ${skillArgs}`
                : `Execute skill ${skillName}`;
            }
          }
        }
      }

      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const contentBlocks = hasImageContent(msgContent) ? (msgContent as UserContentBlock[]) : undefined;
      postMessage(ctx.host, { type: "userMessage", content: originalTextContent, ...(contentBlocks !== undefined ? { contentBlocks } : {}), correlationId });

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
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      postMessage(ctx.host, { type: "conversationCleared" });
    },

    queueMessage: async (msg, ctx) => {
      if (msg.type !== "queueMessage") return;

      const msgContent = msg.content;
      const textContent = extractTextFromContent(msgContent);
      if (!textContent.trim() && !hasImageContent(msgContent)) return;

      const queuedMessage = createQueuedMessage(msgContent);
      const injected = ctx.session.queueInput(msgContent, queuedMessage.id);

      if (injected) {
        postMessage(ctx.host, { type: "messageQueued", message: queuedMessage });
        if (textContent.trim()) {
          storageManager.broadcastPromptHistoryEntry(textContent.trim());
        }
      } else {
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Cannot send mid-stream message: no active streaming session"),
          notificationType: "error",
        });
      }
    },

    resumeSession: async (msg, ctx) => {
      if (msg.type !== "resumeSession" || !msg.sessionId) return;

      const isRecall = await isRecallSession(deps.workspacePath, msg.sessionId);
      const currentStrategy = settingsManager.getActiveStrategyForPanel(ctx.panelId);
      const currentIsRecall = currentStrategy === "recall";

      if (isRecall !== currentIsRecall) {
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t(
            "Cannot load a {0} session in {1} mode",
            isRecall ? "recall" : "normal",
            currentIsRecall ? "recall" : "normal",
          ),
          notificationType: "warning",
        });
        return;
      }

      if (isRecall) {
        await ctx.session.setRecallSession(msg.sessionId);
      } else {
        ctx.session.setResumeSession(msg.sessionId);
      }

      try {
        await deps.historyManager.loadSessionHistory(msg.sessionId, ctx.host);
        postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.sessionId });
      } catch (err) {
        log("[MessageRouter] Error loading session history:", err);
        postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.sessionId });
      }

      if (isRecall) {
        broadcastNodeState(ctx, postMessage);
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

type DirectCommandResult =
  | { kind: "prompt"; content: string }
  | { kind: "notification"; content: string };

function isGitRepo(workspacePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec("git rev-parse --is-inside-work-tree", { cwd: workspacePath, timeout: 5000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === "true");
    });
  });
}

async function resolveDirectCommand(
  commandName: string,
  args: string | undefined,
  workspacePath: string,
): Promise<DirectCommandResult> {
  if (commandName === "batch") {
    if (!args) return { kind: "notification", content: BATCH_HELP_TEXT };
    if (!await isGitRepo(workspacePath)) return { kind: "notification", content: BATCH_NO_GIT_TEXT };
    return { kind: "prompt", content: getBatchPrompt(args) };
  }
  return { kind: "notification", content: `Unknown command: ${commandName}` };
}
