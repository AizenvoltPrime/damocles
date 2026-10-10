import type { Platform } from "../../../../platform/platform";
import type { PanelHost } from "../../../../platform/window-service";
import type { PostMessageFn } from "../types";
import { PROVIDER_SECRET_KEYS } from "../../../pi-session/explore-providers";
import { readExploreSetting } from "../../../pi-session/subagents/cheap-model";
import { EXPLORE_EFFORT_SETTING, EXPLORE_MODEL_SETTING } from "../../../../shared/explore-settings";
import { assertEffortSupported, type SettingWrite } from "../utils";
import { DEFAULT_MODELS, migrateLegacyModelValue, supportedStoredEffort } from "../../../../shared/types/constants";
import type { EffortLevel } from "../../../../shared/types/settings";
import { log } from "../../../logger";
import { t } from "../../../l10n";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { TYPESAFE_SECRET_KEY } from "../../../pi-session/custom-providers";
import { CLASSIFIER_ENV_KEYS, CLASSIFIER_MODELS, classifierCredential, classifierModelOf, memoryJudgeOf, pickClassifierModel } from "../../../pi-session/classifier-model";
import { OPENAI_API_KEY_SECRET, openaiAuthStatus, readOpenAIAuthFromDisk, readPreferOpenAIApiKey } from "../../../pi-session/openai-auth";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { MEMORY_JUDGE_SETTING, forcedClassifierOf, isKnownMemoryJudgeChoice } from "../../../../shared/memory-judge";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { ClassifierCredential, ClassifierProvider, MemoryJudge } from "../../../../shared/types/settings";

const DEEPSEEK_SECRET_KEY = "damocles.deepseek.apiKey";

export class ExploreManager {
  private readonly postMessage: PostMessageFn;
  private readonly platform: Platform;

  constructor(postMessage: PostMessageFn, platform: Platform) {
    this.postMessage = postMessage;
    this.platform = platform;
  }

  /**
   * Re-wire the native custom providers on the live pi runtime after a key changes, so a chat can reach the
   * model without a window reload. Guarded by `PiRuntime.exists` so the settings path never boots pi.
   */
  private resyncCustomProviders(): void {
    if (!PiRuntime.exists) return;
    void PiRuntime.get().syncCustomProviders((k) => this.platform.secrets.get(k));
  }

  /** Explore is read with no folder, so its settings are user-level only (application scope). */
  async setModel(model: string): Promise<SettingWrite> {
    if (model !== "" && !DEFAULT_MODELS.some((m) => m.value === model)) throw new Error(t("Model \"{0}\" is not a known model", model));
    const config = this.platform.settings;
    await config.update(EXPLORE_MODEL_SETTING, model === "" ? undefined : model, "user");
    // Default takes no effort, and a picked model keeps only one it supports.
    const storedEffort = config.get<string>(EXPLORE_EFFORT_SETTING, "");
    if (storedEffort !== "" && supportedStoredEffort(model, storedEffort) === null) {
      await config.update(EXPLORE_EFFORT_SETTING, undefined, "user");
    }
    log("[ExploreManager] setModel: %s", model || "(default)");
    return { key: EXPLORE_MODEL_SETTING, home: "user" };
  }

  async setEffort(effort: EffortLevel | null): Promise<SettingWrite> {
    const { model } = readExploreSetting(this.platform.settings);
    if (effort !== null && model === "") throw new Error(t("Default runs Explore at medium effort. Choose a model to set one."));
    assertEffortSupported(model, effort);
    await this.platform.settings.update(EXPLORE_EFFORT_SETTING, effort ?? undefined, "user");
    log("[ExploreManager] setEffort: %s", effort ?? "(default)");
    return { key: EXPLORE_EFFORT_SETTING, home: "user" };
  }

  // ---- StepFun (own key) ----------------------------------------------------

  async storeStepfunApiKey(key: string): Promise<void> {
    await this.platform.secrets.store(PROVIDER_SECRET_KEYS.stepfun, key.trim());
    log("[ExploreManager] storeStepfunApiKey: stored");
    this.resyncCustomProviders();
  }

