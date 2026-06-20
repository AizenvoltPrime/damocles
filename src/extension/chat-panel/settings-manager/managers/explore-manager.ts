import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import type { ExploreThirdPartyProvider } from "../../../pi-session/explore-providers";
import { DEFAULT_EXPLORE_MODELS, EXPLORE_SECRET_KEYS, EXPLORE_THIRD_PARTY_PROVIDERS } from "../../../pi-session/explore-providers";
import { updateConfigAtEffectiveScope } from "../utils";
import { log } from "../../../logger";
import { PiRuntime } from "../../../pi-session/pi-runtime";

const VALID_PROVIDERS: ReadonlySet<ExploreThirdPartyProvider> = new Set(EXPLORE_THIRD_PARTY_PROVIDERS);
const DEFAULT_PROVIDER_ID = "default" as const;
type ProviderSelection = typeof DEFAULT_PROVIDER_ID | ExploreThirdPartyProvider;

function isInterceptEnabled(): boolean {
  return vscode.workspace.getConfiguration("damocles.explore").get<boolean>("enabled", false);
}

function getProvider(): ExploreThirdPartyProvider {
  const raw = vscode.workspace.getConfiguration("damocles.explore").get<string>("provider", "openrouter");
  return VALID_PROVIDERS.has(raw as ExploreThirdPartyProvider) ? (raw as ExploreThirdPartyProvider) : "openrouter";
}

function getEffectiveProviderSelection(): ProviderSelection {
  return isInterceptEnabled() ? getProvider() : DEFAULT_PROVIDER_ID;
}

function getSecretKey(): string {
  return EXPLORE_SECRET_KEYS[getProvider()];
}

function getEffectiveModel(): string {
  const provider = getProvider();
  const map = vscode.workspace.getConfiguration("damocles.explore").get<Record<string, string>>("modelByProvider", {});
  const stored = map[provider]?.trim();
  if (stored) return stored;
  return DEFAULT_EXPLORE_MODELS[provider];
}

export class ExploreManager {
  private readonly postMessage: PostMessageFn;
  private readonly secrets: vscode.SecretStorage;

  constructor(postMessage: PostMessageFn, secrets: vscode.SecretStorage) {
    this.postMessage = postMessage;
    this.secrets = secrets;
  }

  async storeApiKey(apiKey: string): Promise<void> {
    const key = getSecretKey();
    if (!key) {
      log("[ExploreManager] storeApiKey: provider has no secret key, ignoring");
      return;
    }
    await this.secrets.store(key, apiKey);
    log("[ExploreManager] storeApiKey: stored for %s", key);
    this.resyncCustomProviders();
  }

  async deleteApiKey(): Promise<void> {
    const key = getSecretKey();
    if (!key) {
      log("[ExploreManager] deleteApiKey: provider has no secret key, ignoring");
      return;
    }
    await this.secrets.delete(key);
    log("[ExploreManager] deleteApiKey: deleted for %s", key);
    this.resyncCustomProviders();
  }

  /**
   * Re-wire the native custom providers on the live pi runtime after an explore key changes (Phase 5,
   * US-018.8), so a subagent can reach the model without a window reload. Guarded by `PiRuntime.exists`
   * so the settings path never boots pi.
   */
  private resyncCustomProviders(): void {
    if (!PiRuntime.exists) return;
    void PiRuntime.get().syncCustomProviders((k) => this.secrets.get(k));
  }

  async setProvider(provider: string): Promise<void> {
    if (provider === DEFAULT_PROVIDER_ID) {
      await updateConfigAtEffectiveScope("damocles.explore", "enabled", false);
      log("[ExploreManager] setProvider: default (interception disabled)");
      return;
    }
    if (!VALID_PROVIDERS.has(provider as ExploreThirdPartyProvider)) {
      log("[ExploreManager] setProvider: rejected unknown provider=%s", provider);
      return;
    }
    await updateConfigAtEffectiveScope("damocles.explore", "provider", provider);
    await updateConfigAtEffectiveScope("damocles.explore", "enabled", true);
    log("[ExploreManager] setProvider: %s (effective model: %s, interception enabled)", provider, getEffectiveModel());
  }

  async setModel(model: string): Promise<void> {
    const provider = getProvider();
    const current = vscode.workspace.getConfiguration("damocles.explore").get<Record<string, string>>("modelByProvider", {});
    const next: Record<string, string> = { ...current, [provider]: model };
    await updateConfigAtEffectiveScope("damocles.explore", "modelByProvider", next);
    log("[ExploreManager] setModel: provider=%s model=%s", provider, model);
  }

  async sendExploreKeyStatus(host: WebviewHost): Promise<void> {
    const key = getSecretKey();
    if (!key) {
      this.postMessage(host, { type: "exploreApiKeyUpdate", hasApiKey: false });
      return;
    }
    const stored = await this.secrets.get(key);
    const hasApiKey = stored !== undefined && stored.length > 0;
    log("[ExploreManager] sendExploreKeyStatus: hasApiKey: %s (%s)", hasApiKey, key);
    this.postMessage(host, { type: "exploreApiKeyUpdate", hasApiKey });
  }

  sendExploreConfig(host: WebviewHost): void {
    const provider = getEffectiveProviderSelection();
    const model = provider === DEFAULT_PROVIDER_ID ? "" : getEffectiveModel();
    log("[ExploreManager] sendExploreConfig: provider=%s model=%s", provider, model);
    this.postMessage(host, { type: "exploreConfigUpdate", provider, model });
  }
}
