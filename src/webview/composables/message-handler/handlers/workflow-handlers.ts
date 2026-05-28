import { useWorkflowStore } from '@/stores/useWorkflowStore';
import type { HandlerRegistry } from '../types';

export function createWorkflowHandlers(): Partial<HandlerRegistry> {
  return {
    workflowResult: (msg) => {
      useWorkflowStore().applyResult(msg.toolUseId, {
        taskId: msg.taskId,
        status: msg.status,
        summary: msg.summary,
        result: msg.result,
        outputFile: msg.outputFile,
        ...(msg.transcriptDir ? { transcriptDir: msg.transcriptDir } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
      });
    },

    workflowTranscripts: (msg) => {
      useWorkflowStore().setTranscripts(msg.toolUseId, msg.agents, msg.seq, msg.error);
    },
  };
}
