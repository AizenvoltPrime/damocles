import * as vscode from "vscode";
import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { UserContentBlock } from "../../../../shared/types/content";
import type { ContentInput } from "../../../claude-session/types";
import type { MemoryTier, MemoryEntry } from "../../../../shared/types/memory";
import { createQueuedMessage } from "../../queue-manager";
import { extractTextFromContent, hasImageContent } from "../../../../shared/utils";
import { SDK_SKILL_NAMES, SDK_DIRECT_COMMANDS } from "../../../../shared/slashCommands";
import { getBatchPrompt, BATCH_HELP_TEXT, BATCH_NO_GIT_TEXT } from "../../../../shared/batch-prompt";
import { log } from "../../../logger";
import { isRecallSession } from "../../../recall/history-builder";
import { broadcastNodeState } from "./node-handlers";
import { buildUserMessagePayload } from "../../../claude-session/user-message-payload";
import { exec } from "child_process";

function stampUserMessage(
  ctx: HandlerContext,
  content: string,
  opts: { contentBlocks?: UserContentBlock[]; correlationId: string; isInjected?: boolean },
) {
  const recallService = ctx.session.recallService;
  return buildUserMessagePayload(
    {
      ...(recallService !== undefined ? { recallService } : {}),
      memoryPromptIndex: ctx.session.currentPromptIndex,
    },
    content,
    opts,
  );
}

type InterceptResult =
  | { kind: "handled" }
  | { kind: "passthrough"; transformedContent: string | null; preApprovedSkillName: string | null };

const AUTH_SLASH_RE = /^\/(login|logout)\s*$/;
const MEMORY_SLASH_RE = /^\/(remember|note|memories)(?:\s+(.*))?$/;
const ANY_SLASH_RE = /^\/([a-zA-Z0-9_:-]+)(?:\s+(.*))?$/;

