import * as vscode from "vscode";
import { ChatPanelProvider, flushCoreWrites } from "../core/chat-panel";
import { SidebarViewProvider } from "./panels/sidebar-view-provider";
import { restoredWorkspaceFolderKey } from "../shared/restored-folder-key";
import { installLogSink, log, showLog } from "../core/logger";
import { installPlatform } from "../core/platform-host";
import { createLauncherPool, installProcessLauncher, lockThreadSpawns } from "../core/process-launcher";
import { createWalkHost, installWalkHost, startWalkChild, type WalkHost } from "../core/search-walk";
import { createThreadDiffService, installDiffService } from "../core/diff";
import { createVsCodePlatform } from "./platform";
import { wrapBrowserPanel, wrapChatPanel } from "./panels/webview-hosts";
import { CompassViews } from "./compass/compass-views";
import { markActivationStart, markSinceActivation, timed } from "../core/perf";
import { createVoiceStatusBarItem } from "./voice/status-bar";
import { setupAutoDisable } from "../core/voice/auto-disable";
import { PiRuntime } from "../core/pi-session/pi-runtime";
import { setMcpSecretStorage } from "../core/pi-session/mcp/mcp-auth";
import { movePreferApiKeyFlagsToSettings, runLegacySettingsMigrations } from "../core/config/legacy-settings-migrations";
import { deleteRetiredSecrets } from "../core/config/retired-secrets";
import { providerKeyStored } from "../core/pi-session/custom-providers";
import { PROVIDER_SECRET_KEYS } from "../core/pi-session/explore-providers";
import { runCheckpointMaintenance } from "../core/pi-session/checkpoints";
import { isNavigableUrl } from "../core/browser/net-guard";
import { isUuid } from "../shared/uuid";
import { isFileUrl } from "../shared/served-file-url";
import { connectGuardedFetchThroughHost } from "../core/pi-session/web-access/safe-fetch";
import { registerRelocationOffer } from "./relocation-offer";

let chatPanelProvider: ChatPanelProvider | undefined;
// the extension host's walk processes, which deactivate kills
let walks: WalkHost | undefined;

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

/** The token of the chat a persisted browser editor tab names, which it reopens into; undefined for anything but a well-formed token. */
export function restoredBrowserOwner(state: unknown): string | undefined {
  const raw = (state as { owner?: unknown } | null)?.owner;
  return isUuid(raw) ? raw : undefined;
}

/** The file: address a persisted served page was saved at, which its chat's served files resolve again; undefined for anything else. */
export function restoredBrowserFile(state: unknown): string | undefined {
  const raw = (state as { file?: unknown } | null)?.file;
  return typeof raw === 'string' && isFileUrl(raw) ? raw : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Before the platform, whose content providers and tab listener are part of activation's cost; it reads nothing.
  markActivationStart();
  const platform = createVsCodePlatform(context);
  installPlatform(platform);
  context.subscriptions.push({ dispose: lockThreadSpawns() });
  // read at each call: VS Code patches globalThis.fetch with its proxy resolution
  context.subscriptions.push({ dispose: connectGuardedFetchThroughHost((url, init) => globalThis.fetch(url, init)) });
  installProcessLauncher(createLauncherPool({ workerPath: platform.paths.workerEntry("processLauncher"), sentinelPath: platform.paths.workerEntry("sentinel") }));
  // the @ list's, Grep's and Glob's walks, on walk processes started as walks need them
  walks = createWalkHost(() => startWalkChild(platform.paths.workerEntry("walkChild")), (line) => log(line));
  installWalkHost(walks);
  const diff = createThreadDiffService(platform.paths.workerEntry("diff"));
  installDiffService(diff);
  context.subscriptions.push({ dispose: () => void diff.close() });
  const outputChannel = platform.logSinks.create("Damocles");
  installLogSink(outputChannel);
  context.subscriptions.push(outputChannel);
  log("Damocles extension activating...");
  if (platform.settings.get<boolean>("damocles.debug")) {
    showLog(true);
  }

  await runLegacySettingsMigrations(platform.settings, () => providerKeyStored((key) => platform.secrets.get(key), PROVIDER_SECRET_KEYS.stepfun));
  const preferMoveNotice = await movePreferApiKeyFlagsToSettings(platform.state, platform.settings);
  if (preferMoveNotice) void platform.notifications.warn(preferMoveNotice);
  // SecretStorage can wedge indefinitely, and nothing below needs the deletion done.
  void deleteRetiredSecrets(platform.secrets);
  // Back MCP OAuth credential storage with the OS keychain; set before any MCP server connects.
  setMcpSecretStorage(platform.secrets);

  chatPanelProvider = timed("activate.provider", () => new ChatPanelProvider(platform, {
    subscriptions: context.subscriptions,
    createCompassViews: (options) => new CompassViews(platform, options),
  }));

  registerRelocationOffer(context, chatPanelProvider.getProjectRelocations());

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
          await chatPanelProvider?.restoreBrowserPanel(wrapBrowserPanel(panel), restoredBrowserUrl(state), restoredBrowserOwner(state), restoredBrowserFile(state));
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
    vscode.commands.registerCommand("damocles.newSession", () => chatPanelProvider?.newSession())
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
    vscode.commands.registerCommand("damocles.pickBrowserElement", () => chatPanelProvider?.pickBrowserElementForActiveChat())
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
  const deadline = Date.now() + DEACTIVATE_BUDGET_MS;
  // Awaited within the budget: the runtime's dispose waits for an OAuth refresh's credential write, whose refresh token is spent.
  const runtimeDisposed = settleBy(PiRuntime.exists ? PiRuntime.disposeInstance() : Promise.resolve(), deadline, 'the pi runtime');
  try {
    await chatPanelProvider?.dispose();
  } finally {
    await Promise.all([runtimeDisposed, settleBy(flushCoreWrites(), deadline, 'config writes'), settleBy(walks?.close() ?? Promise.resolve(), deadline, 'the walk processes')]);
  }
  log("Damocles extension deactivated");
}

// The 5 s VS Code gives an extension host's deactivate before it exits the process, counted from deactivate's start.
const DEACTIVATE_BUDGET_MS = 5_000;

// Handles `work`'s rejection synchronously, so awaiting other work before this promise leaves no rejection unhandled.
async function settleBy(work: Promise<unknown>, deadline: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
  });
  const failed = (err: unknown): boolean => {
    log(`[deactivate] ${what} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return false;
  };
  const late = await Promise.race([work.then(() => false, failed), timedOut]);
  clearTimeout(timer);
  if (late) log(`[deactivate] ${what} did not settle within the ${DEACTIVATE_BUDGET_MS} ms deactivate budget`);
}
