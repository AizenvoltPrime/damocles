import * as vscode from "vscode";
import { ChatPanelProvider } from "./chat-panel";
import { SidebarViewProvider } from "./chat-panel/sidebar-view-provider";
import { initLogger, log, showLog } from "./logger";
import { createVoiceStatusBarItem } from "./voice/status-bar";
import { setupAutoDisable } from "./voice/auto-disable";
import { PiRuntime } from "./pi-session/pi-runtime";
import { setMcpSecretStorage } from "./pi-session/mcp/mcp-auth";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_MODELS, LEGACY_EFFORT_VALUE_MAP, LEGACY_MODEL_MAP } from "../shared/types/constants";
import type { EffortLevel } from "../shared/types/settings";
import { EXPLORE_SECRET_KEYS } from "./pi-session/explore-providers";
import { runCheckpointMaintenance } from "./pi-session/checkpoints";

let chatPanelProvider: ChatPanelProvider | undefined;

async function migrateLegacyEffortSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration("damocles");
  const inspect = config.inspect<EffortLevel | null>("effort");
  if (!inspect) return;
  // damocles.effort / effortByModel are window-scoped: VS Code never surfaces a WorkspaceFolder value,
  // so only Global and Workspace scopes can hold a legacy value to migrate.
  const scopes = [
    { target: vscode.ConfigurationTarget.Global, value: inspect.globalValue },
    { target: vscode.ConfigurationTarget.Workspace, value: inspect.workspaceValue },
  ];
  const activeModel = config.get<string>("model", "") || DEFAULT_FALLBACK_MODEL;
  for (const { target, value } of scopes) {
    if (value === undefined || value === null) continue;
    const mapInspect = config.inspect<Record<string, EffortLevel | null>>("effortByModel");
    const currentMap = (target === vscode.ConfigurationTarget.Global
      ? mapInspect?.globalValue
      : mapInspect?.workspaceValue) ?? {};
    if (!(activeModel in currentMap)) {
      const nextMap = { ...currentMap, [activeModel]: value };
      await config.update("effortByModel", nextMap, target);
      log(`[Migration] Moved damocles.effort=${value} → effortByModel[${activeModel}] (scope=${target})`);
    }
    await config.update("effort", undefined, target);
  }
}

export async function migrateLegacyModelSetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration("damocles");
  const modelInspect = config.inspect<string>("model");
  const mapInspect = config.inspect<Record<string, EffortLevel | null>>("effortByModel");
  if (!modelInspect && !mapInspect) return;
  // damocles.model / damocles.effortByModel are window-scoped, so VS Code never surfaces a
  // WorkspaceFolder value for them — only Global and Workspace scopes can hold migratable values.
  const scopes = [
    { target: vscode.ConfigurationTarget.Global, model: modelInspect?.globalValue, map: mapInspect?.globalValue },
    { target: vscode.ConfigurationTarget.Workspace, model: modelInspect?.workspaceValue, map: mapInspect?.workspaceValue },
  ];
  for (const { target, model, map } of scopes) {
    // Migrate the model value when it is a legacy id at this scope. Independent of the effort re-key
    // below: a scope can hold legacy effort entries with no model value set (or vice versa).
    // Own-property lookups guard against inherited keys ("toString", "constructor") on a stored value
    // resolving to a prototype member instead of a real mapping.
    const mappedModel = model != null && Object.hasOwn(LEGACY_MODEL_MAP, model) ? LEGACY_MODEL_MAP[model] : undefined;
    if (mappedModel) {
      await config.update("model", mappedModel, target);
      log(`[Migration] damocles.model=${model} → ${mappedModel} (scope=${target})`);
    }
    // Re-key effortByModel entries stored under a legacy id to the mapped id at the same scope.
    const currentMap = map ?? {};
    let mapChanged = false;
    const nextMap: Record<string, EffortLevel | null> = { ...currentMap };
    for (const legacyId of Object.keys(currentMap)) {
      const mappedId = Object.hasOwn(LEGACY_MODEL_MAP, legacyId) ? LEGACY_MODEL_MAP[legacyId] : undefined;
      if (!mappedId) continue;
      const carried = currentMap[legacyId] ?? null;
      delete nextMap[legacyId];
      mapChanged = true;
      // Non-clobber: keep an existing entry for the mapped id — whether it was present in the stored
      // map OR already written by an earlier legacy id this pass. Two legacy ids can map to the same
      // successor (gpt-5.5 + gpt-5.3-codex → gpt-5.6-sol); testing nextMap makes that first-wins and
      // deterministic (testing currentMap would let the later id clobber the earlier, last-wins).
      if (Object.hasOwn(nextMap, mappedId)) continue;
      nextMap[mappedId] = clampEffortToModel(carried, mappedId);
    }
    // Value-migrate stored effort levels renamed by pi metadata changes (e.g. DeepSeek xhigh → max in
    // pi 0.80.6). This rewrites the id's own value in place — an upward rename matching pi's direction,
    // NOT clampEffortToModel (which would clamp an unsupported level down to supported[0] = 'high').
    // Idempotent: after one pass the renamed old level no longer appears, so a re-run is a no-op.
    for (const modelId of Object.keys(nextMap)) {
      const renames = Object.hasOwn(LEGACY_EFFORT_VALUE_MAP, modelId) ? LEGACY_EFFORT_VALUE_MAP[modelId] : undefined;
      if (!renames) continue;
      const value = nextMap[modelId];
      if (value == null || !Object.hasOwn(renames, value)) continue;
      const renamed = renames[value];
      if (!renamed || renamed === value) continue;
      nextMap[modelId] = renamed;
      mapChanged = true;
    }
    if (mapChanged) {
      await config.update("effortByModel", nextMap, target);
      log(`[Migration] Migrated damocles.effortByModel legacy entries (GPT-5.6 re-key / renamed effort levels) (scope=${target})`);
    }
  }
}

