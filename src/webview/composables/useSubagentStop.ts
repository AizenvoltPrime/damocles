import type { BackgroundTask } from '@shared/types/background-tasks';
import type { SubagentState } from '@shared/types/subagents';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { usePlatformBridge } from './usePlatformBridge';

export interface SubagentStop {
  /** Running or queued, with the record id core announced; a card shows `running` for both. */
  canStop: (subagent: SubagentState) => boolean;
  isStopping: (subagent: SubagentState) => boolean;
  /** A task's own status is the authority, so a task with no card in this panel still shows its stop. */
  isTaskStopping: (task: BackgroundTask) => boolean;
  stop: (agentId: string) => void;
}

/** The user's Stop of one subagent, shared by its card, its overlay and the Background Tasks overlay. */
export function useSubagentStop(): SubagentStop {
  const store = useSubagentStore();
  const { postMessage } = usePlatformBridge();

  function canStop(subagent: SubagentState): boolean {
    return subagent.status === 'running' && subagent.sdkAgentId !== undefined;
  }

  function isStopping(subagent: SubagentState): boolean {
    return subagent.status === 'running' && subagent.sdkAgentId !== undefined && store.isStopRequested(subagent.sdkAgentId);
  }

  function isTaskStopping(task: BackgroundTask): boolean {
    return task.status === 'running' && store.isStopRequested(task.taskId);
  }

  function stop(agentId: string): void {
    if (store.isStopRequested(agentId)) return;
    store.markStopRequested(agentId);
    postMessage({ type: 'stopSubagent', agentId });
  }

  return { canStop, isStopping, isTaskStopping, stop };
}
