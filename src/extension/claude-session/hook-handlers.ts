import { log } from "../logger";
import { persistInjectedMessage, findLastMessageInCurrentTurn, persistSubagentCorrelation } from "../session";
import { extractTextFromContent, hasImageContent } from "../../shared/utils";
import { TOOL_AGENT, TOOL_ENTER_PLAN_MODE, TOOL_CRON_CREATE, TOOL_CRON_DELETE, TOOL_CRON_LIST } from '../../shared/tool-names';
import { cronToIntervalLabel } from '../../shared/utils/cron';
import { DEFAULT_MAX_INJECTED_CHARS } from '../recall/types';
import type { HookDependencies } from "./types";
import type {
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  NotificationHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  PreCompactHookInput,
  UserPromptSubmitHookInput,
  ConfigChangeHookInput,
  WorktreeCreateHookInput,
  WorktreeRemoveHookInput,
  TaskCompletedHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { COMPASS_AGENT_PROMPT } from "../compass/system-prompt";

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
  ConfigChange: HookEntry[];
  WorktreeCreate: HookEntry[];
  WorktreeRemove: HookEntry[];
  TaskCompleted: HookEntry[];
};

function createToolHooks(deps: HookDependencies): Pick<HooksConfig, 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (params: unknown, toolUseId: string | undefined): Promise<Record<string, unknown>> => {
            const p = params as PreToolUseHookInput;
            if ((p as Record<string, unknown>)['agent_id']) {
              log("[HookHandlers] PreToolUse inside agent: tool=%s, agent_id=%s, agent_type=%s",
                p.tool_name, (p as Record<string, unknown>)['agent_id'], (p as Record<string, unknown>)['agent_type'] ?? "unknown");
            }
            const resolvedToolUseId = toolUseId ?? p.tool_use_id;
            const preToolAgentId = (p as Record<string, unknown>)['agent_id'] as string | undefined;
            deps.toolManager.handlePreToolUse(p.tool_name, resolvedToolUseId, p.tool_input);

            if (p.tool_name === 'mcp__damocles-team__create_team' && resolvedToolUseId && deps.options.teamService) {
              deps.options.teamService.setPendingToolUseId(resolvedToolUseId);
            }

            if (preToolAgentId && resolvedToolUseId && deps.options.recallService?.isEnabled) {
              const parentToolUseId = deps.toolManager.getToolUseIdForAgent(preToolAgentId);
              if (parentToolUseId) {
                const input = (typeof p.tool_input === 'object' && p.tool_input !== null ? p.tool_input : {}) as Record<string, unknown>;
                deps.options.recallService.onSubagentToolCall(parentToolUseId, p.tool_name, resolvedToolUseId, input);
              }
            }

            if (deps.options.recallService?.isEnabled) {
              if (p.tool_name === TOOL_CRON_CREATE) {
                try {
                  const input = typeof p.tool_input === 'string' ? JSON.parse(p.tool_input) : p.tool_input;
                  const cron = String((input as Record<string, unknown>)['cron'] ?? '');
                  const prompt = String((input as Record<string, unknown>)['prompt'] ?? (input as Record<string, unknown>)['description'] ?? '');
                  const recurring = Boolean((input as Record<string, unknown>)['recurring'] ?? true);
                  const jobId = deps.loopJobTracker.createLocalJob(cron, prompt, recurring);
                  const humanSchedule = cronToIntervalLabel(cron);
                  await deps.toolManager.handlePostToolUse(p.tool_name, resolvedToolUseId, { id: jobId, humanSchedule, recurring });
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: `Scheduled: ${humanSchedule}\nJob ID: ${jobId}\n${recurring ? 'Recurring (auto-expires after 3 days)' : 'One-shot (fires once)'}`,
                    },
                  };
                } catch (err) {
                  log('[HookHandlers] PreToolUse CronCreate ERROR (deny fallthrough): %O', err);
                }
              }

              if (p.tool_name === TOOL_CRON_LIST) {
                const jobs = deps.loopJobTracker.getJobs();
                const activeJobs = jobs.filter(j => j.status === 'active');
                const responseObj = {
                  jobs: activeJobs.map(j => ({
                    id: j.taskId,
                    cron: j.cron,
                    humanSchedule: j.intervalLabel,
                    prompt: j.prompt,
                  })),
                };
                await deps.toolManager.handlePostToolUse(p.tool_name, resolvedToolUseId, responseObj);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: activeJobs.length > 0
                      ? `Active cron jobs:\n${activeJobs.map(j => `- ${j.taskId}: "${j.prompt}" (${j.cron})`).join('\n')}`
                      : 'No active cron jobs.',
                  },
                };
              }
            }

            // Only handle definitive allow/deny from settings patterns here.
            // For 'ask', let SDK's canUseTool callback handle proper webview prompts.
            const evaluation = await deps.options.permissionHandler.evaluatePermission(
              p.tool_name,
              p.tool_input as Record<string, unknown>
            );

            if (evaluation === 'allow') {
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'allow',
                },
              };
            }

            if (evaluation === 'deny') {
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'Permission denied by settings rule',
                },
              };
            }

            // For 'ask' behavior, return empty to let SDK's canUseTool callback handle it
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
            if ((p as Record<string, unknown>)['agent_id']) {
              log("[HookHandlers] PostToolUse inside agent: tool=%s, agent_id=%s", p.tool_name, (p as Record<string, unknown>)['agent_id']);
            }
            const id = toolUseId ?? p.tool_use_id;
            const agentId = (p as Record<string, unknown>)['agent_id'] as string | undefined;
            const isSubagent = agentId ? true : (id ? deps.toolManager.isSubagentTool(id) : false);
            if (p.tool_name === TOOL_AGENT) {
              deps.streamingManager.flushPendingAssistant();
            }
            await deps.toolManager.handlePostToolUse(p.tool_name, id, p.tool_response, agentId);

            if (p.tool_name === 'Read') {
              try {
                const input = typeof p.tool_input === 'string'
                  ? JSON.parse(p.tool_input) : p.tool_input as Record<string, unknown>;
                const filePath = input['file_path'] as string | undefined;
                if (filePath) {
                  deps.readStateTracker.trackRead(filePath).catch(() => {});
                }
              } catch { /* malformed tool_input — skip read tracking */ }
            }

            if (isSubagent) {
              return {};
            }

            if (!deps.options.recallService?.isEnabled) {
              if (p.tool_name === TOOL_CRON_CREATE && id) {
                try {
                  const input = typeof p.tool_input === 'string' ? JSON.parse(p.tool_input) : (p.tool_input as Record<string, unknown>);
                  const responseStr = typeof p.tool_response === 'string' ? p.tool_response : JSON.stringify(p.tool_response);
                  deps.loopJobTracker.trackCreation(id, input, responseStr);
                } catch (err) {
                  log('[HookHandlers] PostToolUse CronCreate tracking failed: %O', err);
                }
              }
              if (p.tool_name === TOOL_CRON_DELETE && id) {
                const input = typeof p.tool_input === 'string' ? JSON.parse(p.tool_input) : (p.tool_input as Record<string, unknown>);
                const deleteJobId = String((input as Record<string, unknown>)['id'] ?? '');
                if (deleteJobId) {
                  deps.loopJobTracker.trackDeletion(deleteJobId);
                }
              }
            }

            if (p.tool_name === TOOL_ENTER_PLAN_MODE) {
              await deps.options.permissionHandler.activatePlanMode();
              const compassContext = deps.getCompassContext();
              if (compassContext) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    additionalContext: compassContext,
                  },
                };
              }
            }

            if (deps.toolManager.hasActiveAgentTools()) {
              log("[HookHandlers] PostToolUse: Agent tools still in-flight, deferring queue injection");
              return {};
            }

            const queuedMessages = deps.getQueuedMessages();
            if (queuedMessages.length > 0) {
              const queueHasImages = queuedMessages.some((m) => hasImageContent(m.content));

              if (queueHasImages) {
                log("[HookHandlers] PostToolUse: queued messages contain images, deferring to turn-end flush");
                return {};
              }

              if (deps.options.recallService?.isEnabled) {
                deps.streamingManager.flushPendingAssistant();
              }

              const queued = deps.spliceQueuedMessages();
              const rawTexts = queued.map((m) => extractTextFromContent(m.content, ""));
              const context = rawTexts.map((t) => `[User interjection]: ${t}`).join("\n\n");
              log("[HookHandlers] PostToolUse: injecting queued messages as additionalContext");

              deps.options.recallService?.onInterjection(rawTexts.join("\n\n"));

              const isRecall = deps.options.recallService?.isEnabled ?? false;
              const persistSessionId = isRecall
                ? deps.options.recallService!.persistenceSessionId
                : deps.streamingManager.sessionId;

              let parentUuid: string | null;

              if (isRecall) {
                parentUuid = deps.options.recallService!.lastFlushedLeafUuid
                  ?? deps.streamingManager.lastUserMessageId;
              } else {
                parentUuid = deps.streamingManager.lastUserMessageId;
                if (persistSessionId) {
                  const lastMsgUuid = await findLastMessageInCurrentTurn(deps.options.cwd, persistSessionId);
                  if (lastMsgUuid) {
                    parentUuid = lastMsgUuid;
                  }
                }
              }

              for (const msg of queued) {
                if (persistSessionId) {
                  try {
                    await persistInjectedMessage({
                      workspacePath: deps.options.cwd,
                      sessionId: persistSessionId,
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

function createLifecycleHooks(deps: HookDependencies): Pick<HooksConfig, 'SessionStart' | 'SessionEnd' | 'Stop' | 'PreCompact' | 'ConfigChange'> {
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
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as StopHookInput;
            if (p.last_assistant_message) {
              deps.callbacks.onMessage({
                type: "stopInfo",
                lastAssistantMessage: p.last_assistant_message,
              });
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
    ConfigChange: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as ConfigChangeHookInput;
            log("[HookHandlers] ConfigChange: source=%s, path=%s", p.source, p.file_path);
            deps.callbacks.onMessage({
              type: "configChange",
              source: p.source,
              ...(p.file_path ? { filePath: p.file_path } : {}),
            });
            return {};
          },
        ],
      },
    ],
  };
}

const RECALL_CHUNK_SIZE = 9_000;

function chunkText(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    if (text.length - pos <= 0) break;
    if (text.length - pos <= maxChunkSize) {
      chunks.push(text.substring(pos));
      break;
    }

    const end = pos + maxChunkSize;
    const newlineAt = text.lastIndexOf('\n', end);
    const splitAt = newlineAt > pos ? newlineAt : end;

    chunks.push(text.substring(pos, splitAt));
    pos = splitAt + (text[splitAt] === '\n' ? 1 : 0);
  }

  return chunks;
}

function createUserHooks(deps: HookDependencies): Pick<HooksConfig, 'UserPromptSubmit' | 'Notification'> {
  const pendingRecallChunks: string[] = [];
  const maxInjectedChars = deps.options.recallService?.maxInjectedChars ?? DEFAULT_MAX_INJECTED_CHARS;
  const overflowEntryCount = Math.max(0, Math.ceil(maxInjectedChars / RECALL_CHUNK_SIZE) - 1);

  function makeRecallOverflowEntry(): HookEntry {
    return {
      hooks: [
        async (): Promise<Record<string, unknown>> => {
          if (deps.streamingManager.silentAbort) return {};
          const chunk = pendingRecallChunks.shift();
          if (!chunk) return {};
          return {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: chunk,
            },
          };
        },
      ],
    };
  }

  return {
    UserPromptSubmit: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            pendingRecallChunks.length = 0;
            const parts: string[] = [];
            const hookInput = params as UserPromptSubmitHookInput;

            if (deps.options.permissionHandler.getPermissionMode() === "plan") {
              parts.push(
                "<MANDATORY_INSTRUCTION>PLAN MODE ACTIVE: You MUST call EnterPlanMode immediately as your first action. No other tools or responses allowed until you enter plan mode.</MANDATORY_INSTRUCTION>"
              );
            }

            const isRemoteMessage = !deps.streamingManager.localPromptPending && hookInput.prompt?.trim();
            if (isRemoteMessage) {
              if (hookInput.prompt.trimStart().startsWith('<task-notification')) {
                log('[Hook.UserPromptSubmit] Task-notification XML detected — passing through without reroute (len=%d)', hookInput.prompt.length);
                return {};
              }

              deps.callbacks.onMessage({
                type: 'userMessage',
                content: hookInput.prompt,
                correlationId: `remote-bridge-${Date.now()}`,
              });

              if (deps.options.recallService?.isEnabled) {
                log('[Hook.UserPromptSubmit] Blocking remote message for recall reroute: length=%d', hookInput.prompt.length);
                deps.rerouteRemoteMessage(hookInput.prompt);
                return { decision: 'block' };
              }
            }

            if (deps.streamingManager.silentAbort) {
              return {};
            }

            let recallContext = await deps.getRecallContext(hookInput.prompt);
            if (recallContext) {
              if (recallContext.length > maxInjectedChars) {
                log('[HookHandlers] Recall context capped: %d → %d chars', recallContext.length, maxInjectedChars);
                recallContext = recallContext.substring(0, maxInjectedChars);
              }

              const chunks = chunkText(recallContext, RECALL_CHUNK_SIZE);

              if (chunks.length === 1) {
                parts.push(`<recall_session_context>\n${chunks[0]}\n</recall_session_context>`);
              } else {
                log('[HookHandlers] Recall context chunked: %d chars → %d chunks', recallContext.length, chunks.length);
                parts.push(`<recall_session_context part="1" of="${chunks.length}">\n${chunks[0]}\n</recall_session_context>`);
                for (let i = 1; i < chunks.length; i++) {
                  pendingRecallChunks.push(
                    `<recall_session_context part="${i + 1}" of="${chunks.length}">\n${chunks[i]}\n</recall_session_context>`
                  );
                }
              }
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
      ...Array.from({ length: overflowEntryCount }, () => makeRecallOverflowEntry()),
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            if (deps.streamingManager.silentAbort) {
              return {};
            }

            const hookInput = params as UserPromptSubmitHookInput;
            try {
              const memoryContext = await deps.getMemoryContext(hookInput.prompt);
              if (memoryContext) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "UserPromptSubmit",
                    additionalContext: memoryContext,
                  },
                };
              }
            } catch (err) {
              log("[HookHandlers] UserPromptSubmit: memory context failed: %O", err);
            }
            return {};
          },
        ],
      },
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            if (deps.streamingManager.silentAbort) return {};
            if ((params as Record<string, unknown>)['agent_id']) return {};
            const compassContext = deps.getCompassContext();
            if (compassContext) {
              return {
                hookSpecificOutput: {
                  hookEventName: "UserPromptSubmit",
                  additionalContext: compassContext,
                },
              };
            }
            return {};
          },
        ],
      },
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            if (deps.streamingManager.silentAbort) return {};
            if (!(params as Record<string, unknown>)['agent_id']) return {};
            if (!deps.isCompassEnabled()) return {};
            return {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: COMPASS_AGENT_PROMPT,
              },
            };
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
              const isRecall = deps.options.recallService?.isEnabled ?? false;
              const persistSessionId = isRecall
                ? deps.options.recallService!.persistenceSessionId
                : deps.streamingManager.sessionId;

              if (toolUseId && persistSessionId) {
                persistSubagentCorrelation(deps.options.cwd, persistSessionId, toolUseId, p.agent_id).catch(err => {
                  log("[HookHandlers] Failed to persist subagent correlation: %O", err);
                });
              }

              if (toolUseId && isRecall) {
                const agentInput = deps.toolManager.getAgentInput(toolUseId);
                const isBackground = Boolean(agentInput?.['run_in_background']);
                const prompt = typeof agentInput?.['prompt'] === 'string' ? agentInput['prompt'] as string : undefined;
                deps.options.recallService!.onSubagentStart(toolUseId, p.agent_id, isBackground, prompt);
              }

              deps.callbacks.onMessage({
                type: "subagentStart",
                agentId: p.agent_id,
                agentType: p.agent_type || "unknown",
                ...(toolUseId != null ? { toolUseId } : {}),
              });
            }
            const compassContext = deps.getCompassContext();
            if (compassContext) {
              return {
                hookSpecificOutput: {
                  hookEventName: "SubagentStart",
                  additionalContext: compassContext,
                },
              };
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
              deps.options.recallService?.onSubagentStop(p.agent_id, p.last_assistant_message);

              const toolUseId = deps.toolManager.getToolUseIdForAgent(p.agent_id);
              deps.callbacks.onMessage({
                type: "subagentStop",
                agentId: p.agent_id,
                ...(toolUseId ? { toolUseId } : {}),
                ...(p.last_assistant_message ? { lastAssistantMessage: p.last_assistant_message } : {}),
              });
            }
            return {};
          },
        ],
      },
    ],
  };
}