  async deleteStepfunApiKey(): Promise<void> {
    await this.platform.secrets.delete(PROVIDER_SECRET_KEYS.stepfun);
    log("[ExploreManager] deleteStepfunApiKey: deleted");
    this.resyncCustomProviders();
  }

  async sendStepfunAuthStatus(host: PanelHost): Promise<void> {
    const stored = await this.platform.secrets.get(PROVIDER_SECRET_KEYS.stepfun);
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

/** The OpenRouter key, which image generation and Jev on OpenRouter use. */
export async function storeOpenrouterApiKey(platform: Platform, key: string): Promise<void> {
  await storeClassifierKey(platform, "openrouter", PROVIDER_SECRET_KEYS.openrouter, key);
}

export async function deleteOpenrouterApiKey(platform: Platform): Promise<void> {
  await platform.secrets.delete(PROVIDER_SECRET_KEYS.openrouter);
  log("[ExploreManager] deleteOpenrouterApiKey: deleted");
  await resyncCustomProvidersNow(platform);
}

export async function openrouterAuthStatus(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "openrouterAuthStatusChanged" }>> {
  const stored = await platform.secrets.get(PROVIDER_SECRET_KEYS.openrouter);
  return { type: "openrouterAuthStatusChanged", configured: (stored ?? "").length > 0 };
}

/**
 * Until a chat has started pi, the judge is read from the stored keys, the OpenAI auth state and pi's environment
 * keys alone, and a judge model is unknown.
 */
export async function typesafeAuthStatus(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "typesafeAuthStatusChanged" }>> {
  const hasSecret = async (key: string): Promise<boolean> => ((await platform.secrets.get(key)) ?? "").length > 0;
  const configured = await hasSecret(TYPESAFE_SECRET_KEY);
  if (PiRuntime.exists && PiRuntime.get().memoryJudgeKnown) {
    const runtime = PiRuntime.get();
    return { type: "typesafeAuthStatusChanged", configured, memoryJudge: runtime.describeMemoryJudge(), classifierCredentials: runtime.classifierCredentials() };
  }
  const inEnv = (provider: ClassifierProvider): boolean => (process.env[CLASSIFIER_ENV_KEYS[provider]] ?? "").length > 0;
  const openai = openaiAuthStatus(readOpenAIAuthFromDisk(PI_AGENT_DIR), await hasSecret(OPENAI_API_KEY_SECRET));
  const keyed: Record<ClassifierProvider, boolean> = {
    typesafe: configured || inEnv("typesafe"),
    openrouter: inEnv("openrouter") || (await hasSecret(PROVIDER_SECRET_KEYS.openrouter)),
    openai: openai.apiKey || openai.chatgpt || inEnv("openai"),
  };
  const preferApiKey = readPreferOpenAIApiKey(platform.state);
  const classifierCredentials = Object.fromEntries(
    CLASSIFIER_MODELS.map(({ provider }) => [provider, classifierCredential(provider, (p) => keyed[p], { status: openai, preferApiKey })]),
  ) as Record<ClassifierProvider, ClassifierCredential>;
  const choice = migrateLegacyModelValue(platform.settings.get<string>(MEMORY_JUDGE_SETTING, ""));
  const forced = forcedClassifierOf(choice);
  let memoryJudge: MemoryJudge = { kind: "unknown" };
  if (!isKnownMemoryJudgeChoice(choice)) {
    memoryJudge = memoryJudgeOf(null, null, [], { choice, reason: "unrecognized" });
  } else if (choice === "") {
    const classifier = pickClassifierModel(({ provider }) => classifierCredentials[provider] === "ok");
    if (classifier) memoryJudge = memoryJudgeOf(classifier, null);
  } else if (forced) {
    const credential = classifierCredentials[forced];
    memoryJudge = credential === "ok" ? memoryJudgeOf(classifierModelOf(forced), null) : memoryJudgeOf(null, null, [], { choice, reason: credential });
  }
  return { type: "typesafeAuthStatusChanged", configured, memoryJudge, classifierCredentials };
}
