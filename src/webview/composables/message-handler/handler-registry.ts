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
import { createRemoteControlHandlers } from "./handlers/remote-control-handlers";
import { createLoopJobHandlers } from "./handlers/loop-job-handlers";
import { createBtwHandlers } from "./handlers/btw-handlers";
import { createNodeHandlers } from "./handlers/node-handlers";
import { createBackgroundTaskHandlers } from "./handlers/background-task-handlers";
import { createBrowserHandlers } from "./handlers/browser-handlers";
import { createTeamHandlers } from "./handlers/team-handlers";
import { createCompassHandlers } from "./handlers/compass-handlers";

export function createHandlerRegistry(): HandlerRegistry {
  return {
    ...createStreamingHandlers(),
    ...createToolHandlers(),
    ...createPermissionHandlers(),
    ...createSessionHandlers(),
    ...createSettingsHandlers(),
    ...createHistoryHandlers(),
    ...createSubagentHandlers(),
    ...createQueueHandlers(),
    ...createUIHandlers(),
    ...createMemoryHandlers(),
    ...createContextInjectionHandlers(),
    ...createVoiceHandlers(),
    ...createRemoteControlHandlers(),
    ...createLoopJobHandlers(),
    ...createBtwHandlers(),
    ...createNodeHandlers(),
    ...createBackgroundTaskHandlers(),
    ...createBrowserHandlers(),
    ...createTeamHandlers(),
    ...createCompassHandlers(),
  };
}
