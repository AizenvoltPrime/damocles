import * as vscode from "vscode";
import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { UserContentBlock } from "../../../../shared/types/content";
import type { ContentInput } from "../../../session-types";
import type { MemoryScope } from "../../../../shared/types/memory";
import { SLASH_INVOCATION_RE } from "../../../../shared/asset-names";
import { createQueuedMessage } from "../../queue-manager";
import { extractTextFromContent, hasImageContent } from "../../../../shared/utils";
import { log } from "../../../logger";

/** Build a `userMessage` payload for a locally-handled slash-command turn that bypasses sendMessage. */
function stampUserMessage(
  ctx: HandlerContext,
  content: string,
  opts: { contentBlocks?: UserContentBlock[]; correlationId: string; isInjected?: boolean },
): import("../../../../shared/types/messages").ExtensionToWebviewMessage {
  const promptIndex = Math.max(0, ctx.session.currentPromptIndex);
  return {
    type: "userMessage",
    content,
    correlationId: opts.correlationId,
    promptIndex,
    ...(opts.contentBlocks !== undefined ? { contentBlocks: opts.contentBlocks } : {}),
    ...(opts.isInjected ? { isInjected: true } : {}),
  };
}

type InterceptResult =
  | { kind: "handled" }
  | { kind: "passthrough"; transformedContent: string | null; preApprovedSkillName: string | null };

const MEMORY_SLASH_RE = /^\/(remember|note|memories)(?:\s+(.*))?$/;
const COMPACT_SLASH_RE = /^\/compact(?:\s+(.*))?$/;

/** Builtins expanded to a canonical prompt before handing the turn to the agent. */
const DIRECT_COMMANDS: ReadonlySet<string> = new Set(["init"]);

