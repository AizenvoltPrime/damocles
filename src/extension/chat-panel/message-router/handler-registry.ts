import type { HandlerDependencies, HandlerRegistry } from "./types";
import { createChatHandlers } from "./handlers/chat-handlers";
import { createPermissionHandlers } from "./handlers/permission-handlers";
import { createSettingsHandlers } from "./handlers/settings-handlers";
import { createSessionHandlers } from "./handlers/session-handlers";
import { createHistoryHandlers } from "./handlers/history-handlers";
import { createWorkspaceHandlers } from "./handlers/workspace-handlers";
import { createProviderHandlers } from "./handlers/provider-handlers";
import { createModelHandlers } from "./handlers/model-handlers";
import { createMemoryHandlers } from "./handlers/memory-handlers";
import { createVoiceHandlers } from "./handlers/voice-handlers";
import { createRemoteControlHandlers } from "./handlers/remote-control-handlers";
import { createBtwHandlers } from "./handlers/btw-handlers";
import { log } from "../../logger";

export function createHandlerRegistry(deps: HandlerDependencies): HandlerRegistry {
  return {
    log: (msg) => {
      if (msg.type === "log") log("[Webview]", msg.message);
    },

    cancelQueuedMessage: () => {},

    ...createChatHandlers(deps),
    ...createPermissionHandlers(deps),
    ...createSettingsHandlers(deps),
    ...createSessionHandlers(deps),
    ...createHistoryHandlers(deps),
    ...createWorkspaceHandlers(deps),
    ...createProviderHandlers(deps),
    ...createModelHandlers(deps),
    ...createMemoryHandlers(deps),
    ...createVoiceHandlers(deps),
    ...createRemoteControlHandlers(deps),
    ...createBtwHandlers(deps),
  };
}
