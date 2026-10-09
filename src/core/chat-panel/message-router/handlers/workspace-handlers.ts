import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import type { Platform } from "../../../../platform/platform";
import type { ChatSession } from "../../../chat-session";
import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import { listWorkspaceFiles } from "../../ripgrep";
import { resolveSessionFilePath } from "../../session-file-path";
import { findSessionPlanFiles } from "../../../paths";
import { findAgentFile, subagentsDir } from "../../../pi-session/agent-records";
import { ensurePiSessionDir } from "../../../pi-session/session-store/session-dir";
import { log } from "../../../logger";
import { t } from "../../../l10n";
import { openMarkdownPreview } from "../../markdown-preview";
import { mentionInChat } from "../../mention-resolver";
import { parseFileDragTarget } from "../../../../shared/file-drag";
import { isSettingsAccountId, isSettingsSectionId } from "../../../../shared/settings-sections";

function hasPathTraversal(slug: string): boolean {
  return slug.includes("..") || slug.includes("/") || slug.includes("\\");
}

const PLAN_CANDIDATE_LIMIT = 8;

/** A markdown file under a `plans` folder at any depth, or whose name has "plan" as a word (`PLAN.md`, `rollout-plan.md`, `rolloutPlan.md`). */
export function isPlanFileCandidate(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const name = segments.pop() ?? "";
  if (!name.toLowerCase().endsWith(".md")) return false;
  if (segments.some((segment) => segment.toLowerCase() === "plans")) return true;
  const words = name.slice(0, -".md".length).split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/);
  return words.some((word) => word.toLowerCase() === "plan");
}