export function createChatHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, workspaceManager, markUserTypedDuringTurn } = deps;

  /** Withheld project-scope asset: no turn is sent, since the agent never loaded it. */
  const refuseUntrusted = (ctx: HandlerContext): InterceptResult => {
    postMessage(ctx.host, {
      type: "notification",
      message: vscode.l10n.t(
        "This workspace is not trusted, so project skills and commands are not loaded. Trust the workspace to run them.",
      ),
      notificationType: "warning",
    });
    return { kind: "handled" };
  };

  const tryInterceptLocal = async (
    originalTextContent: string,
    ctx: HandlerContext,
  ): Promise<InterceptResult> => {
    const trimmed = originalTextContent.trim();

    const memoryMatch = trimmed.match(MEMORY_SLASH_RE);
    if (memoryMatch) {
      const [, command, rawArg] = memoryMatch;
      const arg = rawArg?.trim() ?? "";
      // Memory commands are side-effects, not conversation — they surface their own feedback and
      // leave no chat bubble or session entry.

      if (command === "memories") {
        postMessage(ctx.host, { type: "openMemoryPanel" });
        return { kind: "handled" };
      }

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return { kind: "handled" };
      }

      // Warm the lazy init before the add calls so the first `/remember` isn't dropped against a null manager.
      await deps.memoryService.ensureInitialized();

      if (command === "remember" && arg) {
        let tier: MemoryScope = "session";
        let content = arg;
        if (arg.startsWith("global:")) {
          tier = "global";
          content = arg.slice("global:".length).trim();
        } else if (arg.startsWith("project:")) {
          tier = "project";
          content = arg.slice("project:".length).trim();
        }
        if (!content) {
          postMessage(ctx.host, { type: "memoryError", message: `Nothing to remember — provide text after /remember${tier !== "session" ? ` ${tier}:` : ""}.` });
          return { kind: "handled" };
        }

        const memory = await deps.memoryService.saveMemory({
          content,
          kind: "fact",
          scope: tier,
          sessionId: ctx.session.memorySessionId,
          workspace: deps.workspacePath,
        });

        if (memory) postMessage(ctx.host, { type: "memoryCreated", memory });
        else postMessage(ctx.host, { type: "memoryError", message: "Failed to save memory." });
        return { kind: "handled" };
      }

      if (command === "note" && arg) {
        const note = await deps.memoryService.addNote(arg);
        if (note) postMessage(ctx.host, { type: "memoryCreated", memory: note });
        else postMessage(ctx.host, { type: "memoryError", message: "Failed to save note." });
        return { kind: "handled" };
      }
      return { kind: "handled" };
    }

    const compactMatch = trimmed.match(COMPACT_SLASH_RE);
    if (compactMatch) {
      const instructions = compactMatch[1]?.trim() ?? "";
      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      postMessage(ctx.host, stampUserMessage(ctx, originalTextContent, { correlationId }));
      await ctx.session.compact(instructions.length > 0 ? instructions : undefined);
      return { kind: "handled" };
    }

    let transformedContent: string | null = null;
    let preApprovedSkillName: string | null = null;
    const skillMatch = trimmed.match(SLASH_INVOCATION_RE);
    if (skillMatch) {
      const [, skillName, skillArgs] = skillMatch;
      if (skillName) {
        if (DIRECT_COMMANDS.has(skillName)) {
          const result = resolveDirectCommand(skillName);
          if (result.kind === "notification") {
            const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            postMessage(ctx.host, stampUserMessage(ctx, originalTextContent, { correlationId, isInjected: true }));
            postMessage(ctx.host, { type: "notification", message: result.content, notificationType: "info" });
            return { kind: "handled" };
          }
          transformedContent = result.content;
        } else {
          // Both lookups run before any branch: a withheld asset of one kind must not speak for a
          // working asset of the other kind that claims the same name. Both are memoized scans.
          const skill = await workspaceManager.findSkill(skillName);
          const command = await workspaceManager.findCommand(skillName);
          const skillRunnable = skill !== undefined && skill.untrusted !== true;
          const commandRunnable = command !== undefined && command.untrusted !== true;

          if (skillRunnable) {
            ctx.permissionHandler.preApproveSkill(skillName);
            preApprovedSkillName = skillName;
            transformedContent = skillArgs
              ? `Execute skill ${skillName}\nAdditional info: ${skillArgs}`
              : `Execute skill ${skillName}`;
          } else if (!commandRunnable && (skill !== undefined || command !== undefined)) {
            // Everything claiming this name is withheld from the agent, so passing it through would
            // send `/name` to the model as literal text.
            return refuseUntrusted(ctx);
          }
          // A runnable command needs no transform: pi expands the prompt template inside `prompt()`.
          // An unknown name passes through unchanged too.
        }
      }
    }

    return { kind: "passthrough", transformedContent, preApprovedSkillName };
  };

  return {
    sendMessage: async (msg, ctx) => {
      if (msg.type !== "sendMessage") return;

      const msgContent = msg.content;
      const originalTextContent = extractTextFromContent(msgContent);
      if (!originalTextContent.trim() && !hasImageContent(msgContent)) return;

      if (markUserTypedDuringTurn !== undefined) markUserTypedDuringTurn();

      const intercept = await tryInterceptLocal(originalTextContent, ctx);
      if (intercept.kind === "handled") {
        // Handled locally with no turn, so the optimistically-armed spinner has no lifecycle event to
        // clear it. Disarm it here — the extension owns whether a turn started.
        postMessage(ctx.host, { type: "processing", isProcessing: false });
        return;
      }

      const { transformedContent, preApprovedSkillName } = intercept;

      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const contentBlocks = hasImageContent(msgContent) ? (msgContent as UserContentBlock[]) : undefined;

      if (originalTextContent.trim()) {
        storageManager.broadcastPromptHistoryEntry(originalTextContent.trim());
      }

      const baseContent = transformedContent ?? msgContent;
      const finalContent = msg.includeIdeContext ? ctx.ideContextManager.buildContentBlocks(baseContent) : baseContent;

      try {
        await ctx.session.sendMessage(finalContent, msg.agentId, correlationId, {
          content: originalTextContent,
          ...(contentBlocks !== undefined ? { contentBlocks } : {}),
        });
      } catch (err) {
        if (preApprovedSkillName) {
          ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        }
        throw err;
      }
    },

    cancelSession: (_msg, ctx) => {
      ctx.session.cancel();
    },

    clearSession: async (_msg, ctx) => {
      ctx.session.clear();
      ctx.permissionHandler.applyDefaultDangerouslySkipPermissions();
      ctx.permissionHandler.clearSubagentAutoApprovals();
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      postMessage(ctx.host, { type: "conversationCleared" });
    },

    queueMessage: async (msg, ctx) => {
      if (msg.type !== "queueMessage") return;

      const msgContent = msg.content;
      const textContent = extractTextFromContent(msgContent);
      if (!textContent.trim() && !hasImageContent(msgContent)) return;

      if (markUserTypedDuringTurn !== undefined) markUserTypedDuringTurn();

      const intercept = await tryInterceptLocal(textContent, ctx);
      if (intercept.kind === "handled") return;

      const { transformedContent, preApprovedSkillName } = intercept;
      const contentToQueue: ContentInput = transformedContent ?? msgContent;

      const queuedMessage = createQueuedMessage(contentToQueue);
      const disposition = ctx.session.queueInput(contentToQueue, queuedMessage.id);

      if (disposition === "queued") {
        postMessage(ctx.host, { type: "messageQueued", message: queuedMessage });
        if (textContent.trim()) {
          storageManager.broadcastPromptHistoryEntry(textContent.trim());
        }
      } else if (disposition === "flushed") {
        if (textContent.trim()) {
          storageManager.broadcastPromptHistoryEntry(textContent.trim());
        }
      } else {
        if (preApprovedSkillName) {
          ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        }
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Cannot send mid-stream message: no active streaming session"),
          notificationType: "error",
        });
      }
    },

    resumeSession: async (msg, ctx) => {
      if (msg.type !== "resumeSession" || !msg.sessionId) return;

      ctx.session.setResumeSession(msg.sessionId);

      try {
        await deps.historyManager.loadSessionHistory(msg.sessionId, ctx.host, ctx.session);
        const rewindableIds = await deps.historyManager.extractRewindableUserIds(msg.sessionId);
        ctx.session.seedCheckpoints(rewindableIds);
        postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.sessionId });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        log("[MessageRouter] Error loading session history:", err);
        postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.sessionId });
      }
    },

    interrupt: async (_msg, ctx) => {
      await ctx.session.interrupt();
    },

    cancelToolCall: (msg, ctx) => {
      if (msg.type !== "cancelToolCall") return;
      if (ctx.session.cancelToolCall(msg.toolUseId, msg.note)) return;
      // A false return is the ordinary race of a click landing after the call finished, never an error.
      // It still has to be reported, because the webview marked the card "Stopping..." on the way in and
      // nothing else will ever clear that flag.
      postMessage(ctx.host, {
        type: "toolCancelRejected",
        toolUseId: msg.toolUseId,
        ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
      });
    },

    cancelAutoCompact: async (_msg, ctx) => {
      await ctx.session.cancelAutoCompact();
    },
  };
}