export function createChatHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, workspaceManager, markUserTypedDuringTurn } = deps;

  const tryInterceptLocal = async (
    originalTextContent: string,
    ctx: HandlerContext,
  ): Promise<InterceptResult> => {
    const trimmed = originalTextContent.trim();

    const authMatch = trimmed.match(AUTH_SLASH_RE);
    if (authMatch) {
      const [, command] = authMatch;
      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      postMessage(ctx.host, stampUserMessage(ctx, originalTextContent, { correlationId, isInjected: true }));
      const commandId = command === "login" ? "damocles.signIn" : "damocles.signOut";
      await vscode.commands.executeCommand(commandId);
      return { kind: "handled" };
    }

    const memoryMatch = trimmed.match(MEMORY_SLASH_RE);
    if (memoryMatch) {
      const [, command, rawArg] = memoryMatch;
      const arg = rawArg?.trim() ?? "";
      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      postMessage(ctx.host, stampUserMessage(ctx, originalTextContent, { correlationId, isInjected: true }));

      if (command === "memories") {
        postMessage(ctx.host, { type: "openMemoryPanel" });
        return { kind: "handled" };
      }

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return { kind: "handled" };
      }

      // Memory uses two-phase lazy init; warm it before the synchronous add calls so the first
      // `/remember` (or `/note`) of a session isn't silently dropped against a null manager.
      await deps.memoryService.ensureInitialized();

      if (command === "remember" && arg) {
        let tier: MemoryTier = "session";
        let content = arg;
        if (arg.startsWith("global:")) {
          tier = "global";
          content = arg.slice("global:".length).trim();
        } else if (arg.startsWith("project:")) {
          tier = "project";
          content = arg.slice("project:".length).trim();
        }
        if (!content) return { kind: "handled" };

        let memory: MemoryEntry | null = null;
        if (tier === "session") memory = deps.memoryService.addSessionMemory(ctx.session.memorySessionId, content);
        else if (tier === "project") memory = deps.memoryService.addProjectMemory(deps.workspacePath, content);
        else memory = deps.memoryService.addGlobalMemory(content);

        if (memory) postMessage(ctx.host, { type: "memoryCreated", memory });
        return { kind: "handled" };
      }

      if (command === "note" && arg) {
        const note = deps.memoryService.addNote(arg);
        if (note) postMessage(ctx.host, { type: "memoryCreated", memory: note });
        return { kind: "handled" };
      }
      return { kind: "handled" };
    }

    let transformedContent: string | null = null;
    let preApprovedSkillName: string | null = null;
    const skillMatch = trimmed.match(ANY_SLASH_RE);
    if (skillMatch) {
      const [, skillName, skillArgs] = skillMatch;
      if (skillName) {
        if (SDK_DIRECT_COMMANDS.has(skillName)) {
          const result = await resolveDirectCommand(skillName, skillArgs?.trim(), deps.workspacePath);
          if (result.kind === "notification") {
            const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            postMessage(ctx.host, stampUserMessage(ctx, originalTextContent, { correlationId, isInjected: true }));
            postMessage(ctx.host, { type: "notification", message: result.content, notificationType: "info" });
            return { kind: "handled" };
          }
          transformedContent = result.content;
        } else {
          const isSkill = await workspaceManager.isSkill(skillName);
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

    return { kind: "passthrough", transformedContent, preApprovedSkillName };
  };

  return {
    sendMessage: async (msg, ctx) => {
      if (msg.type !== "sendMessage") return;

      const msgContent = msg.content;
      const originalTextContent = extractTextFromContent(msgContent);
      if (!originalTextContent.trim() && !hasImageContent(msgContent)) return;

      if (markUserTypedDuringTurn !== undefined) markUserTypedDuringTurn();

      const intercept = await tryInterceptLocal(originalTextContent, ctx);
      if (intercept.kind === "handled") {
        // The command was handled locally and no turn will run, so the processing spinner the
        // webview optimistically armed on send has no lifecycle event to clear it. Authoritatively
        // disarm it here — the extension is the single source of truth for whether a turn started.
        postMessage(ctx.host, { type: "processing", isProcessing: false });
        return;
      }

      const { transformedContent, preApprovedSkillName } = intercept;

      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const contentBlocks = hasImageContent(msgContent) ? (msgContent as UserContentBlock[]) : undefined;

      if (originalTextContent.trim()) {
        storageManager.broadcastPromptHistoryEntry(originalTextContent.trim());
      }

      const baseContent = transformedContent ?? msgContent;
      const finalContent = msg.includeIdeContext ? ctx.ideContextManager.buildContentBlocks(baseContent) : baseContent;

      try {
        await ctx.session.sendMessage(finalContent, msg.agentId, correlationId, {
          content: originalTextContent,
          ...(contentBlocks !== undefined ? { contentBlocks } : {}),
        });
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

      if (markUserTypedDuringTurn !== undefined) markUserTypedDuringTurn();

      const intercept = await tryInterceptLocal(textContent, ctx);
      if (intercept.kind === "handled") return;

      const { transformedContent, preApprovedSkillName } = intercept;
      const contentToQueue: ContentInput = transformedContent ?? msgContent;

      const queuedMessage = createQueuedMessage(contentToQueue);
      const disposition = ctx.session.queueInput(contentToQueue, queuedMessage.id);

      if (disposition === "queued") {
        postMessage(ctx.host, { type: "messageQueued", message: queuedMessage });
        if (textContent.trim()) {
          storageManager.broadcastPromptHistoryEntry(textContent.trim());
        }
      } else if (disposition === "flushed") {
        if (textContent.trim()) {
          storageManager.broadcastPromptHistoryEntry(textContent.trim());
        }
      } else {
        if (preApprovedSkillName) {
          ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        }
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
        await ctx.session.emitExploreHistory(msg.sessionId);
        await deps.historyManager.loadSessionHistory(msg.sessionId, ctx.host);
        const rewindableIds = await deps.historyManager.extractRewindableUserIds(msg.sessionId);
        ctx.session.seedCheckpoints(rewindableIds);
        postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.sessionId });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
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
