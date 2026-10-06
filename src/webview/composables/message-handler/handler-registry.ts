import type { HandlerRegistry } from "./types";
import { createStreamingHandlers } from "./handlers/streaming-handlers";
import { createToolHandlers } from "./handlers/tool-handlers";
import { createPermissionHandlers } from "./handlers/permission-handlers";
import { createSessionHandlers } from "./handlers/session-handlers";
import { createSettingsHandlers } from "./handlers/settings-handlers";
import { createHistoryHandlers } from "./handlers/history-handlers";
import { createSubagentHandlers } from "./handlers/subagent-handlers";
import { createQueueHandlers } from "./handlers/queue-handlers";
import { createUIHandlers } from "./handlers/ui-handlers";
import { createMemoryHandlers } from "./handlers/memory-handlers";
import { createContextInjectionHandlers } from "./handlers/context-injection-handlers";
import { createVoiceHandlers } from "./handlers/voice-handlers";
import { createVoiceStreamHandlers } from "./handlers/voice-stream-handlers";
import { createBtwHandlers } from "./handlers/btw-handlers";
import { createBackgroundTaskHandlers } from "./handlers/background-task-handlers";
import { createBrowserHandlers } from "./handlers/browser-handlers";
import { createTeamHandlers } from "./handlers/team-handlers";
import { createCompassHandlers } from "./handlers/compass-handlers";
import { createNavigatorHandlers } from "./handlers/navigator-handlers";
import { createInputHandlers } from "./handlers/input-handlers";
import { createExploreHandlers } from "./handlers/explore-handlers";
import { createConsolidationHandlers } from "./handlers/consolidation-handlers";
import { createEditorHandlers } from "./handlers/editor-handlers";
import { createAttentionHandlers } from "./handlers/attention-handlers";

export function createHandlerRegistry(): HandlerRegistry {
  // The settings view's handlers come first: a chat handler that extends one of them (workspaceFolderUpdate) overrides it.
  return {
    ...createSettingsHandlers(),
    ...createStreamingHandlers(),
    ...createToolHandlers(),
    ...createPermissionHandlers(),
    ...createSessionHandlers(),
    ...createHistoryHandlers(),
    ...createSubagentHandlers(),
    ...createQueueHandlers(),
    ...createUIHandlers(),
    ...createMemoryHandlers(),
    ...createContextInjectionHandlers(),
    ...createVoiceHandlers(),
    ...createVoiceStreamHandlers(),
    ...createBtwHandlers(),
    ...createBackgroundTaskHandlers(),
    ...createBrowserHandlers(),
    ...createTeamHandlers(),
    ...createCompassHandlers(),
    ...createNavigatorHandlers(),
    ...createInputHandlers(),
    ...createExploreHandlers(),
    ...createConsolidationHandlers(),
    ...createEditorHandlers(),
    ...createAttentionHandlers(),
  };
}
