import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';
import type { HandlerRegistry, ScrollBehavior } from '../types';

export function createBackgroundTaskHandlers(): Partial<HandlerRegistry> {
  const { t } = useI18n();

  return {
    backgroundTaskStarted: (msg, ctx) => {
      ctx.stores.backgroundTaskStore.handleTaskStarted(msg.task);
    },

    backgroundTaskCompleted: (msg, ctx) => {
      if (ctx.stores.backgroundTaskStore.handleTaskCompleted(msg.taskId, msg.status)) {
        const key = msg.status === 'completed' ? 'taskCompleted' : msg.status === 'failed' ? 'taskFailed' : 'taskStopped';
        toast.info(t(`backgroundTask.${key}`));
      }
    },

    backgroundTaskResult: (msg, ctx): ScrollBehavior => {
      const { streamingStore, subagentStore } = ctx.stores;
      const description = subagentStore.getSubagentDescription(msg.toolUseId) ?? msg.summary;
      streamingStore.addMessage({
        role: 'assistant',
        content: msg.result,
        timestamp: Date.now(),
        isBackgroundResult: true,
        backgroundTaskLabel: description,
      });
      return { forceScrollToBottom: true };
    },
  };
}
