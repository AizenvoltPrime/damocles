import * as vscode from "vscode";
import { ChatPanelProvider } from "../core/chat-panel";
import { SidebarViewProvider } from "./panels/sidebar-view-provider";
import { restoredWorkspaceFolderKey } from "../core/chat-panel/panel-manager";
import { installLogSink, log, showLog } from "../core/logger";
import { t } from "../core/l10n";
import { installPlatform } from "../core/platform-host";
import { createVsCodePlatform } from "./platform";
import { wrapBrowserPanel, wrapChatPanel } from "./panels/webview-hosts";
import { CompassViews } from "./compass/compass-views";
import { markActivationStart, markSinceActivation, timed } from "../core/perf";
import { createVoiceStatusBarItem } from "./voice/status-bar";
import { setupAutoDisable } from "../core/voice/auto-disable";
import { PiRuntime } from "../core/pi-session/pi-runtime";
import { setMcpSecretStorage } from "../core/pi-session/mcp/mcp-auth";
import { setExploreApiKey } from "../core/pi-session/explore-api-key";
import { runLegacySettingsMigrations } from "../core/config/legacy-settings-migrations";
import { runCheckpointMaintenance } from "../core/pi-session/checkpoints";
import { isNavigableUrl } from "../core/browser/net-guard";

let chatPanelProvider: ChatPanelProvider | undefined;

/**
 * The URL a persisted browser editor tab may be restored to.
 *
 * The panel persists whatever URL the PAGE last navigated to, so the state blob is page-controlled and
 * survives a window reload. Restoring it verbatim would let a page hand the next window session a
 * `javascript:`/`file:`/`data:` navigation, so only real web schemes pass; everything else — including
 * a malformed value that fails to parse — falls back to `about:blank`.
 *
 * Shares `isNavigableUrl` with the address-bar path deliberately: two panel-driven navigations judged
 * by two copies of the policy is how the address bar ended up with no policy at all.
 */
export function restoredBrowserUrl(state: unknown): string {
  const raw = (state as { url?: unknown } | null)?.url;
  if (typeof raw !== 'string') return 'about:blank';
  return isNavigableUrl(raw) ? raw : 'about:blank';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Before the platform, whose content providers and tab listener are part of activation's cost; it reads nothing.
  markActivationStart();
  const platform = createVsCodePlatform(context);
  installPlatform(platform);
  const outputChannel = platform.logSinks.create("Damocles");
  installLogSink(outputChannel);
  context.subscriptions.push(outputChannel);
  log("Damocles extension activating...");
  if (platform.settings.get<boolean>("damocles.debug")) {
    showLog(true);
  }

  await runLegacySettingsMigrations(platform.settings);
  // Back MCP OAuth credential storage with the OS keychain; set before any MCP server connects.
  setMcpSecretStorage(platform.secrets);

  chatPanelProvider = timed("activate.provider", () => new ChatPanelProvider(platform, {
    subscriptions: context.subscriptions,
    createCompassViews: (options) => new CompassViews(platform, options),
  }));

  // Refresh the pi web-tools active set live when the setting changes — no window reload (only when the
  // pi runtime already exists; otherwise its own init reads the current setting on first use).
  context.subscriptions.push(
    platform.settings.onDidChange("damocles.pi.webSearch.enabled", () => {
      if (PiRuntime.exists) {
        void PiRuntime.get().refreshWebSearch();
      }
    }),
  );

  const voiceService = chatPanelProvider.getVoiceService();
  const voiceStatusBar = createVoiceStatusBarItem(context, voiceService, platform.settings);
  context.subscriptions.push({ dispose: (): void => voiceStatusBar.dispose() });
  const panelManager = chatPanelProvider.getPanelManager();
  setupAutoDisable(voiceService, context.subscriptions, {
    onPanelsAllClosed: (callback: () => void) => panelManager.onAllPanelsClosed(callback),
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
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        try {
          await chatPanelProvider?.restorePanel(wrapChatPanel(panel), restoredWorkspaceFolderKey(state));
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
          await chatPanelProvider?.restoreBrowserPanel(wrapBrowserPanel(panel), restoredBrowserUrl(state));
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
        void platform.notifications.warn(t("Damocles: No browser session active. Open a browser first."));
        return;
      }
      try {
        const element = await browserService.pickElement();
        const delivered = chatPanelProvider?.getPanelManager().postToActivePanel({ type: "browserElementPicked", element }) ?? false;
        if (!delivered) {
          void platform.notifications.warn(t("Damocles: No chat panel is open. Open one to receive picked elements."));
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("cancelled")) return;
        void platform.notifications.error(t("Damocles: Element pick failed: {0}", err instanceof Error ? err.message : String(err)));
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

  context.subscriptions.push(
    vscode.commands.registerCommand("damocles.setExploreApiKey", () => setExploreApiKey(platform))
  );

  const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const readMaintenanceOptions = () => ({
    retentionDays: platform.settings.get<number>('damocles.checkpoints.retentionDays', 30),
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

  markSinceActivation("activate");
  log("Damocles extension activated");
}

/**
 * Returns the teardown promise so VS Code awaits it. `ChatPanelProvider.dispose()` waits for Chrome to
 * exit; voiding it here would put the "Chrome does not outlive the extension host" guarantee back in
 * the same place it was broken — asserted in a comment and dropped in the code.
 */
export async function deactivate(): Promise<void> {
  if (PiRuntime.exists) {
    void PiRuntime.disposeInstance();
  }
  await chatPanelProvider?.dispose();
  log("Damocles extension deactivated");
}
