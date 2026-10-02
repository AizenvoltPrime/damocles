import type { Platform } from "../../../../platform/platform";
import type { SettingsStore } from "../../../../platform/settings-store";
import type { PanelHost } from "../../../../platform/window-service";
import type { PostMessageFn } from "../types";
import type { ExploreThirdPartyProvider } from "../../../pi-session/explore-providers";
import { DEFAULT_EXPLORE_MODELS, EXPLORE_SECRET_KEYS, EXPLORE_THIRD_PARTY_PROVIDERS } from "../../../pi-session/explore-providers";
import { updateConfigAtEffectiveScope } from "../utils";
import { parseEffortLevel, exploreSupportedEffortLevels } from "../../../../shared/types/constants";
import { log } from "../../../logger";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { TYPESAFE_SECRET_KEY } from "../../../pi-session/custom-providers";
import { CLASSIFIER_ENV_KEYS, JEV_VIA_OPENROUTER, JEV_VIA_TYPESAFE, memoryJudgeOf } from "../../../pi-session/classifier-model";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { ClassifierProvider } from "../../../../shared/types/settings";

const VALID_PROVIDERS: ReadonlySet<ExploreThirdPartyProvider> = new Set(EXPLORE_THIRD_PARTY_PROVIDERS);
const DEFAULT_PROVIDER_ID = "default" as const;
type ProviderSelection = typeof DEFAULT_PROVIDER_ID | ExploreThirdPartyProvider;

/** DeepSeek's dedicated SecretStorage key — intentionally NOT under `damocles.explore.apiKey.*`, so it
 *  never appears in the Explore provider dropdown. */
const DEEPSEEK_SECRET_KEY = "damocles.deepseek.apiKey";

function isInterceptEnabled(settings: SettingsStore): boolean {
  return settings.get<boolean>("damocles.explore.enabled", false);
}

function getProvider(settings: SettingsStore): ExploreThirdPartyProvider {
  const raw = settings.get<string>("damocles.explore.provider", "openrouter");
  return VALID_PROVIDERS.has(raw as ExploreThirdPartyProvider) ? (raw as ExploreThirdPartyProvider) : "openrouter";
}

function getEffectiveProviderSelection(settings: SettingsStore): ProviderSelection {
  return isInterceptEnabled(settings) ? getProvider(settings) : DEFAULT_PROVIDER_ID;
}

function getSecretKey(settings: SettingsStore): string {
  return EXPLORE_SECRET_KEYS[getProvider(settings)];
}

function getEffectiveModel(settings: SettingsStore): string {
  const provider = getProvider(settings);
  const map = settings.get<Record<string, string>>("damocles.explore.modelByProvider", {});
  const stored = map[provider]?.trim();
  if (stored) return stored;
  return DEFAULT_EXPLORE_MODELS[provider];
}

function getEffort(settings: SettingsStore): string {
  const raw = settings.get<string>("damocles.explore.effort", "");
  const effort = parseEffortLevel(raw);
  // Coerce against the selected model's advertised levels (same catalog double-match as the resolver +
  // the settings UI): a syntactically valid but unsupported level reads as unset, so the broadcast never
  // diverges from what the UI can display or the subagent resolver will honor.
  return effort && exploreSupportedEffortLevels(getProvider(settings), getEffectiveModel(settings)).includes(effort) ? effort : "";
}

export class ExploreManager {
  private readonly postMessage: PostMessageFn;
  private readonly platform: Platform;

  constructor(postMessage: PostMessageFn, platform: Platform) {
    this.postMessage = postMessage;
    this.platform = platform;
  }

  async storeApiKey(apiKey: string): Promise<void> {
    if (getProvider(this.platform.settings) === "openrouter") return storeOpenrouterApiKey(this.platform, apiKey);
    const key = getSecretKey(this.platform.settings);
    if (!key) {
      log("[ExploreManager] storeApiKey: provider has no secret key, ignoring");
      return;
    }
    await this.platform.secrets.store(key, apiKey.trim());
    log("[ExploreManager] storeApiKey: stored for %s", key);
    await resyncCustomProvidersNow(this.platform);
  }

  async deleteApiKey(): Promise<void> {
    const key = getSecretKey(this.platform.settings);
    if (!key) {
      log("[ExploreManager] deleteApiKey: provider has no secret key, ignoring");
      return;
    }
    await this.platform.secrets.delete(key);
    log("[ExploreManager] deleteApiKey: deleted for %s", key);
    await resyncCustomProvidersNow(this.platform);
  }

