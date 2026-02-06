import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { getSessionFilePath, getAgentFilePath, getSessionMetadata } from "../../../session";
import { log } from "../../../logger";

export function createWorkspaceHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, settingsManager, workspaceManager, setLanguagePreference } = deps;

  return {
    openSettings: () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "damocles");
    },

    openSessionLog: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      if (sessionId) {
        const filePath = await getSessionFilePath(workspacePath, sessionId);
        const fileUri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session to view"));
      }
    },

    openAgentLog: async (msg) => {
      if (msg.type !== "openAgentLog") return;
      try {
        const filePath = await getAgentFilePath(workspacePath, msg.agentId);
        const fileUri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Agent log file not found: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    openSessionContext: async (_msg, ctx) => {
      const context = ctx.session.getDistillContext();
      if (!context) {
        vscode.window.showInformationMessage(vscode.l10n.t("No context available for this session"));
        return;
      }
      postMessage(ctx.panel, { type: "showContextContent", content: context.content, filePath: context.filePath });
    },

    openSessionPlan: async (_msg, ctx) => {
      const sessionId = ctx.session.currentSessionId;
      if (!sessionId) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session"));
        return;
      }

      const metadata = await getSessionMetadata(workspacePath, sessionId);

      if (!metadata?.slug) {
        vscode.window.showInformationMessage(vscode.l10n.t("No plan exists for this session"));
        return;
      }

      const slug = metadata.slug;
      if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
        log("[MessageRouter] Invalid plan slug detected:", slug);
        vscode.window.showInformationMessage(vscode.l10n.t("No plan exists for this session"));
        return;
      }

      const planPath = path.join(os.homedir(), ".claude", "plans", `${slug}.md`);

      try {
        const content = await fs.readFile(planPath, "utf-8");
        postMessage(ctx.panel, { type: "showPlanContent", content, filePath: planPath });
      } catch (err) {
        log("[MessageRouter] Error reading plan file:", err);
        vscode.window.showInformationMessage(vscode.l10n.t("No plan exists for this session"));
      }
    },

    bindPlanToSession: async (_msg, ctx) => {
      const sessionId = ctx.session.currentSessionId;
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
      const metadata = await getSessionMetadata(workspacePath, sessionId);
      const slug = metadata?.slug;

      try {
        const content = await fs.readFile(selectedPath, "utf-8");

        if (slug) {
          if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
            log("[MessageRouter] Invalid plan slug detected:", slug);
            vscode.window.showWarningMessage(vscode.l10n.t("Invalid session slug"));
            return;
          }

          const slugPath = path.join(os.homedir(), ".claude", "plans", `${slug}.md`);

          let fileExists = false;
          try {
            await fs.access(slugPath);
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

          await fs.mkdir(path.dirname(slugPath), { recursive: true });
          await fs.writeFile(slugPath, content);

          const config = vscode.workspace.getConfiguration("damocles");
          const previousThinkingTokens = config.get<number | null>("maxThinkingTokens", null);
          await ctx.session.setMaxThinkingTokens(null);

          try {
            const notifyCorrelationId = `plan-notify-${Date.now()}`;
            postMessage(ctx.panel, {
              type: "userMessage",
              content: "[System] Updating plan file...",
              correlationId: notifyCorrelationId,
            });

            await ctx.session.sendMessage(
              `[System] The plan file for this session has been updated. Plan file path: ${slugPath}. Respond with "Got it. I'll use this plan as reference." - do not take any other action.`,
              undefined,
              notifyCorrelationId
            );
          } finally {
            await ctx.session.setMaxThinkingTokens(previousThinkingTokens);
          }

          postMessage(ctx.panel, {
            type: "notification",
            message: vscode.l10n.t("Plan file updated: {0}", slugPath),
            notificationType: "info",
          });
          log("[MessageRouter] Injected plan from %s to %s", selectedPath, slugPath);
        } else {
          if (ctx.session.processing) {
            vscode.window.showWarningMessage(
              vscode.l10n.t("Cannot initialize plan mode while Claude is processing. Please wait and try again.")
            );
            return;
          }

          const previousMode = ctx.permissionHandler.getPermissionMode();
          const config = vscode.workspace.getConfiguration("damocles");
          const previousThinkingTokens = config.get<number | null>("maxThinkingTokens", null);

          ctx.session.setPendingPlanBind(content);

          await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, "plan");
          await ctx.session.setMaxThinkingTokens(null);
          await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);

          try {
            const triggerCorrelationId = `plan-init-${Date.now()}`;
            postMessage(ctx.panel, {
              type: "userMessage",
              content: "[System] Initializing plan mode for custom plan binding...",
              correlationId: triggerCorrelationId,
            });

            await ctx.session.sendMessage(
              `[System] Plan mode initialization for custom plan binding. Respond with "Got it. I'll use the imported plan as reference." - do not take any other action.`,
              undefined,
              triggerCorrelationId
            );
          } finally {
            await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, previousMode);
            await ctx.session.setMaxThinkingTokens(previousThinkingTokens);
            await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);
          }

          postMessage(ctx.panel, {
            type: "notification",
            message: vscode.l10n.t("Plan file bound to session"),
            notificationType: "info",
          });
          log("[MessageRouter] Plan bind initiated via Stop hook from %s", selectedPath);
        }
      } catch (err) {
        log("[MessageRouter] Error injecting plan:", err);
        vscode.window.showErrorMessage(
          vscode.l10n.t("Failed to inject plan: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    requestWorkspaceFiles: async (_msg, ctx) => {
      await workspaceManager.sendWorkspaceFiles(ctx.panel);
    },

    openFile: async (msg, ctx) => {
      if (msg.type !== "openFile") return;
      await workspaceManager.handleOpenFile(ctx.panel, msg.filePath, msg.line);
    },

    requestCustomSlashCommands: async (_msg, ctx) => {
      const enabledPluginIds = settingsManager.getEnabledPluginIds();
      await workspaceManager.sendCustomSlashCommands(ctx.panel, enabledPluginIds);
    },

    requestCustomAgents: async (_msg, ctx) => {
      const enabledPluginIds = settingsManager.getEnabledPluginIds();
      await workspaceManager.sendCustomAgents(ctx.panel, enabledPluginIds);
    },

    setLanguagePreference: async (msg) => {
      if (msg.type !== "setLanguagePreference") return;
      await setLanguagePreference(msg.locale);
    },
  };
}
