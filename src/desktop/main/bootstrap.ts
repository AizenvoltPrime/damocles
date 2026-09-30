import { ChatPanelProvider } from '../../core/chat-panel';
import type { CompassViewsHandle } from '../../core/chat-panel/types';
import { log } from '../../core/logger';
import { setMcpSecretStorage } from '../../core/pi-session/mcp/mcp-auth';
import { PiRuntime } from '../../core/pi-session/pi-runtime';
import { runCheckpointMaintenance } from '../../core/pi-session/checkpoints';
import { setupAutoDisable } from '../../core/voice/auto-disable';
import type { Disposable } from '../../platform/disposable';
import type { Platform } from '../../platform/platform';

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_FIRST_DELAY_MS = 20_000;

// Compass tree views are VS Code UI; desktop has none.
const NO_COMPASS_VIEWS: CompassViewsHandle = {
  register: () => undefined,
  setActive: () => undefined,
  dispose: () => undefined,
};

export interface DesktopCore {
  readonly provider: ChatPanelProvider;
  // The extension's deactivate chain, then its subscriptions, awaited to the end.
  dispose(): Promise<void>;
}

/**
 * The core services src/vscode/extension.ts activate builds, in the same order, minus VS Code-only UI
 * (sidebar, panel serializers, compass views, voice status bar). The caller runs the legacy settings
 * migrations once per app run, before the first start.
 */
export function startCore(platform: Platform): DesktopCore {
  const subscriptions: Disposable[] = [];
  setMcpSecretStorage(platform.secrets);

  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => NO_COMPASS_VIEWS,
  });

  subscriptions.push(
    platform.settings.onDidChange('damocles.pi.webSearch.enabled', () => {
      if (PiRuntime.exists) void PiRuntime.get().refreshWebSearch();
    }),
  );

  const panelManager = provider.getPanelManager();
  setupAutoDisable(provider.getVoiceService(), subscriptions, {
    onPanelsAllClosed: (callback: () => void) => panelManager.onAllPanelsClosed(callback),
  });

  const runSweep = (): void => {
    const retentionDays = platform.settings.get<number>('damocles.checkpoints.retentionDays', 30);
    runCheckpointMaintenance({ retentionDays }).catch((err: unknown) => {
      log(`[Checkpoints] maintenance sweep threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const initial = setTimeout(runSweep, MAINTENANCE_FIRST_DELAY_MS);
  initial.unref();
  const timer = setInterval(runSweep, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  subscriptions.push({ dispose: () => { clearTimeout(initial); clearInterval(timer); } });

  return {
    provider,
    dispose: async () => {
      const runtimeDisposed = PiRuntime.exists ? PiRuntime.disposeInstance() : Promise.resolve();
      await provider.dispose();
      await runtimeDisposed;
      for (const subscription of subscriptions.reverse()) subscription.dispose();
      log('Damocles core disposed');
    },
  };
}
