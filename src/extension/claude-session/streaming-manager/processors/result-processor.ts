import { createEmptyStreamingContent } from '../../types';
import type { ProcessorContext, ProcessorDependencies, MessageProcessor, ResultProcessorExtra } from '../types';

interface ResultMessage {
  subtype?: string;
  session_id: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  num_turns?: number;
  modelUsage?: Record<string, { contextWindow?: number }>;
}

export function createResultProcessor(deps: ProcessorDependencies): MessageProcessor<ResultProcessorExtra> {
  return (
    message: Record<string, unknown>,
    ctx: ProcessorContext,
    extra: ResultProcessorExtra
  ): void => {
    const { budgetLimit, queryGeneration } = extra;
    const { state } = ctx;
    const { callbacks, toolManager, checkpointTracker } = deps;

    const isStaleQuery = queryGeneration !== undefined && queryGeneration !== state.currentQueryGeneration;
    if (isStaleQuery) {
      return;
    }

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
      ? (Object.values(resultMsg.modelUsage)[0]?.contextWindow ?? 200000)
      : 200000;

    // Update stored context window for next turn's threshold calculations
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
      },
    });

    deps.contextDistillation?.onResponseComplete();

    toolManager.resetTurn();
    state.streamingContent = createEmptyStreamingContent();

    if (deps.contextDistillation?.isEnabled) {
      state.fireTurnComplete();
      const flushed = state.fireTurnEndFlush();
      if (!flushed) {
        state.setProcessing(false);
      }
    } else {
      state.setProcessing(false);
      state.fireTurnComplete();
      state.fireTurnEndFlush();
    }
  };
}