  /**
   * Re-wire the native custom providers on the live pi runtime after an explore key changes (Phase 5,
   * US-018.8), so a subagent can reach the model without a window reload. Guarded by `PiRuntime.exists`
   * so the settings path never boots pi.
   */
  private resyncCustomProviders(): void {
    if (!PiRuntime.exists) return;
    void PiRuntime.get().syncCustomProviders((k) => this.platform.secrets.get(k));
  }

  async setProvider(provider: string): Promise<void> {
    if (provider === DEFAULT_PROVIDER_ID) {
      await updateConfigAtEffectiveScope(this.platform, "damocles.explore", "enabled", false);
      log("[ExploreManager] setProvider: default (interception disabled)");
      return;
    }
    if (!VALID_PROVIDERS.has(provider as ExploreThirdPartyProvider)) {
      log("[ExploreManager] setProvider: rejected unknown provider=%s", provider);
      return;
    }
    await updateConfigAtEffectiveScope(this.platform, "damocles.explore", "provider", provider);
    await updateConfigAtEffectiveScope(this.platform, "damocles.explore", "enabled", true);
    log("[ExploreManager] setProvider: %s (effective model: %s, interception enabled)", provider, getEffectiveModel(this.platform.settings));
  }

  async setModel(model: string): Promise<void> {
    const provider = getProvider(this.platform.settings);
    const current = this.platform.settings.get<Record<string, string>>("damocles.explore.modelByProvider", {});
    const next: Record<string, string> = { ...current, [provider]: model };
    await updateConfigAtEffectiveScope(this.platform, "damocles.explore", "modelByProvider", next);
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
    const next = parsed && exploreSupportedEffortLevels(getProvider(this.platform.settings), getEffectiveModel(this.platform.settings)).includes(parsed) ? parsed : undefined;
    await updateConfigAtEffectiveScope(this.platform, "damocles.explore", "effort", next);
    log("[ExploreManager] setEffort: %s", next ?? "(cleared)");
  }

  async sendExploreKeyStatus(host: PanelHost): Promise<void> {
    const key = getSecretKey(this.platform.settings);
    if (!key) {
      this.postMessage(host, { type: "exploreApiKeyUpdate", hasApiKey: false });
      return;
    }
    const stored = await this.platform.secrets.get(key);
    const hasApiKey = stored !== undefined && stored.length > 0;
    log("[ExploreManager] sendExploreKeyStatus: hasApiKey: %s (%s)", hasApiKey, key);
    this.postMessage(host, { type: "exploreApiKeyUpdate", hasApiKey });
  }

  sendExploreConfig(host: PanelHost): void {
    const provider = getEffectiveProviderSelection(this.platform.settings);
    const model = provider === DEFAULT_PROVIDER_ID ? "" : getEffectiveModel(this.platform.settings);
    const effort = provider === DEFAULT_PROVIDER_ID ? "" : getEffort(this.platform.settings);
    log("[ExploreManager] sendExploreConfig: provider=%s model=%s effort=%s", provider, model, effort);
    this.postMessage(host, { type: "exploreConfigUpdate", provider, model, effort });
  }

  /** The currently selected explore provider (used to decide whether an Explore-key write also affects
   *  the shared StepFun panel). */
  selectedExploreProvider(): ExploreThirdPartyProvider {
    return getProvider(this.platform.settings);
  }

  // ---- StepFun (shared key) -------------------------------------------------
  // StepFun's key is the SAME entry the Explore section writes for provider=stepfun
  // (`damocles.explore.apiKey.stepfun`). These write that fixed key directly — NOT the
  // currently-selected explore provider's key — so the dedicated StepFun panel works regardless of the
  // Explore provider selection.

  async storeStepfunApiKey(key: string): Promise<void> {
    await this.platform.secrets.store(EXPLORE_SECRET_KEYS.stepfun, key.trim());
    log("[ExploreManager] storeStepfunApiKey: stored");
    this.resyncCustomProviders();
  }

  async deleteStepfunApiKey(): Promise<void> {
    await this.platform.secrets.delete(EXPLORE_SECRET_KEYS.stepfun);
    log("[ExploreManager] deleteStepfunApiKey: deleted");
    this.resyncCustomProviders();
  }

  async sendStepfunAuthStatus(host: PanelHost): Promise<void> {
    const stored = await this.platform.secrets.get(EXPLORE_SECRET_KEYS.stepfun);
    const configured = stored !== undefined && stored.length > 0;
    this.postMessage(host, { type: "stepfunAuthStatusChanged", configured });
  }