/** The folder's plan files from the `@` autocomplete's listing (same excludes), newest first. */
async function planFileCandidates(
  host: Pick<Platform, "settings" | "paths">,
  folderPath: string,
): Promise<{ fsPath: string; relativePath: string; modifiedAt: number }[]> {
  const listed = (await listWorkspaceFiles(host, folderPath)).filter(
    (file) => !file.isDirectory && isPlanFileCandidate(file.relativePath),
  );
  const stated = await Promise.all(listed.map(async ({ relativePath }) => {
    const fsPath = path.join(folderPath, relativePath);
    try {
      return { fsPath, relativePath, modifiedAt: (await fs.stat(fsPath)).mtimeMs };
    } catch (err) {
      // Deleted between the listing and the stat.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }));
  return stated
    .filter((file) => file !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, PLAN_CANDIDATE_LIMIT);
}

export function createWorkspaceHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, workspaceManager, historyManager, setLanguagePreference, platform } = deps;

  /** A folder list computed after the panel switched away would overwrite the new folder's list. */
  const stillOnDispatchFolder = (ctx: HandlerContext): boolean =>
    deps.getPanels().get(ctx.panelId)?.folder.key === ctx.folder.key;

  /**
   * Per panel, the plan files its last planFileCandidates listed, by issued id, and the session they were listed for;
   * bindPlanToSession reads only these. A folder switch replaces the session, which retires the ids.
   */
  const issuedPlanFiles = new Map<string, { session: ChatSession; files: Map<string, string> }>();

  /** False, issuing nothing, when the panel closed or replaced the session the listing ran for. */
  const issuePlanFiles = (ctx: HandlerContext, files: Map<string, string>): boolean => {
    const instance = deps.getPanels().get(ctx.panelId);
    if (instance?.session !== ctx.session) return false;
    if (!issuedPlanFiles.has(ctx.panelId)) {
      instance.disposables.push({ dispose: () => issuedPlanFiles.delete(ctx.panelId) });
    }
    issuedPlanFiles.set(ctx.panelId, { session: ctx.session, files });
    return true;
  };

  return {
    openSettings: () => {
      void platform.editor.openHostSettings("damocles");
    },

    openAppSettings: (msg, ctx) => {
      if (msg.type !== "openAppSettings") return;
      if (msg.section !== undefined && !isSettingsSectionId(msg.section)) throw new Error("Unknown settings section");
      if (msg.account !== undefined && !isSettingsAccountId(msg.account)) throw new Error("Unknown settings account");
      if (platform.capabilities.settingsInPanel) {
        postMessage(ctx.host, {
          type: "openSettingsPanel",
          ...(msg.section !== undefined ? { section: msg.section } : {}),
          ...(msg.account !== undefined ? { account: msg.account } : {}),
        });
      } else {
        platform.window.openAppSettings(msg.section, msg.account);
      }
    },

    toggleTerminal: () => {
      platform.window.toggleTerminal();
    },

    openSessionLog: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      const filePath = sessionId ? await resolveSessionFilePath(ctx.folder.fsPath, sessionId) : null;
      if (!filePath) {
        void platform.notifications.info(t("No active session to view"));
        return;
      }
      await platform.editor.openFile(filePath, { editor: "text", preview: false, panelId: ctx.panelId });
    },

    openAgentLog: async (msg, ctx) => {
      if (msg.type !== "openAgentLog") return;
      try {
        // agentId is webview-supplied: reject traversal at the boundary.
        if (hasPathTraversal(msg.agentId)) throw new Error("Invalid agent id");
        const sessionId = ctx.session.persistenceSessionId;
        if (!sessionId) throw new Error("No active session");
        const filePath = await findAgentFile(subagentsDir(ensurePiSessionDir(ctx.folder.fsPath), sessionId), msg.agentId);
        if (!filePath) {
          void platform.notifications.info(
            t("This agent has no log file. A log is written once the agent receives its task."),
          );
          return;
        }
        await platform.editor.openFile(filePath, { editor: "text", preview: false, panelId: ctx.panelId });
      } catch (err) {
        void platform.notifications.warn(
          t("Agent log file not found: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    openSessionPlan: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        void platform.notifications.info(t("No active session"));
        return;
      }

      // Match by the session's stable plan-id suffix rather than recomputing the slug, so a plan bound
      // before the session's first message (when the slug was still the empty fallback) is still found.
      const planPath = (await findSessionPlanFiles(sessionId))[0] ?? null;

      if (!planPath) {
        void platform.notifications.info(t("No plan exists for this session"));
        return;
      }

      try {
        const content = await fs.readFile(planPath, "utf-8");
        postMessage(ctx.host, { type: "showPlanContent", content, filePath: planPath });
      } catch (err) {
        log("[MessageRouter] Error reading plan file:", err);
        void platform.notifications.info(t("No plan exists for this session"));
      }
    },

    // Every request is answered, or the overlay never leaves its loading state.
    requestPlanFileCandidates: async (_msg, ctx) => {
      let hasPlan = false;
      let files: Awaited<ReturnType<typeof planFileCandidates>>;
      try {
        hasPlan = (await ctx.session.getActivePlanFilePath()) !== null;
        files = await planFileCandidates(platform, ctx.folder.fsPath);
      } catch (err) {
        log("[MessageRouter] Listing plan files in %s failed: %O", ctx.folder.fsPath, err);
        issuePlanFiles(ctx, new Map());
        postMessage(ctx.host, { type: "planFileCandidates", files: [], hasPlan, listFailed: true });
        return;
      }
      const issued = new Map<string, string>();
      const listed = files.map((file) => {
        const id = randomUUID();
        issued.set(id, file.fsPath);
        return { id, relativePath: file.relativePath, modifiedAt: file.modifiedAt };
      });
      if (!issuePlanFiles(ctx, issued)) {
        postMessage(ctx.host, { type: "planFileCandidates", files: [], hasPlan: false });
        return;
      }
      postMessage(ctx.host, { type: "planFileCandidates", files: listed, hasPlan });
    },

    bindPlanToSession: async (msg, ctx) => {
      if (msg.type !== "bindPlanToSession") return;
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        void platform.notifications.info(t("No active session"));
        return;
      }

      let selectedPath: string;
      if (msg.candidateId === undefined) {
        const picked = await platform.dialogs.pickFile({
          filters: { Markdown: ["md"] },
          title: t("Select Plan File to Inject"),
          defaultPath: ctx.folder.fsPath,
        });
        if (!picked) return;
        selectedPath = picked;
      } else {
        const entry = issuedPlanFiles.get(ctx.panelId);
        const issued = entry?.session === ctx.session ? entry.files.get(msg.candidateId) : undefined;
        if (!issued) {
          log("[MessageRouter] Refusing to bind plan candidate %s, which this panel's last list for this session did not issue", msg.candidateId);
          return;
        }
        selectedPath = issued;
      }

      // Overwrite the session's EXISTING plan file in place when one is already bound (matched on the
      // stable `-<id8>` suffix, the same resolver consumers read), so binding again never leaves an
      // orphan under a drifted slug. A never-bound session gets the deterministic fresh path.
      const planFilePath = (await ctx.session.getActivePlanFilePath()) ?? ctx.session.getPlanFilePath();

      try {
        const content = await fs.readFile(selectedPath, "utf-8");
        await fs.mkdir(path.dirname(planFilePath), { recursive: true });
        await fs.writeFile(planFilePath, content);

        postMessage(ctx.host, {
          type: "notification",
          message: t("Plan file updated: {0}", planFilePath),
          notificationType: "info",
        });
        log("[MessageRouter] Injected plan from %s to %s", selectedPath, planFilePath);
      } catch (err) {
        log("[MessageRouter] Error injecting plan:", err);
        void platform.notifications.error(
          t("Failed to inject plan: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    requestContextUsage: async (_msg, ctx) => {
      await ctx.session.requestContextUsage();
    },

    requestContextInjection: async (msg, ctx) => {
      if (msg.type !== "requestContextInjection") return;
      if (!Number.isInteger(msg.promptIndex) || msg.promptIndex < 0) return;
      const memoryData = await ctx.session.getMemoryInjection(msg.promptIndex) ?? null;
      postMessage(ctx.host, { type: "contextInjectionLoaded", promptIndex: msg.promptIndex, memoryData });
    },

    // A file dropped on the composer names a project and a relative path; core confines it (mention-resolver.ts).
    mentionDropped: async (msg, ctx) => {
      if (msg.type !== "mentionDropped") return;
      const target = parseFileDragTarget(msg.projectKey, msg.relativePath);
      if (!target) throw new Error("Malformed file drop");
      const instance = deps.getPanels().get(ctx.panelId);
      await mentionInChat(
        { folders: deps.folderRegistry, confinement: platform.confinement, notifications: platform.notifications, post: (message) => postMessage(ctx.host, message) },
        target,
        (instance?.folder ?? ctx.folder).fsPath,
      );
    },

    requestWorkspaceFiles: async (_msg, ctx) => {
      const message = await workspaceManager.workspaceFilesMessage(ctx.folder);
      if (stillOnDispatchFolder(ctx)) postMessage(ctx.host, message);
    },

    openFile: async (msg, ctx) => {
      if (msg.type !== "openFile") return;
      await workspaceManager.handleOpenFile(ctx.panelId, msg.filePath, msg.line, ctx.folder);
    },

    openSystemPrompt: async (_msg, ctx) => {
      const prompt = await ctx.session.getSystemPromptText();
      if (!prompt) {
        void platform.notifications.info(t("The system prompt isn't available yet. Send a message first."));
        return;
      }
      await openMarkdownPreview(platform, "system-prompt", prompt, ctx.panelId);
    },

    openMcpToolInfo: async (msg, ctx) => {
      if (msg.type !== "openMcpToolInfo") return;
      const markdown = ctx.session.getMcpToolInfoMarkdown(msg.piName);
      if (!markdown) {
        void platform.notifications.info(t("Tool information isn't available for \"{0}\".", msg.piName));
        return;
      }
      await openMarkdownPreview(platform, msg.piName, markdown, ctx.panelId);
    },

    openRewindDiff: async (msg, ctx) => {
      if (msg.type !== "openRewindDiff") return;
      const sessionId = ctx.session.currentSessionId;
      const sanitizedPath = workspaceManager.resolveWorkspaceFilePath(msg.filePath, ctx.folder);
      if (!sanitizedPath) {
        log("[MessageRouter] Rejecting rewind diff for a path outside the panel folder:", msg.filePath);
        return;
      }
      if (!sessionId) {
        await workspaceManager.handleOpenFile(ctx.panelId, sanitizedPath, undefined, ctx.folder);
        return;
      }
      try {
        const beforeContent = await historyManager.getFileCheckpointContent(
          ctx.folder.fsPath,
          sessionId,
          msg.userMessageId,
          sanitizedPath,
        );
        if (beforeContent === null) {
          await workspaceManager.handleOpenFile(ctx.panelId, sanitizedPath, undefined, ctx.folder);
          return;
        }
        await workspaceManager.showRewindDiff(sanitizedPath, beforeContent, ctx.panelId);
      } catch (err) {
        log("[MessageRouter] Error opening rewind diff:", err);
        await workspaceManager.handleOpenFile(ctx.panelId, sanitizedPath, undefined, ctx.folder);
      }
    },

    openExternalUrl: async (msg) => {
      if (msg.type !== "openExternalUrl") return;
      await platform.shell.openExternal(msg.url);
    },

    requestCustomSlashCommands: async (_msg, ctx) => {
      const message = await workspaceManager.customSlashCommandsMessage(ctx.folder);
      if (stillOnDispatchFolder(ctx)) postMessage(ctx.host, message);
    },

    requestSteerTargets: (_msg, ctx) => {
      postMessage(ctx.host, { type: "steerTargets", agents: ctx.session.listSteerTargets() });
    },

    requestCustomAgents: async (_msg, ctx) => {
      await workspaceManager.sendCustomAgents(ctx.host);
    },

    setLanguagePreference: async (msg) => {
      if (msg.type !== "setLanguagePreference") return;
      await setLanguagePreference(msg.locale);
    },

    stopSubagent: (msg, ctx) => {
      if (msg.type !== "stopSubagent") return;
      // The stopped run's own completion resolves the card and the task, so a stop that landed posts nothing here.
      if (ctx.session.stopSubagent(msg.agentId)) return;
      // A late click: the agent had already finished, and nothing else clears the webview's "Stopping..." state.
      postMessage(ctx.host, { type: "subagentStopRejected", agentId: msg.agentId });
    },

    steerAgent: async (msg, ctx) => {
      if (msg.type !== "steerAgent") return;
      await ctx.session.steerTarget(msg.agentId, msg.message, msg.images, msg.requestId);
    },

  };
}
