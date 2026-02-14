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
import { createHaikuObserverHandlers } from "./handlers/haiku-observer-handlers";
import { createContextInjectionHandlers } from "./handlers/context-injection-handlers";

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
    ...createHaikuObserverHandlers(),
    ...createContextInjectionHandlers(),
  };
}
