import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { UserContentBlock } from "../../../../shared/types/content";
import type { ContentInput } from "../../../session-types";
import type { QueueRefusal, SendOutcome } from "../../../chat-session";
import type { MemoryScope } from "../../../../shared/types/memory";
import { SLASH_INVOCATION_RE } from "../../../../shared/asset-names";
import { createQueuedMessage } from "../../queue-manager";
import { forgetSender, recordSender } from "../../send-senders";
import { resumeStoredSession } from "./resume-session";
import { extractTextFromContent, hasImageContent } from "../../../../shared/utils";
import { l } from "../../../l10n";
import type { LocalizedText } from "../../../../shared/localized-text";
import { settingsFolderOf } from "../../../workspace-folders/folder-registry";
import { identityFolder } from "../../../worktrees/personal-config";
import { MAX_PENDING_TERMINAL_ATTACHMENTS, type TakenAttachment } from "../../terminal-attachment-manager";
import { attachmentContent } from "../../mcp-resource-attachments";
import { READ_MCP_RESOURCE } from "../../../permission-handler/mcp-resource-rule";

/** Build the echo of a locally-handled slash command that bypasses sendMessage. It commits no user
 *  entry, so it is injected: it names no prompt and carries the latest prompt's index, as a cancel note does. */
function stampUserMessage(
  ctx: HandlerContext,
  content: string,
  opts: { contentBlocks?: UserContentBlock[]; correlationId: string },
): import("../../../../shared/types/messages").ExtensionToWebviewMessage {
  return {
    type: "userMessage",
    content,
    correlationId: opts.correlationId,
    promptIndex: ctx.session.currentPromptIndex,
    ...(opts.contentBlocks !== undefined ? { contentBlocks: opts.contentBlocks } : {}),
    isInjected: true,
    isCommandEcho: true,
  };
}

/** The conversation a webview send names; anything but a string names none. */
function sendTarget(sessionId: unknown): string | undefined {
  return typeof sessionId === "string" ? sessionId : undefined;
}

type InterceptResult =
  | { kind: "handled" }
  | { kind: "passthrough"; transformedContent: string | null; preApprovedSkillName: string | null };

const MEMORY_SLASH_RE = /^\/(remember|note|memories)(?:\s+(.*))?$/;
const COMPACT_SLASH_RE = /^\/compact(?:\s+(.*))?$/;

/** Builtins expanded to a canonical prompt before handing the turn to the agent. */
const DIRECT_COMMANDS: ReadonlySet<string> = new Set(["init"]);

type QueueRefusedReason = "queueRunEnded" | "queueBudgetStopped" | "queueNoRuntime";

/** The reason a refused queued message comes back with, so its note names why core refused it. */
const QUEUE_REFUSED_REASONS: Readonly<Record<QueueRefusal, QueueRefusedReason>> = {
  runEnded: "queueRunEnded",
  budgetStopped: "queueBudgetStopped",
  noRuntime: "queueNoRuntime",
};

