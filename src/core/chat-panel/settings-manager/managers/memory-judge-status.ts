import type { Platform } from "../../../../platform/platform";
import { PROVIDER_SECRET_KEYS } from "../../../pi-session/explore-providers";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { keyProviderOfSecret, providerKeyStored, TYPESAFE_SECRET_KEY } from "../../../pi-session/custom-providers";
import { clientHasKey, clientKeySaved } from "../../../client-snapshots";
import { readProviderSignIns } from "../../../pi-session/provider-auth";
import { CLASSIFIER_ENV_KEYS, CLASSIFIER_MODELS, classifierCredential, classifierModelOf, memoryJudgeOf, pickClassifierModel } from "../../../pi-session/classifier-model";
import { OPENAI_API_KEY_SECRET, openaiAuthStatus, readOpenAIAuthFromDisk, readPreferOpenAIApiKey } from "../../../pi-session/openai-auth";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { MEMORY_JUDGE_SETTING, forcedClassifierOf, isKnownMemoryJudgeChoice } from "../../../../shared/memory-judge";
import { migrateLegacyModelValue } from "../../../../shared/types/constants";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { ClassifierCredential, ClassifierProvider, MemoryJudge } from "../../../../shared/types/settings";

/**
 * Until a chat has started pi, the judge is read from the stored keys, the stored sign-ins, the OpenAI auth state and
 * pi's environment keys alone, and a judge model is unknown.
 */
export async function memoryJudgeStatus(platform: Platform): Promise<Extract<ExtensionToWebviewMessage, { type: "memoryJudgeStatus" }>> {
  if (PiRuntime.exists && PiRuntime.get().memoryJudgeKnown) {
    const runtime = PiRuntime.get();
    return { type: "memoryJudgeStatus", memoryJudge: runtime.describeMemoryJudge(), classifierCredentials: runtime.classifierCredentials() };
  }
  // Bounded, as the settings reply waits on this status; a read that did not answer leaves the judge unknown, so this rejects.
  const hasSecret = async (key: string): Promise<boolean> => {
    // a daemon's core: the key is the client's, known from its clientAuth, never read
    if (platform.remote) {
      const provider = keyProviderOfSecret(key);
      return provider ? clientKeySaved(platform.remote, provider) : clientHasKey(platform.remote, key === OPENAI_API_KEY_SECRET ? "openai" : key);
    }
    const stored = await providerKeyStored((k) => platform.secrets.get(k), key);
    if (stored === undefined) throw new Error(`the secret store did not answer for ${key}`);
    return stored;
  };
  const inEnv = (provider: ClassifierProvider): boolean => (process.env[CLASSIFIER_ENV_KEYS[provider]] ?? "").length > 0;
  const [openaiKey, typesafeKey, openrouterKey] = await Promise.all([
    hasSecret(OPENAI_API_KEY_SECRET),
    hasSecret(TYPESAFE_SECRET_KEY),
    hasSecret(PROVIDER_SECRET_KEYS.openrouter),
  ]);
  const openai = openaiAuthStatus(readOpenAIAuthFromDisk(PI_AGENT_DIR), openaiKey);
  // on a daemon's core auth.json reads as the pinned (else acting) client's sign-ins, as for the key status
  const openrouterSignedIn = readProviderSignIns(PI_AGENT_DIR)?.["openrouter"]?.type === "oauth";
  const keyed: Record<ClassifierProvider, boolean> = {
    typesafe: typesafeKey || inEnv("typesafe"),
    openrouter: inEnv("openrouter") || openrouterKey || openrouterSignedIn,
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
  return { type: "memoryJudgeStatus", memoryJudge, classifierCredentials };
}
