import { createEmptyStreamingContent } from '../../types';
import type { ProcessorContext, ProcessorDependencies, MessageProcessor } from '../types';
import { DEFAULT_CONTEXT_WINDOW } from '../../../../shared/types/constants';

interface ResultMessage {
  subtype?: string;
  session_id: string;
  is_error?: boolean;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  num_turns?: number;
  modelUsage?: Record<string, { contextWindow?: number }>;
  fast_mode_state?: 'off' | 'cooldown' | 'on';
}

export function createResultProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (
    message: Record<string, unknown>,
    ctx: ProcessorContext,
  ): void => {
    const { state } = ctx;
    const { callbacks, toolManager, checkpointTracker } = deps;
    const budgetLimit = state.budgetLimit;

    if (state.isStaleQuery()) return;

    const resultMsg = message as unknown as ResultMessage;

    if (resultMsg.total_cost_usd) {
      checkpointTracker.updateCost(resultMsg.total_cost_usd);
    }

    if (resultMsg.subtype === 'error_max_budget_usd' && budgetLimit) {
      callbacks.onMessage({
        type: 'budgetExceeded',
        finalSpend: resultMsg.total_cost_usd || 0,
        limit: budgetLimit,
      });
    }

    if (budgetLimit && resultMsg.total_cost_usd) {
      const percentUsed = (resultMsg.total_cost_usd / budgetLimit) * 100;
      if (percentUsed >= 80 && percentUsed < 100) {
        callbacks.onMessage({
          type: 'budgetWarning',
          currentSpend: resultMsg.total_cost_usd,
          limit: budgetLimit,
          percentUsed,
        });
      }
    }

    ctx.flushPendingAssistant();

    const contextWindowSize = resultMsg.modelUsage
      ? (Object.values(resultMsg.modelUsage)[0]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
      : DEFAULT_CONTEXT_WINDOW;

    checkpointTracker.setContextWindowSize(contextWindowSize);

    callbacks.onMessage({
      type: 'done',
      data: {
        type: 'result',
        session_id: resultMsg.session_id,
        is_done: !resultMsg.is_error,
        ...(resultMsg.total_cost_usd !== undefined ? { total_cost_usd: resultMsg.total_cost_usd } : {}),
        ...(resultMsg.usage?.output_tokens !== undefined ? { total_output_tokens: resultMsg.usage.output_tokens } : {}),
        ...(resultMsg.num_turns !== undefined ? { num_turns: resultMsg.num_turns } : {}),
        context_window_size: contextWindowSize,
        stop_reason: resultMsg.stop_reason ?? null,
      },
    });

    if (resultMsg.fast_mode_state) {
      callbacks.onMessage({
        type: 'fastModeStateUpdate',
        state: resultMsg.fast_mode_state,
      });
    }

    deps.recallService?.onResponseComplete();

    if (deps.recallService?.isEnabled && !resultMsg.is_error && !state.streamingContent.parentToolUseId) {
      const nm = deps.recallService.getNodeManager();
      const activeNodeId = nm.getNodeState().activeNodeId;
      if (activeNodeId) {
        const node = nm.getNodeById(activeNodeId);
        if (node) {
          callbacks.onMessage({
            type: 'show-node-close-prompt',
            nodeId: node.nodeId,
            title: node.title,
          });
        }
      }
    }

    toolManager.resetTurn();
    state.streamingContent = createEmptyStreamingContent();

    state.fireTurnComplete();
    const flushed = state.fireTurnEndFlush();
    if (!flushed) {
      state.setProcessing(false);
    }
  };

  return { result: handler };
}