/**
 * Clamps a carried effort level to a target model's supported set. Legacy GPT entries allowed
 * `'none'`, but the GPT-5.6 trio is codex-strict `['low','medium','high','xhigh','max']`, so an
 * unsupported level (`'none'`) clamps up to the model's lowest supported level (`'low'`).
 */
function clampEffortToModel(effort: EffortLevel | null, modelId: string): EffortLevel | null {
  if (effort === null) return null;
  const model = DEFAULT_MODELS.find((m) => m.value === modelId);
  const supported = model?.supportedEffortLevels;
  if (!supported || supported.includes(effort)) return effort;
  return supported[0] ?? effort;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = initLogger();
  context.subscriptions.push(outputChannel);
  log("Damocles extension activating...");
  if (vscode.workspace.getConfiguration('damocles').get<boolean>('debug')) {
    showLog(true);
  }

  // Settings migrations are best-effort: a config.update rejection (e.g. a read-only or unwritable
  // scope) must never abort activation. Stored legacy values still resolve at read time via
  // migrateLegacyModelValue / ModelManager's read-side mapping, so a failed write is non-fatal.
  try {
    await migrateLegacyEffortSetting();
    await migrateLegacyModelSetting();
  } catch (err) {
    log(`[Migration] Settings migration failed (non-fatal, read-side mapping still applies): ${err instanceof Error ? err.message : String(err)}`);
  }
  // Back MCP OAuth credential storage with the OS keychain (M1); set before any MCP server connects.
  setMcpSecretStorage(context.secrets);

  chatPanelProvider = new ChatPanelProvider(context.extensionUri, context);

  // Refresh the pi web-tools active set live when the setting changes — no window reload (only when the
  // pi runtime already exists; otherwise its own init reads the current setting on first use).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("damocles.pi.webSearch.enabled") && PiRuntime.exists) {
        void PiRuntime.get().refreshWebSearch();
      }
    }),
  );

  const voiceService = chatPanelProvider.getVoiceService();
  const voiceStatusBar = createVoiceStatusBarItem(context, voiceService);
  context.subscriptions.push({ dispose: (): void => voiceStatusBar.dispose() });
  const panelManager = chatPanelProvider.getPanelManager();
  setupAutoDisable(voiceService, context, {
    onPanelsAllClosed: (callback: () => void): vscode.Disposable => panelManager.onAllPanelsClosed(callback),
  });

  const sidebarProvider = new SidebarViewProvider(
    chatPanelProvider.getPanelManager(),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "damocles.sidebarView",
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("damocles.chat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown) {
        try {
          await chatPanelProvider?.restorePanel(panel);
        } catch (err) {
          log(`[Deserializer] Panel restoration failed: ${err}`);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("damocles-browser-view", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        try {
          const url = (state as { url?: string } | null)?.url || 'about:blank';
          await chatPanelProvider?.restoreBrowserPanel(panel, url);
        } catch (err) {
          log(`[Deserializer] Browser panel restoration failed: ${err}`);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.openChat", () => {
      chatPanelProvider?.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.newSession", () => {
      chatPanelProvider?.newSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.cancelSession", () => {
      chatPanelProvider?.cancelSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.showLog", () => {
      showLog();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.pickBrowserElement", async () => {
      const browserService = chatPanelProvider?.getBrowserService();
      if (!browserService?.isConnected()) {
        vscode.window.showWarningMessage("Damocles: No browser session active. Open a browser first.");
        return;
      }
      try {
        const element = await browserService.pickElement();
        const delivered = chatPanelProvider?.getPanelManager().postToActivePanel({ type: "browserElementPicked", element }) ?? false;
        if (!delivered) {
          vscode.window.showWarningMessage("Damocles: No active chat panel — open a chat panel to receive picked elements.");
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("cancelled")) return;
        vscode.window.showErrorMessage(`Damocles: Element pick failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.browser.toggleDevTools", () => {
      chatPanelProvider?.getBrowserService().toggleDevTools();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.togglePromptNavigator", () => {
      chatPanelProvider?.getPanelManager().postToActivePanel({ type: "togglePromptNavigator" });
    })
  );

  const EXPLORE_PROVIDER_UI = {
    openrouter: { label: "OpenRouter", prompt: "Enter your OpenRouter API key for Explore agents", placeholder: "sk-or-..." },
    gemini: { label: "Gemini", prompt: "Enter your Google Gemini API key", placeholder: "AIza..." },
    stepfun: { label: "StepFun", prompt: "Enter your StepFun (Step Plan) API key", placeholder: "" },
  } as const;
  type ExploreProviderId = keyof typeof EXPLORE_PROVIDER_UI;

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.setExploreApiKey", async () => {
      const raw = vscode.workspace.getConfiguration("damocles.explore").get<string>("provider", "openrouter");
      const providerId: ExploreProviderId = raw in EXPLORE_PROVIDER_UI ? raw as ExploreProviderId : "openrouter";
      const ui = EXPLORE_PROVIDER_UI[providerId];
      const secretKey = EXPLORE_SECRET_KEYS[providerId];
      const key = await vscode.window.showInputBox({
        prompt: ui.prompt,
        password: true,
        placeHolder: ui.placeholder,
      });
      if (key === undefined) return;
      if (key === "") {
        await context.secrets.delete(secretKey);
        vscode.window.showInformationMessage(`Damocles: ${ui.label} API key removed`);
      } else {
        await context.secrets.store(secretKey, key);
        vscode.window.showInformationMessage(`Damocles: ${ui.label} API key saved`);
      }
    })
  );

  const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const readMaintenanceOptions = () => ({
    retentionDays: vscode.workspace.getConfiguration('damocles').get<number>('checkpoints.retentionDays', 30),
  });
  // runCheckpointMaintenance is contractually never-throws; this catch only surfaces a contract
  // violation (never swallows it silently) so a regression is visible in the log rather than lost.
  const runSweep = () => {
    void runCheckpointMaintenance(readMaintenanceOptions()).catch((err) => {
      log(`[Checkpoints] maintenance sweep threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const initial = setTimeout(runSweep, 20_000); // deferred so it never competes with activation
  initial.unref?.();
  const timer = setInterval(runSweep, MAINTENANCE_INTERVAL_MS);
  timer.unref?.();
  context.subscriptions.push({ dispose: () => { clearTimeout(initial); clearInterval(timer); } });

  log("Damocles extension activated");
}

export function deactivate(): void {
  if (PiRuntime.exists) {
    void PiRuntime.disposeInstance();
  }
  chatPanelProvider?.dispose();
  log("Damocles extension deactivated");
}