function createWorktreeHooks(deps: HookDependencies): Pick<HooksConfig, 'WorktreeCreate' | 'WorktreeRemove'> {
  return {
    WorktreeCreate: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as WorktreeCreateHookInput;
            log("[HookHandlers] WorktreeCreate: name=%s", p.name);
            deps.callbacks.onMessage({
              type: "notification",
              message: `Worktree created: ${p.name}`,
              notificationType: "info",
            } as import("../../shared/types/messages").ExtensionToWebviewMessage);
            return {};
          },
        ],
      },
    ],
    WorktreeRemove: [
      {
        hooks: [
          async (params: unknown): Promise<Record<string, unknown>> => {
            const p = params as WorktreeRemoveHookInput;
            log("[HookHandlers] WorktreeRemove: path=%s", p.worktree_path);
            deps.callbacks.onMessage({
              type: "notification",
              message: `Worktree removed: ${p.worktree_path}`,
              notificationType: "info",
            } as import("../../shared/types/messages").ExtensionToWebviewMessage);
            return {};
          },
        ],
      },
    ],
  };
}

function createTaskHooks(deps: HookDependencies): Pick<HooksConfig, 'TaskCompleted'> {
  return {
    TaskCompleted: [{
      hooks: [
        async (params: unknown): Promise<Record<string, unknown>> => {
          const p = params as TaskCompletedHookInput;
          log("[HookHandlers] TaskCompleted: id=%s, subject=%s", p.task_id, p.task_subject);
          deps.callbacks.onMessage({
            type: "notification",
            message: `Task completed: ${p.task_subject}`,
            notificationType: "info",
          } as import("../../shared/types/messages").ExtensionToWebviewMessage);
          return {};
        },
      ],
    }],
  };
}

export function buildHooksConfig(deps: HookDependencies): HooksConfig {
  return {
    ...createToolHooks(deps),
    ...createLifecycleHooks(deps),
    ...createUserHooks(deps),
    ...createSubagentHooks(deps),
    ...createWorktreeHooks(deps),
    ...createTaskHooks(deps),
  };
}
