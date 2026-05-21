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
import { createVoiceStreamHandlers } from "./handlers/voice-stream-handlers";
import { createRemoteControlHandlers } from "./handlers/remote-control-handlers";
import { createBtwHandlers } from "./handlers/btw-handlers";
import { createNodeHandlers } from "./handlers/node-handlers";
import { createBrowserHandlers } from "./handlers/browser-handlers";
import { createTeamHandlers } from "./handlers/team-handlers";
import { createCompassHandlers } from "./handlers/compass-handlers";
import { createOpenAIHandlers } from "./handlers/openai-handlers";
import { log } from "../../logger";

export function createHandlerRegistry(deps: HandlerDependencies): HandlerRegistry {
  const voiceStream = createVoiceStreamHandlers(deps);
  const chatDeps: HandlerDependencies = { ...deps, markUserTypedDuringTurn: voiceStream.markUserTypedDuringTurn };
  return {
    log: (msg) => {
      if (msg.type === "log") log("[Webview]", msg.message);
    },

    cancelQueuedMessage: () => {},

    ...createChatHandlers(chatDeps),
    ...createPermissionHandlers(deps),
    ...createSettingsHandlers(deps),
    ...createSessionHandlers(deps),
    ...createHistoryHandlers(deps),
    ...createWorkspaceHandlers(deps),
    ...createProviderHandlers(deps),
    ...createModelHandlers(deps),
    ...createMemoryHandlers(deps),
    ...createVoiceHandlers(deps),
    ...voiceStream.handlers,
    ...createRemoteControlHandlers(deps),
    ...createBtwHandlers(deps),
    ...createNodeHandlers(deps),
    ...createBrowserHandlers(deps),
    ...createTeamHandlers(deps),
    ...createCompassHandlers(deps),
    ...createOpenAIHandlers(deps),
  };
}
