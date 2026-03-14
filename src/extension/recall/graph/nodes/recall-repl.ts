import type { RecallGraphState } from '../recall-graph-state';
import type { NodeExecutionContext } from '../types';
import { runRecallLoop } from '../../recall-loop';
import type { RecallConfig, RecallIteration } from '../../types';

export interface RecallReplNodeDeps {
  config: RecallConfig;
  cwd: string;
  model: string;
  onIteration?: (iteration: RecallIteration) => void;
}

export function createRecallReplNode(deps: RecallReplNodeDeps) {
  return async function recallReplNode(
    state: Readonly<RecallGraphState>,
    context: NodeExecutionContext,
  ): Promise<Partial<RecallGraphState>> {
    const { context: recallContext, trajectory } = await runRecallLoop(
      state.history,
      state.userPrompt,
      state.promptIndex,
      {
        config: deps.config,
        cwd: deps.cwd,
        model: deps.model,
        abortSignal: context.abortSignal,
        intentContext: {
          intent: state.intent,
          keyEntities: state.keyEntities,
        },
        onIteration: deps.onIteration,
      },
    );

    return { recallContext, recallTrajectory: trajectory };
  };
}
