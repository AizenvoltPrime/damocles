import { useNodeStore } from '@/stores/useNodeStore';
import type { HandlerRegistry } from "../types";

export function createNodeHandlers(): Partial<HandlerRegistry> {
  return {
    'show-node-picker': (msg) => {
      useNodeStore().openPicker(msg);
      return { skipScroll: true };
    },
    'node-created-preview': (msg) => {
      useNodeStore().handleCreatedPreview(msg);
      return { skipScroll: true };
    },
    'show-node-close-prompt': (msg) => {
      useNodeStore().openClosePrompt(msg.nodeId, msg.title);
      return { skipScroll: true };
    },
    'node-state-updated': (msg) => {
      useNodeStore().handleNodeStateUpdated(msg);
      return { skipScroll: true };
    },
    'node-closed-confirmed': (_msg) => {
      useNodeStore().handleNodeClosed();
      return { skipScroll: true };
    },
    'node-close-failed': (_msg) => {
      useNodeStore().handleNodeClosed();
      return { skipScroll: true };
    },
    nodeTurnsLoaded: (msg) => {
      if (msg.type !== 'nodeTurnsLoaded') return;
      useNodeStore().handleNodeTurnsLoaded(msg.nodeId, msg.turns, msg.seedContext, msg.relatedNodes);
      return { skipScroll: true };
    },
  };
}
