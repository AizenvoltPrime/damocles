import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { log } from "../logger";
import { persistInjectedMessage, findLastMessageInCurrentTurn, persistSubagentCorrelation, getSessionMetadata } from "../session";
import { extractTextFromContent, hasImageContent } from "../../shared/utils";
import type { HookDependencies } from "./types";
import type {
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  NotificationHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk";

type HookEntry = {
  hooks: Array<(params: unknown, toolUseId?: string) => Promise<Record<string, unknown>>>;
};

type HooksConfig = {
  PreToolUse: HookEntry[];
  PostToolUse: HookEntry[];
  PostToolUseFailure: HookEntry[];
  Notification: HookEntry[];
  SessionStart: HookEntry[];
  SessionEnd: HookEntry[];
  UserPromptSubmit: HookEntry[];
  SubagentStart: HookEntry[];
  SubagentStop: HookEntry[];
  Stop: HookEntry[];
  PreCompact: HookEntry[];
};

function createToolHooks(deps: HookDependencies): Pick<HooksConfig, 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (params: unknown, toolUseId: string | undefined): Promise<Record<string, unknown>> => {
            const p = params as PreToolUseHookInput;
            deps.toolManager.handlePreToolUse(p.tool_name, toolUseId, p.tool_input);
            return {};
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (params: unknown, toolUseId: string | undefined): Promise<Record<string, unknown>> => {
            const p = params as PostToolUseHookInput;
            const id = toolUseId ?? p.tool_use_id;
            deps.toolManager.handlePostToolUse(p.tool_name, id, p.tool_response);

            if (p.tool_name === 'EnterPlanMode') {
              await deps.options.permissionHandler.activatePlanMode();
            }

            const pendingPlan = deps.getPendingPlanBind();
            if (pendingPlan) {
              const sessionId = deps.streamingManager.sessionId;
              if (sessionId) {
                const planContent = deps.clearPendingPlanBind();
                if (planContent) {
                  deps.bindPlanWhenSlugAvailable(sessionId, planContent);
                }
              }
            }

            const queuedMessages = deps.getQueuedMessages();
            if (queuedMessages.length > 0) {
              const queueHasImages = queuedMessages.some((m) => hasImageContent(m.content));

              if (queueHasImages) {
                log("[HookHandlers] PostToolUse: queued messages contain images, deferring to turn-end flush");
                return {};
              }

              const queued = deps.spliceQueuedMessages();
              const context = queued.map((m) => `[User interjection]: ${extractTextFromContent(m.content, "")}`).join("\n\n");
              log("[HookHandlers] PostToolUse: injecting queued messages as additionalContext");

              const sessionId = deps.streamingManager.sessionId;
              let parentUuid = deps.streamingManager.lastUserMessageId;

              if (sessionId) {
                const lastMsgUuid = await findLastMessageInCurrentTurn(deps.options.cwd, sessionId);
                if (lastMsgUuid) {
                  parentUuid = lastMsgUuid;
                }
              }

              for (const msg of queued) {
                if (sessionId) {
                  try {
                    await persistInjectedMessage({
                      workspacePath: deps.options.cwd,
                      sessionId,
                      content: msg.content,
                      parentUuid,
                      ...(msg.id != null ? { uuid: msg.id } : {}),
                    });
                    if (msg.id) {
                      parentUuid = msg.id;
                    }
                  } catch (err) {
                    log("[HookHandlers] Failed to persist injected message:", err);
                  }
                }

                if (msg.id) {
                  deps.callbacks.onMessage({ type: "queueProcessed", messageId: msg.id });
                }
              }

              return {
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: context,
                },
              };
            }
            return {};
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (params: unknown, toolUseId: string | undefined): Promise<Record<string, unknown>> => {
            const p = params as PostToolUseFailureHookInput;
            const id = toolUseId ?? p.tool_use_id;
            deps.toolManager.handlePostToolUseFailure(p.tool_name, id, p.error, p.is_interrupt);
            return {};
          },
        ],
      },
    ],
  };
}

