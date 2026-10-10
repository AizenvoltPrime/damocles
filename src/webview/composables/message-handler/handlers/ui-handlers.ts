import { nextTick } from "vue";
import { toast } from "vue-sonner";
import { applyLocale, i18n } from "@/i18n";
import { useUsageStatsStore } from "@/stores/useUsageStatsStore";
import { useBindPlanStore } from "@/stores/useBindPlanStore";
import type { PermissionMode } from "@shared/types/settings";
import type { HandlerRegistry } from "../types";
import { nestedTranscript } from "./nested-transcript";

export function createUIHandlers(): Partial<HandlerRegistry> {
  return {
    notification: (msg) => {
      switch (msg.notificationType) {
        case "success":
          toast.success(msg.message);
          break;
        case "error":
          toast.error(msg.message);
          break;
        case "warning":
          toast.warning(msg.message);
          break;
        default:
          toast.info(msg.message);
      }
    },

    panelFocused: (_msg, ctx) => {
      nextTick(() => {
        ctx.refs.chatInputRef.value?.focus();
      });
    },

    ideContextUpdate: (msg, ctx) => {
      ctx.stores.uiStore.setIdeContext(msg.context);
    },

    terminalAttachmentsUpdate: (msg, ctx) => {
      ctx.stores.uiStore.setTerminalAttachments(msg.attachments);
      // Add to Chat is the user's action, and the host has already focused this chat's page.
      if (msg.focusComposer) void nextTick(() => ctx.refs.chatInputRef.value?.focus());
    },

    terminalShown: (msg, ctx) => {
      ctx.stores.uiStore.terminalShown = msg.shown;
      ctx.stores.uiStore.toggleTerminalShortcut = msg.shortcut;
    },

    languageChange: (msg) => {
      applyLocale(msg.locale);
    },

    showPlanContent: (msg, ctx) => {
      ctx.stores.planViewStore.setViewingPlan(msg.content, msg.filePath);
    },

    planFileCandidates: (msg) => {
      useBindPlanStore().setCandidates(msg.files, msg.hasPlan, msg.listFailed === true);
    },

    tokenUsageUpdate: (msg, ctx) => {
      ctx.stores.sessionStore.updateStats({
        ...(msg.inputTokens !== undefined && { contextInputTokens: msg.inputTokens }),
        ...(msg.cacheCreationTokens !== undefined && { contextCacheWriteTokens: msg.cacheCreationTokens }),
        ...(msg.cacheReadTokens !== undefined && { contextCacheReadTokens: msg.cacheReadTokens }),
      });
    },

    sessionUsage: (msg, ctx) => {
      ctx.stores.sessionStore.updateStats({ ...msg.usage, numTurns: msg.numTurns });
    },

    contextUsageSummary: (msg, ctx) => {
      ctx.stores.sessionStore.updateStats({
        contextTotalTokens: msg.totalTokens,
        contextMaxTokens: msg.maxTokens,
        contextPercentage: msg.percentage,
      });
    },

    interruptRecovery: (msg, ctx) => {
      ctx.stores.streamingStore.removeMessageByCorrelationId(msg.correlationId);
      // A prompt stopped before its echo has no message to recover from, so the content comes from the host.
      const blocks = msg.contentBlocks ?? (msg.promptContent ? [{ type: "text" as const, text: msg.promptContent }] : []);
      if (blocks.length === 0) return;
      ctx.refs.chatInputRef.value?.restoreQueued(blocks);
      toast.info(i18n.global.t("toast.interrupted"));
    },

    sessionStart: () => {},

    sessionEnd: () => {},

    contextUsage: (msg, ctx) => {
      ctx.stores.contextUsageStore.handleDataLoaded(msg.data, msg.reason);
    },

    subscriptionUsage: (msg, ctx) => {
      ctx.stores.subscriptionUsageStore.handleDataLoaded(msg.data);
    },

    usageStats: (msg) => {
      useUsageStatsStore().handleResult(msg);
    },

    usageStatsProgress: (msg) => {
      useUsageStatsStore().handleProgress(msg);
    },

    preCompact: () => {},

    supportedCommands: () => {},

    workspaceFiles: () => {},

    customSlashCommands: () => {},

    customAgents: () => {},

    statusUpdate: (msg, ctx) => {
      const { uiStore, settingsStore } = ctx.stores;
      // A nested agent's retry wait is its own card's, never the main status bar's.
      if (msg.parentToolUseId !== undefined) {
        nestedTranscript(ctx.stores, msg.parentToolUseId)?.setRetry(msg.status === "retrying" ? { attempt: msg.attempt, maxAttempts: msg.maxAttempts } : null);
        return;
      }
      uiStore.setCompacting(msg.status === "compacting");
      if (msg.status === "retrying") {
        uiStore.setRetryStatus({ attempt: msg.attempt, maxAttempts: msg.maxAttempts });
        return;
      }
      uiStore.setRetryStatus(null);
      if (msg.permissionMode) {
        settingsStore.setPermissionMode(msg.permissionMode as PermissionMode);
      }
    },

    filesPersisted: (_msg, ctx) => {
      ctx.stores.uiStore.setLastCheckpointTime(Date.now());
    },

    hookLifecycle: (msg, ctx) => {
      const { uiStore } = ctx.stores;
      if (msg.phase === "started") {
        uiStore.setHookActive(msg.hookId, msg.hookName, msg.hookEvent);
      } else if (msg.phase === "response") {
        uiStore.removeHook(msg.hookId);
      }
    },
  };
}
