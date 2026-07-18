import * as vscode from "vscode";
import type { WebviewHost } from "../../types";
import type { PostMessageFn } from "../types";
import type { ExploreThirdPartyProvider } from "../../../pi-session/explore-providers";
import { DEFAULT_EXPLORE_MODELS, EXPLORE_SECRET_KEYS, EXPLORE_THIRD_PARTY_PROVIDERS } from "../../../pi-session/explore-providers";
import { updateConfigAtEffectiveScope } from "../utils";
import { parseEffortLevel, exploreSupportedEffortLevels } from "../../../../shared/types/constants";
import { log } from "../../../logger";
import { PiRuntime } from "../../../pi-session/pi-runtime";

const VALID_PROVIDERS: ReadonlySet<ExploreThirdPartyProvider> = new Set(EXPLORE_THIRD_PARTY_PROVIDERS);
const DEFAULT_PROVIDER_ID = "default" as const;
type ProviderSelection = typeof DEFAULT_PROVIDER_ID | ExploreThirdPartyProvider;

/** DeepSeek's dedicated SecretStorage key — intentionally NOT under `damocles.explore.apiKey.*`, so it
 *  never appears in the Explore provider dropdown. */
const DEEPSEEK_SECRET_KEY = "damocles.deepseek.apiKey";

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

function getEffort(): string {
  const raw = vscode.workspace.getConfiguration("damocles.explore").get<string>("effort", "");
  const effort = parseEffortLevel(raw);
  // Coerce against the selected model's advertised levels (same catalog double-match as the resolver +
  // the settings UI): a syntactically valid but unsupported level reads as unset, so the broadcast never
  // diverges from what the UI can display or the subagent resolver will honor.
  return effort && exploreSupportedEffortLevels(getProvider(), getEffectiveModel()).includes(effort) ? effort : "";
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
    await this.secrets.store(key, apiKey.trim());
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

  async setEffort(effort: string): Promise<void> {
    const parsed = effort === "" ? null : parseEffortLevel(effort);
    if (effort !== "" && !parsed) {
      log("[ExploreManager] setEffort: rejected invalid effort=%s", effort);
      return;
    }
    // Persist only a level the currently-selected model advertises (same catalog double-match as the
    // resolver + UI); an unsupported level is stored as unset so settings.json never holds a value the
    // model can't honor. Passing `undefined` removes the override at the effective scope.
    const next = parsed && exploreSupportedEffortLevels(getProvider(), getEffectiveModel()).includes(parsed) ? parsed : undefined;
    await updateConfigAtEffectiveScope("damocles.explore", "effort", next);
    log("[ExploreManager] setEffort: %s", next ?? "(cleared)");
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
    const effort = provider === DEFAULT_PROVIDER_ID ? "" : getEffort();
    log("[ExploreManager] sendExploreConfig: provider=%s model=%s effort=%s", provider, model, effort);
    this.postMessage(host, { type: "exploreConfigUpdate", provider, model, effort });
  }

  /** The currently selected explore provider (used to decide whether an Explore-key write also affects
   *  the shared StepFun panel). */
  selectedExploreProvider(): ExploreThirdPartyProvider {
    return getProvider();
  }

  // ---- StepFun (shared key) -------------------------------------------------
  // StepFun's key is the SAME entry the Explore section writes for provider=stepfun
  // (`damocles.explore.apiKey.stepfun`). These write that fixed key directly — NOT the
  // currently-selected explore provider's key — so the dedicated StepFun panel works regardless of the
  // Explore provider selection.

  async storeStepfunApiKey(key: string): Promise<void> {
    await this.secrets.store(EXPLORE_SECRET_KEYS.stepfun, key.trim());
    log("[ExploreManager] storeStepfunApiKey: stored");
    this.resyncCustomProviders();
  }

  async deleteStepfunApiKey(): Promise<void> {
    await this.secrets.delete(EXPLORE_SECRET_KEYS.stepfun);
    log("[ExploreManager] deleteStepfunApiKey: deleted");
    this.resyncCustomProviders();
  }

  async sendStepfunAuthStatus(host: WebviewHost): Promise<void> {
    const stored = await this.secrets.get(EXPLORE_SECRET_KEYS.stepfun);
    const configured = stored !== undefined && stored.length > 0;
    this.postMessage(host, { type: "stepfunAuthStatusChanged", configured });
  }

  // ---- DeepSeek (own key) ---------------------------------------------------

  async storeDeepseekApiKey(key: string): Promise<void> {
    await this.secrets.store(DEEPSEEK_SECRET_KEY, key.trim());
    log("[ExploreManager] storeDeepseekApiKey: stored");
    this.resyncCustomProviders();
  }

  async deleteDeepseekApiKey(): Promise<void> {
    await this.secrets.delete(DEEPSEEK_SECRET_KEY);
    log("[ExploreManager] deleteDeepseekApiKey: deleted");
    this.resyncCustomProviders();
  }

  async sendDeepseekAuthStatus(host: WebviewHost): Promise<void> {
    const stored = await this.secrets.get(DEEPSEEK_SECRET_KEY);
    const configured = stored !== undefined && stored.length > 0;
    this.postMessage(host, { type: "deepseekAuthStatusChanged", configured });
  }
}