  // ---- DeepSeek (own key) ---------------------------------------------------

  async storeDeepseekApiKey(key: string): Promise<void> {
    await this.platform.secrets.store(DEEPSEEK_SECRET_KEY, key.trim());
    log("[ExploreManager] storeDeepseekApiKey: stored");
    this.resyncCustomProviders();
  }

  async deleteDeepseekApiKey(): Promise<void> {
    await this.platform.secrets.delete(DEEPSEEK_SECRET_KEY);
    log("[ExploreManager] deleteDeepseekApiKey: deleted");
    this.resyncCustomProviders();
  }

  async sendDeepseekAuthStatus(host: PanelHost): Promise<void> {
    const stored = await this.platform.secrets.get(DEEPSEEK_SECRET_KEY);
    const configured = stored !== undefined && stored.length > 0;
    this.postMessage(host, { type: "deepseekAuthStatusChanged", configured });
  }
}

// ---- TypeSafe (own key, Jev for the memory judges) ---------------------------

/** Awaited, so a status read next (memory judge, image generation's OpenRouter check) sees the new key. */
async function resyncCustomProvidersNow(platform: Platform): Promise<void> {
  if (!PiRuntime.exists) return;
  await PiRuntime.get().syncCustomProviders((k) => platform.secrets.get(k));
}

/** Saving a classifier key, even the same one, is the user saying its refusal is resolved (a 402 can clear with the same key). */
async function storeClassifierKey(platform: Platform, provider: ClassifierProvider, secretKey: string, key: string): Promise<void> {
  await platform.secrets.store(secretKey, key.trim());
  log("[ExploreManager] stored the %s key", provider);
  await resyncCustomProvidersNow(platform);
  if (PiRuntime.exists) PiRuntime.get().resetClassifierBreaker(provider);
}

export async function storeTypesafeApiKey(platform: Platform, key: string): Promise<void> {
  await storeClassifierKey(platform, "typesafe", TYPESAFE_SECRET_KEY, key);
}

export async function deleteTypesafeApiKey(platform: Platform): Promise<void> {
  await platform.secrets.delete(TYPESAFE_SECRET_KEY);
  log("[ExploreManager] deleteTypesafeApiKey: deleted");
  await resyncCustomProvidersNow(platform);
}

/** The OpenRouter key without touching the Explore provider or its enabled state: image generation and Jev use it too. */
export async function storeOpenrouterApiKey(platform: Platform, key: string): Promise<void> {
  await storeClassifierKey(platform, "openrouter", EXPLORE_SECRET_KEYS.openrouter, key);
}

export async function deleteOpenrouterApiKey(platform: Platform): Promise<void> {
  await platform.secrets.delete(EXPLORE_SECRET_KEYS.openrouter);
  log("[ExploreManager] deleteOpenrouterApiKey: deleted");
  await resyncCustomProvidersNow(platform);
}

export async function openrouterAuthStatus(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "openrouterAuthStatusChanged" }>> {
  const stored = await platform.secrets.get(EXPLORE_SECRET_KEYS.openrouter);
  return { type: "openrouterAuthStatusChanged", configured: (stored ?? "").length > 0 };
}

/**
 * Until a chat has started pi, the judge is read from the stored keys and pi's environment keys alone, and
 * the sub-call model is unknown.
 */
export async function typesafeAuthStatus(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "typesafeAuthStatusChanged" }>> {
  const hasSecret = async (key: string): Promise<boolean> => ((await platform.secrets.get(key)) ?? "").length > 0;
  const configured = await hasSecret(TYPESAFE_SECRET_KEY);
  if (PiRuntime.exists && PiRuntime.get().memoryJudgeKnown) {
    return { type: "typesafeAuthStatusChanged", configured, memoryJudge: PiRuntime.get().describeMemoryJudge() };
  }
  const inEnv = (provider: ClassifierProvider): boolean => (process.env[CLASSIFIER_ENV_KEYS[provider]] ?? "").length > 0;
  const classifier =
    configured || inEnv("typesafe") ? JEV_VIA_TYPESAFE
    : inEnv("openrouter") || (await hasSecret(EXPLORE_SECRET_KEYS.openrouter)) ? JEV_VIA_OPENROUTER
    : null;
  return { type: "typesafeAuthStatusChanged", configured, memoryJudge: classifier ? memoryJudgeOf(classifier, null) : { kind: "unknown" } };
}