export function createChatHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, workspaceManager, markUserTypedDuringTurn } = deps;

  /** A send core refused before it started goes back to the sender's composer; a turn already running owns the spinner. */
  const returnRefusedSend = (ctx: HandlerContext, content: string | UserContentBlock[], reason: "sendInProgress" | QueueRefusedReason, correlationId?: string): void => {
    if (!ctx.session.turnRunning) postMessage(ctx.reply, { type: "processing", isProcessing: false });
    postMessage(ctx.reply, {
      type: "promptReturned",
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      reason,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  };

  /** Withheld project-scope asset: no turn is sent, since the agent never loaded it. */
  const refuseUntrusted = (ctx: HandlerContext): InterceptResult => {
    postMessage(ctx.reply, {
      type: "notification",
      message: l(
        "This workspace is not trusted, so project skills and commands are not loaded. Trust the workspace to run them.",
      ),
      notificationType: "warning",
    });
    return { kind: "handled" };
  };

  const tryInterceptLocal = async (
    originalTextContent: string,
    ctx: HandlerContext,
    target: string | undefined,
  ): Promise<InterceptResult> => {
    const trimmed = originalTextContent.trim();

    const memoryMatch = trimmed.match(MEMORY_SLASH_RE);
    if (memoryMatch) {
      const [, command, rawArg] = memoryMatch;
      const arg = rawArg?.trim() ?? "";
      // Memory commands are side-effects, not conversation — they surface their own feedback and
      // leave no chat bubble or session entry.

      if (command === "memories") {
        postMessage(ctx.reply, { type: "openMemoryPanel" });
        return { kind: "handled" };
      }

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.reply, { type: "memoryError", message: l("Memory system is not available") });
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
          postMessage(ctx.reply, { type: "memoryError", message: tier === "session" ? l("Nothing to remember: provide text after /remember.") : l("Nothing to remember: provide text after /remember {0}:.", tier) });
          return { kind: "handled" };
        }

        const memory = await deps.memoryService.saveMemory({
          content,
          kind: "fact",
          scope: tier,
          sessionId: ctx.session.memorySessionId,
          workspace: identityFolder(ctx.folder.fsPath),
        });

        if (memory) postMessage(ctx.reply, { type: "memoryCreated", memory });
        else postMessage(ctx.reply, { type: "memoryError", message: l("Failed to save memory.") });
        return { kind: "handled" };
      }

      if (command === "note" && arg) {
        const note = await deps.memoryService.addNote(arg);
        if (note) postMessage(ctx.reply, { type: "memoryCreated", memory: note });
        else postMessage(ctx.reply, { type: "memoryError", message: l("Failed to save note.") });
        return { kind: "handled" };
      }
      return { kind: "handled" };
    }

    const compactMatch = trimmed.match(COMPACT_SLASH_RE);
    if (compactMatch) {
      const instructions = compactMatch[1]?.trim() ?? "";
      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // A refused compaction says why itself, and leaves no echo of the command it refused.
      await ctx.session.compact(instructions.length > 0 ? instructions : undefined, () => {
        postMessage(ctx.host, stampUserMessage(ctx, originalTextContent, { correlationId }));
      }, target);
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
            postMessage(ctx.reply, stampUserMessage(ctx, originalTextContent, { correlationId }));
            postMessage(ctx.reply, { type: "notification", message: result.content, notificationType: "info" });
            return { kind: "handled" };
          }
          transformedContent = result.content;
        } else {
          // Both lookups run before any branch: a withheld asset of one kind must not speak for a
          // working asset of the other kind that claims the same name. Both are memoized scans.
          const skill = await workspaceManager.findSkill(skillName, ctx.folder);
          const command = await workspaceManager.findCommand(skillName, ctx.folder);
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

      const target = sendTarget(msg.sessionId);
      const intercept = await tryInterceptLocal(originalTextContent, ctx, target);
      if (intercept.kind === "handled") {
        // Handled locally with no turn, so the optimistically-armed spinner has no lifecycle event to clear it.
        // A turn already running owns the spinner: the composer's Compact now sends here mid-turn.
        if (!ctx.session.turnRunning) postMessage(ctx.reply, { type: "processing", isProcessing: false });
        return;
      }

      const { transformedContent, preApprovedSkillName } = intercept;

      // An opted-in chat's first prompt waits for its worktree and setup (slice 12a rule 4); its dispatch runs this handler again.
      if (deps.worktrees().interceptSend(ctx.panelId, msg)) {
        if (preApprovedSkillName) ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        return;
      }

      const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      recordSender(ctx.host, ctx.viewKey, correlationId);
      const contentBlocks = hasImageContent(msgContent) ? (msgContent as UserContentBlock[]) : undefined;
      const baseContent = transformedContent ?? msgContent;
      const ids = msg.terminalAttachmentIds;
      const validIds = Array.isArray(ids) && ids.length <= MAX_PENDING_TERMINAL_ATTACHMENTS && ids.every((id) => typeof id === "string");
      const sending = validIds ? ctx.terminalAttachments.displayInfo().filter((info) => ids.includes(info.id)) : [];
      const attaching = validIds && sending.length > 0;
      // the sending device's editor, on a daemon's core whose devices each have their own
      const sender = deps.platform.remote?.clients.actor();
      const withIde = msg.includeIdeContext === true && ctx.ideContextManager.getDisplayInfo(sender) !== null;
      // pi acts on a slash invocation only at the start of the prompt text, so one that blocks will lead is resolved first.
      const baseText = extractTextFromContent(baseContent);
      const slash = transformedContent === null && (attaching || withIde) && baseText.startsWith("/")
        ? await ctx.session.resolveSlashInvocation(baseText)
        : null;
      const broadcast = { content: originalTextContent, ...(contentBlocks !== undefined ? { contentBlocks } : {}) };
      let attached: readonly TakenAttachment[] = [];
      let restored = false;
      // Once: a Stop returns the chips through the session, and every exit below that did not send them returns them too.
      const restoreAttached = (): void => {
        if (restored || attached.length === 0) return;
        restored = true;
        const dropped = ctx.terminalAttachments.restore(attached);
        if (dropped === 0) return;
        postMessage(ctx.reply, {
          type: "notification",
          message: dropped === 1
            ? l("An attachment added while your message was being sent did not fit beside the ones it gave back, so it was removed.")
            : l("{0} attachments added while your message was being sent did not fit beside the ones it gave back, so they were removed.", dropped),
          notificationType: "warning",
        });
      };
      // Claimed before the chips leave the composer, so a Stop, New chat or disposal during the read returns them.
      const ticket = ctx.session.beginSend(correlationId, broadcast, restoreAttached);
      if (!ticket) {
        forgetSender(ctx.host, correlationId);
        if (preApprovedSkillName) ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        // A turn, a send or a compaction started meanwhile; the chips were never taken.
        returnRefusedSend(ctx, msgContent, "sendInProgress", correlationId);
        return;
      }
      // Recorded only for a send the session took, so a refused one, which goes back to its composer, is in no view's history.
      if (originalTextContent.trim()) storageManager.broadcastPromptHistoryEntry(originalTextContent.trim());

      if (slash?.kind === "command") {
        if (attaching) {
          const terminalOnly = sending.every((info) => info.kind === "terminal");
          postMessage(ctx.reply, {
            type: "notification",
            message: terminalOnly
              ? l("A command takes no terminal output, so the attached output stays in the composer for your next message.")
              : l("A command takes no attachments, so they stay in the composer for your next message."),
            notificationType: "info",
          });
        }
        try {
          await ctx.session.sendMessage(baseContent, target, correlationId, broadcast, undefined, ticket);
        } finally {
          ticket.end();
          // an extension command commits no prompt, so nothing names its send once pi ran it
          forgetSender(ctx.host, correlationId);
        }
        return;
      }

      const typedContent = slash?.kind === "expanded" ? withText(baseContent, slash.text) : baseContent;
      const withIdeContext = withIde ? ctx.ideContextManager.buildContentBlocks(typedContent, sender) : typedContent;
      attached = attaching ? ctx.terminalAttachments.take(ids) : [];
      let outcome: SendOutcome = "unsent";
      try {
        // D12: an attached MCP resource is read now, and any refusal returns the whole message to the composer unsent.
        const built = await attachmentContent(attached, contentBlocks?.filter((block) => block.type === "image").length ?? 0, async () => ({
          port: ctx.session.mcpUserResources(),
          filter: await ctx.permissionHandler.mcpResourceRuleFilter(READ_MCP_RESOURCE),
        }), ticket.signal);
        // The Stop, New chat or disposal already returned the message.
        if (ticket.signal.aborted || "stopped" in built) return;
        if (!built.ok) {
          // A turn already running owns the spinner.
          if (!ctx.session.turnRunning) postMessage(ctx.reply, { type: "processing", isProcessing: false });
          postMessage(ctx.reply, {
            type: "promptReturned",
            content: typeof msgContent === "string" ? [{ type: "text", text: msgContent }] : msgContent,
            reason: "mcpResourceUnavailable",
            detail: built.reason,
          });
          return;
        }
        // Each attachment block starts its own line of the prompt (`extractText` joins blocks with "\n"), ahead of the IDE block and the typed text.
        const finalContent: ContentInput = attached.length === 0 ? withIdeContext : [
          ...built.blocks.map((text) => ({ type: "text" as const, text })),
          ...(typeof withIdeContext === "string" ? [{ type: "text" as const, text: withIdeContext }] : withIdeContext),
          ...built.images,
        ];
        outcome = await ctx.session.sendMessage(finalContent, target, correlationId, {
          ...broadcast,
          ...(attached.length > 0 ? { terminalAttachments: attached.map(({ info }) => info) } : {}),
          ...(built.images.length > 0 ? { attachmentImageCount: built.images.length } : {}),
        }, restoreAttached, ticket);
      } finally {
        ticket.end();
        // The chips leave the composer only with a prompt pi took; a later drop of it returns them through the session.
        if (outcome !== "sent") {
          forgetSender(ctx.host, correlationId);
          restoreAttached();
          if (preApprovedSkillName) ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        }
      }
    },

    removeTerminalAttachment: (msg, ctx) => {
      if (msg.type !== "removeTerminalAttachment" || typeof msg.id !== "string") return;
      ctx.terminalAttachments.remove(msg.id);
    },

    cancelSession: (_msg, ctx) => {
      ctx.session.cancel();
    },

    clearSession: async (_msg, ctx) => {
      ctx.session.clear();
      ctx.permissionHandler.resetForNewConversation(settingsFolderOf(ctx.folder));
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
      postMessage(ctx.host, { type: "conversationCleared" });
    },

    queueMessage: async (msg, ctx) => {
      if (msg.type !== "queueMessage") return;

      const msgContent = msg.content;
      const textContent = extractTextFromContent(msgContent);
      if (!textContent.trim() && !hasImageContent(msgContent)) return;

      if (markUserTypedDuringTurn !== undefined) markUserTypedDuringTurn();

      const target = sendTarget(msg.sessionId);
      const intercept = await tryInterceptLocal(textContent, ctx, target);
      if (intercept.kind === "handled") return;

      const { transformedContent, preApprovedSkillName } = intercept;
      const contentToQueue: ContentInput = transformedContent ?? msgContent;

      const queuedMessage = createQueuedMessage(contentToQueue);
      recordSender(ctx.host, ctx.viewKey, queuedMessage.id);
      const disposition = ctx.session.queueInput(contentToQueue, queuedMessage.id, textContent, target);
      // only a queued message's chip is answered later (processed, put back or cancelled)
      if (disposition !== "queued") forgetSender(ctx.host, queuedMessage.id);

      if (disposition === "otherConversation") {
        if (preApprovedSkillName) ctx.permissionHandler.revokeSkillPreApproval(preApprovedSkillName);
        postMessage(ctx.reply, {
          type: "promptReturned",
          content: typeof msgContent === "string" ? [{ type: "text", text: msgContent }] : msgContent,
          reason: "conversationChanged",
        });
      } else if (disposition === "queued") {
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
        returnRefusedSend(ctx, msgContent, QUEUE_REFUSED_REASONS[disposition]);
      }
    },

    resumeSession: async (msg, ctx) => {
      if (msg.type !== "resumeSession" || !msg.sessionId) return;
      await resumeStoredSession(deps, ctx.panelId, msg.sessionId);
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
      postMessage(ctx.reply, {
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

/** `content` with its text replaced by `text`, as pi would send it; image blocks stay. */
function withText(content: ContentInput, text: string): ContentInput {
  if (typeof content === "string") return text;
  return [{ type: "text", text }, ...content.filter((block) => block.type !== "text")];
}

type DirectCommandResult =
  | { kind: "prompt"; content: string }
  | { kind: "notification"; content: LocalizedText };

const INIT_PROMPT = `Analyze this codebase and create or update a \`CLAUDE.md\` file at the repository root with the guidance an AI coding agent needs to be productive here.

Inspect the project to determine, then document concisely:
- **Build / test / lint / dev commands** — read \`package.json\` scripts, Makefile/justfile targets, or the equivalent for this stack, and list the exact commands to build, run, test, typecheck, and lint.
- **Architecture** — the high-level structure: the main modules/packages, how they fit together, and the entry points. Describe the big picture that isn't obvious from a single file.
- **Conventions** — code style, patterns, and project-specific rules already evident in the code (naming, file layout, testing approach, error handling).
- **Gotchas** — non-obvious constraints, required setup, or pitfalls a new contributor would hit.

If a \`CLAUDE.md\` already exists, read it first and update it surgically — preserve still-accurate content, correct anything stale, and add what is missing. Keep it focused and skimmable; do not pad it with generic advice or restate what any developer already knows. When done, write the file and summarize what you changed.`;

function resolveDirectCommand(commandName: string): DirectCommandResult {
  if (commandName === "init") return { kind: "prompt", content: INIT_PROMPT };
  return { kind: "notification", content: l("Unknown command: {0}", commandName) };
}
