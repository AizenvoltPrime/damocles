import { nextTick } from "vue";
import { toast } from "vue-sonner";
import { applyLocale, i18n } from "@/i18n";
import type { HandlerRegistry, ScrollBehavior } from "../types";

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

    panelFocused: (_msg, ctx): ScrollBehavior => {
      nextTick(() => {
        ctx.refs.chatInputRef.value?.focus();
      });
      return { skipScroll: true };
    },

    ideContextUpdate: (msg, ctx) => {
      ctx.stores.uiStore.setIdeContext(msg.context);
    },

    languageChange: (msg) => {
      applyLocale(msg.locale);
    },

    showPlanContent: (msg, ctx) => {
      ctx.stores.planViewStore.setViewingPlan(msg.content, msg.filePath);
    },

    tokenUsageUpdate: (msg, ctx) => {
      ctx.stores.sessionStore.updateStats({
        totalInputTokens: msg.inputTokens,
        cacheCreationTokens: msg.cacheCreationTokens,
        cacheReadTokens: msg.cacheReadTokens,
      });
    },

    tasksUpdate: (msg, ctx) => {
      ctx.stores.taskStore.handleTaskList({ tasks: msg.tasks });
    },

    interruptRecovery: (msg, ctx) => {
      const { streamingStore } = ctx.stores;
      const { refs } = ctx;
      const removedContent = streamingStore.removeMessageByCorrelationId(msg.correlationId);
      const contentToRecover = removedContent ?? msg.promptContent;
      if (contentToRecover) {
        refs.chatInputRef.value?.setInput(contentToRecover);
        toast.info(i18n.global.t("toast.interrupted"));
      }
    },

    sessionStart: () => {},

    sessionEnd: () => {},

    contextUsage: () => {},

    preCompact: () => {},

    supportedCommands: () => {},

    workspaceFiles: () => {},

    customSlashCommands: () => {},

    customAgents: () => {},

    statusUpdate: (msg, ctx) => {
      const { uiStore, settingsStore } = ctx.stores;
      uiStore.setCompacting(msg.status === "compacting");
      if (msg.permissionMode) {
        settingsStore.setPermissionMode(msg.permissionMode as "plan" | "default" | "acceptEdits");
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
