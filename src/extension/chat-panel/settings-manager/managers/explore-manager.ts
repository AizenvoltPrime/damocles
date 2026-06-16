import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import type { ExploreProvider, ExploreThirdPartyProvider } from "../../../explore/types";
import { DEFAULT_EXPLORE_MODELS, EXPLORE_PROVIDERS, EXPLORE_SECRET_KEYS, EXPLORE_THIRD_PARTY_PROVIDERS } from "../../../explore/types";
import { updateConfigAtEffectiveScope } from "../utils";
import { log } from "../../../logger";

const VALID_PROVIDERS: ReadonlySet<ExploreProvider> = new Set(EXPLORE_PROVIDERS);
const THIRD_PARTY_PROVIDERS: ReadonlySet<ExploreThirdPartyProvider> = new Set(EXPLORE_THIRD_PARTY_PROVIDERS);
const DEFAULT_PROVIDER_ID = "default" as const;
type ProviderSelection = typeof DEFAULT_PROVIDER_ID | ExploreProvider;

function isInterceptEnabled(): boolean {
  return vscode.workspace.getConfiguration("damocles.explore").get<boolean>("enabled", false);
}

function getProvider(): ExploreProvider {
  const raw = vscode.workspace.getConfiguration("damocles.explore").get<string>("provider", "openrouter");
  return VALID_PROVIDERS.has(raw as ExploreProvider) ? (raw as ExploreProvider) : "openrouter";
}

function isThirdPartyProvider(provider: ExploreProvider): provider is ExploreThirdPartyProvider {
  return THIRD_PARTY_PROVIDERS.has(provider as ExploreThirdPartyProvider);
}

function getEffectiveProviderSelection(): ProviderSelection {
  return isInterceptEnabled() ? getProvider() : DEFAULT_PROVIDER_ID;
}

function getSecretKey(): string | null {
  const provider = getProvider();
  return isThirdPartyProvider(provider) ? EXPLORE_SECRET_KEYS[provider] : null;
}

function getEffectiveModel(): string {
  const provider = getProvider();
  if (!isThirdPartyProvider(provider)) return "";
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
  }

  async deleteApiKey(): Promise<void> {
    const key = getSecretKey();
    if (!key) {
      log("[ExploreManager] deleteApiKey: provider has no secret key, ignoring");
      return;
    }
    await this.secrets.delete(key);
    log("[ExploreManager] deleteApiKey: deleted for %s", key);
  }

  async setProvider(provider: string): Promise<void> {
    if (provider === DEFAULT_PROVIDER_ID) {
      await updateConfigAtEffectiveScope("damocles.explore", "enabled", false);
      log("[ExploreManager] setProvider: default (interception disabled)");
      return;
    }
    if (!VALID_PROVIDERS.has(provider as ExploreProvider)) {
      log("[ExploreManager] setProvider: rejected unknown provider=%s", provider);
      return;
    }
    await updateConfigAtEffectiveScope("damocles.explore", "provider", provider);
    await updateConfigAtEffectiveScope("damocles.explore", "enabled", true);
    log("[ExploreManager] setProvider: %s (effective model: %s, interception enabled)", provider, getEffectiveModel());
  }

  async setModel(model: string): Promise<void> {
    const provider = getProvider();
    if (!isThirdPartyProvider(provider)) {
      log("[ExploreManager] setModel: provider=%s does not accept a per-provider model override", provider);
      return;
    }
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