type DirectCommandResult =
  | { kind: "prompt"; content: string }
  | { kind: "notification"; content: string };

const INIT_PROMPT = `Analyze this codebase and create or update a \`CLAUDE.md\` file at the repository root with the guidance an AI coding agent needs to be productive here.

Inspect the project to determine, then document concisely:
- **Build / test / lint / dev commands** — read \`package.json\` scripts, Makefile/justfile targets, or the equivalent for this stack, and list the exact commands to build, run, test, typecheck, and lint.
- **Architecture** — the high-level structure: the main modules/packages, how they fit together, and the entry points. Describe the big picture that isn't obvious from a single file.
- **Conventions** — code style, patterns, and project-specific rules already evident in the code (naming, file layout, testing approach, error handling).
- **Gotchas** — non-obvious constraints, required setup, or pitfalls a new contributor would hit.

If a \`CLAUDE.md\` already exists, read it first and update it surgically — preserve still-accurate content, correct anything stale, and add what is missing. Keep it focused and skimmable; do not pad it with generic advice or restate what any developer already knows. When done, write the file and summarize what you changed.`;

function resolveDirectCommand(commandName: string): DirectCommandResult {
  if (commandName === "init") return { kind: "prompt", content: INIT_PROMPT };
  return { kind: "notification", content: `Unknown command: ${commandName}` };
}
