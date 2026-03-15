import { log } from '../../../logger';
import { generateNodeSummary } from '../../../recall/summary-generator';
import type { HandlerDependencies, HandlerRegistry, PostMessageFn } from "../types";
import type { WebviewHost } from "../../types";

export function createNodeHandlers(
  deps: HandlerDependencies,
): Partial<HandlerRegistry> {
  const postMessage = deps.postMessage;
  return {
    'node-selected': async (msg, ctx) => {
      if (msg.type !== 'node-selected') return;
      const recall = ctx.session.getRecallService();
      if (!recall) {
        ctx.session.resolveNodePicker?.(null);
        return;
      }
      const nm = recall.getNodeManager();
      if (!nm.getNodeById(msg.nodeId)) {
        ctx.session.resolveNodePicker?.(null);
        return;
      }
      nm.setActiveNodeId(msg.nodeId);
      broadcastNodeState(ctx, postMessage);
      ctx.session.resolveNodePicker?.(msg.nodeId);
    },

    'new-node-requested': async (msg, ctx) => {
      if (msg.type !== 'new-node-requested') return;
      const recall = ctx.session.getRecallService();
      if (!recall) {
        ctx.session.resolveNodePicker?.(null);
        return;
      }
      const nm = recall.getNodeManager();
      const pendingPrompt = ctx.session.getPendingNodePrompt?.() ?? '';

      try {
        const node = await nm.createNode(pendingPrompt);

        broadcastNodeState(ctx, postMessage);
        postMessage(ctx.host, {
          type: 'node-created-preview',
          nodeId: node.nodeId,
          title: node.title,
          keyEntities: node.keyEntities,
        });
      } catch (err) {
        log('[NodeHandlers] Failed to create node: %O', err);
        ctx.session.resolveNodePicker?.(null);
      }
    },

    'node-picker-cancelled': async (_msg, ctx) => {
      ctx.session.resolveNodePicker?.(null);
    },

    'close-node-request': async (msg, ctx) => {
      if (msg.type !== 'close-node-request') return;
      const recall = ctx.session.getRecallService();
      if (!recall) return;
      const nm = recall.getNodeManager();
      const node = nm.getNodeById(msg.nodeId);
      if (!node) return;

      try {
        const turns = nm.getNodeTurns(msg.nodeId, recall.getHistory());
        const summary = await generateNodeSummary(node, turns, deps.workspacePath);
        nm.closeNode(msg.nodeId, summary);

        postMessage(ctx.host, { type: 'node-closed-confirmed', nodeId: msg.nodeId });
        broadcastNodeState(ctx, postMessage);
      } catch (err) {
        log('[NodeHandlers] Failed to close node: %O', err);
        postMessage(ctx.host, { type: 'node-close-failed', nodeId: msg.nodeId });
      }
    },

    'reopen-node-request': async (msg, ctx) => {
      if (msg.type !== 'reopen-node-request') return;
      const recall = ctx.session.getRecallService();
      if (!recall) return;
      const nm = recall.getNodeManager();
      nm.reopenNode(msg.nodeId);
      broadcastNodeState(ctx, postMessage);
    },

    'dismiss-node-close-prompt': async () => {
      // No-op on extension side
    },

    'disconnect-node-relation': async (msg, ctx) => {
      if (msg.type !== 'disconnect-node-relation') return;
      const recall = ctx.session.getRecallService();
      if (!recall) return;
      const nm = recall.getNodeManager();
      nm.disconnectNode(msg.nodeId, msg.relatedNodeId);
      broadcastNodeState(ctx, postMessage);
    },

    requestNodeTurns: async (msg, ctx) => {
      if (msg.type !== 'requestNodeTurns') return;
      const recall = ctx.session.getRecallService();
      if (!recall) return;
      const nm = recall.getNodeManager();
      const history = recall.getHistory();
      const turns = nm.getNodeTurns(msg.nodeId, history);
      const node = nm.getNodeById(msg.nodeId);

      const relatedNodes = node
        ? nm.findRelatedClosedNodes(node)
            .filter(n => n.summary)
            .map(n => ({
              nodeId: n.nodeId,
              title: n.summary!.title,
              outcome: n.summary!.outcome,
              taskDescription: n.summary!.taskDescription,
              filesChanged: n.summary!.filesChanged,
              keyDecisions: n.summary!.keyDecisions,
            }))
        : [];

      postMessage(ctx.host, {
        type: 'nodeTurnsLoaded',
        nodeId: msg.nodeId,
        seedContext: node?.seedContext ?? null,
        relatedNodes,
        turns: turns.map(t => ({
          promptIndex: t.promptIndex,
          timestamp: t.timestamp,
          userMessage: t.userMessage,
          assistantResponse: t.assistantResponse,
          toolCalls: t.toolCalls.map(tc => ({ name: tc.name, input: tc.input, result: tc.result })),
          contentBlocks: t.contentBlocks.map(b => {
            if (b.type === 'text') return b;
            const tc = t.toolCalls[b.index];
            if (!tc) return { type: 'tool_call' as const, name: 'unknown', input: {}, result: '' };
            return { type: 'tool_call' as const, name: tc.name, input: tc.input, result: tc.result };
          }),
          thinkingBlocks: t.thinkingBlocks,
          filesTouched: t.filesTouched,
        })),
      });
    },
  };
}

export function broadcastNodeState(
  ctx: { host: WebviewHost; session: import('../../../claude-session').ClaudeSession },
  postMessage: PostMessageFn,
): void {
  const recall = ctx.session.getRecallService();
  if (!recall) return;
  postMessage(ctx.host, { type: 'node-state-updated', ...recall.buildNodeDisplayState() });
}
