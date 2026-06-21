import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { resolveSessionFilePath } from "../../session-file-path";
import { findSessionPlanFiles } from "../../../paths";
import { subagentTranscriptPath } from "../../../pi-session/subagents/output-file";
import { log } from "../../../logger";
import { openMarkdownPreview } from "../../markdown-preview";

function hasPathTraversal(slug: string): boolean {
  return slug.includes("..") || slug.includes("/") || slug.includes("\\");
}

export function createWorkspaceHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, workspaceManager, historyManager, setLanguagePreference } = deps;

  return {
    openSettings: () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "damocles");
    },

    invokeSignIn: (_msg, ctx) => {
      // Auth-failure recovery surfaces the panel-driven Claude auth flow (ClaudeAuthPanel lives in the
      // settings panel) rather than the removed CLI sign-in command.
      postMessage(ctx.host, { type: "openSettingsPanel" });
    },

    openSessionLog: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      const filePath = sessionId ? await resolveSessionFilePath(workspacePath, sessionId) : null;
      if (!filePath) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session to view"));
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
    },

    openAgentLog: async (msg, ctx) => {
      if (msg.type !== "openAgentLog") return;
      try {
        // agentId is webview-supplied and interpolated into a transcript path — reject traversal before
        // it reaches the path builder (extension-generated ids are safe; this guards the boundary).
        if (hasPathTraversal(msg.agentId)) throw new Error("Invalid agent id");
        // pi subagent transcripts live at ~/.damocles/pi/subagents/<enc-cwd>/<sessionId>/tasks/<agentId>.jsonl.
        // The card's agentId is the transcript file base.
        const sessionId = ctx.session.persistenceSessionId;
        if (!sessionId) throw new Error("No active session");
        const filePath = subagentTranscriptPath(workspacePath, sessionId, msg.agentId);
        const fileUri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Agent log file not found: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    openSessionPlan: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session"));
        return;
      }

      // Match by the session's stable plan-id suffix rather than recomputing the slug, so a plan bound
      // before the session's first message (when the slug was still the empty fallback) is still found.
      const planPath = (await findSessionPlanFiles(sessionId))[0] ?? null;

      if (!planPath) {
        vscode.window.showInformationMessage(vscode.l10n.t("No plan exists for this session"));
        return;
      }

      try {
        const content = await fs.readFile(planPath, "utf-8");
        postMessage(ctx.host, { type: "showPlanContent", content, filePath: planPath });
      } catch (err) {
        log("[MessageRouter] Error reading plan file:", err);
        vscode.window.showInformationMessage(vscode.l10n.t("No plan exists for this session"));
      }
    },

    bindPlanToSession: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session"));
        return;
      }

      const fileResult = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { Markdown: ["md"] },
        title: vscode.l10n.t("Select Plan File to Inject"),
        defaultUri: vscode.Uri.file(workspacePath),
      });

      if (!fileResult || fileResult.length === 0) return;
      const selectedFile = fileResult[0];
      if (!selectedFile) return;

      const selectedPath = selectedFile.fsPath;
      const planFilePath = ctx.session.getPlanFilePath();

      try {
        const content = await fs.readFile(selectedPath, "utf-8");

        let fileExists = false;
        try {
          await fs.access(planFilePath);
          fileExists = true;
        } catch {
          fileExists = false;
        }

        if (fileExists) {
          const confirmation = await vscode.window.showWarningMessage(
            vscode.l10n.t("A plan file already exists for this session. Overwrite it?"),
            { modal: true },
            vscode.l10n.t("Overwrite")
          );
          if (!confirmation) {
            return;
          }
        }

        await fs.mkdir(path.dirname(planFilePath), { recursive: true });
        await fs.writeFile(planFilePath, content);

        ctx.session.disableThinkingForNextQuery();

        try {
          const notifyCorrelationId = `plan-notify-${Date.now()}`;
          await ctx.session.sendMessage(
            `[System] The plan file for this session has been updated. Plan file path: ${planFilePath}. Respond with "Got it. I'll use this plan as reference." - do not take any other action.`,
            undefined,
            notifyCorrelationId,
            { content: "[System] Updating plan file..." },
            { isInternal: true },
          );
        } finally {
          ctx.session.restoreThinkingConfig();
        }

        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Plan file updated: {0}", planFilePath),
          notificationType: "info",
        });
        log("[MessageRouter] Injected plan from %s to %s", selectedPath, planFilePath);
      } catch (err) {
        log("[MessageRouter] Error injecting plan:", err);
        vscode.window.showErrorMessage(
          vscode.l10n.t("Failed to inject plan: {0}", err instanceof Error ? err.message : "Unknown error")
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

    requestWorkspaceFiles: async (_msg, ctx) => {
      await workspaceManager.sendWorkspaceFiles(ctx.host);
    },

    openFile: async (msg, ctx) => {
      if (msg.type !== "openFile") return;
      await workspaceManager.handleOpenFile(ctx.host, msg.filePath, msg.line);
    },

    openSystemPrompt: async (_msg, ctx) => {
      const prompt = await ctx.session.getSystemPromptText();
      if (!prompt) {
        vscode.window.showInformationMessage(vscode.l10n.t("The system prompt isn't available yet — send a message first."));
        return;
      }
      await openMarkdownPreview("system-prompt", prompt);
    },

    openMcpToolInfo: async (msg, ctx) => {
      if (msg.type !== "openMcpToolInfo") return;
      const markdown = ctx.session.getMcpToolInfoMarkdown(msg.piName);
      if (!markdown) {
        vscode.window.showInformationMessage(vscode.l10n.t("Tool information isn't available for \"{0}\".", msg.piName));
        return;
      }
      await openMarkdownPreview(msg.piName, markdown);
    },

    openRewindDiff: async (msg, ctx) => {
      if (msg.type !== "openRewindDiff") return;
      const sessionId = ctx.session.currentSessionId;
      const sanitizedPath = workspaceManager.resolveWorkspaceFilePath(msg.filePath);
      if (!sanitizedPath) {
        log("[MessageRouter] Rejecting rewind diff for out-of-workspace path:", msg.filePath);
        return;
      }
      if (!sessionId) {
        await workspaceManager.handleOpenFile(ctx.host, sanitizedPath);
        return;
      }
      try {
        const beforeContent = await historyManager.getFileCheckpointContent(
          sessionId,
          msg.userMessageId,
          sanitizedPath,
        );
        if (beforeContent === null) {
          await workspaceManager.handleOpenFile(ctx.host, sanitizedPath);
          return;
        }
        await workspaceManager.showRewindDiff(sanitizedPath, beforeContent);
      } catch (err) {
        log("[MessageRouter] Error opening rewind diff:", err);
        await workspaceManager.handleOpenFile(ctx.host, sanitizedPath);
      }
    },

    openExternalUrl: async (msg) => {
      if (msg.type !== "openExternalUrl") return;
      await vscode.env.openExternal(vscode.Uri.parse(msg.url));
    },

    requestCustomSlashCommands: async (_msg, ctx) => {
      await workspaceManager.sendCustomSlashCommands(ctx.host);
    },

    requestCustomAgents: async (_msg, ctx) => {
      await workspaceManager.sendCustomAgents(ctx.host);
    },

    setLanguagePreference: async (msg) => {
      if (msg.type !== "setLanguagePreference") return;
      await setLanguagePreference(msg.locale);
    },

    stopBackgroundTask: async (msg, ctx) => {
      if (msg.type !== "stopBackgroundTask" || !msg.taskId) return;
      // Aborting the subagent emits the authoritative `backgroundTaskCompleted` (status `stopped`)
      // from AgentManager; don't optimistically post one here or the store double-counts the stop.
      await ctx.session.stopTask(msg.taskId);
    },

  };
}
