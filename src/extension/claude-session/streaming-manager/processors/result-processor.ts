import { log } from '../../../logger';
import { createEmptyStreamingContent } from '../../types';
import type { ProcessorContext, ProcessorDependencies, MessageProcessor } from '../types';
import type { StreamingState } from '../state';

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
      /** The SDK result is per-prompt-scoped — US-002 confirmed total_cost_usd and num_turns reset each user turn (num_turns 7→5 across two prompts on one persistent query; cost matched a per-turn price reconstruction). Sum into the running session total for costΣ; errored/aborted turns accrue too, since their tokens were billed. */
      state.addTurnCost(resultMsg.total_cost_usd);
      log('[Cache] result — cost=$%s costΣ=$%s turns=%s',
        resultMsg.total_cost_usd.toFixed(4),
        state.cumulativeCostUsd.toFixed(4),
        String(resultMsg.num_turns ?? '?'));
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

    const refusalDetails =
      state.pendingAssistant && !state.pendingAssistant.parentToolUseId
        ? state.pendingAssistant.stopDetails ?? null
        : null;

    ctx.flushPendingAssistant();

    /** Commit cumulative (= last-displayed value) into session total. resultMsg.usage.output_tokens carries only the reconciliation delta for the Codex bridge, which would snap UI backwards. */
    state.sessionTotalOutputTokens += state.cumulativeOutputTokens;

    callbacks.onMessage({
      type: 'done',
      data: {
        type: 'result',
        session_id: resultMsg.session_id,
        is_done: !resultMsg.is_error,
        ...(resultMsg.total_cost_usd !== undefined ? { total_cost_usd: resultMsg.total_cost_usd } : {}),
        total_output_tokens: state.sessionTotalOutputTokens,
        ...(resultMsg.num_turns !== undefined ? { num_turns: resultMsg.num_turns } : {}),
        stop_reason: resultMsg.stop_reason ?? null,
        stop_details: refusalDetails,
      },
    });

    if (resultMsg.fast_mode_state) {
      callbacks.onMessage({
        type: 'fastModeStateUpdate',
        state: resultMsg.fast_mode_state,
      });
    }

    deps.recallService?.onResponseComplete();

    enqueueMemoryTurn(deps, state, resultMsg);

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

/**
 * Enqueue the just-completed main-chat turn as a memory extraction candidate (US-006). Only fires
 * for successful, non-subagent turns when memory is enabled — the `!parentToolUseId` guard excludes
 * subagent turns, and Team/Explore turns run through separate SDK queries that never reach this
 * main-chat result processor. The take-once `getMemoryUserText` is consumed for EVERY completed
 * main-chat turn (even errored ones, before the error bail) so a stale prompt can never carry over
 * to a later turn. When recall is on, the structured turn (user/assistant/files) is read from recall
 * history — but only when the tail turn's promptIndex matches this turn, since an internal/system
 * result pushes no recall turn and would otherwise re-enqueue the previous one. Otherwise the user
 * prompt comes from the consumed text and the assistant text from the still-unreset streaming
 * content, with no file list (a documented best-effort gap); a null prompt means no fresh user turn
 * (e.g. a system-issued internal prompt) and bails.
 */
function enqueueMemoryTurn(
  deps: ProcessorDependencies,
  state: StreamingState,
  resultMsg: ResultMessage,
): void {
  const memoryService = deps.memoryService;
  if (!memoryService?.isEnabled) return;
  if (state.streamingContent.parentToolUseId) return;

  const consumedUserText = deps.getMemoryUserText?.() ?? null;

  if (resultMsg.is_error) return;
  if (!deps.getMemorySessionId) return;

  try {
    let userText = '';
    let assistantText = '';
    let files: string[] = [];

    if (deps.recallService?.isEnabled) {
      const history = deps.recallService.getHistory();
      const turn = history[history.length - 1];
      if (!turn || turn.promptIndex !== deps.getCurrentPromptIndex()) return;
      userText = turn.userMessage;
      assistantText = turn.assistantResponse;
      files = turn.filesTouched;
    } else {
      if (consumedUserText == null) return;
      userText = consumedUserText;
      assistantText = state.streamingContent.text;
    }

    if (!userText.trim() && !assistantText.trim()) return;

    memoryService.enqueueTurnCandidate({
      sessionId: deps.getMemorySessionId(),
      promptIndex: deps.getCurrentPromptIndex(),
      userText,
      assistantText,
      files,
    });
  } catch (err) {
    log('[Memory] enqueueTurnCandidate failed; turn unaffected: %O', err);
  }
}