function createLifecycleHooks(deps: HookDependencies): Pick<HooksConfig, 'SessionStart' | 'SessionEnd' | 'Stop' | 'PreCompact'> {
  return {
    SessionStart: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as SessionStartHookInput;
            deps.callbacks.onMessage({
              type: "sessionStart",
              source: p.source || "startup",
            });
            return {};
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            if (deps.streamingManager.isProcessing) {
              log('[HookHandlers] SessionEnd suppressed: new query is already processing');
              return {};
            }
            const p = params as SessionEndHookInput;
            deps.callbacks.onMessage({
              type: "sessionEnd",
              reason: p.reason || "completed",
            });
            return {};
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          async (): Promise<Record<string, unknown>> => {
            const pendingPlan = deps.getPendingPlanBind();
            if (pendingPlan) {
              const content = deps.clearPendingPlanBind();
              if (!content) {
                return {};
              }

              const sessionId = deps.streamingManager.sessionId;
              if (!sessionId) {
                return {};
              }

              const metadata = await getSessionMetadata(deps.options.cwd, sessionId);
              const slug = metadata?.slug;
              if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
                return {};
              }

              const slugPath = path.join(os.homedir(), ".claude", "plans", `${slug}.md`);
              try {
                await fs.mkdir(path.dirname(slugPath), { recursive: true });
                await fs.writeFile(slugPath, content);
                log("[HookHandlers] Stop hook: Wrote plan file to %s", slugPath);
                return { systemMessage: `A plan file has been bound to this session. Plan file path: ${slugPath}` };
              } catch {
                return {};
              }
            }
            return {};
          },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as PreCompactHookInput;
            deps.callbacks.onMessage({
              type: "preCompact",
              trigger: p.trigger || "auto",
            });
            return {};
          },
        ],
      },
    ],
  };
}

function createUserHooks(deps: HookDependencies): Pick<HooksConfig, 'UserPromptSubmit' | 'Notification'> {
  return {
    UserPromptSubmit: [
      {
        hooks: [
          async (_params: unknown): Promise<Record<string, unknown>> => {
            const parts: string[] = [];

            if (deps.options.permissionHandler.getPermissionMode() === "plan") {
              parts.push(
                "<MANDATORY_INSTRUCTION>PLAN MODE ACTIVE: You MUST call EnterPlanMode immediately as your first action. No other tools or responses allowed until you enter plan mode.</MANDATORY_INSTRUCTION>"
              );
            }

            try {
              const memoryContext = deps.getMemoryContext();
              if (memoryContext) {
                parts.push(memoryContext);
              }
            } catch (err) {
              log("[HookHandlers] UserPromptSubmit: memory context failed: %O", err);
            }

            if (deps.isFirstMessageOfSession()) {
              deps.markFirstMessageSent();
            }

            if (parts.length > 0) {
              return {
                hookSpecificOutput: {
                  hookEventName: "UserPromptSubmit",
                  additionalContext: parts.join("\n\n"),
                },
              };
            }
            return {};
          },
        ],
      },
    ],
    Notification: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as NotificationHookInput;
            if (p.message) {
              deps.callbacks.onMessage({
                type: "notification",
                message: p.message,
                notificationType: p.notification_type || "info",
              } as import("../../shared/types/messages").ExtensionToWebviewMessage);
            }
            return {};
          },
        ],
      },
    ],
  };
}

function createSubagentHooks(deps: HookDependencies): Pick<HooksConfig, 'SubagentStart' | 'SubagentStop'> {
  return {
    SubagentStart: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as SubagentStartHookInput;
            if (p.agent_id) {
              const toolUseId = deps.toolManager.correlateSubagentStart(p.agent_id);
              const sessionId = deps.streamingManager.sessionId;

              if (toolUseId && sessionId) {
                persistSubagentCorrelation(deps.options.cwd, sessionId, toolUseId, p.agent_id).catch(err => {
                  log("[HookHandlers] Failed to persist subagent correlation: %O", err);
                });
              }

              deps.callbacks.onMessage({
                type: "subagentStart",
                agentId: p.agent_id,
                agentType: p.agent_type || "unknown",
                ...(toolUseId != null ? { toolUseId } : {}),
              });
            }
            return {};
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as SubagentStopHookInput;
            if (p.agent_id) {
              deps.callbacks.onMessage({
                type: "subagentStop",
                agentId: p.agent_id,
              });
            }
            return {};
          },
        ],
      },
    ],
  };
}

export function buildHooksConfig(deps: HookDependencies): HooksConfig {
  return {
    ...createToolHooks(deps),
    ...createLifecycleHooks(deps),
    ...createUserHooks(deps),
    ...createSubagentHooks(deps),
  };
}
