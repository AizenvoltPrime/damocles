import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import type { ExploreProvider } from "../../../explore/types";
import { DEFAULT_EXPLORE_MODELS, EXPLORE_PROVIDERS, EXPLORE_SECRET_KEYS } from "../../../explore/types";
import { log } from "../../../logger";

const VALID_PROVIDERS: ReadonlySet<ExploreProvider> = new Set(EXPLORE_PROVIDERS);
const DEFAULT_PROVIDER_ID = "default" as const;
type ProviderSelection = typeof DEFAULT_PROVIDER_ID | ExploreProvider;

function isInterceptEnabled(): boolean {
  return vscode.workspace.getConfiguration("damocles.explore").get<boolean>("enabled", false);
}

function getProvider(): ExploreProvider {
  const raw = vscode.workspace.getConfiguration("damocles.explore").get<string>("provider", "openrouter");
  return VALID_PROVIDERS.has(raw as ExploreProvider) ? (raw as ExploreProvider) : "openrouter";
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
    await this.secrets.store(key, apiKey);
    log("[ExploreManager] storeApiKey: stored for %s", key);
  }

  async deleteApiKey(): Promise<void> {
    const key = getSecretKey();
    await this.secrets.delete(key);
    log("[ExploreManager] deleteApiKey: deleted for %s", key);
  }

  async setProvider(provider: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles.explore");
    if (provider === DEFAULT_PROVIDER_ID) {
      await config.update("enabled", false, vscode.ConfigurationTarget.Workspace);
      log("[ExploreManager] setProvider: default (interception disabled)");
      return;
    }
    if (!VALID_PROVIDERS.has(provider as ExploreProvider)) {
      log("[ExploreManager] setProvider: rejected unknown provider=%s", provider);
      return;
    }
    await config.update("provider", provider, vscode.ConfigurationTarget.Workspace);
    await config.update("enabled", true, vscode.ConfigurationTarget.Workspace);
    log("[ExploreManager] setProvider: %s (effective model: %s, interception enabled)", provider, getEffectiveModel());
  }

  async setModel(model: string): Promise<void> {
    const provider = getProvider();
    const config = vscode.workspace.getConfiguration("damocles.explore");
    const current = config.get<Record<string, string>>("modelByProvider", {});
    const next: Record<string, string> = { ...current, [provider]: model };
    await config.update("modelByProvider", next, vscode.ConfigurationTarget.Workspace);
    log("[ExploreManager] setModel: provider=%s model=%s", provider, model);
  }

  async sendExploreKeyStatus(host: WebviewHost): Promise<void> {
    const key = getSecretKey();
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
