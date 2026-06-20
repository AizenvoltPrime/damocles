import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { getPiSessionMetadata } from "../../../pi-session/session-store";
import { resolveSessionFilePath } from "../../session-file-path";
import { DAMOCLES_PLANS_DIR } from "../../../auth/paths";
import { readWorkflowTranscripts, isWithinWorkflowsDir } from "../../../workflow-transcripts";
import { subagentTranscriptPath } from "../../../pi-session/subagents/output-file";
import { log } from "../../../logger";
import { openMarkdownPreview } from "../../../markdown-preview";

function hasPathTraversal(slug: string): boolean {
  return slug.includes("..") || slug.includes("/") || slug.includes("\\");
}

function resolvePlanFilePath(metadata: import("@shared/types/session").StoredSession | null): string | null {
  const plansDir = path.resolve(DAMOCLES_PLANS_DIR);
  if (metadata?.planPath) {
    const resolved = path.resolve(metadata.planPath);
    if (resolved.startsWith(plansDir + path.sep) || resolved === plansDir) return resolved;
    return null;
  }
  if (metadata?.slug && !hasPathTraversal(metadata.slug)) {
    return path.join(plansDir, `${metadata.slug}.md`);
  }
  return null;
}

export function createWorkspaceHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, settingsManager, workspaceManager, historyManager, setLanguagePreference } = deps;

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

      const metadata = await getPiSessionMetadata(workspacePath, sessionId);
      const planPath = resolvePlanFilePath(metadata);

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
      const metadata = await getPiSessionMetadata(workspacePath, sessionId);
      const existingPlanPath = resolvePlanFilePath(metadata);

      try {
        const content = await fs.readFile(selectedPath, "utf-8");

        if (existingPlanPath) {
          let fileExists = false;
          try {
            await fs.access(existingPlanPath);
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

          await fs.mkdir(path.dirname(existingPlanPath), { recursive: true });
          await fs.writeFile(existingPlanPath, content);

          ctx.session.disableThinkingForNextQuery();

          try {
            const notifyCorrelationId = `plan-notify-${Date.now()}`;
            await ctx.session.sendMessage(
              `[System] The plan file for this session has been updated. Plan file path: ${existingPlanPath}. Respond with "Got it. I'll use this plan as reference." - do not take any other action.`,
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
            message: vscode.l10n.t("Plan file updated: {0}", existingPlanPath),
            notificationType: "info",
          });
          log("[MessageRouter] Injected plan from %s to %s", selectedPath, existingPlanPath);
        } else {
          if (ctx.session.processing) {
            vscode.window.showWarningMessage(
              vscode.l10n.t("Cannot initialize plan mode while Claude is processing. Please wait and try again.")
            );
            return;
          }

          const previousMode = ctx.permissionHandler.getPermissionMode();

          await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, "plan");
          ctx.session.disableThinkingForNextQuery();
          await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);

          try {
            const notifyCorrelationId = `plan-notify-${Date.now()}`;
            await ctx.session.sendMessage(
              `[System] A plan file will be bound to this session. Respond with "Got it. I'll use this plan as reference." - do not take any other action.`,
              undefined,
              notifyCorrelationId,
              { content: "[System] Binding plan file..." },
              { isInternal: true },
            );
          } finally {
            await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, previousMode);
            ctx.session.restoreThinkingConfig();
            await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
          }

          const newSessionId = ctx.session.currentSessionId;
          let planWritten = false;
          if (newSessionId) {
            const newMetadata = await getPiSessionMetadata(workspacePath, newSessionId);
            if (newMetadata?.slug && !hasPathTraversal(newMetadata.slug)) {
              const newPlanPath = path.join(DAMOCLES_PLANS_DIR, `${newMetadata.slug}.md`);
              await fs.mkdir(path.dirname(newPlanPath), { recursive: true });
              await fs.writeFile(newPlanPath, content);
              log("[MessageRouter] Plan bound from %s to %s (slug: %s)", selectedPath, newPlanPath, newMetadata.slug);
              planWritten = true;
            }
          }

          postMessage(ctx.host, {
            type: "notification",
            message: planWritten
              ? vscode.l10n.t("Plan file bound to session")
              : vscode.l10n.t("Plan acknowledged but file could not be written (missing session slug)"),
            notificationType: planWritten ? "info" : "warning",
          });
        }
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
      const prompt = ctx.session.getSystemPromptText();
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
      try {
        await ctx.session.stopTask(msg.taskId);
        ctx.host.webview.postMessage({
          type: 'backgroundTaskCompleted',
          taskId: msg.taskId,
          status: 'stopped',
          summary: '',
          outputFile: null,
        });
      } catch (err) {
        log("[WorkspaceHandlers] Failed to stop background task %s: %s", msg.taskId, err);
        ctx.host.webview.postMessage({
          type: 'backgroundTaskCompleted',
          taskId: msg.taskId,
          status: 'failed',
          summary: `Failed to stop task: ${err instanceof Error ? err.message : String(err)}`,
          outputFile: null,
        });
      }
    },

    stopWorkflow: async (msg, ctx) => {
      if (msg.type !== "stopWorkflow" || !msg.taskId) return;
      try {
        await ctx.session.stopTask(msg.taskId);
        postMessage(ctx.host, {
          type: 'workflowResult',
          toolUseId: msg.toolUseId,
          taskId: msg.taskId,
          status: 'stopped',
          summary: '',
          result: '',
          outputFile: null,
        });
      } catch (err) {
        log("[WorkspaceHandlers] Failed to stop workflow %s: %s", msg.taskId, err);
        postMessage(ctx.host, {
          type: 'workflowResult',
          toolUseId: msg.toolUseId,
          taskId: msg.taskId,
          status: 'failed',
          summary: `Failed to stop workflow: ${err instanceof Error ? err.message : String(err)}`,
          result: '',
          outputFile: null,
        });
      }
    },

    getWorkflowTranscripts: async (msg, ctx) => {
      if (msg.type !== "getWorkflowTranscripts") return;
      // This on-open fetch is a one-shot seed (it fires only while transcripts are unset), so it
      // carries no seq: live pushes own the monotonic ordering and will correct it if they race.
      try {
        const agents = await readWorkflowTranscripts(msg.transcriptDir);
        postMessage(ctx.host, { type: "workflowTranscripts", toolUseId: msg.toolUseId, agents });
      } catch (err) {
        log("[WorkspaceHandlers] Failed to read workflow transcripts: %s", err);
        postMessage(ctx.host, {
          type: "workflowTranscripts",
          toolUseId: msg.toolUseId,
          agents: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    openWorkflowAgentLog: async (msg) => {
      if (msg.type !== "openWorkflowAgentLog") return;
      const dir = path.dirname(msg.logFile);
      if (!isWithinWorkflowsDir(dir)) {
        vscode.window.showWarningMessage(vscode.l10n.t("Refusing to open a log outside the workflows directory"));
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.logFile));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Agent log file not found: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    openWorkflowJournal: async (msg) => {
      if (msg.type !== "openWorkflowJournal") return;
      if (!isWithinWorkflowsDir(msg.transcriptDir)) {
        vscode.window.showWarningMessage(vscode.l10n.t("Refusing to open a log outside the workflows directory"));
        return;
      }
      try {
        const journalPath = path.join(msg.transcriptDir, "journal.jsonl");
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(journalPath));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Workflow log file not found: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },
  };
}
