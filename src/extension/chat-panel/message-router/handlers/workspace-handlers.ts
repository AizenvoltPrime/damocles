import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { getSessionFilePath, getAgentFilePath, getSessionMetadata } from "../../../session";
import { log } from "../../../logger";

function hasPathTraversal(slug: string): boolean {
  return slug.includes("..") || slug.includes("/") || slug.includes("\\");
}

function resolvePlanFilePath(metadata: import("@shared/types/session").StoredSession | null): string | null {
  const plansDir = path.resolve(os.homedir(), ".claude", "plans");
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

    openHaikuLog: async (msg, ctx) => {
      if (msg.type !== "openHaikuLog") return;
      if (!Number.isInteger(msg.promptIndex) || msg.promptIndex < 0) return;
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session to view"));
        return;
      }
      const filePath = path.join(os.homedir(), '.damocles', 'context', 'haiku', sessionId, `prompt-${msg.promptIndex}`, 'haiku.jsonl');
      try {
        const fileUri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showWarningMessage(vscode.l10n.t("Haiku log file not found for prompt {0}", String(msg.promptIndex)));
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

    openContextFile: async (msg, ctx) => {
      if (msg.type !== "openContextFile") return;
      if (!Number.isInteger(msg.promptIndex) || msg.promptIndex < 0) return;
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session to view"));
        return;
      }
      const filePath = path.join(os.homedir(), '.damocles', 'context', 'haiku', sessionId, `prompt-${msg.promptIndex}`, 'context.md');
      try {
        const fileUri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showWarningMessage(vscode.l10n.t("Context file not found for prompt {0}", String(msg.promptIndex)));
      }
    },

    openSessionPlan: async (_msg, ctx) => {
      const sessionId = ctx.session.persistenceSessionId;
      if (!sessionId) {
        vscode.window.showInformationMessage(vscode.l10n.t("No active session"));
        return;
      }

      const metadata = await getSessionMetadata(workspacePath, sessionId);
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
      const metadata = await getSessionMetadata(workspacePath, sessionId);
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

          const config = vscode.workspace.getConfiguration("damocles");
          const previousThinkingTokens = config.get<number | null>("maxThinkingTokens", null);
          await ctx.session.setMaxThinkingTokens(null);

          try {
            const notifyCorrelationId = `plan-notify-${Date.now()}`;
            postMessage(ctx.host, {
              type: "userMessage",
              content: "[System] Updating plan file...",
              correlationId: notifyCorrelationId,
            });

            await ctx.session.sendMessage(
              `[System] The plan file for this session has been updated. Plan file path: ${existingPlanPath}. Respond with "Got it. I'll use this plan as reference." - do not take any other action.`,
              undefined,
              notifyCorrelationId
            );
          } finally {
            await ctx.session.setMaxThinkingTokens(previousThinkingTokens);
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

          const isDistill = !!metadata?.isDistill;
          if (isDistill) {
            const newPlanPath = path.join(os.homedir(), ".claude", "plans", `${sessionId}.md`);
            await fs.mkdir(path.dirname(newPlanPath), { recursive: true });
            await fs.writeFile(newPlanPath, content);
            ctx.session.distillPlanPath = newPlanPath;

            const config = vscode.workspace.getConfiguration("damocles");
            const previousThinkingTokens = config.get<number | null>("maxThinkingTokens", null);
            await ctx.session.setMaxThinkingTokens(null);

            try {
              const notifyCorrelationId = `plan-notify-${Date.now()}`;
              postMessage(ctx.host, {
                type: "userMessage",
                content: "[System] Binding plan file...",
                correlationId: notifyCorrelationId,
              });

              await ctx.session.sendMessage(
                `[System] A plan file has been bound to this session. Plan file path: ${newPlanPath}. Respond with "Got it. I'll use this plan as reference." - do not take any other action.`,
                undefined,
                notifyCorrelationId
              );
            } finally {
              await ctx.session.setMaxThinkingTokens(previousThinkingTokens);
            }

            postMessage(ctx.host, {
              type: "notification",
              message: vscode.l10n.t("Plan file bound to session"),
              notificationType: "info",
            });
            log("[MessageRouter] Distill plan bound from %s to %s", selectedPath, newPlanPath);
          } else {
            const previousMode = ctx.permissionHandler.getPermissionMode();
            const config = vscode.workspace.getConfiguration("damocles");
            const previousThinkingTokens = config.get<number | null>("maxThinkingTokens", null);

            ctx.session.setPendingPlanBind(content);

            await settingsManager.handleSetPermissionMode(ctx.session, ctx.permissionHandler, "plan");
            await ctx.session.setMaxThinkingTokens(null);
            await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);

            try {
              const triggerCorrelationId = `plan-init-${Date.now()}`;
              postMessage(ctx.host, {
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
              await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
            }

            postMessage(ctx.host, {
              type: "notification",
              message: vscode.l10n.t("Plan file bound to session"),
              notificationType: "info",
            });
            log("[MessageRouter] Plan bind initiated via Stop hook from %s", selectedPath);
          }
        }
      } catch (err) {
        log("[MessageRouter] Error injecting plan:", err);
        vscode.window.showErrorMessage(
          vscode.l10n.t("Failed to inject plan: {0}", err instanceof Error ? err.message : "Unknown error")
        );
      }
    },

    requestHaikuActivity: async (_msg, ctx) => {
      const activities = await ctx.session.getHaikuActivities();
      postMessage(ctx.host, { type: "haikuActivityLoaded", activities: activities ?? [] });
    },

    requestWorkspaceFiles: async (_msg, ctx) => {
      await workspaceManager.sendWorkspaceFiles(ctx.host);
    },

    openFile: async (msg, ctx) => {
      if (msg.type !== "openFile") return;
      await workspaceManager.handleOpenFile(ctx.host, msg.filePath, msg.line);
    },

    requestCustomSlashCommands: async (_msg, ctx) => {
      const enabledPluginIds = settingsManager.getEnabledPluginIds();
      await workspaceManager.sendCustomSlashCommands(ctx.host, enabledPluginIds);
    },

    requestCustomAgents: async (_msg, ctx) => {
      const enabledPluginIds = settingsManager.getEnabledPluginIds();
      await workspaceManager.sendCustomAgents(ctx.host, enabledPluginIds);
    },

    setLanguagePreference: async (msg) => {
      if (msg.type !== "setLanguagePreference") return;
      await setLanguagePreference(msg.locale);
    },
  };
}
