import { log } from '../../../logger';
import { generateNodeSummary } from '../../../recall/summary-generator';
import { toNodeTurnDisplays, toRelatedNodeSummaries } from '../../../recall/index';
import type { HandlerDependencies, HandlerRegistry, PostMessageFn } from "../types";
import type { WebviewHost } from "../../types";

export function createNodeHandlers(
  deps: HandlerDependencies,
): Partial<HandlerRegistry> {
  const postMessage = deps.postMessage;
  return {
    'set-active-node': async (msg, ctx) => {
      if (msg.type !== 'set-active-node') return;
      const recall = ctx.session.getRecallService();
      if (!recall) return;
      const nm = recall.getNodeManager();
      if (!nm.getNodeById(msg.nodeId)) return;
      nm.setActiveNodeId(msg.nodeId);
      broadcastNodeState(ctx, postMessage);
    },

    'new-node-requested': async (_msg, ctx) => {
      const recall = ctx.session.getRecallService();
      if (!recall) return;
      const nm = recall.getNodeManager();
      if (!nm.canCreateNode()) return;
      nm.setPendingNewNode();
      broadcastNodeState(ctx, postMessage);
    },

    'regenerate-seed-context': async (msg, ctx) => {
      if (msg.type !== 'regenerate-seed-context') return;
      const recall = ctx.session.getRecallService();
      if (!recall) return;

      try {
        await recall.regenerateSeedContext(msg.nodeId, msg.customPrompt);
        broadcastNodeState(ctx, postMessage);

        const nm = recall.getNodeManager();
        const history = recall.getHistory();
        const turns = nm.getNodeTurns(msg.nodeId, history);
        const node = nm.getNodeById(msg.nodeId);

        const relatedNodes = node ? toRelatedNodeSummaries(nm.findRelatedClosedNodes(node)) : [];

        postMessage(ctx.host, {
          type: 'nodeTurnsLoaded',
          nodeId: msg.nodeId,
          seedContext: node?.seedContext ?? null,
          seedContextPrompt: node?.seedContextPrompt ?? null,
          relatedNodes,
          turns: toNodeTurnDisplays(turns, { includeThinking: true }),
        });

        postMessage(ctx.host, { type: 'seed-context-regenerated', nodeId: msg.nodeId });
      } catch (err) {
        log('[NodeHandlers] Failed to regenerate seed context: %O', err);
        postMessage(ctx.host, { type: 'seed-context-regenerated', nodeId: msg.nodeId });
      }
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
        const summary = await generateNodeSummary(node, turns, deps.workspacePath, msg.outcome);
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

      const relatedNodes = node ? toRelatedNodeSummaries(nm.findRelatedClosedNodes(node)) : [];

      postMessage(ctx.host, {
        type: 'nodeTurnsLoaded',
        nodeId: msg.nodeId,
        seedContext: node?.seedContext ?? null,
        seedContextPrompt: node?.seedContextPrompt ?? null,
        relatedNodes,
        turns: toNodeTurnDisplays(turns, { includeThinking: true }),
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
